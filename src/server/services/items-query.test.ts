import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyChip, chipCount, type ChipKey } from "@/components/wardrobe/category-chips";
import { ITEM_CATEGORIES } from "@/lib/db/enums";
import type { NewItem } from "@/lib/db/schema";
import {
  DEFAULT_ITEM_FILTERS,
  parseItemFilters,
  serializeItemFilters,
  type ItemFilters,
} from "@/lib/items/filters";
import { COLOR_FACET_MAX, WardrobeListDtoSchema } from "@/lib/items/wardrobe";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeImage, makeItem, makeTaggedItem } from "../../../test/factories";
import { escapeLikePattern, listWardrobeItems } from "./items-query";

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

function filters(overrides: Partial<ItemFilters> = {}): ItemFilters {
  return { ...DEFAULT_ITEM_FILTERS, ...overrides };
}

/** Distinct creation times, oldest first, so the default sort is predictable. */
let clock = 0;
function at(): Date {
  clock += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, clock));
}

function tagged(overrides: Partial<NewItem> = {}) {
  return makeTaggedItem(testDb.db, { createdAt: at(), ...overrides });
}

async function names(overrides: Partial<ItemFilters> = {}): Promise<string[]> {
  const list = await listWardrobeItems(testDb.db, filters(overrides));
  return list.items.map((item) => item.name ?? "(no name)");
}

/** The same names in any order. */
async function expectNames(overrides: Partial<ItemFilters>, expected: string[]): Promise<void> {
  expect((await names(overrides)).sort()).toEqual([...expected].sort());
}

describe("escapeLikePattern", () => {
  it("escapes the wildcards and the escape character itself", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
    expect(escapeLikePattern("back\\slash")).toBe("back\\\\slash");
    expect(escapeLikePattern("\\%")).toBe("\\\\\\%");
  });
});

