import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { aiBatches, items, type Item } from "@/lib/db/schema";
import type { ItemPatch } from "@/lib/items/contracts";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeImage, makeItem, makeTaggedItem, TAGGED_ITEM_FIELDS } from "../../../test/factories";
import { createFakeAnthropic, fakeMessage } from "../../../test/fakes/anthropic";
import { COAT_TAGS } from "../../../test/fixtures/item-tags";
import { confirmItem, confirmItems, missingTagFields, tagItemByHand, updateItem } from "./items";
import { tagItem } from "./tag-item";

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

/** A tagged item whose columns match its ai_raw (COAT_TAGS), as tagging leaves it. */
function makeTaggedCoat(overrides: Parameters<typeof makeTaggedItem>[1] = {}): Promise<Item> {
  return makeTaggedItem(testDb.db, {
    name: COAT_TAGS.name,
    subcategory: COAT_TAGS.subcategory,
    colors: COAT_TAGS.colors,
    colorHex: COAT_TAGS.color_hex,
    materials: COAT_TAGS.materials,
    warmthLevel: COAT_TAGS.warmth_level,
    waterproof: COAT_TAGS.waterproof,
    windproof: COAT_TAGS.windproof,
    insulated: COAT_TAGS.insulated,
    breathable: COAT_TAGS.breathable,
    seasons: COAT_TAGS.seasons,
    formality: COAT_TAGS.formality,
    condition: COAT_TAGS.condition,
    description: COAT_TAGS.description,
    aiRaw: COAT_TAGS,
    aiConfidence: COAT_TAGS.confidence,
    ...overrides,
  });
}

async function row(id: string): Promise<Item> {
  const [found] = await testDb.db.select().from(items).where(eq(items.id, id));
  if (found === undefined) throw new Error(`item ${id} is gone`);
  return found;
}

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected an AppError");
}

describe("updateItem", () => {
  it("saves the patch and records the tag fields that differ from Claude's", async () => {
    const item = await makeTaggedCoat();
    const card = await updateItem(testDb.db, item.id, {
      name: "Winter coat",
      warmth_level: COAT_TAGS.warmth_level,
      seasons: ["winter", "autumn"],
      notes: "Dry clean only",
      location: "hamburg",
    });

    expect(card).toMatchObject({
      id: item.id,
      name: "Winter coat",
      notes: "Dry clean only",
      location: "hamburg",
      userEditedFields: ["name"],
      status: "tagged",
    });
    const saved = await row(item.id);
    expect(saved.userEditedFields).toEqual(["name"]);
    expect(saved.seasons).toEqual(["winter", "autumn"]);
    expect(saved.updatedAt.getTime()).toBeGreaterThanOrEqual(item.updatedAt.getTime());
  });

  it("adds to earlier edits instead of replacing them", async () => {
    const item = await makeTaggedCoat({ userEditedFields: ["pattern"] });
    await updateItem(testDb.db, item.id, { condition: "worn" });
    await updateItem(testDb.db, item.id, { name: COAT_TAGS.name });
    expect((await row(item.id)).userEditedFields).toEqual(["pattern", "condition"]);
  });

  it("records every tag field of a patch on an item that has no tags yet", async () => {
    const item = await makeItem(testDb.db);
    const card = await updateItem(testDb.db, item.id, { name: "Grey scarf", category: "scarf", size: "one size" });
    expect(card).toMatchObject({ status: "pending_tagging", name: "Grey scarf", category: "scarf", size: "one size" });
    expect((await row(item.id)).userEditedFields).toEqual(["name", "category"]);
  });

  it("refuses an invalid patch and leaves the row alone", async () => {
    const item = await makeTaggedCoat();
    // colors without color_hex would misalign the parallel lists.
    const patch = { colors: ["black"] } as ItemPatch;
    const error = await appError(updateItem(testDb.db, item.id, patch));
    expect(error.code).toBe("VALIDATION");
    expect(error.details?.issues).toEqual([{ path: "color_hex", message: "Send colors and color_hex together." }]);
    expect((await row(item.id)).colors).toEqual(COAT_TAGS.colors);
  });

  it("answers NOT_FOUND for an unknown or malformed id", async () => {
    expect((await appError(updateItem(testDb.db, randomUUID(), { name: "x" }))).code).toBe("NOT_FOUND");
    expect((await appError(updateItem(testDb.db, "not-a-uuid", { name: "x" }))).code).toBe("NOT_FOUND");
  });

  it("refuses a patch that would leave a tagged item without a required tag", async () => {
    // Only a hand-edited row can lack a name; the check still answers VALIDATION, not a 500.
    const item = await makeTaggedCoat({ name: null });
    const error = await appError(updateItem(testDb.db, item.id, { notes: "x" }));
    expect(error.code).toBe("VALIDATION");
    expect(error.details?.missing).toEqual(["name"]);
  });

  it("checks the session before touching the database", async () => {
    const item = await makeTaggedCoat();
    requireSession.mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Signed out."));
    expect((await appError(updateItem(testDb.db, item.id, { name: "x" }))).code).toBe("UNAUTHENTICATED");
    expect((await row(item.id)).name).toBe(COAT_TAGS.name);
  });
});

