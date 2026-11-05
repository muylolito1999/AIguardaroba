import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { HAMBURG } from "@/lib/climate/hamburg";
import { appSettings, climateProfiles, items, outfitItems, outfits, wearLogs, type Item } from "@/lib/db/schema";
import type { OutfitInputValues } from "@/lib/outfits/contracts";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeImage, makeItem, makeTaggedItem } from "../../../test/factories";
import { OUTFIT_TEMPLATES, type OutfitTemplateKey } from "../../../test/outfit-fixtures";
import {
  deleteOutfit,
  getOutfit,
  listCandidatesBySlot,
  listOutfits,
  listSlotCandidates,
  saveOutfit,
} from "./outfits";
import { logWear } from "./wear";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

const MISSING_ID = "00000000-0000-4000-8000-000000000000";
const NOW = new Date("2026-11-03T13:20:00.000Z");

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
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof AppError)) throw new Error(`expected an AppError, got ${String(error)}`);
  return error;
}

function item(key: OutfitTemplateKey, overrides: Partial<Item> = {}): Promise<Item> {
  const template = OUTFIT_TEMPLATES[key];
  return makeTaggedItem(testDb.db, {
    ...template,
    colors: [...template.colors],
    materials: [...template.materials],
    seasons: [...template.seasons],
    status: "confirmed",
    ...overrides,
  });
}

function input(entries: OutfitInputValues["items"], overrides: Partial<OutfitInputValues> = {}): OutfitInputValues {
  return {
    name: "Rainy office day",
    occasion: "Office",
    weatherMinC: 4,
    weatherMaxC: 11.5,
    rainOk: true,
    rating: 4,
    notes: "",
    items: entries,
    ...overrides,
  };
}

async function counts() {
  const [outfitRows, itemRows] = await Promise.all([
    testDb.db.select({ id: outfits.id }).from(outfits),
    testDb.db.select({ outfitId: outfitItems.outfitId }).from(outfitItems),
  ]);
  return { outfits: outfitRows.length, outfitItems: itemRows.length };
}

