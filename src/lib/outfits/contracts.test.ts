import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ITEM_CATEGORIES,
  OUTFIT_SLOTS,
  type ItemCategory,
  type ItemCollection,
  type ItemStatus,
  type OutfitSlot,
} from "@/lib/db/enums";
import {
  MAX_ACCESSORIES,
  MAX_OUTFIT_ITEMS,
  NOT_CLOTHING_MESSAGE,
  OUTFIT_ISSUE_CODES,
  outfitItemProblem,
  OutfitInputSchema,
  SLOT_CATEGORIES,
  SLOT_LABELS,
  SLOT_ORDER,
  slotForCategory,
  sortBySlot,
  validateOutfit,
  type OutfitCheckItem,
  type OutfitEntry,
  type OutfitInputValues,
} from "@/lib/outfits/contracts";

function item(
  category: ItemCategory | null,
  status: ItemStatus = "confirmed",
  collection: ItemCollection = "clothing",
): OutfitCheckItem {
  return { id: randomUUID(), category, status, collection };
}

/** Entries plus the item map for [slot, item] pairs. */
function outfit(...pairs: [OutfitSlot, OutfitCheckItem][]) {
  const entries: OutfitEntry[] = pairs.map(([slot, entry]) => ({ slot, itemId: entry.id }));
  const items = new Map(pairs.map(([, entry]) => [entry.id, entry]));
  return { entries, items };
}

function codes(result: ReturnType<typeof validateOutfit>): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe("slots", () => {
  it("maps every slot to its categories, a dress to the top slot and a bag to accessories (D-038)", () => {
    expect(SLOT_CATEGORIES.top).toEqual(["top", "dress"]);
    expect(SLOT_CATEGORIES.accessory).toEqual(["accessory", "bag"]);
    expect(SLOT_CATEGORIES.hat).toEqual(["hat_beanie"]);
    expect(SLOT_CATEGORIES.base_layer).toEqual(["base_layer"]);
    expect(Object.keys(SLOT_CATEGORIES).sort()).toEqual([...OUTFIT_SLOTS].sort());
  });

  it("gives every category but other exactly one slot", () => {
    for (const category of ITEM_CATEGORIES) {
      const slots = OUTFIT_SLOTS.filter((slot) => SLOT_CATEGORIES[slot].includes(category));
      expect(slots, category).toHaveLength(category === "other" ? 0 : 1);
      expect(slotForCategory(category)).toBe(slots[0] ?? null);
    }
  });

  it("orders and labels every slot once", () => {
    expect([...SLOT_ORDER].sort()).toEqual([...OUTFIT_SLOTS].sort());
    expect(SLOT_ORDER.slice(0, 4)).toEqual(["outerwear", "top", "base_layer", "bottom"]);
    for (const slot of OUTFIT_SLOTS) expect(SLOT_LABELS[slot]).toMatch(/^[A-Z]/);
  });

  it("sorts entries by slot order and keeps the order within a slot", () => {
    const sorted = sortBySlot([
      { slot: "accessory", itemId: "a1" },
      { slot: "shoes", itemId: "s" },
      { slot: "accessory", itemId: "a2" },
      { slot: "outerwear", itemId: "o" },
      { slot: "top", itemId: "t" },
    ]);
    expect(sorted.map((entry) => entry.itemId)).toEqual(["o", "t", "s", "a1", "a2"]);
  });
});

