import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeImage, makeItem, makeTaggedItem } from "../../../test/factories";
import { loadItemCard, loadItemCards, toItemCardDto } from "./dto";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

let testDb: TestDb;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  requireSession.mockReset();
  requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
});

afterAll(async () => {
  await testDb.close();
});

async function taggedItemWithImages() {
  const item = await makeTaggedItem(testDb.db, {
    aiRaw: { multiple_items_detected: true },
    aiConfidence: { category: 0.9, brand: 0.2 },
    aiModel: "claude-haiku-5-5",
    brand: "Acme",
    purchasePrice: 129.9,
    purchaseDate: "2025-10-01",
    userEditedFields: ["name"],
  });
  const thumb = await makeImage(testDb.db, item.id, { kind: "thumb", width: 400, height: 300 });
  const processed = await makeImage(testDb.db, item.id, { kind: "processed", width: 1024, height: 768 });
  const original = await makeImage(testDb.db, item.id, { kind: "original", width: 4032, height: 3024 });
  return { item, images: [original, processed, thumb], thumb, processed };
}

describe("toItemCardDto", () => {
  it("maps a tagged item with its images", async () => {
    const { item, images, thumb, processed } = await taggedItemWithImages();
    const other = await makeItem(testDb.db);
    const stray = await makeImage(testDb.db, other.id, { kind: "nobg" });

    expect(toItemCardDto(item, [...images, stray])).toEqual({
      id: item.id,
      status: "tagged",
      createdAt: item.createdAt.toISOString(),
      name: "Navy wool coat",
      category: "outerwear",
      subcategory: "coat",
      colors: ["navy"],
      colorHex: ["#1f2a44"],
      materialGuess: null,
      materials: ["wool"],
      warmthLevel: 4,
      waterproof: false,
      windproof: true,
      insulated: true,
      breathable: null,
      seasons: ["winter", "autumn"],
      formality: "smart_casual",
      pattern: null,
      fit: null,
      condition: "good",
      brand: "Acme",
      size: null,
      description: "Knee-length navy wool coat.",
      notes: "",
      purchasePrice: 129.9,
      currency: "EUR",
      purchaseDate: "2025-10-01",
      location: "bologna",
      decision: "undecided",
      collection: "clothing",
      aiConfidence: { category: 0.9, brand: 0.2 },
      multipleItemsDetected: true,
      userEditedFields: ["name"],
      taggingError: null,
      taggingBatchId: null,
      aiModel: "claude-haiku-5-5",
      images: {
        thumb: { url: thumb.blobUrl, width: 400, height: 300 },
        processed: { url: processed.blobUrl, width: 1024, height: 768 },
        nobg: null,
      },
    });
  });

  it("maps a pending item with no images or tags", async () => {
    const item = await makeItem(testDb.db, { taggingError: "Claude is busy. Try again." });
    const card = toItemCardDto(item, []);
    expect(card).toMatchObject({
      id: item.id,
      status: "pending_tagging",
      collection: "clothing",
      name: null,
      category: null,
      colors: [],
      colorHex: [],
      seasons: [],
      warmthLevel: null,
      waterproof: null,
      aiConfidence: null,
      aiModel: null,
      multipleItemsDetected: false,
      userEditedFields: [],
      taggingError: "Claude is busy. Try again.",
      images: { thumb: null, processed: null, nobg: null },
    });
  });

  it("carries the item's collection", async () => {
    const item = await makeItem(testDb.db, { collection: "running" });
    expect(toItemCardDto(item, []).collection).toBe("running");
  });

  it("reads multipleItemsDetected only from a true flag in ai_raw", async () => {
    const item = await makeItem(testDb.db);
    expect(toItemCardDto({ ...item, aiRaw: null }, []).multipleItemsDetected).toBe(false);
    expect(toItemCardDto({ ...item, aiRaw: { multiple_items_detected: false } }, []).multipleItemsDetected).toBe(false);
    expect(toItemCardDto({ ...item, aiRaw: { multiple_items_detected: "yes" } }, []).multipleItemsDetected).toBe(false);
    expect(toItemCardDto({ ...item, aiRaw: [] }, []).multipleItemsDetected).toBe(false);
  });
});

describe("loadItemCard", () => {
  it("loads one card with its images after checking the session", async () => {
    const { item, thumb } = await taggedItemWithImages();
    const card = await loadItemCard(testDb.db, item.id);
    expect(requireSession).toHaveBeenCalledOnce();
    expect(card.id).toBe(item.id);
    expect(card.images.thumb).toEqual({ url: thumb.blobUrl, width: 400, height: 300 });
    expect(card.images.processed).not.toBeNull();
  });

  it.each([randomUUID(), "not-a-uuid"])("throws NOT_FOUND for %s", async (id) => {
    await makeItem(testDb.db);
    await expect(loadItemCard(testDb.db, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("stops before the query when the session check fails", async () => {
    const { item } = await taggedItemWithImages();
    requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Signed out."));
    await expect(loadItemCard(testDb.db, item.id)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("loadItemCards", () => {
  it("returns cards in the order of the ids", async () => {
    const first = await makeItem(testDb.db);
    const { item: second } = await taggedItemWithImages();
    const third = await makeItem(testDb.db);
    await makeImage(testDb.db, third.id, { kind: "nobg", width: 800, height: 800 });

    const cards = await loadItemCards(testDb.db, [third.id, first.id, second.id, first.id]);
    expect(requireSession).toHaveBeenCalledOnce();
    expect(cards.map((card) => card.id)).toEqual([third.id, first.id, second.id, first.id]);
    expect(cards[0]?.images.nobg).toMatchObject({ width: 800, height: 800 });
    expect(cards[2]?.images.thumb).not.toBeNull();
    expect(cards[1]?.images).toEqual({ thumb: null, processed: null, nobg: null });
  });

  it("returns an empty list for no ids", async () => {
    expect(await loadItemCards(testDb.db, [])).toEqual([]);
    expect(requireSession).toHaveBeenCalledOnce();
  });

  it("throws NOT_FOUND listing every missing id", async () => {
    const item = await makeItem(testDb.db);
    const missing = randomUUID();
    const error: unknown = await loadItemCards(testDb.db, [item.id, missing, "bad"]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "NOT_FOUND", details: { itemIds: [missing, "bad"] } });
  });
});
