// The relocation outputs in three forms (D-018, D-025, D-027):
// - Wire schemas constrain what Claude writes: every key required, no length
//   or range limits (the descriptions and the prompt state them), enums and
//   integer types kept, items named by alias.
// - Strict schemas check the JSON.parse'd reply; a failure is invalid output
//   that callStructured retries. They take the aliases the request listed.
// - RelocationAnalysisSchema is the stored result: item uuids, the spec's
//   field names, computed warnings and run metadata.
// Pure zod: safe in client code (the result view parses stored results). No
// key may contain reasoning, thinking or thought (D-022).

import { z } from "zod";

import { ITEM_CATEGORIES, PACKING_GROUPS } from "@/lib/db/enums";
import {
  BUY_TIMINGS,
  MAX_EUR,
  RELOCATION_DECISIONS,
  RELOCATION_EFFORTS,
  RELOCATION_PRIORITIES,
} from "@/lib/relocation/contracts";

// ---------------------------------------------------------------------------
// Shared limits and enums
// ---------------------------------------------------------------------------

export const RELOCATION_LIMITS = {
  /** The prompt asks for 120; the check leaves room. */
  reasonMax: 200,
  summaryMax: 1200,
  layeringMin: 3,
  layeringMax: 5,
  titleMax: 80,
  conditionsMax: 200,
  gapNoteMax: 300,
  gapsMax: 12,
  /** itemType, reason and specs match the shopping list's limits so a gap always fits there. */
  itemTypeMax: 120,
  whyNeededMax: 500,
  specsMax: 10,
  specMax: 120,
  quantityMin: 1,
  quantityMax: 10,
  extrasMax: 10,
  extraMax: 120,
  warningMessageMax: 300,
  gapKeyMax: 80,
} as const;

/** Item aliases as payload.ts writes them. */
export const ALIAS_PATTERN = /^i\d+$/;

/** Warning kinds Claude may write. */
export const AI_WARNING_KINDS = ["uncertain_tags", "duplicate", "poor_condition", "other"] as const;
export type AiWarningKind = (typeof AI_WARNING_KINDS)[number];

/** Every warning kind of a stored result; the last three are computed by the service. */
export const WARNING_KINDS = [...AI_WARNING_KINDS, "over_budget", "packing", "placeholder_climate"] as const;
export type WarningKind = (typeof WARNING_KINDS)[number];

export const WARNING_SOURCES = ["ai", "computed"] as const;
export type WarningSource = (typeof WARNING_SOURCES)[number];

const L = RELOCATION_LIMITS;

// ---------------------------------------------------------------------------
// Chunk calls
// ---------------------------------------------------------------------------

export const ChunkWireSchema = z.strictObject({
  decisions: z
    .array(
      z.strictObject({
        item: z.string().describe("The item's alias exactly as listed, e.g. i12."),
        decision: z.enum(RELOCATION_DECISIONS),
        priority: z.literal(RELOCATION_PRIORITIES).describe("1 = most important or clear-cut, 3 = least."),
        reason: z.string().describe("Terse and specific, at most 120 characters."),
      }),
    )
    .describe("One entry per listed alias, each alias exactly once."),
});
export type ChunkWire = z.infer<typeof ChunkWireSchema>;
export type ChunkDecision = ChunkWire["decisions"][number];

const requiredText = (max: number) => z.string().trim().min(1).max(max);

/**
 * An enum value compared case-insensitively. Structured outputs do not
 * guarantee the capitalisation of enum values, so a reply with "Bring" means
 * bring rather than a paid retry; the result keeps the canonical value
 * (D-165). Strict schemas only: the wire schemas stay plain enums.
 */
const looseEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(z.enum(values));

/** Adds an issue for every alias outside `known`. */
function checkAliases(
  aliases: readonly string[],
  known: ReadonlySet<string>,
  ctx: z.RefinementCtx,
  path: ReadonlyArray<string | number>,
): void {
  aliases.forEach((alias, index) => {
    if (!known.has(alias)) ctx.addIssue({ code: "custom", path: [...path, index], message: `Unknown alias ${alias}.` });
  });
}

/**
 * The strict check of a chunk (or repair) reply: aliases well-formed, all from
 * this request, none twice; priorities 1 to 3; reasons non-empty and at most
 * 200 characters. Missing aliases pass: the service makes one repair call.
 */