describe("confirmItem", () => {
  it("confirms a tagged item", async () => {
    const item = await makeTaggedCoat();
    const card = await confirmItem(testDb.db, item.id);
    expect(card.status).toBe("confirmed");
    expect(card.userEditedFields).toEqual([]);
  });

  it("applies a patch in the same update and records the edits", async () => {
    const item = await makeTaggedCoat();
    const card = await confirmItem(testDb.db, item.id, { waterproof: true, decision: "bring" });
    expect(card).toMatchObject({ status: "confirmed", waterproof: true, decision: "bring", userEditedFields: ["waterproof"] });
  });

  it("is idempotent for a confirmed item", async () => {
    const item = await makeTaggedCoat({ status: "confirmed" });
    expect((await confirmItem(testDb.db, item.id, { brand: "Hackett" })).status).toBe("confirmed");
  });

  it("refuses an item that has no tags yet, even with a patch", async () => {
    const item = await makeItem(testDb.db);
    const error = await appError(confirmItem(testDb.db, item.id, { name: "Scarf" }));
    expect(error.code).toBe("VALIDATION");
    expect(error.details).toMatchObject({ status: "pending_tagging" });
    const saved = await row(item.id);
    expect(saved.status).toBe("pending_tagging");
    expect(saved.name).toBeNull();
  });

  it("refuses an archived item", async () => {
    const item = await makeTaggedCoat({ status: "archived" });
    expect((await appError(confirmItem(testDb.db, item.id))).code).toBe("VALIDATION");
    expect((await row(item.id)).status).toBe("archived");
  });

  it("refuses a tagged item with an incomplete tag set", async () => {
    const item = await makeTaggedCoat({ name: null, colors: [], colorHex: [] });
    const error = await appError(confirmItem(testDb.db, item.id));
    expect(error.code).toBe("VALIDATION");
    expect(error.details?.missing).toEqual(["name", "colors"]);
    expect((await row(item.id)).status).toBe("tagged");
  });

  it("accepts the patch that completes the tag set", async () => {
    const item = await makeTaggedCoat({ name: null });
    expect((await confirmItem(testDb.db, item.id, { name: "Navy coat" })).status).toBe("confirmed");
  });
});

