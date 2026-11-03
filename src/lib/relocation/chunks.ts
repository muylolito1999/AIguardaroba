// Splitting a snapshot into chunk calls, and the run's cache key (D-025,
// D-028). Pure; the cache key hashes with node:crypto through payload.ts, so
// this module is for server code and tests, not client components.

import { MAX_ITEMS_PER_CHUNK, normalizeConstraints, type RelocationEffort } from "@/lib/relocation/contracts";
import { canonicalJson, sha256Hex, type SnapshotLine } from "@/lib/relocation/payload";

export type RelocationChunk = {
  /** 0-based; the chunk part's partIndex. */
  index: number;
  /** Every alias exactly once across the chunks. */
  aliases: string[];
  /** The categories in the chunk, in snapshot order ("unknown" for an item without one). */
  categories: string[];
};

type ChunkLine = Pick<SnapshotLine, "alias" | "category" | "subcategory">;

const UNKNOWN_CATEGORY = "unknown";

/** Groups by key in order of first appearance, each group keeping its input order. */
function groupBy<T>(values: readonly T[], key: (value: T) => string): Array<{ key: string; values: T[] }> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const k = key(value);
    const group = groups.get(k);
    if (group) group.push(value);
    else groups.set(k, [value]);
  }
  return [...groups].map(([k, grouped]) => ({ key: k, values: grouped }));
}

/** Cuts a list into consecutive slices of at most `max`. */
function slices<T>(values: readonly T[], max: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += max) result.push(values.slice(start, start + max));
  return result;
}

/**
 * Plans the chunk calls: whole categories packed greedily in snapshot order,
 * at most `maxPerChunk` items each. A category larger than that is split
 * along its subcategories (each kept together where it fits, so similar items
 * are judged side by side), then by order. Deterministic; [] for no lines.
 */
export function planChunks(
  lines: readonly ChunkLine[],
  options: { maxPerChunk?: number } = {},
): RelocationChunk[] {
  const max = options.maxPerChunk ?? MAX_ITEMS_PER_CHUNK;
  if (!Number.isInteger(max) || max < 1) throw new RangeError("maxPerChunk must be a positive integer.");

  // Packing units: a whole category when it fits a chunk; otherwise each of
  // its subcategories (cut by order when even one subcategory is too large).
  const units: ChunkLine[][] = [];
  for (const category of groupBy(lines, (line) => line.category ?? UNKNOWN_CATEGORY)) {
    if (category.values.length <= max) {
      units.push(category.values);
      continue;
    }
    for (const subcategory of groupBy(category.values, (line) => (line.subcategory ?? "").trim().toLowerCase())) {
      units.push(...slices(subcategory.values, max));
    }
  }

  const chunks: ChunkLine[][] = [];
  let current: ChunkLine[] = [];
  for (const unit of units) {
    if (current.length + unit.length > max && current.length > 0) {
      chunks.push(current);
      current = [];
    }
    current.push(...unit);
  }
  if (current.length > 0) chunks.push(current);

  return chunks.map((chunk, index) => ({
    index,
    aliases: chunk.map((line) => line.alias),
    categories: [...new Set(chunk.map((line) => line.category ?? UNKNOWN_CATEGORY))],
  }));
}

export type RelocationCacheKeyInput = {
  promptVersion: string;
  model: string;
  effort: RelocationEffort;
  snapshotHash: string;
  climateText: string;
  /** Months in range order, arrival first. */
  months: readonly number[];
  constraints: string;
  purchaseBudgetEur: number | null;
  includeOnlyConfirmed: boolean;
};

/**
 * sha256 of everything the prompt depends on (D-028). The exact dates are not
 * in it: the prompt sees only the months in order, so a later run over the
 * same months reuses the result. Constraints are whitespace-normalised, the
 * same way the prompt shows them.
 */
export function relocationCacheKey(input: RelocationCacheKeyInput): string {
  return sha256Hex(
    canonicalJson({
      promptVersion: input.promptVersion,
      model: input.model,
      effort: input.effort,
      snapshotHash: input.snapshotHash,
      climateText: input.climateText,
      months: [...input.months],
      constraints: normalizeConstraints(input.constraints),
      purchaseBudgetEur: input.purchaseBudgetEur,
      includeOnlyConfirmed: input.includeOnlyConfirmed,
    }),
  );
}
