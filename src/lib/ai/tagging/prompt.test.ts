import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { estimateTextTokens } from "@/lib/ai/cost";
import {
  buildTaggingContent,
  TAG_PROMPT_VERSION,
  TAGGING_PARAMS,
  TAGGING_SYSTEM_PROMPT,
  TAGGING_USER_INSTRUCTION,
} from "@/lib/ai/tagging/prompt";
import { FORMALITIES, ITEM_CATEGORIES, ITEM_CONDITIONS, SEASONS } from "@/lib/db/enums";

// Changing the prompt or the instruction changes what Claude is asked. Bump
// TAG_PROMPT_VERSION (stored per item) and record the new hashes here; the old
// version's items keep their tags until they are re-tagged.
const PINNED = {
  "tag-v1": {
    system: "c6e3ece4d5fd2447996762ea3b5f01ee38ad73a75bc7a82c1a62274e1f207b0a",
    instruction: "54d7d744b96806e6dd3be7e9f713e638cc398154a3ea543ae6869b252b338e9b",
  },
} as const;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("tagging prompt", () => {
  it("matches the hashes pinned for its version", () => {
    expect(TAG_PROMPT_VERSION).toBe("tag-v1");
    expect(sha256(TAGGING_SYSTEM_PROMPT)).toBe(PINNED[TAG_PROMPT_VERSION].system);
    expect(sha256(TAGGING_USER_INSTRUCTION)).toBe(PINNED[TAG_PROMPT_VERSION].instruction);
  });

  it("is long enough to cache, with headroom over the 512-token minimum", () => {
    const tokens = estimateTextTokens(TAGGING_SYSTEM_PROMPT);
    expect(tokens).toBeGreaterThanOrEqual(1024);
    // About 1.3K to 1.8K real tokens; the estimate adds a 1.3x safety factor.
    expect(tokens).toBeLessThanOrEqual(1800 * 1.3);
  });

  it("is static text: no dates, ids, template leftovers or CR characters", () => {
    expect(TAGGING_SYSTEM_PROMPT).not.toMatch(/\$\{|\r|\d{4}-\d{2}-\d{2}|[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(TAGGING_SYSTEM_PROMPT).toBe(TAGGING_SYSTEM_PROMPT.trim());
  });

  it("defines every category, formality and condition, and names every season", () => {
    for (const category of ITEM_CATEGORIES) expect(TAGGING_SYSTEM_PROMPT).toContain(`- ${category}:`);
    for (const formality of FORMALITIES) expect(TAGGING_SYSTEM_PROMPT).toContain(`${formality} =`);
    for (const condition of ITEM_CONDITIONS) expect(TAGGING_SYSTEM_PROMPT).toContain(`${condition} =`);
    for (const season of SEASONS) expect(TAGGING_SYSTEM_PROMPT).toContain(season);
  });

  it("carries the spec's rules", () => {
    for (const level of [1, 2, 3, 4, 5]) expect(TAGGING_SYSTEM_PROMPT).toContain(`${level} = `);
    expect(TAGGING_SYSTEM_PROMPT).toContain("down parkas, shearling, insulated waterproof boots");
    expect(TAGGING_SYSTEM_PROMPT).toMatch(/waxed cotton \(mention "water-resistant waxed cotton" in the description\)/);
    expect(TAGGING_SYSTEM_PROMPT).toContain("multiple_items_detected to true");
    expect(TAGGING_SYSTEM_PROMPT).toContain("at most 180 characters");
    expect(TAGGING_SYSTEM_PROMPT).toContain("lowercase #rrggbb");
    expect(TAGGING_SYSTEM_PROMPT).toMatch(/null when you cannot tell/);
    expect(TAGGING_SYSTEM_PROMPT).toMatch(/brand_guess only from a legible name or logo/);
  });

  it("never asks for reasoning, thinking or thoughts", () => {
    expect(TAGGING_SYSTEM_PROMPT).not.toMatch(/reasoning|thinking|thought/i);
    expect(TAGGING_USER_INSTRUCTION).not.toMatch(/reasoning|thinking|thought/i);
  });
});

describe("buildTaggingContent", () => {
  it("puts a base64 image before the instruction", () => {
    const content = buildTaggingContent({ type: "base64", mediaType: "image/webp", data: "AAAA" });
    expect(content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "AAAA" } },
      { type: "text", text: TAGGING_USER_INSTRUCTION },
    ]);
  });

  it("puts a URL image before the instruction", () => {
    const url = "https://example.public.blob.vercel-storage.com/items/x/processed.webp";
    const [image, text] = buildTaggingContent({ type: "url", url });
    expect(image).toEqual({ type: "image", source: { type: "url", url } });
    expect(text.type).toBe("text");
  });

  it("sets no cache marker on the varying user content", () => {
    for (const block of buildTaggingContent({ type: "url", url: "https://example.com/a.webp" })) {
      expect(block).not.toHaveProperty("cache_control");
    }
  });
});

describe("TAGGING_PARAMS", () => {
  it("uses low effort, 4096 tokens and one doubling", () => {
    expect(TAGGING_PARAMS).toEqual({ purpose: "tagging", effort: "low", maxTokens: 4096, maxTokensCeiling: 8192 });
  });
});