describe("saveOutfit", () => {
  it("saves an outfit with its items and reads it back in slot order", async () => {
    const [shell, sweater, jeans, boots, belt, tote] = await Promise.all([
      item("shell"),
      item("sweater"),
      item("jeans"),
      item("boots"),
      item("belt"),
      item("tote"),
    ]);
    await makeImage(testDb.db, sweater.id, { kind: "thumb" });

    const saved = await saveOutfit(
      testDb.db,
      input([
        { slot: "accessory", itemId: tote.id },
        { slot: "shoes", itemId: boots.id },
        { slot: "bottom", itemId: jeans.id },
        { slot: "top", itemId: sweater.id },
        { slot: "outerwear", itemId: shell.id },
        { slot: "accessory", itemId: belt.id },
      ]),
    );

    expect(saved).toMatchObject({
      name: "Rainy office day",
      occasion: "Office",
      weatherMinC: 4,
      weatherMaxC: 11.5,
      rainOk: true,
      rating: 4,
      source: "user",
      aiReasoning: null,
      notes: "",
      timesWorn: 0,
      lastWornOn: null,
    });
    expect(saved.items.map((entry) => [entry.slot, entry.name])).toEqual([
      ["outerwear", "Navy waterproof shell jacket"],
      ["top", "Grey merino crew-neck sweater"],
      ["bottom", "Dark blue slim jeans"],
      ["shoes", "Brown waterproof leather boots"],
      // Accessories by name.
      ["accessory", "Black canvas tote bag"],
      ["accessory", "Brown leather belt"],
    ]);
    const top = saved.items.find((entry) => entry.slot === "top");
    expect(top).toMatchObject({ itemId: sweater.id, category: "top", status: "confirmed", wearCount: 0, exists: true });
    expect(top?.thumbUrl).toMatch(/^https:\/\/example\.invalid\//);
    expect(await getOutfit(testDb.db, saved.id)).toEqual(saved);
  });

  it("allows a dress without a bottom, and stores an empty occasion as null", async () => {
    const [dress, boots] = await Promise.all([item("dress"), item("boots")]);
    const saved = await saveOutfit(
      testDb.db,
      input(
        [
          { slot: "top", itemId: dress.id },
          { slot: "shoes", itemId: boots.id },
        ],
        { occasion: "  ", weatherMinC: null, weatherMaxC: null, rating: null },
      ),
    );
    expect(saved).toMatchObject({ occasion: null, weatherMinC: null, weatherMaxC: null, rating: null });
  });

  it("refuses invalid combinations and archived items with the outfit's issues, writing nothing", async () => {
    const [sweater, oxford, jeans, archivedJeans, boots] = await Promise.all([
      item("sweater"),
      item("oxford"),
      item("jeans"),
      item("chinos", { status: "archived" }),
      item("boots"),
    ]);

    const twoTops = await appError(
      saveOutfit(
        testDb.db,
        input([
          { slot: "top", itemId: sweater.id },
          { slot: "top", itemId: oxford.id },
          { slot: "bottom", itemId: jeans.id },
        ]),
      ),
    );
    expect(twoTops.code).toBe("VALIDATION");
    expect(twoTops.details?.outfitIssues).toEqual([expect.objectContaining({ code: "slot_taken", slot: "top" })]);

    const noBottom = await appError(saveOutfit(testDb.db, input([{ slot: "top", itemId: sweater.id }])));
    expect(noBottom.details?.outfitIssues).toEqual([expect.objectContaining({ code: "missing_bottom" })]);

    const wrongSlot = await appError(
      saveOutfit(
        testDb.db,
        input([
          { slot: "top", itemId: sweater.id },
          { slot: "bottom", itemId: boots.id },
        ]),
      ),
    );
    expect(wrongSlot.details?.outfitIssues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "wrong_category", itemId: boots.id })]),
    );

    const archived = await appError(
      saveOutfit(
        testDb.db,
        input([
          { slot: "top", itemId: sweater.id },
          { slot: "bottom", itemId: archivedJeans.id },
        ]),
      ),
    );
    expect(archived.details?.outfitIssues).toEqual([expect.objectContaining({ code: "archived_item" })]);

    const missing = await appError(
      saveOutfit(
        testDb.db,
        input([
          { slot: "top", itemId: sweater.id },
          { slot: "bottom", itemId: MISSING_ID },
        ]),
      ),
    );
    expect(missing.details?.outfitIssues).toEqual([expect.objectContaining({ code: "unknown_item" })]);

    const badForm = await appError(
      saveOutfit(testDb.db, input([{ slot: "top", itemId: sweater.id }], { name: " ", weatherMinC: 12, weatherMaxC: 3 })),
    );
    expect(badForm.code).toBe("VALIDATION");
    expect(badForm.details?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "name" }), expect.objectContaining({ path: "weatherMaxC" })]),
    );

    expect(await counts()).toEqual({ outfits: 0, outfitItems: 0 });
  });

  it("replaces an outfit's fields and items in one transaction, keeping its source and reason", async () => {
    const [sweater, oxford, jeans, chinos] = await Promise.all([
      item("sweater"),
      item("oxford"),
      item("jeans"),
      item("chinos"),
    ]);
    const [ai] = await testDb.db
      .insert(outfits)
      .values({ name: "Suggested", source: "ai", aiReasoning: "Layers for wind." })
      .returning();
    if (ai === undefined) throw new Error("no outfit");
    await testDb.db.insert(outfitItems).values([
      { outfitId: ai.id, itemId: sweater.id, slot: "top" },
      { outfitId: ai.id, itemId: jeans.id, slot: "bottom" },
    ]);

    const edited = await saveOutfit(
      testDb.db,
      input(
        [
          { slot: "top", itemId: oxford.id },
          { slot: "bottom", itemId: chinos.id },
        ],
        { name: "Suggested, lighter" },
      ),
      ai.id,
    );
    expect(edited).toMatchObject({ id: ai.id, name: "Suggested, lighter", source: "ai", aiReasoning: "Layers for wind." });
    expect(edited.items.map((entry) => entry.itemId)).toEqual([oxford.id, chinos.id]);

    // An invalid edit leaves the stored outfit as it was.
    await testDb.db.update(items).set({ status: "archived" }).where(eq(items.id, chinos.id));
    const refused = await appError(
      saveOutfit(
        testDb.db,
        input(
          [
            { slot: "top", itemId: sweater.id },
            { slot: "bottom", itemId: chinos.id },
          ],
          { name: "Should not stick" },
        ),
        ai.id,
      ),
    );
    expect(refused.code).toBe("VALIDATION");
    const after = await getOutfit(testDb.db, ai.id);
    expect(after.name).toBe("Suggested, lighter");
    expect(after.items.map((entry) => entry.itemId)).toEqual([oxford.id, chinos.id]);

    expect((await appError(saveOutfit(testDb.db, input([]), MISSING_ID))).code).toBe("VALIDATION");
    expect(
      (
        await appError(
          saveOutfit(
            testDb.db,
            input([
              { slot: "top", itemId: sweater.id },
              { slot: "bottom", itemId: jeans.id },
            ]),
            MISSING_ID,
          ),
        )
      ).code,
    ).toBe("NOT_FOUND");
  });

  it("refuses running gear with a not_clothing issue on its slot, writing nothing (D-250)", async () => {
    const [sweater, runningTights] = await Promise.all([item("sweater"), item("jeans", { collection: "running" })]);

    const refused = await appError(
      saveOutfit(
        testDb.db,
        input([
          { slot: "top", itemId: sweater.id },
          { slot: "bottom", itemId: runningTights.id },
        ]),
      ),
    );
    expect(refused.code).toBe("VALIDATION");
    expect(refused.message).toBe("This item is running gear, which outfits leave out.");
    expect(refused.details?.outfitIssues).toEqual([
      {
        code: "not_clothing",
        slot: "bottom",
        itemId: runningTights.id,
        message: "This item is running gear, which outfits leave out.",
      },
    ]);
    expect(await counts()).toEqual({ outfits: 0, outfitItems: 0 });
  });

  it("keeps listing an item moved to running gear, and refuses a re-save until it is swapped out (D-250)", async () => {
    const [sweater, jeans, chinos] = await Promise.all([item("sweater"), item("jeans"), item("chinos")]);
    const entries: OutfitInputValues["items"] = [
      { slot: "top", itemId: sweater.id },
      { slot: "bottom", itemId: jeans.id },
    ];
    const saved = await saveOutfit(testDb.db, input(entries));
    expect(saved.items.map((entry) => entry.collection)).toEqual(["clothing", "clothing"]);

    await testDb.db.update(items).set({ collection: "running" }).where(eq(items.id, jeans.id));

    // The outfit still lists the piece, flagged by its collection.
    const moved = await getOutfit(testDb.db, saved.id);
    expect(moved.items.find((entry) => entry.itemId === jeans.id)).toMatchObject({
      slot: "bottom",
      collection: "running",
      status: "confirmed",
      exists: true,
    });
    const [listed] = await listOutfits(testDb.db);
    expect(listed?.items.map((entry) => [entry.itemId, entry.collection])).toEqual([
      [sweater.id, "clothing"],
      [jeans.id, "running"],
    ]);

    // Saved again unchanged: refused, and the stored outfit stays as it was.
    const refused = await appError(saveOutfit(testDb.db, input(entries, { name: "Should not stick" }), saved.id));
    expect(refused.code).toBe("VALIDATION");
    expect(refused.details?.outfitIssues).toEqual([
      expect.objectContaining({ code: "not_clothing", slot: "bottom", itemId: jeans.id }),
    ]);
    expect(await getOutfit(testDb.db, saved.id)).toEqual(moved);

    // Swapped for clothing, it saves.
    const swapped = await saveOutfit(
      testDb.db,
      input([
        { slot: "top", itemId: sweater.id },
        { slot: "bottom", itemId: chinos.id },
      ]),
      saved.id,
    );
    expect(swapped.items.map((entry) => entry.itemId)).toEqual([sweater.id, chinos.id]);
  });

  it("saves an AI suggestion with its source and reason", async () => {
    const [sweater, jeans] = await Promise.all([item("sweater"), item("jeans")]);
    const saved = await saveOutfit(
      testDb.db,
      input([
        { slot: "top", itemId: sweater.id },
        { slot: "bottom", itemId: jeans.id },
      ]),
      undefined,
      { source: "ai", aiReasoning: "Warm enough for 6 °C." },
    );
    expect(saved).toMatchObject({ source: "ai", aiReasoning: "Warm enough for 6 °C." });
  });
});

