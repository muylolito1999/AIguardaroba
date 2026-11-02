import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeImage, makeItem, makeTaggedItem } from "../../../test/factories";
import { loadItemDetail } from "./detail";

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

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected an AppError");
}

describe("loadItemDetail", () => {
  it("returns the card plus wear history, the last change and the original with its size", async () => {
    const lastWornAt = new Date("2026-10-20T08:30:00.000Z");
    const item = await makeTaggedItem(testDb.db, { status: "confirmed", wearCount: 3, lastWornAt });
    await makeImage(testDb.db, item.id, { kind: "original", contentType: "image/jpeg", width: 4032, height: 3024, bytes: 2_400_000 });
    await makeImage(testDb.db, item.id, { kind: "processed" });
    await makeImage(testDb.db, item.id, { kind: "nobg", contentType: "image/png", width: 1024, height: 768 });
    await makeImage(testDb.db, item.id, { kind: "thumb", width: 400, height: 300 });
    // Another item's photo must not leak into this one.
    const other = await makeItem(testDb.db);
    await makeImage(testDb.db, other.id, { kind: "original" });

    const detail = await loadItemDetail(testDb.db, item.id);

    expect(detail).toMatchObject({
      id: item.id,
      status: "confirmed",
      name: "Navy wool coat",
      category: "outerwear",
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      wearCount: 3,
      lastWornAt: "2026-10-20T08:30:00.000Z",
      original: {
        url: `https://example.invalid/items/${item.id}/original-test.webp`,
        width: 4032,
        height: 3024,
        bytes: 2_400_000,
      },
      images: {
        processed: { url: `https://example.invalid/items/${item.id}/processed-test.webp`, width: 1024, height: 768 },
        nobg: { url: `https://example.invalid/items/${item.id}/nobg-test.webp`, width: 1024, height: 768 },
        thumb: { url: `https://example.invalid/items/${item.id}/thumb-test.webp`, width: 400, height: 300 },
      },
    });
    expect(requireSession).toHaveBeenCalled();
  });

  it("returns a pending item without images, never worn", async () => {
    const item = await makeItem(testDb.db);

    const detail = await loadItemDetail(testDb.db, item.id);

    expect(detail).toMatchObject({
      id: item.id,
      status: "pending_tagging",
      name: null,
      category: null,
      wearCount: 0,
      lastWornAt: null,
      original: null,
      images: { thumb: null, processed: null, nobg: null },
    });
  });

  it("answers NOT_FOUND for an unknown or malformed id", async () => {
    await makeItem(testDb.db);
    expect((await appError(loadItemDetail(testDb.db, randomUUID()))).code).toBe("NOT_FOUND");
    expect((await appError(loadItemDetail(testDb.db, "not-a-uuid"))).code).toBe("NOT_FOUND");
  });

  it("checks the session before reading", async () => {
    const item = await makeItem(testDb.db);
    requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Signed out."));
    expect((await appError(loadItemDetail(testDb.db, item.id))).code).toBe("UNAUTHENTICATED");
  });
});
