// `pnpm db:seed:demo`: inserts 300 synthetic confirmed items for checking the
// wardrobe grid (virtualisation, filters, sorting) at a realistic size.
// `pnpm db:seed:demo --clean` removes them again. Local databases only: it
// refuses to run unless DATABASE_URL points at localhost or 127.0.0.1.
//
// Every demo item has notes = 'demo-seed' (the clean step deletes exactly
// those; their image rows cascade) and a thumb and processed image row that
// point at /icons/icon-192.png, a file the app serves itself, so no Blob store
// is involved. The data is generated from a fixed seed and each item's image
// hash is derived from its index, so running the seed twice adds nothing new.
//
// Runs under `tsx --conditions=react-server`, so `server-only` resolves to its
// empty export (D-017). The environment is loaded inside main(), so the tests
// can import the generator without reading any .env file.

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import type {
  Formality,
  ItemCategory,
  ItemCondition,
  ItemDecision,
  ItemLocation,
  Season,
} from "@/lib/db/enums";
import { nonLocalReason } from "@/lib/db/local-url";
import { itemImages, items, type NewItem, type NewItemImage } from "@/lib/db/schema";

export const DEMO_MARKER = "demo-seed";
export const DEMO_ITEM_COUNT = 300;
/** Same-origin placeholder photo; 192 x 192 PNG. */
export const DEMO_PHOTO = { url: "/icons/icon-192.png", width: 192, height: 192, bytes: 4_000 } as const;
// ---------------------------------------------------------------------------
// Safety check
// ---------------------------------------------------------------------------

// The check lives in src/lib/db/local-url.ts so drizzle.config.ts can share it.
export { nonLocalReason };

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/** mulberry32: a small seeded generator, so every run produces the same wardrobe. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Random = () => number;

function pick<T>(random: Random, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error("pick: empty list");
  return value;
}

/** Picks by weight; weights need not add up to 1. */
function weighted<T>(random: Random, entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  const last = entries.at(-1);
  if (last === undefined) throw new Error("weighted: empty list");
  return last[0];
}

function chance(random: Random, probability: number): boolean {
  return random() < probability;
}

const COLORS = [
  { name: "black", hex: "#111111" },
  { name: "navy", hex: "#1f2a44" },
  { name: "grey", hex: "#8a8d91" },
  { name: "charcoal", hex: "#36454f" },
  { name: "white", hex: "#f4f4f2" },
  { name: "cream", hex: "#f3ead8" },
  { name: "beige", hex: "#d8c3a5" },
  { name: "camel", hex: "#c19a6b" },
  { name: "brown", hex: "#6b4a2f" },
  { name: "olive", hex: "#556b2f" },
  { name: "green", hex: "#2e7d4f" },
  { name: "blue", hex: "#2f5d9e" },
  { name: "burgundy", hex: "#6d1a2b" },
  { name: "red", hex: "#b3261e" },
  { name: "pink", hex: "#e8a0b4" },
  { name: "yellow", hex: "#e3b505" },
] as const;

const BRANDS = ["Northfold", "Ardesia", "Linea Uno", "Fjellby", "Corte Nove", "Brume", "Haldor", "Sentiero"] as const;

type Kind = {
  subcategory: string;
  noun: string;
  materials: readonly string[];
  warmth: readonly [number, number];
  seasons: readonly Season[];
  formality: readonly Formality[];
  /** Probabilities of the three flags. */
  waterproof: number;
  windproof: number;
  insulated: number;
};