describe("listOutfits and deleteOutfit", () => {
  it("lists outfits newest first with how often each was worn", async () => {
    const [hamburg] = await testDb.db.insert(climateProfiles).values(HAMBURG).returning();
    if (hamburg === undefined) throw new Error("no profile");
    await testDb.db.insert(appSettings).values({ id: 1, homeProfileId: hamburg.id });
    const [sweater, jeans, oxford] = await Promise.all([item("sweater"), item("jeans"), item("oxford")]);
    const first = await saveOutfit(
      testDb.db,
      input([
        { slot: "top", itemId: sweater.id },
        { slot: "bottom", itemId: jeans.id },
      ], { name: "First" }),
    );
    const second = await saveOutfit(
      testDb.db,
      input([
        { slot: "top", itemId: oxford.id },
        { slot: "bottom", itemId: jeans.id },
      ], { name: "Second" }),
    );
    await testDb.db.update(outfits).set({ createdAt: new Date("2026-11-01T08:00:00Z") }).where(eq(outfits.id, first.id));
    await logWear(testDb.db, { kind: "outfit", outfitId: first.id, wornOn: "2026-11-02" }, { now: NOW });
    await logWear(testDb.db, { kind: "outfit", outfitId: first.id }, { now: NOW });

    const list = await listOutfits(testDb.db);
    expect(list.map((outfit) => outfit.name)).toEqual(["Second", "First"]);
    expect(list[1]).toMatchObject({ timesWorn: 2, lastWornOn: "2026-11-03" });
    expect(list[0]).toMatchObject({ timesWorn: 0, lastWornOn: null });
    expect(list[1]).not.toHaveProperty("notes");
    expect(list[1]?.items.find((entry) => entry.itemId === sweater.id)?.wearCount).toBe(2);
    expect(second.id).toBe(list[0]?.id);
  });

  it("deletes an outfit but keeps its items and their wear history", async () => {
    const [hamburg] = await testDb.db.insert(climateProfiles).values(HAMBURG).returning();
    if (hamburg === undefined) throw new Error("no profile");
    await testDb.db.insert(appSettings).values({ id: 1, homeProfileId: hamburg.id });
    const [sweater, jeans] = await Promise.all([item("sweater"), item("jeans")]);
    const saved = await saveOutfit(
      testDb.db,
      input([
        { slot: "top", itemId: sweater.id },
        { slot: "bottom", itemId: jeans.id },
      ]),
    );
    await logWear(testDb.db, { kind: "outfit", outfitId: saved.id }, { now: NOW });

    expect(await deleteOutfit(testDb.db, saved.id)).toEqual({ deleted: true });
    expect(await counts()).toEqual({ outfits: 0, outfitItems: 0 });
    expect(await testDb.db.select({ id: items.id }).from(items)).toHaveLength(2);
    const logs = await testDb.db.select().from(wearLogs);
    expect(logs).toHaveLength(2);
    expect(logs.every((log) => log.outfitId === null)).toBe(true);

    expect((await appError(deleteOutfit(testDb.db, saved.id))).code).toBe("NOT_FOUND");
    expect((await appError(getOutfit(testDb.db, saved.id))).code).toBe("NOT_FOUND");
    expect((await appError(getOutfit(testDb.db, "not-a-uuid"))).code).toBe("NOT_FOUND");
  });
});

