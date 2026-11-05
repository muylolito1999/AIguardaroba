import { readdirSync } from "node:fs";

import { eq } from "drizzle-orm";
import { isPgEnum } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BOLOGNA_MONTHS } from "@/lib/climate/bologna";
import {
  AI_CALL_STATUSES,
  AI_PURPOSES,
  ANALYSIS_KINDS,
  ANALYSIS_PART_KINDS,
  ANALYSIS_STATUSES,
  BATCH_STATUSES,
  FORMALITIES,
  IMAGE_KINDS,
  ITEM_CATEGORIES,
  ITEM_COLLECTIONS,
  ITEM_CONDITIONS,
  ITEM_DECISIONS,
  ITEM_LOCATIONS,
  ITEM_STATUSES,
  OUTFIT_SLOTS,
  OUTFIT_SOURCES,
  PACKING_GROUPS,
  PART_STATUSES,
  SHOPPING_STATUSES,
} from "@/lib/db/enums";
import * as schema from "@/lib/db/schema";
import {
  appSettings,
  climateProfiles,
  itemImages,
  items,
  outfits,
  shoppingListItems,
  wearLogs,
  type NewItem,
} from "@/lib/db/schema";

import { makeTestDb, MIGRATIONS_FOLDER, schemaTableNames, type TestDb } from "../db";
import { makeImage, makeItem, makeTaggedItem } from "../factories";

let t: TestDb;

beforeAll(async () => {
  t = await makeTestDb();
}, 60_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.truncateAll();
});

type DbErrorFields = { code?: unknown; constraint?: unknown };