export function makeChunkStrictSchema(aliases: readonly string[]): z.ZodType<ChunkWire> {
  const known = new Set(aliases);
  return z
    .strictObject({
      decisions: z.array(
        z.strictObject({
          item: z.string().regex(ALIAS_PATTERN),
          decision: looseEnum(RELOCATION_DECISIONS),
          priority: z.literal(RELOCATION_PRIORITIES),
          reason: requiredText(L.reasonMax),
        }),
      ),
    })
    .superRefine((reply, ctx) => {
      const seen = new Set<string>();
      reply.decisions.forEach((entry, index) => {
        if (!known.has(entry.item)) {
          ctx.addIssue({ code: "custom", path: ["decisions", index, "item"], message: `Unknown alias ${entry.item}.` });
        } else if (seen.has(entry.item)) {
          ctx.addIssue({ code: "custom", path: ["decisions", index, "item"], message: `Duplicate alias ${entry.item}.` });
        }
        seen.add(entry.item);
      });
    });
}

// ---------------------------------------------------------------------------
// Synthesis call
// ---------------------------------------------------------------------------

export const SynthesisWireSchema = z.strictObject({
  summary: z.string().describe("At most 1,200 characters."),
  layering_systems: z
    .array(
      z.strictObject({
        title: z.string().describe("The condition in a few words, at most 80 characters."),
        conditions: z.string().describe("The weather in numbers, at most 200 characters."),
        item_aliases: z.array(z.string()).describe("Owned items only, base layer to outer layer, then footwear and accessories."),
        gap_note: z
          .string()
          .nullable()
          .describe(`What is missing for this condition, at most ${L.gapNoteMax} characters; null when owned items cover it.`),
      }),
    )
    .describe("3 to 5 systems."),
  gaps: z
    .array(
      z.strictObject({
        item_type: z.string().describe("What to buy, at most 120 characters."),
        category: z.enum(ITEM_CATEGORIES),
        why_needed: z.string().describe("Cites the climate numbers, at most 500 characters."),
        specs: z.array(z.string()).describe("Up to 10 concrete, checkable features, each at most 120 characters."),
        priority: z.literal(RELOCATION_PRIORITIES),
        quantity: z.number().int().describe("1 to 10."),
        est_price_min_eur: z.number().int().describe("Whole euros."),
        est_price_max_eur: z.number().int().describe("Whole euros, not below the minimum."),
        buy_timing: z.enum(BUY_TIMINGS),
      }),
    )
    .describe("At most 12, most important first."),
  packing_checklist: z
    .array(
      z.strictObject({
        group: z.enum(PACKING_GROUPS),
        item_aliases: z.array(z.string()).describe("Items decided bring; each alias in at most one group."),
        extras: z
          .array(z.string())
          .describe(
            `Up to ${L.extrasMax} short free-text things to pack that are not catalogued items, each at most ${L.extraMax} characters.`,
          ),
      }),
    )
    .describe("One entry per group."),
  warnings: z.array(
    z.strictObject({
      kind: z.enum(AI_WARNING_KINDS),
      item_aliases: z.array(z.string()),
      message: z.string().describe("At most 300 characters."),
    }),
  ),
});
export type SynthesisWire = z.infer<typeof SynthesisWireSchema>;

/** Trimmed entries with empty ones dropped, then at most `count` of at most `max` characters. */
const textList = (count: number, max: number) =>
  z
    .array(z.string())
    .transform((values) => values.map((value) => value.trim()).filter((value) => value !== ""))
    .pipe(z.array(z.string().max(max)).max(count));

/** An empty or blank note means no note. */
const optionalNote = (max: number) =>
  z
    .string()
    .nullable()
    .transform((value) => (value === null || value.trim() === "" ? null : value.trim()))
    .pipe(z.string().max(max).nullable());

const priceEur = z.number().int().min(0).max(MAX_EUR);

/**
 * The strict check of the synthesis reply: summary at most 1,200 characters,
 * 3 to 5 layering systems, at most 12 gaps with priority 1 to 3, an integer
 * quantity of 1 to 10, 0 <= min <= max and a non-empty why_needed, every alias
 * known, and each alias in at most one packing group (a group listed once).
 * An alias repeated within one group is harmless (the result keeps it once),
 * so it is not worth a paid retry (D-144).
 */