describe("listWardrobeItems", () => {
  it("checks the session before reading anything", async () => {
    requireSession.mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Signed out."));
    await expect(listWardrobeItems(testDb.db, filters())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await tagged();
    await listWardrobeItems(testDb.db, filters());
    expect(requireSession).toHaveBeenCalledTimes(2);
  });

  it("maps a row to the tile DTO with its thumb and the multiple-items flag", async () => {
    const coat = await tagged({
      name: "Navy coat",
      wearCount: 3,
      decision: "bring",
      location: "hamburg",
      aiRaw: { multiple_items_detected: true },
    });
    await makeImage(testDb.db, coat.id, { kind: "processed", blobUrl: "https://store.example/processed.webp" });
    await makeImage(testDb.db, coat.id, {
      kind: "thumb",
      blobUrl: "https://store.example/thumb.webp",
      width: 400,
      height: 300,
    });
    // Only a processed image: no thumb yet.
    const plain = await tagged({ name: "Plain coat" });
    await makeImage(testDb.db, plain.id, { kind: "processed" });

    const list = await listWardrobeItems(testDb.db, filters());
    expect(WardrobeListDtoSchema.parse(list)).toEqual(list);
    expect(list.items).toHaveLength(2);
    const [plainTile, coatTile] = list.items;
    expect(coatTile).toEqual({
      id: coat.id,
      name: "Navy coat",
      category: "outerwear",
      subcategory: "coat",
      status: "tagged",
      decision: "bring",
      location: "hamburg",
      warmthLevel: 4,
      waterproof: false,
      windproof: true,
      insulated: true,
      colors: ["navy"],
      colorHex: ["#1f2a44"],
      wearCount: 3,
      multipleItemsDetected: true,
      thumb: { url: "https://store.example/thumb.webp", width: 400, height: 300 },
    });
    expect(plainTile).toMatchObject({ id: plain.id, thumb: null, multipleItemsDetected: false });
    expect(list).toMatchObject({ total: 2, capped: false });
  });

  describe("status", () => {
    it("hides archived items unless they are asked for", async () => {
      await tagged({ name: "Kept" });
      await makeItem(testDb.db, { name: "Waiting", createdAt: at() });
      await tagged({ name: "Confirmed", status: "confirmed" });
      await tagged({ name: "Archived", status: "archived" });

      await expectNames({}, ["Kept", "Waiting", "Confirmed"]);
      await expectNames({ status: ["archived"] }, ["Archived"]);
      await expectNames({ status: ["pending_tagging", "archived"] }, ["Waiting", "Archived"]);
    });

    it("counts the archived items the default view hides", async () => {
      await tagged({ name: "Archived", status: "archived" });
      await tagged({ name: "Archived too", status: "archived", category: "shoes" });
      const list = await listWardrobeItems(testDb.db, filters());
      expect(list).toMatchObject({ items: [], total: 0 });
      expect(list.counts).toMatchObject({ total: 0, archived: 2 });
    });
  });

  describe("each filter alone", () => {
    it("category", async () => {
      await tagged({ name: "Coat" });
      await tagged({ name: "Boots", category: "shoes" });
      await tagged({ name: "Scarf", category: "scarf" });
      await makeItem(testDb.db, { name: "Untagged", createdAt: at() });
      await expectNames({ category: ["shoes"] }, ["Boots"]);
      // Alternatives within a field; an item without a category never matches.
      await expectNames({ category: ["shoes", "scarf"] }, ["Boots", "Scarf"]);
    });

    it("season (any of the chosen seasons)", async () => {
      await tagged({ name: "Winter only", seasons: ["winter"] });
      await tagged({ name: "Summer only", seasons: ["summer"] });
      await tagged({ name: "Spring and autumn", seasons: ["spring", "autumn"] });
      await expectNames({ season: ["winter"] }, ["Winter only"]);
      await expectNames({ season: ["summer", "autumn"] }, ["Summer only", "Spring and autumn"]);
    });

    it("warmth bounds are inclusive and leave out items without a warmth", async () => {
      for (const level of [1, 2, 3, 4, 5]) await tagged({ name: `Warmth ${level}`, warmthLevel: level });
      await makeItem(testDb.db, { name: "No warmth", createdAt: at() });
      await expectNames({ warmthMin: 4 }, ["Warmth 4", "Warmth 5"]);
      await expectNames({ warmthMax: 2 }, ["Warmth 1", "Warmth 2"]);
      await expectNames({ warmthMin: 2, warmthMax: 3 }, ["Warmth 2", "Warmth 3"]);
      await expectNames({ warmthMin: 3, warmthMax: 3 }, ["Warmth 3"]);
    });

    it("waterproof and windproof (yes or no; untagged items match neither)", async () => {
      await tagged({ name: "Shell", waterproof: true, windproof: true });
      await tagged({ name: "Fleece", waterproof: false, windproof: false });
      await tagged({ name: "Softshell", waterproof: false, windproof: true });
      await makeItem(testDb.db, { name: "Untagged", createdAt: at() });
      await expectNames({ waterproof: true }, ["Shell"]);
      await expectNames({ waterproof: false }, ["Fleece", "Softshell"]);
      await expectNames({ windproof: true }, ["Shell", "Softshell"]);
      await expectNames({ windproof: false }, ["Fleece"]);
    });

    it("colour matches any of the item's colours, ignoring case", async () => {
      await tagged({ name: "Navy and grey", colors: ["Navy", "grey"], colorHex: ["#1f2a44", "#888888"] });
      await tagged({ name: "Red", colors: ["RED"], colorHex: ["#cc0000"] });
      await tagged({ name: "Light navy", colors: ["light navy"], colorHex: ["#4455aa"] });
      await expectNames({ color: ["navy"] }, ["Navy and grey"]);
      await expectNames({ color: ["grey", "red"] }, ["Navy and grey", "Red"]);
      await expectNames({ color: ["light navy"] }, ["Light navy"]);
    });

    it("formality, condition, location and decision", async () => {
      await tagged({ name: "Suit", formality: "business", condition: "new", location: "hamburg", decision: "bring" });
      await tagged({ name: "Hoodie", formality: "casual", condition: "worn", location: "bologna", decision: "donate" });
      await tagged({ name: "Jersey", formality: "athletic", condition: "needs_repair", location: "in_transit" });
      await expectNames({ formality: ["business"] }, ["Suit"]);
      await expectNames({ formality: ["casual", "athletic"] }, ["Hoodie", "Jersey"]);
      await expectNames({ condition: ["worn", "needs_repair"] }, ["Hoodie", "Jersey"]);
      await expectNames({ location: ["in_transit"] }, ["Jersey"]);
      await expectNames({ decision: ["undecided"] }, ["Jersey"]);
      await expectNames({ decision: ["bring", "donate"] }, ["Suit", "Hoodie"]);
    });
  });

  it("combines fields with AND", async () => {
    await tagged({ name: "Rain shell", waterproof: true, seasons: ["autumn", "spring"] });
    await tagged({ name: "Winter parka", waterproof: true, seasons: ["winter"], warmthLevel: 5 });
    await tagged({ name: "Rain boots", category: "shoes", waterproof: true, seasons: ["autumn"] });
    await tagged({ name: "Wool coat", waterproof: false, seasons: ["winter", "autumn"] });
    await expectNames({ category: ["outerwear"], waterproof: true }, ["Rain shell", "Winter parka"]);
    await expectNames({ category: ["outerwear"], waterproof: true, season: ["autumn"] }, ["Rain shell"]);
    await expectNames({ waterproof: true, warmthMin: 5, q: "parka" }, ["Winter parka"]);
    await expectNames({ season: ["autumn"], q: "rain" }, ["Rain shell", "Rain boots"]);
  });

  describe("search", () => {
    it("looks at name, description, brand, subcategory and notes, ignoring case", async () => {
      await tagged({ name: "Duffle coat" });
      await tagged({ name: "A", description: "Warm DUFFLE-style jacket" });
      await tagged({ name: "B", brand: "Duffleworks" });
      await tagged({ name: "C", subcategory: "duffle" });
      await tagged({ name: "D", notes: "my old duffle" });
      await tagged({ name: "E", description: "Something else" });
      await expectNames({ q: "duffle" }, ["Duffle coat", "A", "B", "C", "D"]);
    });

    it("matches any colour or material element, ignoring case", async () => {
      // The factory's description mentions navy wool; these rows must match on the arrays alone.
      const plain = { description: null, subcategory: null };
      await tagged({ ...plain, name: "Navy coat", colors: ["Navy"], colorHex: ["#1f2a44"], materials: ["wool"] });
      await tagged({ ...plain, name: "Base layer", colors: ["black"], materials: ["Merino Wool"] });
      await tagged({ ...plain, name: "Tee", colors: ["white"], materials: ["cotton"] });
      await expectNames({ q: "NAVY" }, ["Navy coat"]);
      await expectNames({ q: "merino" }, ["Base layer"]);
      await expectNames({ q: "wool" }, ["Navy coat", "Base layer"]);
    });

    it("treats % and _ as literal characters", async () => {
      await tagged({ name: "100% cotton tee" });
      await tagged({ name: "1000 thread shirt" });
      await tagged({ name: "a_b scarf" });
      await tagged({ name: "axb scarf" });
      // Unescaped, '%100%%' would also match "1000 thread shirt" and '%a_b%' "axb scarf".
      await expectNames({ q: "100%" }, ["100% cotton tee"]);
      await expectNames({ q: "a_b" }, ["a_b scarf"]);
      await expectNames({ q: "%" }, ["100% cotton tee"]);
      await expectNames({ q: "_" }, ["a_b scarf"]);
    });

    it("treats a backslash as a literal character", async () => {
      await tagged({ name: "back\\slash coat" });
      await tagged({ name: "packs coat" });
      // Unescaped, 'k\s' would mean 'ks' and match "packs coat" instead.
      await expectNames({ q: "k\\s" }, ["back\\slash coat"]);
      await expectNames({ q: "\\" }, ["back\\slash coat"]);
    });
  });

  describe("sort", () => {
    async function seedSortable() {
      const first = await tagged({ name: "Oldest, warmth 3, worn 5", warmthLevel: 3, wearCount: 5 });
      const second = await tagged({ name: "Warmth 5, worn 1", warmthLevel: 5, wearCount: 1 });
      const pending = await makeItem(testDb.db, { name: "Pending, no warmth", createdAt: at() });
      const third = await tagged({ name: "Warmth 1, worn 5", warmthLevel: 1, wearCount: 5 });
      const newest = await tagged({ name: "Newest, warmth 3, worn 0", warmthLevel: 3, wearCount: 0 });
      return { first, second, pending, third, newest };
    }

    async function ids(sort: ItemFilters["sort"]): Promise<string[]> {
      return (await listWardrobeItems(testDb.db, filters({ sort }))).items.map((item) => item.id);
    }

    it("orders by creation time either way", async () => {
      const { first, second, pending, third, newest } = await seedSortable();
      expect(await ids("created_desc")).toEqual([newest.id, third.id, pending.id, second.id, first.id]);
      expect(await ids("created_asc")).toEqual([first.id, second.id, pending.id, third.id, newest.id]);
    });

    it("orders by warmth with items without a warmth last, newest first on ties", async () => {
      const { first, second, pending, third, newest } = await seedSortable();
      expect(await ids("warmth_desc")).toEqual([second.id, newest.id, first.id, third.id, pending.id]);
      expect(await ids("warmth_asc")).toEqual([third.id, newest.id, first.id, second.id, pending.id]);
    });

    it("orders by wear count, newest first on ties", async () => {
      const { first, second, pending, third, newest } = await seedSortable();
      expect(await ids("wear_desc")).toEqual([third.id, first.id, second.id, newest.id, pending.id]);
    });

    it("breaks equal creation times by id, so the order is stable", async () => {
      const same = new Date(Date.UTC(2026, 5, 1));
      const a = await makeTaggedItem(testDb.db, { name: "Twin A", createdAt: same });
      const b = await makeTaggedItem(testDb.db, { name: "Twin B", createdAt: same });
      const [low, high] = [a.id, b.id].sort();
      expect(await ids("created_desc")).toEqual([high, low]);
      expect(await ids("created_asc")).toEqual([low, high]);
    });
  });

  describe("category counts", () => {
    it("ignore the category filter but honour every other filter", async () => {
      await tagged({ name: "Shell", waterproof: true });
      await tagged({ name: "Parka", waterproof: true });
      await tagged({ name: "Wool coat", waterproof: false });
      await tagged({ name: "Rain boots", category: "shoes", waterproof: true });
      await tagged({ name: "Sneakers", category: "shoes", waterproof: false });
      await tagged({ name: "Archived shell", waterproof: true, status: "archived" });
      await makeItem(testDb.db, { name: "Untagged", createdAt: at() });

      const all = await listWardrobeItems(testDb.db, filters());
      expect(all.counts.byCategory).toMatchObject({ outerwear: 3, shoes: 2, scarf: 0 });
      expect(all.counts).toMatchObject({ uncategorized: 1, total: 6 });

      const list = await listWardrobeItems(testDb.db, filters({ category: ["shoes"], waterproof: true }));
      expect(list.items.map((item) => item.name)).toEqual(["Rain boots"]);
      expect(list.total).toBe(1);
      // Outerwear still counted (category ignored), but only the waterproof ones
      // (waterproof honoured), and the untagged item no longer matches.
      expect(list.counts.byCategory).toMatchObject({ outerwear: 2, shoes: 1 });
      expect(list.counts).toMatchObject({ uncategorized: 0, total: 3 });

      const withArchived = await listWardrobeItems(
        testDb.db,
        filters({ waterproof: true, status: ["tagged", "archived"] }),
      );
      expect(withArchived.counts.byCategory).toMatchObject({ outerwear: 3, shoes: 1 });
    });

    it("count items without a category as uncategorized, and waiting items as untagged", async () => {
      await makeItem(testDb.db, { createdAt: at() });
      await makeItem(testDb.db, { createdAt: at() });
      await tagged();
      // The Untagged view lists the two waiting items; All and the categories
      // would go back to the default statuses, so they count the tagged coat too.
      const list = await listWardrobeItems(testDb.db, filters({ status: ["pending_tagging"] }));
      expect(list.items.map((item) => item.name)).toEqual([null, null]);
      expect(list.counts).toMatchObject({ uncategorized: 2, total: 3, untagged: 2, archived: 0 });
      expect(list.counts.byCategory.outerwear).toBe(1);
    });

    describe("each chip's badge is what the list shows with that chip alone on", () => {
      const CHIPS: readonly ChipKey[] = ["all", "untagged", ...ITEM_CATEGORIES];

      /** The canonical filters the page would parse from the URL. */
      function canon(value: ItemFilters): ItemFilters {
        return parseItemFilters(serializeItemFilters(value));
      }

      /** The filters with only `key` on, starting from `view`. */
      function soleChip(view: ItemFilters, key: ChipKey): ItemFilters {
        if (key === "untagged") return canon({ ...view, category: [], status: ["pending_tagging"] });
        const all = applyChip(view, "all");
        return canon(key === "all" ? all : { ...all, category: [key] });
      }

      async function mismatches(view: ItemFilters): Promise<string[]> {
        const list = await listWardrobeItems(testDb.db, canon(view));
        const wrong: string[] = [];
        for (const key of CHIPS) {
          const shown = (await listWardrobeItems(testDb.db, soleChip(view, key))).total;
          const badge = chipCount(list.counts, key);
          if (badge !== shown) wrong.push(`${key}: badge ${badge}, list ${shown}`);
        }
        return wrong;
      }

      beforeEach(async () => {
        await tagged({ name: "Boots A", category: "shoes", waterproof: true });
        await tagged({ name: "Boots B", category: "shoes" });
        await tagged({ name: "Parka", status: "confirmed", waterproof: true });
        await makeItem(testDb.db, { name: "Waiting", createdAt: at() });
        // Unarchiving an incomplete item returns it to waiting with its category kept.
        await tagged({ name: "Unarchived shell", status: "pending_tagging", waterproof: true });
        await makeItem(testDb.db, { name: "Archived blank", status: "archived", createdAt: at() });
        await tagged({ name: "Archived coat", status: "archived", waterproof: true });
      });

      it("in the default view, the Untagged view and an archived view", async () => {
        const untaggedView = canon(applyChip(DEFAULT_ITEM_FILTERS, "untagged"));
        expect(await mismatches(DEFAULT_ITEM_FILTERS)).toEqual([]);
        expect(await mismatches(untaggedView)).toEqual([]);
        expect(await mismatches(filters({ status: ["archived"] }))).toEqual([]);
        expect(await mismatches(filters({ status: ["tagged", "archived"] }))).toEqual([]);

        // With no category chosen, pressing an unpressed chip gives exactly that view.
        for (const view of [DEFAULT_ITEM_FILTERS, untaggedView, filters({ status: ["archived"] })]) {
          const list = await listWardrobeItems(testDb.db, view);
          for (const key of CHIPS.filter((chip) => chip !== "untagged" || view !== untaggedView)) {
            expect(chipCount(list.counts, key), `${key} from ${serializeItemFilters(view).toString()}`).toBe(
              (await listWardrobeItems(testDb.db, canon(applyChip(view, key)))).total,
            );
          }
        }

        // The archived view still offers Untagged for the items waiting for tags.
        const archived = await listWardrobeItems(testDb.db, filters({ status: ["archived"] }));
        expect(archived.counts).toMatchObject({ untagged: 2, archived: 2, total: 2, uncategorized: 1 });
      });

      it("with a category chosen, a search or another filter", async () => {
        expect(await mismatches(filters({ category: ["shoes"] }))).toEqual([]);
        expect(await mismatches(filters({ category: ["shoes"], status: ["pending_tagging"] }))).toEqual([]);
        expect(await mismatches(filters({ q: "boots" }))).toEqual([]);
        expect(await mismatches(filters({ waterproof: true, status: ["pending_tagging"] }))).toEqual([]);
      });
    });
  });

  describe("colour facet", () => {
    async function colourNames(overrides: Partial<ItemFilters> = {}): Promise<string[]> {
      const list = await listWardrobeItems(testDb.db, filters(overrides));
      return list.colors.map((option) => option.name);
    }

    beforeEach(async () => {
      await tagged({ name: "Navy coat" });
      await tagged({ name: "Black boots", category: "shoes", colors: ["black"], colorHex: ["#111111"] });
      await tagged({
        name: "Scarf",
        category: "scarf",
        colors: ["grey", "Navy"],
        colorHex: ["#888888", "#1f2a44"],
      });
      await tagged({ name: "White shirt", category: "top", colors: ["white"], colorHex: [] });
      await tagged({ name: "Red archived", status: "archived", colors: ["red"] });
    });

    it("lists the colours of every match, most common first, ignoring case", async () => {
      const list = await listWardrobeItems(testDb.db, filters());
      expect(list.colors).toEqual([
        { name: "navy", hex: "#1f2a44", count: 2 },
        { name: "black", hex: "#111111", count: 1 },
        { name: "grey", hex: "#888888", count: 1 },
        // No hex stored for it: no swatch.
        { name: "white", hex: null, count: 1 },
      ]);
    });

    it("ignores the colour filter itself, so choosing a colour keeps the others on offer", async () => {
      const list = await listWardrobeItems(testDb.db, filters({ color: ["navy"] }));
      expect(list.items.map((item) => item.name).sort()).toEqual(["Navy coat", "Scarf"]);
      expect(list.colors.map((option) => option.name)).toEqual(["navy", "black", "grey", "white"]);
    });

    it("honours every other filter, the category and status included", async () => {
      expect(await colourNames({ category: ["shoes"] })).toEqual(["black"]);
      expect(await colourNames({ category: ["shoes"], color: ["navy"] })).toEqual(["black"]);
      expect(await colourNames()).not.toContain("red");
      expect(await colourNames({ status: ["tagged", "archived"] })).toContain("red");
    });

    it("offers at most the most common colours, ties alphabetical", async () => {
      await testDb.truncateAll();
      for (let index = 0; index < COLOR_FACET_MAX + 4; index += 1) {
        await tagged({ colors: [`colour ${String(index).padStart(2, "0")}`], colorHex: [] });
      }
      await tagged({ colors: ["colour 27"], colorHex: [] });
      const names = await colourNames();
      expect(names).toHaveLength(COLOR_FACET_MAX);
      // The one colour on two items comes first; the rest are equally common.
      expect(names.slice(0, 3)).toEqual(["colour 27", "colour 00", "colour 01"]);
      expect(names.at(-1)).toBe("colour 22");
    });
  });

  it("answers a URL with a NUL in the search or a colour instead of failing", async () => {
    await tagged({ name: "Navy coat" });
    const parsed = parseItemFilters(new URLSearchParams("q=co%00at&color=na%00vy&color=%00"));
    const list = await listWardrobeItems(testDb.db, parsed);
    expect(list.items.map((item) => item.name)).toEqual(["Navy coat"]);
  });

  describe("limit", () => {
    it("caps the list and says how many match", async () => {
      for (let index = 0; index < 5; index += 1) await tagged({ name: `Coat ${index}` });
      await tagged({ name: "Boots", category: "shoes" });

      const capped = await listWardrobeItems(testDb.db, filters(), { limit: 3 });
      expect(capped.items.map((item) => item.name)).toEqual(["Boots", "Coat 4", "Coat 3"]);
      expect(capped).toMatchObject({ total: 6, capped: true });

      const narrowed = await listWardrobeItems(testDb.db, filters({ category: ["outerwear"] }), { limit: 3 });
      expect(narrowed).toMatchObject({ total: 5, capped: true });
      expect(narrowed.items).toHaveLength(3);
    });

    it("counts every match of a capped Untagged view, not the whole wardrobe", async () => {
      await makeItem(testDb.db, { createdAt: at() });
      await makeItem(testDb.db, { createdAt: at() });
      for (let index = 0; index < 3; index += 1) await tagged({ name: `Coat ${index}` });
      const list = await listWardrobeItems(testDb.db, filters({ status: ["pending_tagging"] }), { limit: 1 });
      expect(list).toMatchObject({ total: 2, capped: true });
      expect(list.counts.total).toBe(5);
    });

    it("is not capped when exactly the limit matches", async () => {
      for (let index = 0; index < 3; index += 1) await tagged({ name: `Coat ${index}` });
      const list = await listWardrobeItems(testDb.db, filters(), { limit: 3 });
      expect(list).toMatchObject({ total: 3, capped: false });
      expect(list.items).toHaveLength(3);
    });
  });
});
