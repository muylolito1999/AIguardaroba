import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ITEM_CATEGORIES } from "@/lib/db/enums";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeItem, makeTaggedItem } from "../../../test/factories";
import { getWardrobeStats } from "./stats";

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

describe("getWardrobeStats", () => {
  it("checks the session before reading anything", async () => {
    requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in again."));
    await makeTaggedItem(testDb.db);

    await expect(getWardrobeStats(testDb.db)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(requireSession).toHaveBeenCalledTimes(1);
  });

  it("returns zeros for every bucket of an empty wardrobe", async () => {
    const stats = await getWardrobeStats(testDb.db);

    expect(requireSession).toHaveBeenCalledTimes(1);
    expect(stats.totals).toEqual({ all: 0, confirmed: 0, tagged: 0, pending: 0, archived: 0, running: 0 });
    expect(Object.keys(stats.byCategory)).toEqual([...ITEM_CATEGORIES]);
    expect(Object.values(stats.byCategory).every((count) => count === 0)).toBe(true);
    expect(stats.warmth).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
    expect(stats.flags).toEqual({ waterproof: 0, windproof: 0, insulated: 0 });
    expect(stats.byDecision).toEqual({ bring: 0, leave: 0, donate: 0, sell: 0, undecided: 0 });
    expect(stats.byLocation).toEqual({ bologna: 0, hamburg: 0, in_transit: 0, unknown: 0 });
    expect(stats.winterReadiness).toHaveLength(6);
    expect(stats.winterReadiness.every((row) => !row.satisfied)).toBe(true);
  });

  it("counts statuses, leaves archived items out and keeps pending items out of tag-based numbers", async () => {
    const { db } = testDb;
    // Tagged and confirmed: the base of the tag-based numbers.
    await makeTaggedItem(db, {
      status: "confirmed",
      category: "outerwear",
      warmthLevel: 4,
      waterproof: true,
      windproof: true,
      insulated: true,
      decision: "bring",
      location: "bologna",
    });
    await makeTaggedItem(db, {
      status: "confirmed",
      category: "outerwear",
      warmthLevel: 5,
      waterproof: false,
      windproof: true,
      insulated: true,
      decision: "bring",
      location: "hamburg",
    });
    await makeTaggedItem(db, {
      status: "tagged",
      category: "scarf",
      warmthLevel: 3,
      waterproof: false,
      windproof: false,
      insulated: false,
      decision: "donate",
      location: "bologna",
    });
    // Pending: counted in totals, decision and location only.
    await makeItem(db, { decision: "undecided", location: "in_transit" });
    await makeItem(db, { decision: "sell", location: "bologna" });
    // Archived, with tags that would otherwise show everywhere.
    await makeTaggedItem(db, {
      status: "archived",
      category: "shoes",
      warmthLevel: 1,
      waterproof: true,
      windproof: true,
      insulated: true,
      decision: "leave",
      location: "unknown",
    });

    const stats = await getWardrobeStats(db);

    expect(stats.totals).toEqual({ all: 5, confirmed: 2, tagged: 1, pending: 2, archived: 1, running: 0 });
    expect(stats.byCategory).toMatchObject({ outerwear: 2, scarf: 1, shoes: 0, top: 0 });
    expect(Object.values(stats.byCategory).reduce((sum, count) => sum + count, 0)).toBe(3);
    expect(stats.warmth).toEqual({ 1: 0, 2: 0, 3: 1, 4: 1, 5: 1 });
    expect(stats.flags).toEqual({ waterproof: 1, windproof: 2, insulated: 2 });
    expect(stats.byDecision).toEqual({ bring: 2, leave: 0, donate: 1, sell: 1, undecided: 1 });
    expect(stats.byLocation).toEqual({ bologna: 3, hamburg: 1, in_transit: 1, unknown: 0 });
  });

  it("counts running gear in its own tile only, and archived running gear as archived (D-249)", async () => {
    const { db } = testDb;
    // One piece of clothing, so the breakdowns have something to compare against.
    await makeTaggedItem(db, {
      status: "confirmed",
      category: "top",
      warmthLevel: 2,
      waterproof: false,
      windproof: false,
      insulated: false,
      decision: "bring",
      location: "bologna",
    });
    // Running gear in every status, with tags and choices the clothing does not have.
    await makeTaggedItem(db, {
      collection: "running",
      status: "confirmed",
      category: "shoes",
      warmthLevel: 1,
      waterproof: true,
      windproof: true,
      insulated: true,
      decision: "sell",
      location: "hamburg",
    });
    await makeTaggedItem(db, {
      collection: "running",
      status: "tagged",
      category: "gloves",
      warmthLevel: 3,
      waterproof: true,
      windproof: true,
      insulated: true,
      decision: "leave",
      location: "unknown",
    });
    await makeItem(db, { collection: "running", decision: "donate", location: "in_transit" });
    // Archived running gear counts as archived, not as running gear.
    await makeTaggedItem(db, { collection: "running", status: "archived", category: "top", decision: "undecided" });

    const stats = await getWardrobeStats(db);

    expect(stats.totals).toEqual({ all: 1, confirmed: 1, tagged: 0, pending: 0, archived: 1, running: 3 });
    expect(stats.byCategory).toMatchObject({ top: 1, shoes: 0, gloves: 0 });
    expect(Object.values(stats.byCategory).reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(stats.warmth).toEqual({ 1: 0, 2: 1, 3: 0, 4: 0, 5: 0 });
    expect(stats.flags).toEqual({ waterproof: 0, windproof: 0, insulated: 0 });
    expect(stats.byDecision).toEqual({ bring: 1, leave: 0, donate: 0, sell: 0, undecided: 0 });
    expect(stats.byLocation).toEqual({ bologna: 1, hamburg: 0, in_transit: 0, unknown: 0 });
  });

  it("keeps running gear in the winter checklist (D-249)", async () => {
    const { db } = testDb;
    const gloves = await makeTaggedItem(db, {
      collection: "running",
      name: "Running gloves",
      category: "gloves",
      windproof: true,
      decision: "bring",
    });
    const beanie = await makeTaggedItem(db, {
      collection: "running",
      name: "Running beanie",
      status: "confirmed",
      category: "hat_beanie",
      warmthLevel: 3,
    });

    const stats = await getWardrobeStats(db);
    const byKey = Object.fromEntries(stats.winterReadiness.map((row) => [row.key, row]));

    expect(stats.totals).toMatchObject({ all: 0, running: 2 });
    expect(byKey.windproof_gloves).toMatchObject({ satisfied: true, evidenceIds: [gloves.id] });
    expect(byKey.warm_beanie).toMatchObject({ satisfied: true, evidenceIds: [beanie.id] });
  });

  it("adds up items that share every grouped column", async () => {
    const { db } = testDb;
    for (let index = 0; index < 3; index += 1) {
      await makeTaggedItem(db, { status: "confirmed", category: "top", warmthLevel: 2 });
    }

    const stats = await getWardrobeStats(db);

    expect(stats.totals).toMatchObject({ all: 3, confirmed: 3 });
    expect(stats.byCategory.top).toBe(3);
    expect(stats.warmth[2]).toBe(3);
  });

  it("builds the winter checklist from tagged and confirmed items going to Hamburg, newest first", async () => {
    const { db } = testDb;
    const older = new Date("2026-10-01T10:00:00Z");
    const newer = new Date("2026-10-02T10:00:00Z");
    const shell = await makeTaggedItem(db, {
      name: "Rain shell",
      category: "outerwear",
      waterproof: true,
      decision: "bring",
      createdAt: older,
    });
    const newerShell = await makeTaggedItem(db, {
      name: "Hardshell parka",
      status: "confirmed",
      category: "outerwear",
      waterproof: true,
      createdAt: newer,
    });
    // Would count, but is staying in Bologna.
    await makeTaggedItem(db, { category: "scarf", decision: "leave" });
    // Would count, but is archived.
    await makeTaggedItem(db, { status: "archived", category: "gloves", windproof: true });
    // A pending item has no tags to judge.
    await makeItem(db, { category: "hat_beanie", warmthLevel: 4 });
    const merino = await makeTaggedItem(db, {
      name: "Merino long-sleeve",
      category: "base_layer",
      materials: ["merino"],
      warmthLevel: 2,
    });

    const rows = await getWardrobeStats(db).then((stats) => stats.winterReadiness);
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));

    expect(byKey.waterproof_shell).toMatchObject({
      satisfied: true,
      evidenceIds: [newerShell.id, shell.id],
      evidence: [
        { id: newerShell.id, name: "Hardshell parka" },
        { id: shell.id, name: "Rain shell" },
      ],
      need: "",
    });
    expect(byKey.scarf).toMatchObject({ satisfied: false, evidenceIds: [] });
    expect(byKey.windproof_gloves).toMatchObject({ satisfied: false, evidenceIds: [] });
    expect(byKey.warm_beanie).toMatchObject({ satisfied: false, evidenceIds: [] });
    expect(byKey.base_layers).toMatchObject({ satisfied: false, evidenceIds: [merino.id] });
    expect(byKey.base_layers?.need).toMatch(/1 of 2/);
  });
});