export function makeSynthesisStrictSchema(allAliases: readonly string[]): z.ZodType<SynthesisWire> {
  const known = new Set(allAliases);
  return z
    .strictObject({
      summary: requiredText(L.summaryMax),
      layering_systems: z
        .array(
          z.strictObject({
            title: requiredText(L.titleMax),
            conditions: requiredText(L.conditionsMax),
            item_aliases: z.array(z.string()),
            gap_note: optionalNote(L.gapNoteMax),
          }),
        )
        .min(L.layeringMin)
        .max(L.layeringMax),
      gaps: z
        .array(
          z.strictObject({
            item_type: requiredText(L.itemTypeMax),
            category: looseEnum(ITEM_CATEGORIES),
            why_needed: requiredText(L.whyNeededMax),
            specs: textList(L.specsMax, L.specMax),
            priority: z.literal(RELOCATION_PRIORITIES),
            quantity: z.number().int().min(L.quantityMin).max(L.quantityMax),
            est_price_min_eur: priceEur,
            est_price_max_eur: priceEur,
            buy_timing: looseEnum(BUY_TIMINGS),
          }),
        )
        .max(L.gapsMax),
      packing_checklist: z.array(
        z.strictObject({
          group: looseEnum(PACKING_GROUPS),
          item_aliases: z.array(z.string()),
          extras: textList(L.extrasMax, L.extraMax),
        }),
      ),
      warnings: z.array(
        z.strictObject({
          kind: looseEnum(AI_WARNING_KINDS),
          item_aliases: z.array(z.string()),
          message: requiredText(L.warningMessageMax),
        }),
      ),
    })
    .superRefine((reply, ctx) => {
      reply.layering_systems.forEach((system, index) =>
        checkAliases(system.item_aliases, known, ctx, ["layering_systems", index, "item_aliases"]),
      );
      reply.gaps.forEach((gap, index) => {
        if (gap.est_price_min_eur > gap.est_price_max_eur) {
          ctx.addIssue({
            code: "custom",
            path: ["gaps", index, "est_price_max_eur"],
            message: "est_price_max_eur is below est_price_min_eur.",
          });
        }
      });
      const groups = new Set<string>();
      const packed = new Map<string, string>();
      reply.packing_checklist.forEach((entry, index) => {
        if (groups.has(entry.group)) {
          ctx.addIssue({ code: "custom", path: ["packing_checklist", index, "group"], message: `Group ${entry.group} listed twice.` });
        }
        groups.add(entry.group);
        checkAliases(entry.item_aliases, known, ctx, ["packing_checklist", index, "item_aliases"]);
        entry.item_aliases.forEach((alias, aliasIndex) => {
          const previous = packed.get(alias);
          if (previous === undefined) {
            packed.set(alias, entry.group);
          } else if (previous !== entry.group) {
            ctx.addIssue({
              code: "custom",
              path: ["packing_checklist", index, "item_aliases", aliasIndex],
              message: `Alias ${alias} is packed twice (${previous} and ${entry.group}).`,
            });
          }
        });
      });
      reply.warnings.forEach((warning, index) =>
        checkAliases(warning.item_aliases, known, ctx, ["warnings", index, "item_aliases"]),
      );
    });
}

// ---------------------------------------------------------------------------
// The stored result
// ---------------------------------------------------------------------------

const itemIds = z.array(z.uuid());

export const RelocationAnalysisSchema = z
  .strictObject({
    summary: requiredText(L.summaryMax),
    items: z.array(
      z.strictObject({
        item_id: z.uuid(),
        decision: z.enum(RELOCATION_DECISIONS),
        priority: z.literal(RELOCATION_PRIORITIES),
        reason: requiredText(L.reasonMax),
      }),
    ),
    layering_systems: z
      .array(
        z.strictObject({
          title: requiredText(L.titleMax),
          conditions: requiredText(L.conditionsMax),
          item_ids: itemIds,
          gap_note: z.string().max(L.gapNoteMax).nullable(),
        }),
      )
      .min(L.layeringMin)
      .max(L.layeringMax),
    gaps: z
      .array(
        z.strictObject({
          /** Stable within the analysis; the shopping list's idempotency key (D-029). */
          gap_key: requiredText(L.gapKeyMax),
          item_type: requiredText(L.itemTypeMax),
          category: z.enum(ITEM_CATEGORIES),
          why_needed: requiredText(L.whyNeededMax),
          specs: z.array(z.string().max(L.specMax)).max(L.specsMax),
          priority: z.literal(RELOCATION_PRIORITIES),
          quantity: z.number().int().min(L.quantityMin).max(L.quantityMax),
          est_price_range_eur: z.strictObject({ min: priceEur, max: priceEur }),
          buy_before_or_after_move: z.enum(BUY_TIMINGS),
        }),
      )
      .max(L.gapsMax),
    packing_checklist: z.array(
      z.strictObject({
        group: z.enum(PACKING_GROUPS),
        item_ids: itemIds,
        extras: z.array(z.string().max(L.extraMax)).max(L.extrasMax),
      }),
    ),
    warnings: z.array(
      z.strictObject({
        kind: z.enum(WARNING_KINDS),
        item_ids: itemIds,
        message: requiredText(L.warningMessageMax),
        source: z.enum(WARNING_SOURCES),
      }),
    ),
    meta: z.strictObject({
      prompt_version: z.string().min(1),
      model: z.string().min(1),
      effort: z.enum(RELOCATION_EFFORTS),
      item_count: z.number().int().min(0),
      chunk_count: z.number().int().min(0),
      months: z.array(z.number().int().min(1).max(12)),
      climate_profile: z.strictObject({ id: z.uuid(), city: z.string(), is_placeholder: z.boolean() }).nullable(),
      purchase_budget_eur: priceEur.nullable(),
      estimated_cost_usd: z.number().min(0).nullable(),
      repair_calls: z.number().int().min(0),
    }),
  })
  .superRefine((result, ctx) => {
    const seen = new Set<string>();
    result.items.forEach((item, index) => {
      if (seen.has(item.item_id)) {
        ctx.addIssue({ code: "custom", path: ["items", index, "item_id"], message: `Item ${item.item_id} appears twice.` });
      }
      seen.add(item.item_id);
    });
    const gapKeys = new Set<string>();
    result.gaps.forEach((gap, index) => {
      if (gapKeys.has(gap.gap_key)) {
        ctx.addIssue({ code: "custom", path: ["gaps", index, "gap_key"], message: `gap_key ${gap.gap_key} appears twice.` });
      }
      gapKeys.add(gap.gap_key);
      if (gap.est_price_range_eur.min > gap.est_price_range_eur.max) {
        ctx.addIssue({ code: "custom", path: ["gaps", index, "est_price_range_eur"], message: "min is above max." });
      }
    });
  });
