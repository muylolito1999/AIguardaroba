import { randomUUID } from "node:crypto";

import { PACKING_GROUPS, type ItemCategory } from "@/lib/db/enums";
import type { RelocationDecision } from "@/lib/relocation/contracts";
import type { SnapshotItemInput } from "@/lib/relocation/payload";
import { RELOC_PROMPT_VERSION } from "@/lib/relocation/prompts";
import { makeGapKey, type ChunkWire, type RelocationAnalysis, type SynthesisWire } from "@/lib/relocation/schemas";

// Builders for relocation tests: snapshot items, Claude replies (the wire
// data; wrap it in fakeMessage({ json }) from test/fakes/anthropic.ts for the
// fake client) and stored results. Every builder returns data that passes the
// matching strict schema unless the overrides say otherwise. No SDK or
// database imports, so component tests and the Playwright seeds can use it.

let itemSeq = 0;

/** A confirmed, fully tagged item; ids are random uuids, createdAt one minute apart per call. */
export function makeSnapshotItem(overrides: Partial<SnapshotItemInput> = {}): SnapshotItemInput {
  itemSeq += 1;
  return {
    id: randomUUID(),
    createdAt: new Date(Date.UTC(2026, 0, 1) + itemSeq * 60_000),
    name: "Navy wool coat",
    category: "outerwear",
    subcategory: "coat",
    colors: ["navy"],
    materials: ["wool", "polyamide"],
    materialGuess: "wool blend",
    warmthLevel: 4,
    waterproof: false,
    windproof: true,
    insulated: true,
    breathable: null,
    seasons: ["winter", "autumn"],
    formality: "smart_casual",
    condition: "good",
    status: "confirmed",
    location: "bologna",
    aiConfidence: { category: 0.95, colors: 0.9, materials: 0.8, warmth_level: 0.8, condition: 0.75 },
    userEditedFields: [],
    ...overrides,
  };
}

type Template = Pick<
  SnapshotItemInput,
  "name" | "category" | "subcategory" | "colors" | "materials" | "warmthLevel" | "waterproof" | "windproof" | "insulated" | "seasons" | "formality"
>;

