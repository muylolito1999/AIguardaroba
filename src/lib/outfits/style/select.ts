// The selection step of outfit suggestions (D-256): Claude proposes several
// candidate outfits, each following a style direction, and this pipeline
// turns them into the few the owner sees. Each candidate is checked against
// the outfit rules, its layers and feet are judged and repaired (a tee goes
// under a lone hoodie, socks into closed shoes), the repaired outfit is
// checked again, repeats of an earlier outfit's core pieces go, and the
// survivors are scored and picked greedily for quality and variety. Too few
// usable candidates reject the reply, so the caller asks Claude again. Pure
// and client-safe: no I/O, no clock, no randomness; ties fall to the
// candidate index.

import { validateOutfit } from "@/lib/outfits/contracts";
import { assessLayering, wardrobeCounts } from "@/lib/outfits/style/layering";
import {
  coreItems,
  DIVERSITY_PENALTY,
  jaccard,
  repairOutfit,
  SAME_DIRECTION_PENALTY,
  scoreOutfit,
} from "@/lib/outfits/style/score";
import type {
  Candidate,
  DropReason,
  RepairKind,
  ScoreBreakdown,
  SelectedOutfit,
  SelectionContext,
  SelectionReport,
  SelectionResult,
  StyleEntry,
  StyleItem,
} from "@/lib/outfits/style/types";
import { isRainyDay, keepsDry } from "@/lib/outfits/style/weather";

// keepsDry moved to weather.ts, where the rain penalty reads it too; this
// import path keeps working.
export { keepsDry } from "@/lib/outfits/style/weather";

/** A candidate that passed every check, repaired and scored. */
type Survivor = {
  candidate: Candidate;
  /** Repaired, in slot order. */
  entries: StyleEntry[];
  repairs: RepairKind[];
  core: string[];
  score: ScoreBreakdown;
};

/** The order drop reasons are named in a detail when their counts tie: the pipeline's own order. */
const DROP_ORDER: readonly DropReason[] = ["malformed", "unknown_alias", "invalid_outfit", "layering", "duplicate"];

/** Adjusted scores closer than this are a tie (float noise), which the lower candidate index wins. */
const TIE_EPSILON = 1e-9;

/** The survivor's score in a round: its total, less the diversity and same-direction penalties against `picks`. */
function adjustedScore(survivor: Survivor, picks: readonly Survivor[]): number {
  let overlap = 0;
  for (const pick of picks) overlap = Math.max(overlap, jaccard(survivor.core, pick.core));
  const direction = survivor.candidate.direction;
  const sameDirection = direction !== null && picks.some((pick) => pick.candidate.direction === direction);
  return survivor.score.total - DIVERSITY_PENALTY * overlap - (sameDirection ? SAME_DIRECTION_PENALTY : 0);
}

/** The best of `pool` next to `picks`; `pool` is in candidate-index order, so the first of tied scores wins. */
function bestNext(pool: readonly Survivor[], picks: readonly Survivor[]): Survivor | null {
  let best: Survivor | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const survivor of pool) {
    const score = adjustedScore(survivor, picks);
    if (best === null || score > bestScore + TIE_EPSILON) {
      best = survivor;
      bestScore = score;
    }
  }
  return best;
}

/** Greedy: each round takes the best adjusted score against the picks so far. */
function pickGreedy(survivors: readonly Survivor[], count: number): Survivor[] {
  const picks: Survivor[] = [];
  while (picks.length < count) {
    const next = bestNext(
      survivors.filter((survivor) => !picks.includes(survivor)),
      picks,
    );
    if (next === null) break;
    picks.push(next);
  }
  return picks;
}

/**
 * On a rainy day at least one pick should keep the owner dry. When none does
 * and an unpicked survivor would, the lowest-ranked pick (the last) gives way
 * to the best dry one against the other picks (adjustedScore). The picks stay
 * distinct: the replacement comes only from survivors not already picked, and
 * no two survivors share their core pieces (the dedupe in selectSuggestions).
 * A dry outfit can still share pieces with a kept pick (the same coat over
 * other shoes), which adjustedScore weighs like any other overlap.
 */
function ensureDryPick(picks: Survivor[], survivors: readonly Survivor[], ctx: SelectionContext): Survivor[] {
  if (picks.length === 0 || !isRainyDay(ctx.weather)) return picks;
  if (picks.some((pick) => keepsDry(pick.entries, ctx.items))) return picks;
  const kept = picks.slice(0, -1);
  const unpicked = survivors.filter((survivor) => !picks.includes(survivor));
  const replacement = bestNext(
    unpicked.filter((survivor) => keepsDry(survivor.entries, ctx.items)),
    kept,
  );
  return replacement === null ? picks : [...kept, replacement];
}