describe("slot candidates", () => {
  it("lists a slot's non-archived items by name with search, thumbs and wear", async () => {
    const [sweater, oxford, dress] = await Promise.all([
      item("sweater", { wearCount: 3, lastWornAt: new Date("2026-10-30T11:00:00Z") }),
      item("oxford"),
      item("dress"),
      item("tee", { status: "archived" }),
      item("jeans"),
      makeItem(testDb.db),
    ]);
    await makeImage(testDb.db, oxford.id, { kind: "thumb" });

    const tops = await listSlotCandidates(testDb.db, "top");
    expect(tops.map((candidate) => candidate.name)).toEqual([
      "Black wool shift dress",
      "Grey merino crew-neck sweater",
      "Light blue oxford shirt",
    ]);
    expect(tops[1]).toMatchObject({
      id: sweater.id,
      category: "top",
      wearCount: 3,
      lastWornAt: "2026-10-30T11:00:00.000Z",
      location: "bologna",
      thumbUrl: null,
    });
    expect(tops[2]?.thumbUrl).toMatch(/^https:\/\/example\.invalid\//);
    expect((await listSlotCandidates(testDb.db, "top", "shift")).map((candidate) => candidate.id)).toEqual([dress.id]);
    // Colours count too, and LIKE wildcards are literal.
    expect((await listSlotCandidates(testDb.db, "top", "light blue")).map((candidate) => candidate.id)).toEqual([oxford.id]);
    expect(await listSlotCandidates(testDb.db, "top", "%")).toEqual([]);

    const bySlot = await listCandidatesBySlot(testDb.db);
    expect(bySlot.top.map((candidate) => candidate.id)).toEqual(tops.map((candidate) => candidate.id));
    expect(bySlot.bottom).toHaveLength(1);
    expect(bySlot.hat).toEqual([]);
  });

  it("leaves running gear out of every slot, searched or not (D-249)", async () => {
    const [sweater, jeans, runningTop, runningShoes] = await Promise.all([
      item("sweater"),
      item("jeans"),
      item("tee", { name: "Neon running tee", collection: "running" }),
      item("sneakers", { name: "Trail running shoes", collection: "running" }),
    ]);

    expect((await listSlotCandidates(testDb.db, "top")).map((candidate) => candidate.id)).toEqual([sweater.id]);
    expect(await listSlotCandidates(testDb.db, "top", "running")).toEqual([]);
    expect(await listSlotCandidates(testDb.db, "shoes")).toEqual([]);

    const bySlot = await listCandidatesBySlot(testDb.db);
    const offered = Object.values(bySlot).flatMap((candidates) => candidates.map((candidate) => candidate.id));
    expect(offered).not.toContain(runningTop.id);
    expect(offered).not.toContain(runningShoes.id);
    expect(bySlot.top.map((candidate) => candidate.id)).toEqual([sweater.id]);
    expect(bySlot.bottom.map((candidate) => candidate.id)).toEqual([jeans.id]);
    expect(bySlot.shoes).toEqual([]);

    // Moved back to clothing, the item is offered again.
    await testDb.db.update(items).set({ collection: "clothing" }).where(eq(items.id, runningShoes.id));
    expect((await listSlotCandidates(testDb.db, "shoes")).map((candidate) => candidate.id)).toEqual([runningShoes.id]);
  });
});