const CATALOGUE: Record<ItemCategory, readonly Kind[]> = {
  outerwear: [
    { subcategory: "parka", noun: "down parka", materials: ["nylon", "down"], warmth: [5, 5], seasons: ["winter"], formality: ["casual"], waterproof: 0.6, windproof: 0.9, insulated: 1 },
    { subcategory: "rain jacket", noun: "rain shell", materials: ["polyester"], warmth: [1, 2], seasons: ["spring", "autumn"], formality: ["casual", "athletic"], waterproof: 0.95, windproof: 0.9, insulated: 0 },
    { subcategory: "coat", noun: "wool coat", materials: ["wool", "cashmere"], warmth: [4, 4], seasons: ["winter", "autumn"], formality: ["smart_casual", "business"], waterproof: 0.05, windproof: 0.7, insulated: 0.6 },
    { subcategory: "trench", noun: "trench coat", materials: ["cotton"], warmth: [2, 3], seasons: ["spring", "autumn"], formality: ["smart_casual"], waterproof: 0.3, windproof: 0.6, insulated: 0 },
  ],
  top: [
    { subcategory: "t-shirt", noun: "cotton tee", materials: ["cotton"], warmth: [1, 1], seasons: ["summer", "spring"], formality: ["casual"], waterproof: 0, windproof: 0, insulated: 0 },
    { subcategory: "sweater", noun: "merino sweater", materials: ["merino wool"], warmth: [3, 3], seasons: ["winter", "autumn"], formality: ["casual", "smart_casual"], waterproof: 0, windproof: 0.1, insulated: 0 },
    { subcategory: "shirt", noun: "oxford shirt", materials: ["cotton"], warmth: [2, 2], seasons: ["spring", "autumn", "summer"], formality: ["smart_casual", "business"], waterproof: 0, windproof: 0, insulated: 0 },
    { subcategory: "hoodie", noun: "hoodie", materials: ["cotton", "polyester"], warmth: [3, 3], seasons: ["autumn", "spring"], formality: ["casual", "athletic"], waterproof: 0, windproof: 0.1, insulated: 0.2 },
  ],
  bottom: [
    { subcategory: "jeans", noun: "denim jeans", materials: ["cotton denim"], warmth: [2, 2], seasons: ["autumn", "winter", "spring"], formality: ["casual"], waterproof: 0, windproof: 0.3, insulated: 0 },
    { subcategory: "chinos", noun: "chinos", materials: ["cotton"], warmth: [2, 2], seasons: ["spring", "summer", "autumn"], formality: ["smart_casual"], waterproof: 0, windproof: 0.1, insulated: 0 },
    { subcategory: "shorts", noun: "linen shorts", materials: ["linen"], warmth: [1, 1], seasons: ["summer"], formality: ["casual"], waterproof: 0, windproof: 0, insulated: 0 },
    { subcategory: "trousers", noun: "wool trousers", materials: ["wool"], warmth: [3, 3], seasons: ["winter", "autumn"], formality: ["business", "formal"], waterproof: 0, windproof: 0.3, insulated: 0 },
  ],
  dress: [
    { subcategory: "summer dress", noun: "summer dress", materials: ["viscose"], warmth: [1, 1], seasons: ["summer"], formality: ["casual", "smart_casual"], waterproof: 0, windproof: 0, insulated: 0 },
    { subcategory: "knit dress", noun: "knit dress", materials: ["wool"], warmth: [3, 3], seasons: ["winter", "autumn"], formality: ["smart_casual"], waterproof: 0, windproof: 0, insulated: 0 },
  ],
  shoes: [
    { subcategory: "boots", noun: "winter boots", materials: ["leather", "rubber"], warmth: [4, 5], seasons: ["winter"], formality: ["casual"], waterproof: 0.8, windproof: 0.9, insulated: 0.8 },
    { subcategory: "sneakers", noun: "sneakers", materials: ["canvas", "rubber"], warmth: [1, 2], seasons: ["spring", "summer", "autumn"], formality: ["casual", "athletic"], waterproof: 0.1, windproof: 0.2, insulated: 0 },
    { subcategory: "loafers", noun: "loafers", materials: ["leather"], warmth: [2, 2], seasons: ["spring", "autumn"], formality: ["smart_casual", "business"], waterproof: 0, windproof: 0.3, insulated: 0 },
  ],
  gloves: [
    { subcategory: "gloves", noun: "leather gloves", materials: ["leather", "wool"], warmth: [3, 4], seasons: ["winter"], formality: ["smart_casual"], waterproof: 0.2, windproof: 0.9, insulated: 0.6 },
    { subcategory: "mittens", noun: "knit mittens", materials: ["wool"], warmth: [4, 4], seasons: ["winter"], formality: ["casual"], waterproof: 0, windproof: 0.2, insulated: 0.5 },
  ],
  hat_beanie: [
    { subcategory: "beanie", noun: "wool beanie", materials: ["wool"], warmth: [3, 4], seasons: ["winter", "autumn"], formality: ["casual"], waterproof: 0, windproof: 0.4, insulated: 0.3 },
    { subcategory: "cap", noun: "baseball cap", materials: ["cotton"], warmth: [1, 1], seasons: ["summer", "spring"], formality: ["casual", "athletic"], waterproof: 0, windproof: 0, insulated: 0 },
  ],
  scarf: [
    { subcategory: "scarf", noun: "wool scarf", materials: ["wool"], warmth: [3, 4], seasons: ["winter", "autumn"], formality: ["casual", "smart_casual"], waterproof: 0, windproof: 0.5, insulated: 0 },
    { subcategory: "silk scarf", noun: "silk scarf", materials: ["silk"], warmth: [1, 2], seasons: ["spring", "summer"], formality: ["smart_casual", "formal"], waterproof: 0, windproof: 0, insulated: 0 },
  ],
  base_layer: [
    { subcategory: "thermal top", noun: "merino base layer", materials: ["merino wool"], warmth: [3, 3], seasons: ["winter"], formality: ["athletic"], waterproof: 0, windproof: 0, insulated: 0.2 },
    { subcategory: "leggings", noun: "thermal leggings", materials: ["polyester", "elastane"], warmth: [2, 3], seasons: ["winter", "autumn"], formality: ["athletic"], waterproof: 0, windproof: 0, insulated: 0.2 },
  ],
  accessory: [
    { subcategory: "belt", noun: "leather belt", materials: ["leather"], warmth: [1, 1], seasons: ["winter", "spring", "summer", "autumn"], formality: ["smart_casual", "business"], waterproof: 0, windproof: 0, insulated: 0 },
    { subcategory: "umbrella", noun: "umbrella", materials: ["polyester"], warmth: [1, 1], seasons: ["spring", "autumn", "winter"], formality: ["casual"], waterproof: 1, windproof: 0.3, insulated: 0 },
  ],
  bag: [
    { subcategory: "backpack", noun: "backpack", materials: ["nylon"], warmth: [1, 1], seasons: ["winter", "spring", "summer", "autumn"], formality: ["casual"], waterproof: 0.5, windproof: 0, insulated: 0 },
    { subcategory: "tote", noun: "canvas tote", materials: ["canvas"], warmth: [1, 1], seasons: ["spring", "summer"], formality: ["casual"], waterproof: 0, windproof: 0, insulated: 0 },
  ],
  other: [{ subcategory: "swimwear", noun: "swim shorts", materials: ["polyester"], warmth: [1, 1], seasons: ["summer"], formality: ["athletic"], waterproof: 0, windproof: 0, insulated: 0 }],
};

