import { describe, expect, it } from "vitest";

import {
  activeFilterCount,
  DEFAULT_ITEM_FILTERS,
  DEFAULT_SORT,
  DEFAULT_STATUSES,
  hasActiveFilters,
  isUntaggedView,
  ITEM_FILTER_LIMITS,
  ITEM_FILTER_PARAMS,
  itemFiltersKey,
  parseItemFilters,
  serializeItemFilters,
  statusesAfterChip,
  type ItemFilters,
} from "./filters";

const FULL: ItemFilters = {
  q: "wool coat 100%",
  category: ["outerwear", "shoes", "scarf"],
  season: ["winter", "autumn"],
  warmthMin: 3,
  warmthMax: 5,
  waterproof: true,
  windproof: false,
  color: ["black", "dark green", "navy"],
  formality: ["casual", "smart_casual"],
  condition: ["good", "worn"],
  location: ["bologna", "in_transit"],
  decision: ["bring", "undecided"],
  status: ["tagged", "confirmed", "archived"],
  sort: "warmth_desc",
};

function withFilters(patch: Partial<ItemFilters>): ItemFilters {
  return { ...DEFAULT_ITEM_FILTERS, ...patch };
}

describe("parseItemFilters and serializeItemFilters", () => {
  it("round-trips a fully populated filter set", () => {
    const params = serializeItemFilters(FULL);
    const parsed = parseItemFilters(params);
    expect(parsed).toEqual(FULL);
    expect(serializeItemFilters(parsed).toString()).toBe(params.toString());
    // Keys come out in the documented order, arrays as repeated keys.
    expect([...new Set(params.keys())]).toEqual(ITEM_FILTER_PARAMS);
    expect(params.getAll("category")).toEqual(["outerwear", "shoes", "scarf"]);
    expect(params.toString()).toBe(
      "q=wool+coat+100%25&category=outerwear&category=shoes&category=scarf&season=winter&season=autumn" +
        "&warmthMin=3&warmthMax=5&waterproof=true&windproof=false&color=black&color=dark+green&color=navy" +
        "&formality=casual&formality=smart_casual&condition=good&condition=worn&location=bologna" +
        "&location=in_transit&decision=bring&decision=undecided&status=tagged&status=confirmed" +
        "&status=archived&sort=warmth_desc",
    );
  });

  it("round-trips the defaults through an empty query string", () => {
    const parsed = parseItemFilters(new URLSearchParams(""));
    expect(parsed).toEqual(DEFAULT_ITEM_FILTERS);
    expect(parsed.status).toEqual(DEFAULT_STATUSES);
    expect(parsed.sort).toBe(DEFAULT_SORT);
    expect(serializeItemFilters(parsed).toString()).toBe("");
    expect(itemFiltersKey(DEFAULT_ITEM_FILTERS)).toBe("");
    expect(parseItemFilters({})).toEqual(DEFAULT_ITEM_FILTERS);
  });

  it("re-serializes a parsed URL byte for byte", () => {
    const messy = new URLSearchParams(
      "sort=wear_desc&color=Navy&category=shoes&q=%20boots%20&category=outerwear&status=archived&extra=1",
    );
    const once = serializeItemFilters(parseItemFilters(messy)).toString();
    const twice = serializeItemFilters(parseItemFilters(new URLSearchParams(once))).toString();
    expect(twice).toBe(once);
    expect(once).toBe("q=boots&category=outerwear&category=shoes&color=navy&status=archived&sort=wear_desc");
  });

  it("reads a Next searchParams record with string and string[] values", () => {
    const parsed = parseItemFilters({
      q: "parka",
      category: ["shoes", "outerwear"],
      season: "winter",
      waterproof: "true",
      color: ["Black", "navy"],
      sort: "created_asc",
      missing: undefined,
    });
    expect(parsed).toEqual(
      withFilters({
        q: "parka",
        category: ["outerwear", "shoes"],
        season: ["winter"],
        waterproof: true,
        color: ["black", "navy"],
        sort: "created_asc",
      }),
    );
  });

  it("drops invalid values and keeps the valid ones", () => {
    const parsed = parseItemFilters(
      new URLSearchParams(
        "category=hat&category=shoes&season=monsoon&warmthMin=7&warmthMax=0&waterproof=yes&windproof=1" +
          "&formality=black_tie&condition=broken&location=paris&decision=maybe&status=deleted&sort=random",
      ),
    );
    expect(parsed).toEqual(withFilters({ category: ["shoes"] }));
  });

  it("rejects warmth values that only look numeric", () => {
    for (const value of ["3.0", " 3", "03", "3a", "", "-1", "6"]) {
      expect(parseItemFilters({ warmthMin: value }).warmthMin).toBeNull();
    }
    expect(parseItemFilters({ warmthMin: "1", warmthMax: "5" })).toMatchObject({ warmthMin: 1, warmthMax: 5 });
  });

  it("swaps a reversed warmth range", () => {
    expect(parseItemFilters({ warmthMin: "5", warmthMax: "2" })).toMatchObject({ warmthMin: 2, warmthMax: 5 });
    expect(serializeItemFilters(withFilters({ warmthMin: 4, warmthMax: 1 })).toString()).toBe(
      "warmthMin=1&warmthMax=4",
    );
  });

  it("keeps one open-ended warmth bound", () => {
    expect(parseItemFilters({ warmthMax: "2" })).toMatchObject({ warmthMin: null, warmthMax: 2 });
  });

  it("excludes archived by default and includes it when asked", () => {
    expect(parseItemFilters({}).status).not.toContain("archived");
    expect(parseItemFilters({ status: "archived" }).status).toEqual(["archived"]);
    expect(parseItemFilters({ status: ["archived", "confirmed"] }).status).toEqual(["confirmed", "archived"]);
    // Only invalid statuses: back to the default set.
    expect(parseItemFilters({ status: "deleted" }).status).toEqual(DEFAULT_STATUSES);
  });

  it("omits the default statuses whatever their order", () => {
    const reordered = withFilters({ status: ["confirmed", "pending_tagging", "tagged"] });
    expect(serializeItemFilters(reordered).has("status")).toBe(false);
    expect(serializeItemFilters(withFilters({ status: [] })).has("status")).toBe(false);
  });

  it("trims and caps the search text", () => {
    expect(parseItemFilters({ q: "   down parka  " }).q).toBe("down parka");
    expect(parseItemFilters({ q: "   " }).q).toBe("");
    const long = parseItemFilters({ q: "x".repeat(250) }).q;
    expect(long).toHaveLength(ITEM_FILTER_LIMITS.qMax);
    // A cut that lands after a space leaves no trailing whitespace.
    expect(parseItemFilters({ q: `${"a".repeat(99)} bcd` }).q).toBe("a".repeat(99));
    // A cut inside an emoji drops the half pair instead of keeping a lone surrogate.
    const emoji = parseItemFilters({ q: `${"a".repeat(99)}\u{1F9E5}` }).q;
    expect(emoji).toBe("a".repeat(99));
    expect(parseItemFilters({ q: ["first", "second"] }).q).toBe("first");
  });

  it("collapses duplicate values", () => {
    const parsed = parseItemFilters(
      new URLSearchParams("category=shoes&category=shoes&season=winter&season=winter&color=navy&color=NAVY&color= navy "),
    );
    expect(parsed.category).toEqual(["shoes"]);
    expect(parsed.season).toEqual(["winter"]);
    expect(parsed.color).toEqual(["navy"]);
  });

  it("lowercases, sorts and caps colours", () => {
    const parsed = parseItemFilters({ color: ["Red", "BLUE", "", "  ", "x".repeat(41)] });
    expect(parsed.color).toEqual(["blue", "red"]);
    const many = Array.from({ length: 15 }, (_, index) => `c${String(index).padStart(2, "0")}`).reverse();
    const capped = parseItemFilters({ color: many }).color;
    expect(capped).toHaveLength(ITEM_FILTER_LIMITS.colorsMax);
    expect(capped[0]).toBe("c00");
  });

  it("normalises filters built by hand before writing them", () => {
    const handMade = withFilters({ q: "  coat ", category: ["shoes", "outerwear", "shoes"], color: ["Navy", "black"] });
    expect(serializeItemFilters(handMade).toString()).toBe(
      "q=coat&category=outerwear&category=shoes&color=black&color=navy",
    );
  });

  it("ignores unknown keys", () => {
    expect(parseItemFilters({ page: "2", utm_source: "x", Category: "shoes" })).toEqual(DEFAULT_ITEM_FILTERS);
  });

  it("drops NUL characters, which Postgres text cannot hold, from the search and colours", () => {
    const parsed = parseItemFilters(new URLSearchParams("q=a%00b&color=r%00ed&color=%00"));
    expect(parsed.q).toBe("ab");
    expect(parsed.color).toEqual(["red"]);
    const once = serializeItemFilters(parsed).toString();
    expect(once).toBe("q=ab&color=red");
    expect(serializeItemFilters(parseItemFilters(new URLSearchParams(once))).toString()).toBe(once);

    const onlyNul = parseItemFilters({ q: " \u0000 " });
    expect(onlyNul.q).toBe("");
    expect(hasActiveFilters(onlyNul)).toBe(false);
    // Serialising filters built by hand drops it too.
    expect(serializeItemFilters(withFilters({ q: "co\u0000at", color: ["na\u0000vy"] })).toString()).toBe(
      "q=coat&color=navy",
    );
  });
});