describe("tagItemByHand", () => {
  /** Every required tag and a season, plus optional fields left empty. */
  const HAND_TAGS = {
    name: "Grey wool scarf",
    category: "scarf",
    colors: ["grey", "white"],
    color_hex: ["#808080", "#ffffff"],
    warmth_level: 3,
    waterproof: false,
    windproof: true,
    insulated: false,
    seasons: ["winter"],
    formality: "casual",
    condition: "good",
    subcategory: "  ",
    materials: [],
    breathable: null,
    brand: null,
    fit: "",
    description: "",
    notes: "From the market in Bologna",
  } satisfies ItemPatch;

  async function batchedItem(): Promise<Item> {
    const [batch] = await testDb.db
      .insert(aiBatches)
      .values({ anthropicBatchId: "msgbatch_hand", purpose: "tagging", model: "claude-haiku-5-5", requestCount: 1 })
      .returning();
    return makeItem(testDb.db, { taggingBatchId: batch?.id ?? null });
  }

  /** What the form sends for HAND_TAGS when the owner switched windproof on and left the other defaults alone. */
  const LEFT_AT_START = ["warmth_level", "waterproof", "insulated", "breathable"] as const;

  it("tags a pending item from the owner's values and records the fields they set, not the defaults they left", async () => {
    const item = await makeItem(testDb.db, { taggingError: "Claude declined to tag this photo." });

    const card = await tagItemByHand(testDb.db, item.id, HAND_TAGS, { confirm: false, uncheckedDefaults: LEFT_AT_START });

    expect(card).toMatchObject({
      id: item.id,
      status: "tagged",
      name: "Grey wool scarf",
      colors: ["grey", "white"],
      colorHex: ["#808080", "#ffffff"],
      waterproof: false,
      notes: "From the market in Bologna",
      taggingError: null,
      aiModel: null,
      aiConfidence: null,
    });
    const saved = await row(item.id);
    expect(saved).toMatchObject({ status: "tagged", aiRaw: null, aiModel: null, aiConfidence: null, taggingError: null });
    // The defaults left alone are stored (the tagged CHECK needs them) but not marked (D-232).
    expect(saved).toMatchObject({ warmthLevel: 3, waterproof: false, insulated: false, breathable: null });
    // Empty optional fields and non-tag fields are not recorded either.
    expect(saved.userEditedFields).toEqual([
      "name",
      "category",
      "colors",
      "color_hex",
      "windproof",
      "seasons",
      "formality",
      "condition",
    ]);
  });

  it("records the defaults the owner kept, breathable's Unknown included", async () => {
    const item = await makeItem(testDb.db);
    await tagItemByHand(testDb.db, item.id, HAND_TAGS, { confirm: false, uncheckedDefaults: [] });
    // false and, for breathable, null are values once the owner kept them.
    expect((await row(item.id)).userEditedFields).toEqual([
      "name",
      "category",
      "colors",
      "color_hex",
      "warmth_level",
      "waterproof",
      "windproof",
      "insulated",
      "breathable",
      "seasons",
      "formality",
      "condition",
    ]);
  });

  it("records an optional tag field that has a value", async () => {
    const item = await makeItem(testDb.db);
    await tagItemByHand(testDb.db, item.id, { ...HAND_TAGS, brand: "Hackett", breathable: true, materials: ["wool"] }, {
      confirm: false,
      uncheckedDefaults: ["warmth_level"],
    });
    expect((await row(item.id)).userEditedFields).toEqual(
      expect.arrayContaining(["materials", "breathable", "brand"]),
    );
  });

  it("confirms in the same step", async () => {
    const item = await makeItem(testDb.db);
    const card = await tagItemByHand(testDb.db, item.id, HAND_TAGS, { confirm: true, uncheckedDefaults: LEFT_AT_START });
    expect(card.status).toBe("confirmed");
    expect((await row(item.id)).status).toBe("confirmed");
  });

  it("keeps an earlier mark on a field now listed as a default left alone", async () => {
    const item = await makeItem(testDb.db, { userEditedFields: ["warmth_level"] });
    await tagItemByHand(testDb.db, item.id, HAND_TAGS, { confirm: false, uncheckedDefaults: LEFT_AT_START });
    expect((await row(item.id)).userEditedFields).toContain("warmth_level");
  });

  it.each([
    ["a field the form has no default for", { uncheckedDefaults: ["name"] }],
    ["a field twice", { uncheckedDefaults: ["warmth_level", "warmth_level"] }],
  ])("refuses a list that names %s and changes nothing", async (_label, { uncheckedDefaults }) => {
    const item = await makeItem(testDb.db);
    const error = await appError(
      // Deliberately malformed: only the action's schema stands between a client and this call.
      tagItemByHand(testDb.db, item.id, HAND_TAGS, { confirm: false, uncheckedDefaults: uncheckedDefaults as never }),
    );
    expect(error.code).toBe("VALIDATION");
    expect(error.details?.issues).toEqual([expect.objectContaining({ path: expect.stringMatching(/^uncheckedDefaults/) })]);
    expect(await row(item.id)).toMatchObject({ status: "pending_tagging", name: null, userEditedFields: [] });
  });

  it("refuses a default left alone whose value is not the form's default, and changes nothing", async () => {
    const item = await makeItem(testDb.db);
    const patch: ItemPatch = { ...HAND_TAGS, warmth_level: 4, breathable: true };
    delete patch.waterproof;

    const error = await appError(
      tagItemByHand(testDb.db, item.id, patch, {
        confirm: false,
        uncheckedDefaults: ["warmth_level", "waterproof", "insulated", "breathable"],
      }),
    );

    expect(error.code).toBe("VALIDATION");
    // insulated is false in the patch, so only the other three do not match.
    expect(error.details).toEqual({ uncheckedDefaults: ["warmth_level", "waterproof", "breathable"] });
    expect(await row(item.id)).toMatchObject({ status: "pending_tagging", warmthLevel: null, userEditedFields: [] });
  });

  it("uses tag fields saved on the item earlier and keeps their marks", async () => {
    const item = await makeItem(testDb.db);
    await updateItem(testDb.db, item.id, { name: "Scarf from Nonna" });
    const withoutName: ItemPatch = { ...HAND_TAGS };
    delete withoutName.name;

    const card = await tagItemByHand(testDb.db, item.id, withoutName, { confirm: false, uncheckedDefaults: LEFT_AT_START });

    expect(card).toMatchObject({ status: "tagged", name: "Scarf from Nonna" });
    expect((await row(item.id)).userEditedFields).toContain("name");
  });

  it.each([
    ["a required tag", "warmth_level", ["warmth_level"]],
    ["a season", "seasons", ["seasons"]],
    ["the colours", "colors", ["colors"]],
  ] as const)("refuses a patch without %s and changes nothing", async (_label, left, missing) => {
    const item = await makeItem(testDb.db, { taggingError: "Claude declined to tag this photo." });
    const patch: ItemPatch = { ...HAND_TAGS };
    delete patch[left];
    if (left === "colors") delete patch.color_hex;

    const error = await appError(tagItemByHand(testDb.db, item.id, patch, { confirm: true, uncheckedDefaults: [] }));

    expect(error.code).toBe("VALIDATION");
    expect(error.details).toEqual({ itemId: item.id, missing });
    expect(await row(item.id)).toMatchObject({
      status: "pending_tagging",
      name: null,
      userEditedFields: [],
      taggingError: "Claude declined to tag this photo.",
    });
  });

  it("refuses an invalid patch", async () => {
    const item = await makeItem(testDb.db);
    const error = await appError(
      tagItemByHand(testDb.db, item.id, { ...HAND_TAGS, seasons: [] } as ItemPatch, { confirm: false, uncheckedDefaults: [] }),
    );
    expect(error.code).toBe("VALIDATION");
    expect((await row(item.id)).status).toBe("pending_tagging");
  });

  it("refuses an item that waits in a batch", async () => {
    const item = await batchedItem();
    const error = await appError(tagItemByHand(testDb.db, item.id, HAND_TAGS, { confirm: false, uncheckedDefaults: [] }));
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toMatch(/waiting in a tagging batch/);
    expect((await row(item.id)).status).toBe("pending_tagging");
  });

  it.each([
    ["a tagged item", { ...TAGGED_ITEM_FIELDS, status: "tagged" as const }],
    ["a confirmed item", { ...TAGGED_ITEM_FIELDS, status: "confirmed" as const }],
    ["a pending item that has Claude's output", { aiRaw: COAT_TAGS }],
  ])("refuses %s", async (_label, overrides) => {
    const item = await makeItem(testDb.db, overrides);
    const before = await row(item.id);

    const error = await appError(tagItemByHand(testDb.db, item.id, HAND_TAGS, { confirm: false, uncheckedDefaults: [] }));

    expect(error.code).toBe("CONFLICT");
    expect(error.message).toBe("This item already has tags. Reload the page to see them.");
    expect(await row(item.id)).toEqual(before);
  });

  it("answers NOT_FOUND for an unknown or malformed id", async () => {
    expect((await appError(tagItemByHand(testDb.db, randomUUID(), HAND_TAGS, { confirm: false, uncheckedDefaults: [] }))).code).toBe(
      "NOT_FOUND",
    );
    expect((await appError(tagItemByHand(testDb.db, "not-a-uuid", HAND_TAGS, { confirm: false, uncheckedDefaults: [] }))).code).toBe(
      "NOT_FOUND",
    );
  });

  it("checks the session before touching the database", async () => {
    const item = await makeItem(testDb.db);
    requireSession.mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Signed out."));
    expect((await appError(tagItemByHand(testDb.db, item.id, HAND_TAGS, { confirm: true, uncheckedDefaults: [] }))).code).toBe(
      "UNAUTHENTICATED",
    );
    expect((await row(item.id)).status).toBe("pending_tagging");
  });

  // D-232 end to end: the hand-tagging service, then a Re-tag through the real
  // tagging service, with the fake Anthropic client answering COAT_TAGS.
  it("lets a later Re-tag replace the defaults left alone and keeps the values the owner chose or kept", async () => {
    const item = await makeItem(testDb.db);
    await makeImage(testDb.db, item.id, {
      kind: "processed",
      contentType: "image/webp",
      blobUrl: `https://fakestore.public.blob.vercel-storage.com/items/${item.id}/processed-abc123.webp`,
    });
    // As the form sends it: insulated switched on (a choice), windproof left
    // off but kept with Keep, warmth, waterproof and breathable left alone.
    await tagItemByHand(testDb.db, item.id, { ...HAND_TAGS, windproof: false, insulated: true }, {
      confirm: true,
      uncheckedDefaults: ["warmth_level", "waterproof", "breathable"],
    });
    const edited = (await row(item.id)).userEditedFields;
    expect(edited).toEqual(expect.arrayContaining(["windproof", "insulated"]));
    expect(edited).not.toEqual(expect.arrayContaining(["warmth_level"]));

    const fake = createFakeAnthropic([fakeMessage({ json: COAT_TAGS })]);
    const result = await tagItem(
      {
        db: testDb.db,
        anthropic: () => fake,
        fetch: vi.fn<typeof fetch>(async () => new Response(new Uint8Array(Buffer.from("fake webp")), { status: 200 })),
        sleep: async () => {},
        random: () => 0.5,
      },
      item.id,
      { force: true },
    );

    expect(result.cached).toBe(false);
    expect(fake.requests).toHaveLength(1);
    expect(await row(item.id)).toMatchObject({
      // Left alone: Claude's values replace the form's defaults (warmth 3, breathable unknown).
      warmthLevel: COAT_TAGS.warmth_level,
      breathable: COAT_TAGS.breathable,
      waterproof: COAT_TAGS.waterproof,
      // Chosen or kept: the owner's values stay against Claude's insulated false and windproof true.
      insulated: true,
      windproof: false,
      name: HAND_TAGS.name,
      category: HAND_TAGS.category,
      status: "confirmed",
      aiRaw: COAT_TAGS,
      userEditedFields: edited,
    });
    expect([COAT_TAGS.warmth_level, COAT_TAGS.breathable, COAT_TAGS.insulated, COAT_TAGS.windproof]).toEqual([
      4,
      true,
      false,
      true,
    ]);
  });
});