export type RelocationAnalysis = z.infer<typeof RelocationAnalysisSchema>;
export type RelocationItemResult = RelocationAnalysis["items"][number];
export type RelocationGap = RelocationAnalysis["gaps"][number];
export type RelocationLayeringSystem = RelocationAnalysis["layering_systems"][number];
export type RelocationPackingGroupResult = RelocationAnalysis["packing_checklist"][number];
export type RelocationWarning = RelocationAnalysis["warnings"][number];

/**
 * The stored result of one run: every snapshot item decided exactly once, and
 * every item id named anywhere in the result one of the snapshot's.
 */
export function makeRelocationAnalysisSchema(snapshotItemIds: readonly string[]): z.ZodType<RelocationAnalysis> {
  const known = new Set(snapshotItemIds);
  return RelocationAnalysisSchema.superRefine((result, ctx) => {
    const decided = new Set(result.items.map((item) => item.item_id));
    for (const id of known) {
      if (!decided.has(id)) ctx.addIssue({ code: "custom", path: ["items"], message: `Item ${id} has no decision.` });
    }
    result.items.forEach((item, index) => {
      if (!known.has(item.item_id)) {
        ctx.addIssue({ code: "custom", path: ["items", index, "item_id"], message: `Item ${item.item_id} is not in the snapshot.` });
      }
    });
    const checkIds = (ids: readonly string[], path: ReadonlyArray<string | number>) =>
      ids.forEach((id, index) => {
        if (!known.has(id)) ctx.addIssue({ code: "custom", path: [...path, index], message: `Item ${id} is not in the snapshot.` });
      });
    result.layering_systems.forEach((system, index) => checkIds(system.item_ids, ["layering_systems", index, "item_ids"]));
    result.packing_checklist.forEach((group, index) => checkIds(group.item_ids, ["packing_checklist", index, "item_ids"]));
    result.warnings.forEach((warning, index) => checkIds(warning.item_ids, ["warnings", index, "item_ids"]));
  });
}

/**
 * The least the priority 1 and 2 gaps cost: the sum of minimum price times
 * quantity. The synthesis prompt asks to keep this within the purchase budget;
 * the service's over_budget warning compares the same number.
 */
export function priorityGapsMinimumEur(
  gaps: ReadonlyArray<Pick<RelocationGap, "priority" | "quantity" | "est_price_range_eur">>,
): number {
  return gaps
    .filter((gap) => gap.priority <= 2)
    .reduce((sum, gap) => sum + gap.est_price_range_eur.min * gap.quantity, 0);
}

/** Longest slug in a gap key: "g12-" plus this stays within gapKeyMax. */
const GAP_SLUG_MAX = 70;

/** Lowercase ASCII words joined by hyphens, cut at a word boundary to at most GAP_SLUG_MAX characters. */
function slugify(text: string): string {
  const words = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
  let slug = "";
  for (const word of words) {
    const next = slug === "" ? word : `${slug}-${word}`;
    if (next.length > GAP_SLUG_MAX) return slug === "" ? word.slice(0, GAP_SLUG_MAX) : slug;
    slug = next;
  }
  return slug;
}

/**
 * A gap's key: its 1-based position in the synthesis, then a slug of its
 * category and type, e.g. "g1-outerwear-waterproof-shell-jacket". The
 * position makes it unique within a run and lets the shopping list keep the
 * run's most-important-first order (gapPosition); the key is the list's
 * idempotency key (D-029, D-149). The service and the fixtures both use this.
 */
export function makeGapKey(index: number, gap: { category: string; item_type: string }): string {
  const slug = slugify(`${gap.category} ${gap.item_type}`);
  return slug === "" ? `g${index + 1}` : `g${index + 1}-${slug}`;
}