describe("isUntaggedView and statusesAfterChip", () => {
  it("is the Untagged view only with no category chosen", () => {
    expect(isUntaggedView(withFilters({ status: ["pending_tagging"] }))).toBe(true);
    expect(isUntaggedView(withFilters({ status: ["pending_tagging"], category: ["shoes"] }))).toBe(false);
    expect(isUntaggedView(withFilters({ status: ["pending_tagging", "tagged"] }))).toBe(false);
    expect(isUntaggedView(DEFAULT_ITEM_FILTERS)).toBe(false);
  });

  it("goes back to the default statuses only when leaving the Untagged view", () => {
    expect(statusesAfterChip(withFilters({ status: ["pending_tagging"] }))).toEqual([...DEFAULT_STATUSES]);
    expect(statusesAfterChip(withFilters({ status: ["archived"] }))).toEqual(["archived"]);
    expect(statusesAfterChip(withFilters({ status: ["pending_tagging"], category: ["shoes"] }))).toEqual([
      "pending_tagging",
    ]);
  });
});

describe("hasActiveFilters and activeFilterCount", () => {
  it("is inactive for the defaults and for a sort change alone", () => {
    expect(hasActiveFilters(DEFAULT_ITEM_FILTERS)).toBe(false);
    expect(activeFilterCount(DEFAULT_ITEM_FILTERS)).toBe(0);
    expect(hasActiveFilters(withFilters({ sort: "wear_desc" }))).toBe(false);
  });

  it("counts search and category as active but not in the panel badge", () => {
    const filters = withFilters({ q: "coat", category: ["outerwear"] });
    expect(hasActiveFilters(filters)).toBe(true);
    expect(activeFilterCount(filters)).toBe(0);
  });

  it("counts each panel field once", () => {
    expect(activeFilterCount(withFilters({ season: ["winter", "autumn"] }))).toBe(1);
    expect(activeFilterCount(withFilters({ warmthMin: 2, warmthMax: 4 }))).toBe(1);
    expect(activeFilterCount(withFilters({ warmthMax: 4 }))).toBe(1);
    expect(activeFilterCount(withFilters({ waterproof: false }))).toBe(1);
    expect(activeFilterCount(withFilters({ status: ["archived"] }))).toBe(1);
    expect(activeFilterCount(withFilters({ status: ["tagged", "confirmed", "pending_tagging"] }))).toBe(0);
    expect(hasActiveFilters(withFilters({ status: ["archived"] }))).toBe(true);
    expect(activeFilterCount(FULL)).toBe(10);
  });
});