describe("validateOutfit", () => {
  const top = item("top");
  const bottom = item("bottom");
  const shoes = item("shoes");

  it("accepts a top, a bottom and shoes", () => {
    const { entries, items } = outfit(["top", top], ["bottom", bottom], ["shoes", shoes]);
    expect(validateOutfit(entries, items)).toEqual({ ok: true });
  });

  it("accepts a full cold-weather outfit with a base layer and three accessories", () => {
    const { entries, items } = outfit(
      ["outerwear", item("outerwear")],
      ["base_layer", item("base_layer")],
      ["top", top],
      ["bottom", bottom],
      ["shoes", shoes],
      ["hat", item("hat_beanie")],
      ["gloves", item("gloves")],
      ["scarf", item("scarf")],
      ["accessory", item("accessory")],
      ["accessory", item("bag")],
      ["accessory", item("accessory")],
    );
    expect(validateOutfit(entries, items)).toEqual({ ok: true });
  });

  it("accepts a dress without a bottom, and a dress with one", () => {
    const dress = item("dress");
    const alone = outfit(["top", dress], ["shoes", shoes]);
    expect(validateOutfit(alone.entries, alone.items)).toEqual({ ok: true });
    const withBottom = outfit(["top", dress], ["bottom", bottom], ["shoes", shoes]);
    expect(validateOutfit(withBottom.entries, withBottom.items)).toEqual({ ok: true });
  });

  it("does not require shoes or outerwear", () => {
    const { entries, items } = outfit(["top", top], ["bottom", bottom]);
    expect(validateOutfit(entries, items).ok).toBe(true);
  });

  it("needs a top", () => {
    const { entries, items } = outfit(["bottom", bottom], ["shoes", shoes]);
    expect(codes(validateOutfit(entries, items))).toEqual(["missing_top"]);
  });

  it("needs a bottom with a top that is not a dress", () => {
    const { entries, items } = outfit(["top", top], ["shoes", shoes]);
    const result = validateOutfit(entries, items);
    expect(codes(result)).toEqual(["missing_bottom"]);
    expect(result.ok ? null : result.issues[0]).toMatchObject({ slot: "bottom", message: "Choose a bottom, or a dress as the top." });
  });

  it("reports an empty outfit as missing both", () => {
    expect(codes(validateOutfit([], new Map()))).toEqual(["missing_top", "missing_bottom"]);
  });

  it("rejects two tops, naming the second", () => {
    const second = item("top");
    const { entries, items } = outfit(["top", top], ["top", second], ["bottom", bottom]);
    const result = validateOutfit(entries, items);
    expect(codes(result)).toEqual(["slot_taken"]);
    expect(result.ok ? null : result.issues[0]).toMatchObject({ slot: "top", itemId: second.id });
  });

  it.each(["outerwear", "base_layer", "bottom", "shoes", "hat", "gloves", "scarf"] as const)(
    "rejects a second item in %s",
    (slot) => {
      const category = SLOT_CATEGORIES[slot][0] ?? "other";
      const pairs: [OutfitSlot, OutfitCheckItem][] = [["top", top], ["bottom", bottom], [slot, item(category)]];
      // The bottom slot is already filled once above.
      if (slot !== "bottom") pairs.push([slot, item(category)]);
      const { entries, items } = outfit(...pairs);
      expect(codes(validateOutfit(entries, items))).toEqual(["slot_taken"]);
    },
  );

  it(`allows ${MAX_ACCESSORIES} accessories and rejects each one more`, () => {
    const accessories = Array.from({ length: MAX_ACCESSORIES + 2 }, () => item("accessory"));
    const { entries, items } = outfit(["top", top], ["bottom", bottom], ...accessories.map((entry) => ["accessory", entry] as [OutfitSlot, OutfitCheckItem]));
    const result = validateOutfit(entries, items);
    expect(codes(result)).toEqual(["too_many_accessories", "too_many_accessories"]);
    expect(result.ok ? [] : result.issues.map((issue) => issue.itemId)).toEqual([accessories[3]?.id, accessories[4]?.id]);
  });

  it.each([
    ["a dress in bottom", "bottom", "dress"],
    ["shoes in top", "top", "shoes"],
    ["a bag in hat", "hat", "bag"],
    ["a base layer in top", "top", "base_layer"],
    ["other in accessory", "accessory", "other"],
  ] as const)("rejects %s as wrong_category", (_label, slot, category) => {
    const wrong = item(category);
    const pairs: [OutfitSlot, OutfitCheckItem][] = [[slot, wrong]];
    if (slot !== "top") pairs.push(["top", top]);
    if (slot !== "bottom") pairs.push(["bottom", bottom]);
    const { entries, items } = outfit(...pairs);
    const result = validateOutfit(entries, items);
    expect(codes(result)).toContain("wrong_category");
    expect(result.ok ? null : result.issues.find((issue) => issue.code === "wrong_category")).toMatchObject({
      slot,
      itemId: wrong.id,
    });
  });

  it("rejects an untagged item (no category) as wrong_category", () => {
    const { entries, items } = outfit(["top", top], ["bottom", bottom], ["shoes", item(null, "pending_tagging")]);
    expect(codes(validateOutfit(entries, items))).toEqual(["wrong_category"]);
  });

  it("rejects archived and missing items", () => {
    const archived = item("shoes", "archived");
    const { entries, items } = outfit(["top", top], ["bottom", bottom], ["shoes", archived]);
    const missingId = randomUUID();
    const result = validateOutfit([...entries, { slot: "outerwear", itemId: missingId }], items);
    expect(result.ok ? [] : result.issues.map(({ code, itemId }) => ({ code, itemId }))).toEqual([
      { code: "archived_item", itemId: archived.id },
      { code: "unknown_item", itemId: missingId },
    ]);
  });

  it("rejects running gear with exactly a not_clothing issue on its slot (D-250)", () => {
    const runningShoes = item("shoes", "confirmed", "running");
    const { entries, items } = outfit(["top", top], ["bottom", bottom], ["shoes", runningShoes]);
    expect(validateOutfit(entries, items)).toEqual({
      ok: false,
      issues: [
        {
          code: "not_clothing",
          slot: "shoes",
          itemId: runningShoes.id,
          message: "This item is running gear, which outfits leave out.",
        },
      ],
    });
  });

  it("reports an archived running item as archived and not clothing, and still checks its category", () => {
    const archivedRunning = item("shoes", "archived", "running");
    const { entries, items } = outfit(["top", archivedRunning], ["bottom", bottom]);
    const result = validateOutfit(entries, items);
    expect(result.ok ? [] : result.issues.map(({ code, slot, itemId }) => ({ code, slot, itemId }))).toEqual([
      { code: "archived_item", slot: "top", itemId: archivedRunning.id },
      { code: "not_clothing", slot: "top", itemId: archivedRunning.id },
      { code: "wrong_category", slot: "top", itemId: archivedRunning.id },
    ]);
  });

  it("still names a collection the database knows before this code does (D-248)", () => {
    // A value added to the enum ahead of the code that labels it: still not clothing, still a message.
    const cycling = { ...item("shoes", "confirmed"), collection: "cycling" as unknown as ItemCollection };
    const { entries, items } = outfit(["top", top], ["bottom", bottom], ["shoes", cycling]);
    expect(validateOutfit(entries, items)).toEqual({
      ok: false,
      issues: [
        { code: "not_clothing", slot: "shoes", itemId: cycling.id, message: "This item is not clothing, which outfits leave out." },
      ],
    });
  });

  it("lists not_clothing right after archived_item, with a message for every other collection", () => {
    expect(OUTFIT_ISSUE_CODES.indexOf("not_clothing")).toBe(OUTFIT_ISSUE_CODES.indexOf("archived_item") + 1);
    expect(NOT_CLOTHING_MESSAGE.running).toMatch(/^[A-Z].*\.$/);
  });

  it("rejects an item listed twice, even in another slot, without a slot_taken for it", () => {
    const { entries, items } = outfit(["top", top], ["bottom", bottom]);
    const result = validateOutfit([...entries, { slot: "accessory", itemId: top.id }], items);
    expect(codes(result)).toEqual(["duplicate_item"]);
  });

  it("treats a missing top-slot item as not a dress, so the bottom is still required", () => {
    const result = validateOutfit([{ slot: "top", itemId: randomUUID() }], new Map());
    expect(codes(result)).toEqual(["unknown_item", "missing_bottom"]);
  });

  it(`rejects more than ${MAX_OUTFIT_ITEMS} items`, () => {
    const accessories = Array.from({ length: 11 }, () => item("accessory"));
    const { entries, items } = outfit(["top", top], ["bottom", bottom], ...accessories.map((entry) => ["accessory", entry] as [OutfitSlot, OutfitCheckItem]));
    expect(entries).toHaveLength(13);
    expect(codes(validateOutfit(entries, items))).toContain("too_many_items");
  });

  it("gives every issue a plain English message", () => {
    const { entries, items } = outfit(["top", item("shoes", "archived", "running")], ["top", top]);
    const result = validateOutfit(entries, items);
    expect(result.ok).toBe(false);
    for (const issue of result.ok ? [] : result.issues) expect(issue.message).toMatch(/^[A-Z].*\.$/);
  });
});

