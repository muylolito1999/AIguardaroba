import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { asc } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/lib/db/client";
import { ITEM_CATEGORIES, OUTFIT_SLOTS } from "@/lib/db/enums";
import { relations } from "@/lib/db/relations";
import { items, shoppingListItems } from "@/lib/db/schema";

import { MIGRATIONS_FOLDER } from "../db";
import { makeTaggedItem } from "../factories";

// The socks-and-layers migration (D-254) recreates item_category and moves
// socks tagged base_layer into the new socks category. A plain makeTestDb()
// runs every migration in one transaction together with init's CREATE TYPE,
// where Postgres would also accept an ADD VALUE followed by an UPDATE; on a
// database that already holds the earlier migrations it would not. So this
// test migrates in two phases, as production does: first every migration but
// the socks one, then, with rows in place, the rest.

const SOCKS_MIGRATION = "20261105230129_socks-and-layers";

let client: PGlite;
let pglite: PgliteDatabase<typeof relations>;
/** The same database, typed as the app's Db for the factories. */
let db: Db;
let olderFolder: string;

beforeAll(async () => {
  const all = readdirSync(MIGRATIONS_FOLDER, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(all).toContain(SOCKS_MIGRATION);
  olderFolder = mkdtempSync(join(tmpdir(), "wardrobe-migrations-"));
  for (const name of all.filter((folder) => folder < SOCKS_MIGRATION)) {
    cpSync(join(MIGRATIONS_FOLDER, name), join(olderFolder, name), { recursive: true });
  }

  client = await PGlite.create();
  pglite = drizzle({ client, relations });
  db = pglite;
  await migrate(pglite, { migrationsFolder: olderFolder });
}, 60_000);

afterAll(async () => {
  await client?.close();
  if (olderFolder !== undefined) rmSync(olderFolder, { recursive: true, force: true });
});

async function enumLabels(name: string): Promise<string[]> {
  const { rows } = await client.query<{ labels: string[] }>(
    `select array_agg(e.enumlabel order by e.enumsortorder) as labels
       from pg_type t join pg_enum e on e.enumtypid = t.oid
      where t.typname = $1`,
    [name],
  );
  return rows[0]?.labels ?? [];
}

describe("the socks-and-layers migration on a database that holds the earlier ones", () => {
  it("moves socks tagged base_layer to socks and leaves every other item where it was", async () => {
    // Inserted while item_category has no socks value yet: the old database's state.
    const longAgo = new Date("2026-01-01T00:00:00Z");
    const plainSocks = await makeTaggedItem(db, { category: "base_layer", subcategory: "socks", name: "Grey socks", updatedAt: longAgo });
    const namedSocks = await makeTaggedItem(db, { category: "base_layer", subcategory: null, name: "Wool hiking socks" });
    const upperSocks = await makeTaggedItem(db, { category: "base_layer", subcategory: "Ankle Socks", name: "Trainer liners" });
    const thermal = await makeTaggedItem(db, {
      category: "base_layer",
      subcategory: "thermal top",
      name: "Merino long sleeve",
      updatedAt: longAgo,
    });
    const tee = await makeTaggedItem(db, { category: "top", subcategory: "t-shirt", name: "Grey tee" });
    const sockLikeTop = await makeTaggedItem(db, { category: "top", subcategory: "t-shirt", name: "Socks print tee" });
    const untagged = await makeTaggedItem(db, { category: null, status: "pending_tagging", name: "Socks maybe" });
    await db.insert(shoppingListItems).values([
      { itemType: "Merino socks", category: "base_layer" },
      { itemType: "Thermal leggings", category: "base_layer" },
      { itemType: "Rain shell", category: "outerwear" },
    ]);
    await migrate(pglite, { migrationsFolder: MIGRATIONS_FOLDER });

    const rows = await db.select({ id: items.id, category: items.category, updatedAt: items.updatedAt }).from(items);
    const categoryOf = new Map(rows.map((row) => [row.id, row.category]));
    expect(categoryOf.get(plainSocks.id)).toBe("socks");
    expect(categoryOf.get(namedSocks.id)).toBe("socks");
    expect(categoryOf.get(upperSocks.id)).toBe("socks");
    expect(categoryOf.get(thermal.id)).toBe("base_layer");
    expect(categoryOf.get(tee.id)).toBe("top");
    // Only base_layer items move: a top that mentions socks stays a top.
    expect(categoryOf.get(sockLikeTop.id)).toBe("top");
    expect(categoryOf.get(untagged.id)).toBeNull();

    // A moved item shows as changed; an item left alone keeps its timestamp.
    const updatedOf = new Map(rows.map((row) => [row.id, row.updatedAt.getTime()]));
    expect(updatedOf.get(plainSocks.id)).toBeGreaterThan(longAgo.getTime());
    expect(updatedOf.get(thermal.id)).toBe(longAgo.getTime());

    const shopping = await db
      .select({ itemType: shoppingListItems.itemType, category: shoppingListItems.category })
      .from(shoppingListItems)
      .orderBy(asc(shoppingListItems.itemType));
    expect(shopping).toEqual([
      { itemType: "Merino socks", category: "socks" },
      { itemType: "Rain shell", category: "outerwear" },
      { itemType: "Thermal leggings", category: "base_layer" },
    ]);
  });

  it("leaves both enums in the order of the shared TS lists, and the category index in place", async () => {
    expect(await enumLabels("item_category")).toEqual([...ITEM_CATEGORIES]);
    expect(await enumLabels("outfit_slot")).toEqual([...OUTFIT_SLOTS]);
    const { rows } = await client.query<{ indexname: string }>(
      "select indexname from pg_indexes where tablename = 'items' and indexname = 'items_category_idx'",
    );
    expect(rows).toHaveLength(1);
    const { rows: types } = await client.query<{ udt_name: string }>(
      `select udt_name from information_schema.columns
        where table_name in ('items', 'shopping_list_items') and column_name = 'category'`,
    );
    expect(types.map((row) => row.udt_name)).toEqual(["item_category", "item_category"]);
  });

  it("accepts the new values once applied", async () => {
    const socks = await makeTaggedItem(db, { category: "socks", subcategory: "wool socks", name: "Wool socks" });
    expect(socks.category).toBe("socks");
  });
});
