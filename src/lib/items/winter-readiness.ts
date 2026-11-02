// The "winter-ready" checklist on /stats (spec section 3, Phase 4): does the
// wardrobe hold what a Hamburg winter needs? Pure and client-safe, so the
// stats service, the page and the tests share one set of rules.
//
// Only items that are tagged or confirmed count: pending items have no tags
// to judge, and archived items are gone. Items the owner has decided to leave
// behind, donate or sell will not be in Hamburg, so they are never evidence.

import type { ItemCategory, ItemDecision, ItemStatus } from "@/lib/db/enums";
import { itemDisplayName } from "@/lib/items/wardrobe";

/** The per-item fields the rules read. */
export type WinterReadinessItem = {
  id: string;
  name: string | null;
  subcategory: string | null;
  category: ItemCategory | null;
  status: ItemStatus;
  decision: ItemDecision;
  materials: readonly string[];
  materialGuess: string | null;
  warmthLevel: number | null;
  waterproof: boolean | null;
  windproof: boolean | null;
  insulated: boolean | null;
};

export const WINTER_READINESS_KEYS = [
  "waterproof_shell",
  "insulated_waterproof_footwear",
  "windproof_gloves",
  "warm_beanie",
  "scarf",
  "base_layers",
] as const;
export type WinterReadinessKey = (typeof WINTER_READINESS_KEYS)[number];

export type WinterReadinessEvidence = { id: string; name: string };

export type WinterReadinessRow = {
  key: WinterReadinessKey;
  label: string;
  satisfied: boolean;
  /** Items that meet the rule, in input order; each links to /wardrobe/[id]. */
  evidenceIds: string[];
  /** The same items with the name a link shows (itemDisplayName). */
  evidence: WinterReadinessEvidence[];
  /** What is still missing, in a short sentence; "" once the rule is met. */
  need: string;
};

/** Decisions that take an item out of the Hamburg wardrobe. */
export const READINESS_EXCLUDED_DECISIONS: readonly ItemDecision[] = ["leave", "donate", "sell"];

/** Statuses whose tags the rules can trust. */
export const READINESS_STATUSES: readonly ItemStatus[] = ["tagged", "confirmed"];

/** Categories any rule looks at, so the service can fetch only these rows. */
export const READINESS_CATEGORIES: readonly ItemCategory[] = [
  "outerwear",
  "shoes",
  "gloves",
  "hat_beanie",
  "scarf",
  "base_layer",
];

/** A beanie at this warmth level or above counts as warm (rubric 3: mid layer). */
export const WARM_BEANIE_MIN_WARMTH = 3;

/** Base layers are worn in rotation, so one is not enough. */
export const BASE_LAYERS_NEEDED = 2;

// Merino, wool and thermal fabrics, wherever the tags mention them: the
// materials list, Claude's material guess, the subcategory ("thermal top") or
// the name. Substring match, so "merino wool", "lambswool" and "thermals" count.
const WARM_BASE_FABRIC = /merino|wool|thermal/i;

function hasWarmBaseFabric(item: WinterReadinessItem): boolean {
  const texts = [...item.materials, item.materialGuess, item.subcategory, item.name];
  return texts.some((text) => text !== null && WARM_BASE_FABRIC.test(text));
}

type Rule = {
  key: WinterReadinessKey;
  label: string;
  matches: (item: WinterReadinessItem) => boolean;
  /** How many matching items the rule needs. */
  needed: number;
  /** The need text when nothing matches. */
  need: string;
  /** The need text when some, but too few, match. */
  needMore?: (have: number) => string;
};

const RULES: readonly Rule[] = [
  {
    key: "waterproof_shell",
    label: "Waterproof shell",
    matches: (item) => item.category === "outerwear" && item.waterproof === true,
    needed: 1,
    need: "A waterproof jacket or coat for the frequent drizzle.",
  },
  {
    key: "insulated_waterproof_footwear",
    label: "Insulated waterproof footwear",
    matches: (item) => item.category === "shoes" && item.insulated === true && item.waterproof === true,
    needed: 1,
    need: "Shoes or boots that are both insulated and waterproof.",
  },
  {
    key: "windproof_gloves",
    label: "Windproof gloves",
    matches: (item) => item.category === "gloves" && item.windproof === true,
    needed: 1,
    need: "A pair of windproof gloves.",
  },
  {
    key: "warm_beanie",
    label: "Warm beanie",
    matches: (item) =>
      item.category === "hat_beanie" && item.warmthLevel !== null && item.warmthLevel >= WARM_BEANIE_MIN_WARMTH,
    needed: 1,
    need: `A hat or beanie with warmth ${WARM_BEANIE_MIN_WARMTH} or more.`,
  },
  {
    key: "scarf",
    label: "Scarf",
    matches: (item) => item.category === "scarf",
    needed: 1,
    need: "A scarf.",
  },
  {
    key: "base_layers",
    label: "Merino or thermal base layers",
    matches: (item) => item.category === "base_layer" && hasWarmBaseFabric(item),
    needed: BASE_LAYERS_NEEDED,
    need: `At least ${BASE_LAYERS_NEEDED} base layers in merino, wool or a thermal fabric.`,
    needMore: (have) =>
      `${BASE_LAYERS_NEEDED - have} more base layer in merino, wool or a thermal fabric (${have} of ${BASE_LAYERS_NEEDED} so far).`,
  },
];

/** Whether an item may serve as evidence at all: tagged or confirmed, and going to Hamburg. */
export function countsForReadiness(item: Pick<WinterReadinessItem, "status" | "decision">): boolean {
  return READINESS_STATUSES.includes(item.status) && !READINESS_EXCLUDED_DECISIONS.includes(item.decision);
}

/** One row per rule, in checklist order, with the items that meet it. */
export function computeWinterReadiness(items: readonly WinterReadinessItem[]): WinterReadinessRow[] {
  const eligible = items.filter(countsForReadiness);
  return RULES.map((rule) => {
    const matching = eligible.filter(rule.matches);
    const satisfied = matching.length >= rule.needed;
    let need = "";
    if (!satisfied) need = matching.length > 0 && rule.needMore ? rule.needMore(matching.length) : rule.need;
    return {
      key: rule.key,
      label: rule.label,
      satisfied,
      evidenceIds: matching.map((item) => item.id),
      evidence: matching.map((item) => ({ id: item.id, name: itemDisplayName(item) })),
      need,
    };
  });
}