// Realistic item shapes per category, cycled to build a wardrobe of any size.
const TEMPLATES: Record<ItemCategory, readonly Template[]> = {
  outerwear: [
    { name: "Navy wool overcoat", category: "outerwear", subcategory: "overcoat", colors: ["navy"], materials: ["wool", "polyamide"], warmthLevel: 4, waterproof: false, windproof: true, insulated: true, seasons: ["winter", "autumn"], formality: "smart_casual" },
    { name: "Black down puffer jacket", category: "outerwear", subcategory: "puffer jacket", colors: ["black"], materials: ["down", "nylon"], warmthLevel: 5, waterproof: false, windproof: true, insulated: true, seasons: ["winter"], formality: "casual" },
    { name: "Beige cotton trench coat", category: "outerwear", subcategory: "trench coat", colors: ["beige"], materials: ["cotton"], warmthLevel: 2, waterproof: false, windproof: true, insulated: false, seasons: ["spring", "autumn"], formality: "smart_casual" },
  ],
  top: [
    { name: "White oxford shirt", category: "top", subcategory: "shirt", colors: ["white"], materials: ["cotton"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, seasons: ["spring", "summer", "autumn"], formality: "business" },
    { name: "Grey merino crew-neck sweater", category: "top", subcategory: "sweater", colors: ["grey"], materials: ["merino"], warmthLevel: 3, waterproof: false, windproof: false, insulated: false, seasons: ["winter", "spring", "autumn"], formality: "smart_casual" },
    { name: "Striped cotton t-shirt", category: "top", subcategory: "t-shirt", colors: ["navy", "white"], materials: ["cotton"], warmthLevel: 1, waterproof: false, windproof: false, insulated: false, seasons: ["summer"], formality: "casual" },
    { name: "Olive linen shirt", category: "top", subcategory: "shirt", colors: ["olive"], materials: ["linen"], warmthLevel: 1, waterproof: false, windproof: false, insulated: false, seasons: ["summer"], formality: "smart_casual" },
  ],
  bottom: [
    { name: "Dark blue slim jeans", category: "bottom", subcategory: "jeans", colors: ["dark blue"], materials: ["denim", "elastane"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, seasons: ["winter", "spring", "autumn"], formality: "casual" },
    { name: "Stone cotton chinos", category: "bottom", subcategory: "chinos", colors: ["stone"], materials: ["cotton"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, seasons: ["spring", "summer", "autumn"], formality: "smart_casual" },
  ],
  dress: [
    { name: "Black wool shift dress", category: "dress", subcategory: "shift dress", colors: ["black"], materials: ["wool"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, seasons: ["winter", "autumn"], formality: "business" },
  ],
  shoes: [
    { name: "Brown leather chelsea boots", category: "shoes", subcategory: "chelsea boots", colors: ["brown"], materials: ["leather", "rubber"], warmthLevel: 3, waterproof: false, windproof: true, insulated: false, seasons: ["winter", "spring", "autumn"], formality: "smart_casual" },
    { name: "White canvas sneakers", category: "shoes", subcategory: "sneakers", colors: ["white"], materials: ["canvas", "rubber"], warmthLevel: 1, waterproof: false, windproof: false, insulated: false, seasons: ["spring", "summer"], formality: "casual" },
  ],
  gloves: [
    { name: "Black leather gloves", category: "gloves", subcategory: "gloves", colors: ["black"], materials: ["leather", "wool"], warmthLevel: 3, waterproof: false, windproof: true, insulated: true, seasons: ["winter"], formality: "smart_casual" },
  ],
  hat_beanie: [
    { name: "Charcoal ribbed wool beanie", category: "hat_beanie", subcategory: "beanie", colors: ["charcoal"], materials: ["wool"], warmthLevel: 3, waterproof: false, windproof: false, insulated: false, seasons: ["winter", "autumn"], formality: "casual" },
  ],
  scarf: [
    { name: "Camel cashmere scarf", category: "scarf", subcategory: "scarf", colors: ["camel"], materials: ["cashmere"], warmthLevel: 3, waterproof: false, windproof: false, insulated: false, seasons: ["winter", "autumn"], formality: "smart_casual" },
  ],
  base_layer: [
    { name: "Black merino long-sleeve base layer", category: "base_layer", subcategory: "thermal top", colors: ["black"], materials: ["merino"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, seasons: ["winter", "autumn"], formality: "athletic" },
    { name: "Grey wool socks", category: "base_layer", subcategory: "socks", colors: ["grey"], materials: ["wool", "nylon"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, seasons: ["winter", "autumn"], formality: "casual" },
  ],
  accessory: [
    { name: "Brown leather belt", category: "accessory", subcategory: "belt", colors: ["brown"], materials: ["leather"], warmthLevel: 1, waterproof: false, windproof: false, insulated: false, seasons: ["winter", "spring", "summer", "autumn"], formality: "smart_casual" },
  ],
  bag: [
    { name: "Black nylon backpack", category: "bag", subcategory: "backpack", colors: ["black"], materials: ["nylon"], warmthLevel: 1, waterproof: false, windproof: false, insulated: false, seasons: ["winter", "spring", "summer", "autumn"], formality: "casual" },
  ],
  other: [
    { name: "Navy swim shorts", category: "other", subcategory: "swimwear", colors: ["navy"], materials: ["polyester"], warmthLevel: 1, waterproof: false, windproof: false, insulated: false, seasons: ["summer"], formality: "casual" },
  ],
};

/** How a 300-item wardrobe splits by category; other sizes scale it. */
const TYPICAL_SHARES: ReadonlyArray<readonly [ItemCategory, number]> = [
  ["outerwear", 20],
  ["top", 90],
  ["bottom", 45],
  ["dress", 10],
  ["shoes", 30],
  ["gloves", 5],
  ["hat_beanie", 8],
  ["scarf", 8],
  ["base_layer", 40],
  ["accessory", 24],
  ["bag", 12],
  ["other", 8],
];

/**
 * A deterministic, realistic wardrobe of `count` confirmed items (default
 * 300): category shares of a typical wardrobe, names of 15 to 35 characters,
 * one or two colours and materials, and a low-confidence tag on every fourth
 * item. The estimate test prices it; e2e seeds can insert it.
 */
export function makeTypicalWardrobe(count = 300): SnapshotItemInput[] {
  const plan = TYPICAL_SHARES.flatMap(([category, share]) =>
    Array.from({ length: share }, (_, n) => TEMPLATES[category][n % TEMPLATES[category].length]),
  ).filter((template): template is Template => template !== undefined);
  return Array.from({ length: count }, (_, index) =>
    makeSnapshotItem({
      ...plan[index % plan.length],
      breathable: null,
      condition: index % 7 === 6 ? "worn" : "good",
      aiConfidence:
        index % 4 === 3
          ? { category: 0.9, materials: 0.45, warmth_level: 0.8 }
          : { category: 0.95, materials: 0.8, warmth_level: 0.85 },
    }),
  );
}

/** bring, bring, leave, donate, sell, repeating: every column of the result view gets items. */
export function cycleDecision(index: number): RelocationDecision {
  const cycle: RelocationDecision[] = ["bring", "bring", "leave", "donate", "sell"];
  return cycle[index % cycle.length] ?? "bring";
}

export type FakeChunkReplyOptions = {
  /** Decision per alias; default cycleDecision(index). */
  decide?: (alias: string, index: number) => RelocationDecision;
  /** Aliases left out of the reply, to exercise the repair call. */
  omit?: readonly string[];
  /** Entries appended as they are (unknown or duplicate aliases). */
  extra?: ChunkWire["decisions"];
};

/** A chunk (or repair) reply deciding every alias once. */
export function fakeChunkReply(aliases: readonly string[], options: FakeChunkReplyOptions = {}): ChunkWire {
  const omit = new Set(options.omit ?? []);
  const decide = options.decide ?? ((_alias: string, index: number) => cycleDecision(index));
  const decisions: ChunkWire["decisions"] = aliases.flatMap((alias, index) =>
    omit.has(alias)
      ? []
      : [
          {
            item: alias,
            decision: decide(alias, index),
            priority: ((index % 3) + 1) as 1 | 2 | 3,
            reason: `Test reason for ${alias}: fits 16-18 rain days a month.`,
          },
        ],
  );
  return { decisions: [...decisions, ...(options.extra ?? [])] };
}

/**
 * A synthesis reply that passes makeSynthesisStrictSchema(aliases): three
 * layering systems, two gaps, every alias packed once across the four groups,
 * and one warning. Overrides replace whole top-level fields.
 */
export function fakeSynthesisReply(aliases: readonly string[], overrides: Partial<SynthesisWire> = {}): SynthesisWire {
  const first = aliases.slice(0, 3);
  const groups = PACKING_GROUPS.map((group) => ({ group, item_aliases: [] as string[], extras: [] as string[] }));
  aliases.forEach((alias, index) => groups[index % groups.length]?.item_aliases.push(alias));
  groups[0]?.extras.push("Travel umbrella");
  return {
    summary:
      "Hamburg is cool, wet and windy: 15-18 rain days every month, 2-3 °C winter means and about 7.5 h of December daylight. " +
      "Bring the layering pieces, add a breathable waterproof shell and waterproof boots, and leave the summer-only clothes.",
    layering_systems: [
      {
        title: "Cold drizzle and wind",
        conditions: "About 3 °C, drizzle, 30 km/h wind",
        item_aliases: first,
        gap_note: "Needs a breathable waterproof shell with a hood.",
      },
      { title: "Showery April", conditions: "About 12 °C with showers", item_aliases: first.slice(0, 2), gap_note: null },
      { title: "July with rain risk", conditions: "About 21 °C, chance of rain", item_aliases: first.slice(0, 1), gap_note: null },
    ],
    gaps: [
      {
        item_type: "Waterproof breathable shell jacket",
        category: "outerwear",
        why_needed: "16-18 rain days a month from October to January; daily cycling.",
        specs: ["Hood and taped seams", "At least 10,000 mm water column"],
        priority: 1,
        quantity: 1,
        est_price_min_eur: 120,
        est_price_max_eur: 200,
        buy_timing: "before_move",
      },
      {
        item_type: "Insulated waterproof boots",
        category: "shoes",
        why_needed: "About 62 frost days a year and frequent rain.",
        specs: ["Grippy sole", "Insulated lining"],
        priority: 2,
        quantity: 1,
        est_price_min_eur: 90,
        est_price_max_eur: 160,
        buy_timing: "after_move",
      },
    ],
    packing_checklist: groups,
    warnings: [{ kind: "duplicate", item_aliases: first.slice(0, 2), message: "Two items do the same job." }],
    ...overrides,
  };
}

/**
 * A stored result that passes makeRelocationAnalysisSchema(itemIds): every id
 * decided once (cycleDecision), the fake synthesis mapped to ids, gap keys
 * from makeGapKey and run metadata. Overrides replace whole top-level fields.
 */
export function makeRelocationResult(
  itemIds: readonly string[],
  overrides: Partial<RelocationAnalysis> = {},
): RelocationAnalysis {
  const aliases = itemIds.map((_, index) => `i${index + 1}`);
  const idOf = (alias: string): string => {
    const id = itemIds[Number(alias.slice(1)) - 1];
    if (id === undefined) throw new Error(`makeRelocationResult: no item for ${alias}`);
    return id;
  };
  const synthesis = fakeSynthesisReply(aliases);
  const decisions = fakeChunkReply(aliases).decisions;
  return {
    summary: synthesis.summary,
    items: decisions.map((entry) => ({
      item_id: idOf(entry.item),
      decision: entry.decision,
      priority: entry.priority,
      reason: entry.reason,
    })),
    layering_systems: synthesis.layering_systems.map((system) => ({
      title: system.title,
      conditions: system.conditions,
      item_ids: system.item_aliases.map(idOf),
      gap_note: system.gap_note,
    })),
    gaps: synthesis.gaps.map((gap, index) => ({
      gap_key: makeGapKey(index, gap),
      item_type: gap.item_type,
      category: gap.category,
      why_needed: gap.why_needed,
      specs: gap.specs,
      priority: gap.priority,
      quantity: gap.quantity,
      est_price_range_eur: { min: gap.est_price_min_eur, max: gap.est_price_max_eur },
      buy_before_or_after_move: gap.buy_timing,
    })),
    packing_checklist: synthesis.packing_checklist.map((group) => ({
      group: group.group,
      item_ids: group.item_aliases.map(idOf),
      extras: group.extras,
    })),
    warnings: synthesis.warnings.map((warning) => ({
      kind: warning.kind,
      item_ids: warning.item_aliases.map(idOf),
      message: warning.message,
      source: "ai" as const,
    })),
    meta: {
      prompt_version: RELOC_PROMPT_VERSION,
      model: "claude-sonnet-5-5",
      effort: "medium",
      item_count: itemIds.length,
      chunk_count: Math.max(1, Math.ceil(itemIds.length / 70)),
      months: [11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      climate_profile: null,
      purchase_budget_eur: 600,
      estimated_cost_usd: 0.42,
      repair_calls: 0,
    },
    ...overrides,
  };
}