/** Postgres error fields from a Drizzle error, which wraps the driver error as `cause`. */
function dbErrorFields(error: unknown): DbErrorFields[] {
  const chain: DbErrorFields[] = [];
  let current: unknown = error;
  while (typeof current === "object" && current !== null && chain.length < 5) {
    chain.push(current as DbErrorFields);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** Asserts the action fails because of exactly this constraint, not some other error. */
async function expectViolation(action: () => Promise<unknown>, constraint: string): Promise<void> {
  const outcome = await action().then(
    () => ({ rejected: false as const }),
    (error: unknown) => ({ rejected: true as const, error }),
  );
  expect(outcome.rejected, `expected ${constraint} to reject the write`).toBe(true);
  if (!outcome.rejected) return;
  const constraints = dbErrorFields(outcome.error).map((fields) => fields.constraint);
  expect(constraints).toContain(constraint);
}

const PROFILE_FIELDS = {
  city: "Testville",
  country: "Nowhere",
  lat: 0,
  lon: 0,
  timezone: "UTC",
  source: "test",
  months: BOLOGNA_MONTHS,
};

describe("migrations", () => {
  it("are recorded once per migration folder", async () => {
    const folders = readdirSync(MIGRATIONS_FOLDER, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const { rows } = await t.client.query<{ count: number }>(
      "select count(*)::int as count from drizzle.__drizzle_migrations",
    );
    expect(folders.length).toBeGreaterThan(0);
    expect(rows[0]?.count).toBe(folders.length);
  });

  it("index every foreign key column (D-058)", async () => {
    // A foreign key counts as indexed when some index (plain, unique or the
    // primary key) leads with its column, which is what ON DELETE lookups and
    // joins need.
    const { rows } = await t.client.query<{ fk: string }>(
      `select c.conrelid::regclass::text || '.' || a.attname as fk
         from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f'
          and cardinality(c.conkey) = 1
          and not exists (
            select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]
          )
        order by 1`,
    );
    // app_settings holds a single row, so an index there would buy nothing.
    expect(rows.map((row) => row.fk)).toEqual(["app_settings.home_profile_id"]);
  });

  it("create exactly the tables the schema exports", async () => {
    const { rows } = await t.client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    );
    const expected = schemaTableNames();
    expect(expected).toEqual(expect.arrayContaining(["items", "login_attempts", "app_settings"]));
    expect(rows.map((row) => row.table_name).sort()).toEqual(expected);
  });

  it("create database enums whose values equal the shared TS lists", async () => {
    const { rows } = await t.client.query<{ name: string; labels: string[] }>(
      `select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as labels
         from pg_type t
         join pg_enum e on e.enumtypid = t.oid
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public'
        group by t.typname`,
    );
    const inDb = Object.fromEntries(rows.map((row) => [row.name, row.labels]));

    const expected: Record<string, readonly string[]> = {
      item_status: ITEM_STATUSES,
      item_location: ITEM_LOCATIONS,
      item_decision: ITEM_DECISIONS,
      item_collection: ITEM_COLLECTIONS,
      item_category: ITEM_CATEGORIES,
      formality: FORMALITIES,
      item_condition: ITEM_CONDITIONS,
      image_kind: IMAGE_KINDS,
      analysis_kind: ANALYSIS_KINDS,
      analysis_status: ANALYSIS_STATUSES,
      analysis_part_kind: ANALYSIS_PART_KINDS,
      part_status: PART_STATUSES,
      shopping_status: SHOPPING_STATUSES,
      packing_group: PACKING_GROUPS,
      outfit_source: OUTFIT_SOURCES,
      outfit_slot: OUTFIT_SLOTS,
      ai_purpose: AI_PURPOSES,
      ai_call_status: AI_CALL_STATUSES,
      batch_status: BATCH_STATUSES,
    };
    expect(inDb).toEqual(expected);

    // Every pgEnum the schema exports is covered above, so a new enum cannot slip past this test.
    const schemaExports: unknown[] = Object.values(schema);
    const exported = schemaExports
      .filter(isPgEnum)
      .map((pgEnum) => pgEnum.enumName)
      .sort();
    expect(exported).toEqual(Object.keys(expected).sort());
  });
});

describe("defaults", () => {
  it("start a new item as pending, in Bologna, undecided, clothing, with empty arrays", async () => {
    const item = await makeItem(t.db);
    expect(item).toMatchObject({
      status: "pending_tagging",
      location: "bologna",
      decision: "undecided",
      collection: "clothing",
      colors: [],
      colorHex: [],
      materials: [],
      seasons: [],
      userEditedFields: [],
      notes: "",
      currency: "EUR",
      wearCount: 0,
      category: null,
      warmthLevel: null,
    });
    expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(item.createdAt).toBeInstanceOf(Date);
  });

  it("round-trips numeric money columns as numbers", async () => {
    const item = await makeItem(t.db, { purchasePrice: 129.9, purchaseDate: "2025-11-30" });
    expect(item.purchasePrice).toBe(129.9);
    expect(item.purchaseDate).toBe("2025-11-30");
  });

  it("moves updated_at forward on update", async () => {
    const stale = new Date("2020-01-01T00:00:00Z");
    const item = await makeItem(t.db, { updatedAt: stale });
    expect(item.updatedAt).toEqual(stale);
    const [updated] = await t.db.update(items).set({ notes: "hem fixed" }).where(eq(items.id, item.id)).returning();
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(stale.getTime());
  });
});

describe("constraints", () => {
  it("accept a fully tagged or confirmed item", async () => {
    await expect(makeTaggedItem(t.db)).resolves.toMatchObject({ status: "tagged" });
    await expect(makeTaggedItem(t.db, { status: "confirmed" })).resolves.toMatchObject({ status: "confirmed" });
  });

  it("reject warmth_level outside 1–5", async () => {
    await expectViolation(() => makeItem(t.db, { warmthLevel: 6 }), "items_warmth_level_check");
    await expectViolation(() => makeItem(t.db, { warmthLevel: 0 }), "items_warmth_level_check");
  });

  it("reject seasons outside the four seasons", async () => {
    await expectViolation(() => makeItem(t.db, { seasons: ["monsoon"] }), "items_seasons_check");
    await expectViolation(() => makeItem(t.db, { seasons: ["winter", "monsoon"] }), "items_seasons_check");
  });

  it("reject a tagged item without category", async () => {
    await expectViolation(() => makeTaggedItem(t.db, { category: null }), "items_tagged_complete_check");
  });

  const missingTagFields: Array<[string, Partial<NewItem>]> = [
    ["warmthLevel", { warmthLevel: null }],
    ["waterproof", { waterproof: null }],
    ["windproof", { windproof: null }],
    ["insulated", { insulated: null }],
    ["formality", { formality: null }],
    ["condition", { condition: null }],
    ["seasons", { seasons: [] }],
  ];
  it.each(missingTagFields)("reject a confirmed item missing %s", async (_field, patch) => {
    await expectViolation(
      () => makeTaggedItem(t.db, { status: "confirmed", ...patch }),
      "items_tagged_complete_check",
    );
  });

  it("allow pending and archived items without tags", async () => {
    await expect(makeItem(t.db, { status: "archived" })).resolves.toMatchObject({ category: null });
  });

  it("reject a duplicate image_hash", async () => {
    await makeItem(t.db, { imageHash: "a".repeat(64) });
    await expectViolation(() => makeItem(t.db, { imageHash: "a".repeat(64) }), "items_image_hash_key");
  });

  it("reject a duplicate source_hash but allow many null ones", async () => {
    await makeItem(t.db, { sourceHash: "b".repeat(64) });
    await expectViolation(() => makeItem(t.db, { sourceHash: "b".repeat(64) }), "items_source_hash_key");
    await makeItem(t.db);
    await makeItem(t.db);
  });

  it("reject a second image of the same kind for an item", async () => {
    const item = await makeItem(t.db);
    await makeImage(t.db, item.id, { kind: "thumb" });
    await expectViolation(() => makeImage(t.db, item.id, { kind: "thumb" }), "item_images_item_id_kind_unique");
  });

  it("reject shopping priority outside 1–3", async () => {
    await expectViolation(
      () => t.db.insert(shoppingListItems).values({ itemType: "Rain shell", priority: 4 }),
      "shopping_list_items_priority_check",
    );
  });

  it("reject an outfit rating outside 1–5", async () => {
    await expectViolation(
      () => t.db.insert(outfits).values({ name: "Drizzle commute", rating: 6 }),
      "outfits_rating_check",
    );
    await expect(t.db.insert(outfits).values({ name: "Unrated" })).resolves.toBeDefined();
  });

  it("reject a second default climate profile", async () => {
    await t.db.insert(climateProfiles).values({ ...PROFILE_FIELDS, slug: "first", isDefault: true });
    await t.db.insert(climateProfiles).values({ ...PROFILE_FIELDS, slug: "second", isDefault: false });
    await expectViolation(
      () => t.db.insert(climateProfiles).values({ ...PROFILE_FIELDS, slug: "third", isDefault: true }),
      "climate_profiles_single_default_idx",
    );
  });

  it("reject a climate profile without 12 months", async () => {
    await expectViolation(
      () => t.db.insert(climateProfiles).values({ ...PROFILE_FIELDS, slug: "short", months: BOLOGNA_MONTHS.slice(0, 11) }),
      "climate_profiles_months_check",
    );
  });

  it("reject a wear log with neither item nor outfit", async () => {
    await expectViolation(
      () => t.db.insert(wearLogs).values({ wornOn: "2026-11-02" }),
      "wear_logs_target_check",
    );
  });

  it("reject an app_settings row other than id 1", async () => {
    await expectViolation(() => t.db.insert(appSettings).values({ id: 2 }), "app_settings_single_row_check");
    await expectViolation(
      async () => {
        await t.db.insert(appSettings).values({ id: 1 });
        await t.db.insert(appSettings).values({ id: 1 });
      },
      "app_settings_pkey",
    );
  });
});

describe("foreign keys", () => {
  it("delete an item together with its images and its own wear logs", async () => {
    const item = await makeItem(t.db);
    await makeImage(t.db, item.id, { kind: "original" });
    await makeImage(t.db, item.id, { kind: "thumb" });
    await t.db.insert(wearLogs).values({ itemId: item.id, wornOn: "2026-11-01" });

    await t.db.delete(items).where(eq(items.id, item.id));

    expect(await t.db.select().from(itemImages)).toEqual([]);
    expect(await t.db.select().from(wearLogs)).toEqual([]);
  });

  it("delete an outfit together with its outfit-only wear logs", async () => {
    const [outfit] = await t.db.insert(outfits).values({ name: "Windy Monday" }).returning();
    if (outfit === undefined) throw new Error("no outfit");
    await t.db.insert(wearLogs).values({ outfitId: outfit.id, wornOn: "2026-11-01" });

    await t.db.delete(outfits).where(eq(outfits.id, outfit.id));

    expect(await t.db.select().from(wearLogs)).toEqual([]);
  });

  it("keep a shopping entry when its linked item is deleted", async () => {
    const item = await makeItem(t.db);
    await t.db.insert(shoppingListItems).values({ itemType: "Beanie", linkedItemId: item.id, status: "bought" });

    await t.db.delete(items).where(eq(items.id, item.id));

    const [entry] = await t.db.select().from(shoppingListItems);
    expect(entry).toMatchObject({ itemType: "Beanie", linkedItemId: null });
  });
});
