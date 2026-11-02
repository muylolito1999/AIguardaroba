// `pnpm ai:smoke [image-path] [https-image-url]`: a live check of the tagging
// call against the real API. Never part of `pnpm test`; it costs about $0.002.
//
// It sends two identical base64 tagging requests (the second must read the
// cached system prompt), then, when an https URL is given, one request with a
// URL image source and the 1-hour cache TTL, which are the batch parameters
// (D-024). It prints usage, stop reasons, the parsed tags and costs, and exits
// non-zero when the second request shows no cache read.
//
// Attempts go to ai_calls (purpose smoke_test) only when DATABASE_URL is set;
// otherwise they are kept in memory and nothing is written anywhere.
// Runs under `tsx --conditions=react-server` (D-017).
import "./load-env";

import type { CacheTtl, CallStructuredDeps, CallStructuredResult } from "@/lib/ai/call";
import type { AiCallRecord } from "@/lib/ai/log";
import type { ItemTags } from "@/lib/ai/tagging/schema";
import type { TaggingImageSource } from "@/lib/ai/tagging/prompt";

type Args = { imagePath: string | null; imageUrl: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { imagePath: null, imageUrl: null };
  for (const arg of argv) {
    if (/^https:\/\//i.test(arg)) {
      if (args.imageUrl !== null) throw new Error("Pass at most one image URL.");
      args.imageUrl = arg;
    } else if (/^[a-z]+:\/\//i.test(arg)) {
      throw new Error("Image URLs must use https.");
    } else {
      if (args.imagePath !== null) throw new Error("Pass at most one image path.");
      args.imagePath = arg;
    }
  }
  return args;
}

// A flat navy jacket on a light background: enough garment for Claude to tag
// when no photo is given.
const SYNTHETIC_GARMENT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024" viewBox="0 0 768 1024">
  <rect width="768" height="1024" fill="#f2efe9"/>
  <path d="M300 140 L384 190 L468 140 L600 200 L700 560 L620 590 L560 380 L560 900 L208 900 L208 380 L148 590 L68 560 L168 200 Z" fill="#1f2a44"/>
  <path d="M300 140 L384 260 L468 140" fill="none" stroke="#6b4423" stroke-width="22"/>
  <line x1="384" y1="260" x2="384" y2="900" stroke="#c9c9c9" stroke-width="6"/>
  <rect x="240" y="620" width="110" height="90" rx="8" fill="#18213a"/>
  <rect x="418" y="620" width="110" height="90" rx="8" fill="#18213a"/>