describe("outfitItemProblem", () => {
  const usable = { exists: true, status: "confirmed", collection: "clothing" } as const;

  it("finds nothing wrong with a clothing item that exists and is not archived", () => {
    expect(outfitItemProblem(usable)).toBeNull();
    expect(outfitItemProblem({ ...usable, status: "pending_tagging" })).toBeNull();
  });

  it("names the first problem: deleted, then archived, then not clothing", () => {
    expect(outfitItemProblem({ exists: false, status: null, collection: null })).toBe("deleted");
    expect(outfitItemProblem({ exists: false, status: "archived", collection: "running" })).toBe("deleted");
    expect(outfitItemProblem({ exists: true, status: "archived", collection: "running" })).toBe("archived");
    expect(outfitItemProblem({ ...usable, status: "archived" })).toBe("archived");
    expect(outfitItemProblem({ ...usable, collection: "running" })).toBe("not_clothing");
  });

  it("counts an unknown collection as clothing", () => {
    expect(outfitItemProblem({ ...usable, collection: null })).toBeNull();
  });
});

describe("OutfitInputSchema", () => {
  const valid: OutfitInputValues = {
    name: "  Rainy commute  ",
    occasion: "  ",
    weatherMinC: 2,
    weatherMaxC: 9.5,
    rainOk: true,
    rating: 4,
    notes: " Good on the bike. ",
    items: [
      { slot: "top", itemId: randomUUID() },
      { slot: "bottom", itemId: randomUUID() },
    ],
  };

  it("trims the text and turns an empty occasion into null", () => {
    const parsed = OutfitInputSchema.parse(valid);
    expect(parsed).toMatchObject({ name: "Rainy commute", occasion: null, notes: "Good on the bike.", weatherMaxC: 9.5 });
    expect(OutfitInputSchema.parse({ ...valid, occasion: " Office " }).occasion).toBe("Office");
  });

  it("accepts null temperatures and rating", () => {
    const parsed = OutfitInputSchema.parse({ ...valid, weatherMinC: null, weatherMaxC: null, rating: null });
    expect(parsed).toMatchObject({ weatherMinC: null, weatherMaxC: null, rating: null });
  });

  it("keeps one decimal exact, allowing float noise", () => {
    expect(OutfitInputSchema.parse({ ...valid, weatherMinC: 0.1 * 3 }).weatherMinC).toBe(0.3);
    expect(OutfitInputSchema.parse({ ...valid, weatherMinC: -40, weatherMaxC: 50 })).toMatchObject({ weatherMinC: -40, weatherMaxC: 50 });
  });

  it.each([
    ["an empty name", { name: "   " }],
    ["an 81-character name", { name: "x".repeat(81) }],
    ["an 81-character occasion", { occasion: "x".repeat(81) }],
    ["two decimals", { weatherMinC: 2.25 }],
    ["below -40 °C", { weatherMinC: -40.1 }],
    ["above 50 °C", { weatherMaxC: 50.5 }],
    ["min above max", { weatherMinC: 10, weatherMaxC: 9 }],
    ["rating 0", { rating: 0 }],
    ["rating 6", { rating: 6 }],
    ["rating 3.5", { rating: 3.5 }],
    ["1,001 characters of notes", { notes: "x".repeat(1001) }],
    ["no items", { items: [] }],
    ["13 items", { items: Array.from({ length: 13 }, () => ({ slot: "accessory", itemId: randomUUID() })) }],
    ["an unknown slot", { items: [{ slot: "socks", itemId: randomUUID() }] }],
    ["a non-uuid item id", { items: [{ slot: "top", itemId: "i1" }] }],
    ["an unknown key", { extra: true }],
  ])("rejects %s", (_label, change) => {
    expect(OutfitInputSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });

  it("points a reversed range at weatherMaxC", () => {
    const result = OutfitInputSchema.safeParse({ ...valid, weatherMinC: 10, weatherMaxC: 9 });
    expect(result.success ? [] : result.error.issues.map((issue) => issue.path.join("."))).toEqual(["weatherMaxC"]);
  });
});