/** Roughly how a real wardrobe splits across categories. */
const CATEGORY_WEIGHTS: readonly (readonly [ItemCategory, number])[] = [
  ["top", 22],
  ["bottom", 14],
  ["outerwear", 12],
  ["shoes", 12],
  ["base_layer", 6],
  ["dress", 5],
  ["gloves", 5],
  ["hat_beanie", 5],
  ["scarf", 6],
  ["accessory", 6],
  ["bag", 5],
  ["other", 2],
];
const CONDITION_WEIGHTS: readonly (readonly [ItemCondition, number])[] = [
  ["new", 10],
  ["good", 60],
  ["worn", 24],
  ["needs_repair", 6],
];
const DECISION_WEIGHTS: readonly (readonly [ItemDecision, number])[] = [
  ["undecided", 55],
  ["bring", 20],
  ["leave", 10],
  ["donate", 10],
  ["sell", 5],
];
const LOCATION_WEIGHTS: readonly (readonly [ItemLocation, number])[] = [
  ["bologna", 70],
  ["hamburg", 18],
  ["in_transit", 8],
  ["unknown", 4],
];

const DAY_MS = 86_400_000;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The deterministic image hash of demo item `index` (sha256 hex, like a real one). */
export function demoImageHash(index: number): string {
  return createHash("sha256").update(`${DEMO_MARKER}:${index}`).digest("hex");
}