</svg>`;

/** The longest a single smoke call may take, retries included. */
const CALL_DEADLINE_MS = 60_000;

function show(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : String(value);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // Imported after load-env so env.ts sees the loaded variables.
  const [
    { aiEnv, dbEnv },
    { getAnthropic },
    { callStructured },
    { estimateImageTokens, estimateTextTokens, formatUsd, taggingCostRates },
    { buildTaggingContent, TAG_PROMPT_VERSION, TAGGING_PARAMS, TAGGING_SYSTEM_PROMPT },
    { ItemTagsSchema, ItemTagsWireSchema },
    { createDb },
    { default: sharp },
  ] = await Promise.all([
    import("@/env"),
    import("@/lib/ai/client"),
    import("@/lib/ai/call"),
    import("@/lib/ai/cost"),
    import("@/lib/ai/tagging/prompt"),
    import("@/lib/ai/tagging/schema"),
    import("@/lib/db/client"),
    import("sharp"),
  ]);

  const settings = aiEnv();
  const model = settings.models.tagging;
  const anthropic = getAnthropic();

  // Same preparation as the processed image of an upload: 1024 px, WebP q80.
  const input = args.imagePath ?? Buffer.from(SYNTHETIC_GARMENT_SVG);
  const image = await sharp(input)
    .rotate()
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer({ resolveWithObject: true });
  console.log(
    `model ${model}, prompt ${TAG_PROMPT_VERSION}, image ${args.imagePath ?? "synthetic jacket"} ` +
      `(${image.info.width}x${image.info.height} WebP, ${image.info.size} bytes, ` +
      `about ${estimateImageTokens(image.info.width, image.info.height)} image tokens)`,
  );
  console.log(`system prompt: about ${estimateTextTokens(TAGGING_SYSTEM_PROMPT)} tokens by the estimator`);

  const logged: AiCallRecord[] = [];
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const connection = databaseUrl ? createDb(dbEnv().DATABASE_URL) : null;
  const deps: CallStructuredDeps = connection
    ? { anthropic, db: connection.db }
    : {
        anthropic,
        logCall: async (row) => {
          logged.push(row);
        },
      };
  console.log(
    connection
      ? "DATABASE_URL is set: attempts are written to ai_calls with purpose smoke_test."
      : "DATABASE_URL is not set: attempts are kept in memory only.",
  );

  const run = async (
    label: string,
    source: TaggingImageSource,
    cacheTtl: CacheTtl,
  ): Promise<CallStructuredResult<ItemTags>> => {
    const result = await callStructured({
      deps,
      purpose: "smoke_test",
      model,
      system: TAGGING_SYSTEM_PROMPT,
      cacheTtl,
      content: buildTaggingContent(source),
      wire: ItemTagsWireSchema,
      strict: ItemTagsSchema,
      effort: TAGGING_PARAMS.effort,
      maxTokens: TAGGING_PARAMS.maxTokens,
      maxTokensCeiling: TAGGING_PARAMS.maxTokensCeiling,
      deadlineAt: Date.now() + CALL_DEADLINE_MS,
    });
    const { usage } = result;
    console.log(`\n${label}: ${result.attempts} attempt(s), request ${result.requestId ?? "-"}, ${result.latencyMs} ms`);
    console.log(
      `  input ${usage.input_tokens}, output ${usage.output_tokens} ` +
        `(thinking ${show(usage.output_tokens_details?.thinking_tokens)}), ` +
        `cache write ${show(usage.cache_creation_input_tokens)} ` +
        `(5m ${show(usage.cache_creation?.ephemeral_5m_input_tokens)}, 1h ${show(usage.cache_creation?.ephemeral_1h_input_tokens)}), ` +
        `cache read ${show(usage.cache_read_input_tokens)}`,
    );
    console.log(`  stop_reason end_turn, cost ${formatUsd(result.costUsd)} (all attempts)`);
    console.log(`  tags ${JSON.stringify(result.data)}`);
    return result;
  };

  try {
    const base64: TaggingImageSource = {
      type: "base64",
      mediaType: "image/webp",
      data: image.data.toString("base64"),
    };
    const first = await run("base64 call 1", base64, "5m");
    const second = await run("base64 call 2", base64, "5m");
    const third = args.imageUrl ? await run("url call (batch parameters)", { type: "url", url: args.imageUrl }, "1h") : null;

    const rates = taggingCostRates(model);
    console.log(
      `\nestimate per item: first ${formatUsd(rates.firstItemUsd)}, next ${formatUsd(rates.nextItemUsd)}; ` +
        `measured: first ${formatUsd(first.costUsd)}, second ${formatUsd(second.costUsd)}` +
        (third ? `, url ${formatUsd(third.costUsd)}` : ""),
    );
    if (!connection) console.log(`${logged.length} attempt(s) recorded in memory.`);
    if (!args.imageUrl) console.log("No https image URL given: the URL-source call was skipped.");

    if ((second.usage.cache_read_input_tokens ?? 0) === 0) {
      console.error(
        "FAIL: the second call read nothing from the prompt cache. Something in the system prompt, " +
          "the schema or the effort changes between requests.",
      );
      return 1;
    }
    console.log("OK: the second call read the system prompt from the cache.");
    return 0;
  } finally {
    await connection?.pool.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // AppError messages name variables, never values, and API errors carry no key.
    console.error(`ai:smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
