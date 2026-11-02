import { count, eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { itemImages, items } from "@/lib/db/schema";

import { makeTestDb, type TestDb } from "../test/db";
import { makeTaggedItem } from "../test/factories";
import {
  buildDemoItems,
  DEMO_ITEM_COUNT,
  DEMO_MARKER,
  DEMO_PHOTO,
  insertDemoItems,
  nonLocalReason,
  removeDemoItems,
} from "./seed-demo";

describe("nonLocalReason", () => {
  it("accepts localhost and 127.0.0.1 only", () => {
    expect(nonLocalReason("postgres://wardrobe:wardrobe@localhost:5432/wardrobe")).toBeNull();
    expect(nonLocalReason("postgresql://u:p@127.0.0.1/wardrobe")).toBeNull();
    expect(nonLocalReason("postgres://u:p@db.example.neon.tech/wardrobe")).toMatch(/db\.example\.neon\.tech/);
    expect(nonLocalReason("postgres://u:p@localhost.example.com/wardrobe")).not.toBeNull();
    expect(nonLocalReason("not a url")).toMatch(/not a valid URL/);
  });

  it("never echoes the password", () => {
    expect(nonLocalReason("postgres://user:hunter2@remote.example/wardrobe")).not.toContain("hunter2");
    expect(nonLocalReason("postgres://user:hunter2@localhost/wardrobe?host=remote.example")).not.toContain("hunter2");
  });

  it("refuses a local URL whose query string names another host", () => {
    const sneaky = [
      "postgresql://u:p@localhost:5432/neondb?host=ep-prod-123.eu-central-1.aws.neon.tech",
      "postgres://u:p@127.0.0.1/db?host=db.example.com",
      "postgres://u:p@localhost/db?hostaddr=203.0.113.7",
    ];
    // The driver really connects to the query's host, not the URL's.
    expect(new pg.Client({ connectionString: sneaky[0] }).host).toBe("ep-prod-123.eu-central-1.aws.neon.tech");
    for (const url of sneaky) expect(nonLocalReason(url), url).toMatch(/query string/);
    // Other query parameters are fine.
    expect(nonLocalReason("postgres://u:p@localhost:5432/wardrobe?application_name=seed")).toBeNull();
  });
});

describe("buildDemoItems", () => {
  const now = new Date(Date.UTC(2026, 10, 2));

  it("is the same wardrobe every run, newest first, all confirmed and marked", () => {
    const first = buildDemoItems(DEMO_ITEM_COUNT, now);
    expect(buildDemoItems(DEMO_ITEM_COUNT, now)).toEqual(first);
    expect(first).toHaveLength(DEMO_ITEM_COUNT);
    expect(first.every((item) => item.status === "confirmed" && item.notes === DEMO_MARKER)).toBe(true);
    const times = first.map((item) => item.createdAt?.getTime() ?? 0);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("varies every field the filters use", () => {
    const demo = buildDemoItems(DEMO_ITEM_COUNT, now);
    const distinct = (values: unknown[]) => new Set(values).size;
    expect(distinct(demo.map((item) => item.category))).toBeGreaterThanOrEqual(10);
    expect(distinct(demo.map((item) => item.warmthLevel))).toBe(5);
    expect(distinct(demo.map((item) => item.decision))).toBe(5);
    expect(distinct(demo.map((item) => item.location))).toBe(4);
    expect(distinct(demo.map((item) => item.condition))).toBe(4);
    expect(distinct(demo.flatMap((item) => item.colors ?? []))).toBeGreaterThanOrEqual(12);
    expect(distinct(demo.flatMap((item) => item.seasons ?? []))).toBe(4);
    expect(distinct(demo.map((item) => item.waterproof))).toBe(2);
    expect(distinct(demo.map((item) => item.windproof))).toBe(2);
    expect(demo.some((item) => (item.wearCount ?? 0) > 0)).toBe(true);
    expect(demo.some((item) => item.wearCount === 0)).toBe(true);
  });
});

describe("insertDemoItems and removeDemoItems", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await makeTestDb();
  });

  beforeEach(async () => {
    await testDb.truncateAll();
  });

  afterAll(async () => {
    await testDb.close();
  });

  async function countRows() {
    const [itemRows] = await testDb.db.select({ value: count() }).from(items);
    const [imageRows] = await testDb.db.select({ value: count() }).from(itemImages);
    return { items: itemRows?.value ?? 0, images: imageRows?.value ?? 0 };
  }

  it("inserts 300 items that pass every table check, each with a thumb and a processed image", async () => {
    expect(await insertDemoItems(testDb.db)).toEqual({ inserted: DEMO_ITEM_COUNT, skipped: 0 });
    expect(await countRows()).toEqual({ items: DEMO_ITEM_COUNT, images: DEMO_ITEM_COUNT * 2 });
    const [thumb] = await testDb.db.select().from(itemImages).where(eq(itemImages.kind, "thumb")).limit(1);
    expect(thumb).toMatchObject({ blobUrl: DEMO_PHOTO.url, width: 192, height: 192, contentType: "image/png" });
    expect(thumb?.blobPathname.startsWith(`${DEMO_MARKER}/`)).toBe(true);
  });

  it("adds nothing when run again", async () => {
    await insertDemoItems(testDb.db);
    expect(await insertDemoItems(testDb.db)).toEqual({ inserted: 0, skipped: DEMO_ITEM_COUNT });
    expect(await countRows()).toEqual({ items: DEMO_ITEM_COUNT, images: DEMO_ITEM_COUNT * 2 });
  });

  it("removes only the demo items, with their images", async () => {
    const own = await makeTaggedItem(testDb.db, { notes: "bought in Bologna; not demo-seed data" });
    await insertDemoItems(testDb.db);
    expect(await removeDemoItems(testDb.db)).toBe(DEMO_ITEM_COUNT);
    expect(await countRows()).toEqual({ items: 1, images: 0 });
    const [left] = await testDb.db.select({ id: items.id }).from(items);
    expect(left?.id).toBe(own.id);
  });
});
