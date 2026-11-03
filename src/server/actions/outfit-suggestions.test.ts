import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { HAMBURG } from "@/lib/climate/hamburg";
import { analyses, climateProfiles, items, outfits } from "@/lib/db/schema";
import { OUTFIT_PROMPT_VERSION } from "@/lib/outfits/suggestion";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeOutfitSuggestionResult, makeOutfitWardrobe } from "../../../test/outfit-fixtures";

// Wiring of /today's Save: session check, strict input and the Result shape,
// including the CONFLICT for an item archived since. The service has its own
// tests.

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  db: { current: undefined as unknown },
}));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db.current }));

const { saveSuggestedOutfit } = await import("./outfit-suggestions");

let testDb: TestDb;
let analysisId: string;
let firstTop: string;

beforeAll(async () => {
  testDb = await makeTestDb();
  mocks.db.current = testDb.db;
});

beforeEach(async () => {
  await testDb.truncateAll();
  mocks.requireSession.mockReset();
  mocks.requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
  const [profile] = await testDb.db.insert(climateProfiles).values(HAMBURG).returning();
  const wardrobe = Object.values(makeOutfitWardrobe());
  await testDb.db.insert(items).values(
    wardrobe.map((item, index) => ({
      id: item.id,
      imageHash: String(index).padStart(64, "0"),
      status: item.status,
      location: item.location,
      name: item.name,
      category: item.category,
      subcategory: item.subcategory,
      colors: [...item.colors],
      materials: [...item.materials],
      warmthLevel: item.warmthLevel,
      waterproof: item.waterproof,
      windproof: item.windproof,
      insulated: item.insulated,
      seasons: [...item.seasons],
      formality: item.formality,
      condition: "good" as const,
    })),
  );
  const result = makeOutfitSuggestionResult(wardrobe);
  firstTop = result.outfits[0]?.items.find((entry) => entry.slot === "top")?.itemId ?? "";
  const [row] = await testDb.db
    .insert(analyses)
    .values({
      kind: "outfit_suggestion",
      status: "complete",
      climateProfileId: profile?.id ?? null,
      dateFrom: result.weather.date,
      dateTo: result.weather.date,
      model: "claude-sonnet-5-5",
      effort: "low",
      promptVersion: OUTFIT_PROMPT_VERSION,
      result,
      completedAt: new Date(),
    })
    .returning({ id: analyses.id });
  analysisId = row?.id ?? "";
});

afterAll(async () => {
  await testDb.close();
});

describe("saveSuggestedOutfit action", () => {
  it("saves the outfit and answers its id", async () => {
    const result = await saveSuggestedOutfit({ analysisId, index: 1 });
    expect(result).toMatchObject({ ok: true, data: { analysisId, index: 1, alreadySaved: false } });
    if (!result.ok) throw new Error("expected ok");
    const [outfit] = await testDb.db.select().from(outfits).where(eq(outfits.id, result.data.outfitId));
    expect(outfit?.source).toBe("ai");
  });

  it("validates its input strictly", async () => {
    for (const input of [
      { analysisId: "x", index: 0 },
      { analysisId, index: 3 },
      { analysisId, index: 0.5 },
      { analysisId, index: "0" },
      { analysisId, index: 0, extra: 1 },
    ]) {
      const result = await saveSuggestedOutfit(input as { analysisId: string; index: number });
      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect(await testDb.db.select({ id: outfits.id }).from(outfits)).toHaveLength(0);
  });

  it("passes NOT_FOUND and CONFLICT on with their messages", async () => {
    expect(await saveSuggestedOutfit({ analysisId: randomUUID(), index: 0 })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    await testDb.db.update(items).set({ status: "archived" }).where(eq(items.id, firstTop));
    expect(await saveSuggestedOutfit({ analysisId, index: 0 })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", message: expect.stringContaining("deleted or archived") },
    });
  });

  it("answers UNAUTHENTICATED without a session and saves nothing", async () => {
    mocks.requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in again."));
    expect(await saveSuggestedOutfit({ analysisId, index: 0 })).toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
    expect(await testDb.db.select({ id: outfits.id }).from(outfits)).toHaveLength(0);
  });
});