describe("confirmItems", () => {
  it("confirms only the items that are still tagged", async () => {
    const first = await makeTaggedCoat();
    const second = await makeTaggedCoat();
    const pending = await makeItem(testDb.db);
    const confirmed = await makeTaggedCoat({ status: "confirmed" });
    const archived = await makeTaggedCoat({ status: "archived" });
    const known = [first.id, second.id, pending.id, confirmed.id, archived.id];

    expect(await confirmItems(testDb.db, [...known, randomUUID(), "bad-id"])).toEqual({ confirmed: 2 });

    const rows = await testDb.db
      .select({ id: items.id, status: items.status })
      .from(items)
      .where(inArray(items.id, known));
    const statuses = Object.fromEntries(rows.map((entry) => [entry.id, entry.status]));
    expect(statuses).toEqual({
      [first.id]: "confirmed",
      [second.id]: "confirmed",
      [pending.id]: "pending_tagging",
      [confirmed.id]: "confirmed",
      [archived.id]: "archived",
    });
  });

  it("does nothing for an empty or unknown list", async () => {
    expect(await confirmItems(testDb.db, [])).toEqual({ confirmed: 0 });
    expect(await confirmItems(testDb.db, [randomUUID()])).toEqual({ confirmed: 0 });
  });
});

describe("missingTagFields", () => {
  it("lists the required tags a row lacks", () => {
    expect(missingTagFields(TAGGED_ITEM_FIELDS)).toEqual([]);
    expect(
      missingTagFields({ ...TAGGED_ITEM_FIELDS, name: " ", category: null, seasons: [], warmthLevel: null, condition: null }),
    ).toEqual(["name", "category", "warmth_level", "seasons", "condition"]);
  });
});