/** `count` confirmed demo items, the newest first, generated from a fixed seed. */
export function buildDemoItems(count: number, now: Date): NewItem[] {
  const random = seededRandom(20_261_102);
  return Array.from({ length: count }, (_, index) => {
    const category = weighted(random, CATEGORY_WEIGHTS);
    const kind = pick(random, CATALOGUE[category]);
    const colors = [pick(random, COLORS)];
    if (chance(random, 0.35)) {
      const second = pick(random, COLORS);
      if (second.name !== colors[0]?.name) colors.push(second);
    }
    const [low, high] = kind.warmth;
    const warmthLevel = low + Math.floor(random() * (high - low + 1));
    const wearCount = chance(random, 0.3) ? 0 : Math.floor(random() ** 2 * 60);
    // Spread over roughly the last year, newest first, never two at the same instant.
    const createdAt = new Date(now.getTime() - index * 1.2 * DAY_MS - Math.floor(random() * 3_600_000));
    const lastWornAt = wearCount === 0 ? null : new Date(now.getTime() - Math.floor(random() * 60) * DAY_MS);
    const brand = chance(random, 0.7) ? pick(random, BRANDS) : null;
    const name = `${capitalize(colors[0]?.name ?? "plain")} ${kind.noun}`;
    return {
      status: "confirmed",
      createdAt,
      location: weighted(random, LOCATION_WEIGHTS),
      decision: weighted(random, DECISION_WEIGHTS),
      name,
      category,
      subcategory: kind.subcategory,
      colors: colors.map((color) => color.name),
      colorHex: colors.map((color) => color.hex),
      materialGuess: kind.materials[0] ?? null,
      materials: [...kind.materials],
      warmthLevel,
      waterproof: chance(random, kind.waterproof),
      windproof: chance(random, kind.windproof),
      insulated: chance(random, kind.insulated),
      breathable: null,
      seasons: [...kind.seasons],
      formality: pick(random, kind.formality),
      condition: weighted(random, CONDITION_WEIGHTS),
      brand,
      description: `${name}${brand === null ? "" : ` by ${brand}`}.`,
      notes: DEMO_MARKER,
      imageHash: demoImageHash(index),
      wearCount,
      lastWornAt,
    } satisfies NewItem;
  });
}

function demoImages(itemId: string): NewItemImage[] {
  return (["thumb", "processed"] as const).map((kind) => ({
    itemId,
    kind,
    blobUrl: DEMO_PHOTO.url,
    blobPathname: `${DEMO_MARKER}/${itemId}/${kind}`,
    contentType: "image/png",
    width: DEMO_PHOTO.width,
    height: DEMO_PHOTO.height,
    bytes: DEMO_PHOTO.bytes,
  }));
}

// ---------------------------------------------------------------------------
// Database steps
// ---------------------------------------------------------------------------

/** Inserts the demo items that are not there yet, with their image rows. */
export async function insertDemoItems(
  db: Db,
  count: number = DEMO_ITEM_COUNT,
  now: Date = new Date(),
): Promise<{ inserted: number; skipped: number }> {
  const rows = buildDemoItems(count, now);
  return db.transaction(async (tx) => {
    const created = await tx
      .insert(items)
      .values(rows)
      .onConflictDoNothing({ target: items.imageHash })
      .returning({ id: items.id });
    if (created.length > 0) await tx.insert(itemImages).values(created.flatMap((row) => demoImages(row.id)));
    return { inserted: created.length, skipped: rows.length - created.length };
  });
}

/** Deletes every demo item; their image rows go with them (ON DELETE CASCADE). */
export async function removeDemoItems(db: Db): Promise<number> {
  const removed = await db.delete(items).where(eq(items.notes, DEMO_MARKER)).returning({ id: items.id });
  return removed.length;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await import("./load-env");
  // Imported after load-env so the environment is complete before any module
  // that reads it is evaluated.
  const [{ dbEnv }, { createDb }] = await Promise.all([import("@/env"), import("@/lib/db/client")]);
  const databaseUrl = dbEnv().DATABASE_URL;
  const reason = nonLocalReason(databaseUrl);
  if (reason !== null) {
    console.error(`Refusing to run: ${reason} The demo seed writes 300 fake items and is for local databases only.`);
    process.exitCode = 1;
    return;
  }

  const clean = process.argv.slice(2).includes("--clean");
  const { db, pool } = createDb(databaseUrl);
  try {
    if (clean) {
      const removed = await removeDemoItems(db);
      console.log(`Removed ${removed} demo ${removed === 1 ? "item" : "items"}.`);
    } else {
      const { inserted, skipped } = await insertDemoItems(db);
      console.log(`Inserted ${inserted} demo items (${skipped} already there).`);
      console.log("Remove them with `pnpm db:seed:demo --clean`.");
    }
  } finally {
    await pool.end();
  }
}

/** True when this file is the script being run, not a module imported by a test. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = path.resolve(fileURLToPath(import.meta.url));
  const target = path.resolve(entry);
  return process.platform === "win32" ? self.toLowerCase() === target.toLowerCase() : self === target;
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    // Messages from env.ts name variables, never values, and pg errors carry
    // no password, so the message is safe to print.
    console.error(`Demo seed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