/** "2 of 5 candidates usable: 2 layering, 1 invalid_outfit": counts high to low, ties in pipeline order. */
function describe(report: SelectionReport): string {
  const noun = report.received === 1 ? "candidate" : "candidates";
  const drops = DROP_ORDER.flatMap((reason) => {
    const count = report.dropped[reason] ?? 0;
    return count > 0 ? [{ reason, count }] : [];
  })
    .sort((a, b) => b.count - a.count || DROP_ORDER.indexOf(a.reason) - DROP_ORDER.indexOf(b.reason))
    .map(({ reason, count }) => `${count} ${reason}`);
  const head = `${report.usable} of ${report.received} ${noun} usable`;
  return drops.length === 0 ? head : `${head}: ${drops.join(", ")}`;
}

/**
 * What makes two outfits the same to the owner: their sorted core item ids
 * (coreItems, CORE_SLOTS). Other socks, a scarf or a thermal under the top do
 * not make another outfit. Two outfits with the same item set always share it,
 * since a top counts as core in either of its slots.
 */
function outfitKey(core: readonly string[]): string {
  return core.join("\n");
}

function toSelected(survivor: Survivor, items: ReadonlyMap<string, StyleItem>): SelectedOutfit {
  const { candidate } = survivor;
  return {
    candidateIndex: candidate.index,
    direction: candidate.direction,
    title: candidate.title,
    why: candidate.why,
    // Read from the repaired outfit with the prompt's own rule (keepsDry), not
    // taken from Claude's flag: never claimed wrongly, and the dry pick step 7
    // brings in (or a repair that added rain boots under a coat) shows as
    // rain-ready even when Claude said false.
    rain_ok: keepsDry(survivor.entries, items),
    entries: survivor.entries,
    repairs: survivor.repairs,
    score: survivor.score,
  };
}

/**
 * Turns Claude's candidates into ctx.count outfits, or rejects the reply.
 *
 * 1. Each candidate, in index order, must pass validateOutfit
 *    (ctx.checkItems); a failure is dropped as invalid_outfit.
 * 2. assessLayering judges its layers and feet against what the wardrobe
 *    (ctx.items) offers: a drop verdict is dropped as layering, otherwise
 *    repairOutfit applies the fixes, avoiding the companions (tee, socks,
 *    shoes) earlier survivors' repairs added, so the cards do not all show
 *    the same tee or socks while the wardrobe has another of the same tier.
 * 3. The repaired outfit must pass validateOutfit again (invalid_outfit).
 * 4. A repaired outfit with the same core pieces (coreItems: outerwear, mid
 *    layer, top, bottom, shoes) as an earlier one is dropped as duplicate,
 *    whatever its socks, base layer or extras; the lower index stays.
 * 5. Each survivor is scored (scoreOutfit).
 * 6. Picks are greedy: each round takes the highest total less
 *    DIVERSITY_PENALTY x the largest core-piece Jaccard similarity with a
 *    pick so far, less SAME_DIRECTION_PENALTY when a pick already follows its
 *    (non-null) direction; ties go to the lower candidate index.
 * 7. On a rainy day with no pick that keepsDry, the last pick gives way to
 *    the best dry survivor (ensureDryPick).
 *
 * Fewer survivors than ctx.count rejects the reply with a short English
 * detail naming the drop counts. The report counts every candidate received,
 * the survivors (usable), those among them that needed a repair, and the
 * drops by reason. Candidates are not changed.
 */
export function selectSuggestions(candidates: readonly Candidate[], ctx: SelectionContext): SelectionResult {
  const wardrobe = wardrobeCounts(ctx.items.values());
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (reason: DropReason) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };

  const ordered = [...candidates].sort((a, b) => a.index - b.index);
  const survivors: Survivor[] = [];
  const seen = new Set<string>();
  // The companions earlier survivors' repairs added, which later repairs avoid.
  const companions = new Set<string>();
  for (const candidate of ordered) {
    if (!validateOutfit(candidate.entries, ctx.checkItems).ok) {
      drop("invalid_outfit");
      continue;
    }
    const verdict = assessLayering(candidate.entries, ctx.items, wardrobe);
    if (verdict.drop) {
      drop("layering");
      continue;
    }
    const { entries, repairs } = repairOutfit(candidate.entries, verdict, ctx, companions);
    if (!validateOutfit(entries, ctx.checkItems).ok) {
      drop("invalid_outfit");
      continue;
    }
    const core = coreItems(entries);
    const key = outfitKey(core);
    if (seen.has(key)) {
      drop("duplicate");
      continue;
    }
    seen.add(key);
    const own = new Set(candidate.entries.map((entry) => entry.itemId));
    for (const entry of entries) {
      if (!own.has(entry.itemId)) companions.add(entry.itemId);
    }
    survivors.push({ candidate, entries, repairs, core, score: scoreOutfit(entries, ctx) });
  }

  const report: SelectionReport = {
    received: candidates.length,
    usable: survivors.length,
    repaired: survivors.filter((survivor) => survivor.repairs.length > 0).length,
    dropped,
  };
  if (survivors.length < ctx.count) return { ok: false, report, detail: describe(report) };

  const picks = ensureDryPick(pickGreedy(survivors, ctx.count), survivors, ctx);
  return { ok: true, outfits: picks.map((pick) => toSelected(pick, ctx.items)), report };
}
