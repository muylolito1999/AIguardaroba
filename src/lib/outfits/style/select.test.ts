import { describe, expect, it } from "vitest";

import { sortBySlot, validateOutfit } from "@/lib/outfits/contracts";
import { assessLayering, footwearKind, topKind, wardrobeCounts } from "@/lib/outfits/style/layering";
import { seededRandom } from "@/lib/outfits/style/random";
import { coreItems, repairOutfit, scoreOutfit } from "@/lib/outfits/style/score";
import { keepsDry, selectSuggestions } from "@/lib/outfits/style/select";
import {
  DIRECTION_KEYS,
  EMPTY_HISTORY,
  type Candidate,
  type DirectionKey,
  type SelectionContext,
  type StyleEntry,
  type StyleItem,
  type VarietyHistory,
} from "@/lib/outfits/style/types";
import { keepsDry as weatherKeepsDry } from "@/lib/outfits/style/weather";
import type { WeatherSnapshot } from "@/lib/weather/open-meteo";

import { checkMap, entriesOf, makeStyleItem, styleMap } from "../../../../test/style-fixtures";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A dry, calm November day that feels like minC to maxC. */
function day(minC: number, maxC: number, overrides: Partial<WeatherSnapshot> = {}): WeatherSnapshot {
  return {
    date: "2026-11-06",
    timezone: "Europe/Berlin",
    currentC: (minC + maxC) / 2,
    tminC: minC,
    tmaxC: maxC,
    apparentMinC: minC,
    apparentMaxC: maxC,
    precipSumMm: 0,
    precipProbMax: 0,
    windGustMaxKmh: 10,
    weatherCode: 3,
    label: "Overcast",
    fetchedAt: "2026-11-06T07:00:00.000Z",
    ...overrides,
  };
}

const RAIN = { precipProbMax: 80, precipSumMm: 5, weatherCode: 61, label: "Rain" } as const;

/** A realistic wardrobe of 23 pieces; no season tags except the sandals, so off-season costs stay out of the way. */
function wardrobe() {
  const item = (id: string, overrides: Partial<StyleItem>) => makeStyleItem({ id, seasons: [], ...overrides });
  return {
    teeWhite: item("tee-white", { subcategory: "t-shirt", colors: ["white"], colorHex: ["#f5f5f2"], warmthLevel: 1 }),
    teeNavy: item("tee-navy", { subcategory: "t-shirt", colors: ["navy"], colorHex: ["#1f2a44"], warmthLevel: 1 }),
    teeRed: item("tee-red", { subcategory: "t-shirt", colors: ["red"], colorHex: ["#b3261e"], warmthLevel: 1 }),
    longSleeve: item("tee-long-grey", { subcategory: "long sleeve", colors: ["grey"], colorHex: ["#8a8d91"], warmthLevel: 2 }),
    oxford: item("shirt-oxford", {
      subcategory: "oxford shirt",
      colors: ["light blue"],
      colorHex: ["#a7c7e7"],
      formality: "smart_casual",
      warmthLevel: 2,
    }),
    hoodie: item("hoodie-grey", { subcategory: "hoodie", colors: ["heather grey"], colorHex: ["#a7a9ac"], warmthLevel: 3 }),
    sweater: item("sweater-navy", {
      subcategory: "crew neck sweater",
      colors: ["navy"],
      colorHex: ["#1f2a44"],
      formality: "smart_casual",
      warmthLevel: 3,
      materials: ["wool"],
    }),
    jeans: item("jeans", { category: "bottom", subcategory: "jeans", colors: ["denim"], colorHex: ["#3d5a80"], warmthLevel: 2 }),
    chinos: item("chinos", {
      category: "bottom",
      subcategory: "chinos",
      colors: ["beige"],
      colorHex: ["#d8c3a5"],
      formality: "smart_casual",
      warmthLevel: 2,
    }),
    trousers: item("trousers-wool", {
      category: "bottom",
      subcategory: "wool trousers",
      colors: ["charcoal"],
      colorHex: ["#3b3e42"],
      formality: "business",
      warmthLevel: 3,
    }),
    dress: item("dress-midi", {
      category: "dress",
      subcategory: "midi dress",
      colors: ["olive"],
      colorHex: ["#556b2f"],
      formality: "smart_casual",
      warmthLevel: 2,
    }),
    sneakers: item("sneakers", { category: "shoes", subcategory: "sneakers", colors: ["white"], colorHex: ["#f5f5f2"], warmthLevel: 2 }),
    chelsea: item("boots-chelsea", {
      category: "shoes",
      subcategory: "chelsea boots",
      colors: ["brown"],
      colorHex: ["#6b4a2f"],
      formality: "smart_casual",
      warmthLevel: 3,
    }),
    rainBoots: item("boots-rain", {
      category: "shoes",
      subcategory: "rain boots",
      colors: ["black"],
      colorHex: ["#111111"],
      warmthLevel: 3,
      waterproof: true,
    }),
    derbies: item("derbies", {
      category: "shoes",
      subcategory: "derby shoes",
      colors: ["black"],
      colorHex: ["#111111"],
      formality: "business",
      warmthLevel: 2,
    }),
    sandals: item("sandals", {
      category: "shoes",
      subcategory: "sandals",
      colors: ["tan"],
      colorHex: ["#d2b48c"],
      warmthLevel: 1,
      seasons: ["summer"],
    }),
    woolSocks: item("socks-wool", {
      category: "socks",
      subcategory: "wool socks",
      colors: ["grey"],
      colorHex: ["#8a8d91"],
      warmthLevel: 3,
      materials: ["wool"],
    }),
    dressSocks: item("socks-dress", {
      category: "socks",
      subcategory: "dress socks",
      colors: ["navy"],
      colorHex: ["#1f2a44"],
      formality: "business",
      warmthLevel: 1,
    }),
    runSocks: item("socks-run", {
      category: "socks",
      subcategory: "running socks",
      colors: ["white"],
      colorHex: ["#f5f5f2"],
      formality: "athletic",
      warmthLevel: 1,
    }),
    cottonSocks: item("socks-cotton", { category: "socks", subcategory: "socks", colors: ["black"], colorHex: ["#111111"], warmthLevel: 1 }),
    shell: item("jacket-rain", {
      category: "outerwear",
      subcategory: "rain jacket",
      colors: ["olive"],
      colorHex: ["#556b2f"],
      warmthLevel: 2,
      waterproof: true,
      windproof: true,
    }),
    coat: item("coat-wool", {
      category: "outerwear",
      subcategory: "wool coat",
      colors: ["camel"],
      colorHex: ["#c19a6b"],
      formality: "smart_casual",
      warmthLevel: 4,
      materials: ["wool"],
    }),
    scarf: item("scarf-wool", { category: "scarf", subcategory: "scarf", colors: ["grey"], colorHex: ["#8a8d91"], warmthLevel: 3 }),
  };
}

const W = wardrobe();
const ALL = Object.values(W);

function selection(
  items: readonly StyleItem[] = ALL,
  weather: WeatherSnapshot = day(6, 12),
  history: VarietyHistory = EMPTY_HISTORY,
  count = 3,
): SelectionContext {
  return { items: styleMap(...items), checkItems: checkMap(...items), weather, history, count };
}

function candidate(index: number, entries: StyleEntry[], overrides: Partial<Candidate> = {}): Candidate {
  return { index, direction: null, title: `Outfit ${index}`, why: "Works for the day.", rain_ok: false, entries, ...overrides };
}

/** Three sound outfits with no core piece in common. */
function threeGood(): Candidate[] {
  return [
    candidate(0, entriesOf(["mid_layer", W.hoodie], ["top", W.teeWhite], ["bottom", W.jeans], ["shoes", W.sneakers], ["socks", W.runSocks])),
    candidate(1, entriesOf(["outerwear", W.coat], ["mid_layer", W.sweater], ["top", W.oxford], ["bottom", W.chinos], ["shoes", W.chelsea], ["socks", W.woolSocks])),
    candidate(2, entriesOf(["top", W.longSleeve], ["bottom", W.trousers], ["shoes", W.derbies], ["socks", W.dressSocks])),
  ];
}

function okResult(result: ReturnType<typeof selectSuggestions>) {
  if (!result.ok) throw new Error(`expected ok, got: ${result.detail}`);
  return result;
}

const itemSetKey = (entries: readonly StyleEntry[]) =>
  entries
    .map((entry) => entry.itemId)
    .sort()
    .join(",");

// ---------------------------------------------------------------------------
// keepsDry
// ---------------------------------------------------------------------------

describe("keepsDry", () => {
  const items = styleMap(...ALL, { ...W.coat, id: "coat-unknown-flag", waterproof: null });

  it.each<[string, StyleEntry[], boolean]>([
    ["a waterproof jacket", entriesOf(["outerwear", W.shell], ["top", W.teeWhite], ["bottom", W.jeans], ["shoes", W.sneakers]), true],
    ["a coat over waterproof boots", entriesOf(["outerwear", W.coat], ["top", W.teeWhite], ["bottom", W.jeans], ["shoes", W.rainBoots]), true],
    ["waterproof boots without outerwear", entriesOf(["top", W.teeWhite], ["bottom", W.jeans], ["shoes", W.rainBoots]), false],
    ["a coat over sneakers", entriesOf(["outerwear", W.coat], ["top", W.teeWhite], ["bottom", W.jeans], ["shoes", W.sneakers]), false],
    ["an unknown waterproof flag", [{ slot: "outerwear", itemId: "coat-unknown-flag" }, ...entriesOf(["top", W.teeWhite])], false],
    ["nothing to keep the rain off", entriesOf(["top", W.teeWhite], ["bottom", W.jeans]), false],
  ])("%s: %s", (_label, entries, expected) => {
    expect(keepsDry(entries, items)).toBe(expected);
  });

  it("is the weather library's, which the rain penalty reads too", () => {
    expect(keepsDry).toBe(weatherKeepsDry);
  });
});

// ---------------------------------------------------------------------------
// Properties over random candidates
// ---------------------------------------------------------------------------

describe("selectSuggestions properties", () => {
  const tops = [W.teeWhite, W.teeNavy, W.teeRed, W.longSleeve, W.oxford, W.hoodie, W.sweater, W.dress];
  const layerable = [W.teeWhite, W.oxford, W.hoodie, W.sweater];
  const bottoms = [W.jeans, W.chinos, W.trousers];
  const shoes = [W.sneakers, W.chelsea, W.rainBoots, W.derbies, W.sandals];
  const socks = [W.woolSocks, W.dressSocks, W.runSocks, W.cottonSocks];
  const outers = [W.shell, W.coat];

  function randomCandidates(seed: number, count: number): Candidate[] {
    const random = seededRandom(seed);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
    const maybe = (chance: number) => random() < chance;
    return Array.from({ length: count }, (_, index) => {
      const entries: StyleEntry[] = [{ slot: "top", itemId: pick(tops).id }];
      if (maybe(0.4)) entries.push({ slot: "mid_layer", itemId: pick(layerable).id });
      if (maybe(0.9)) entries.push({ slot: "bottom", itemId: pick(bottoms).id });
      if (maybe(0.8)) entries.push({ slot: "shoes", itemId: pick(shoes).id });
      if (maybe(0.5)) entries.push({ slot: "socks", itemId: pick(socks).id });
      if (maybe(0.5)) entries.push({ slot: "outerwear", itemId: pick(outers).id });
      if (maybe(0.2)) entries.push({ slot: "scarf", itemId: W.scarf.id });
      const direction: DirectionKey | null = maybe(0.8) ? pick(DIRECTION_KEYS) : null;
      return candidate(index, entries, { direction, rain_ok: maybe(0.5) });
    });
  }

  const weathers = [day(8, 13, RAIN), day(-3, 4), day(14, 24), day(22, 30)];

  it("picks valid, well-layered, distinct outfits, deterministically, over 400 random replies", () => {
    let accepted = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const candidates = randomCandidates(seed, 6);
      const before = structuredClone(candidates);
      const ctx = selection(ALL, weathers[seed % weathers.length]);
      const result = selectSuggestions(candidates, ctx);

      expect(candidates).toEqual(before);
      const dropped = Object.values(result.report.dropped).reduce((sum, count) => sum + (count ?? 0), 0);
      expect(result.report.received).toBe(6);
      expect(result.report.usable + dropped).toBe(6);
      expect(result.report.repaired).toBeLessThanOrEqual(result.report.usable);
      expect(selectSuggestions(structuredClone(candidates), ctx)).toEqual(result);
      if (!result.ok) {
        expect(result.report.usable).toBeLessThan(3);
        continue;
      }
      accepted += 1;

      expect(result.outfits).toHaveLength(3);
      expect(new Set(result.outfits.map((outfit) => itemSetKey(outfit.entries))).size).toBe(3);
      // Not even the core pieces repeat: other socks do not make another outfit.
      expect(new Set(result.outfits.map((outfit) => coreItems(outfit.entries).join(","))).size).toBe(3);
      expect(new Set(result.outfits.map((outfit) => outfit.candidateIndex)).size).toBe(3);
      for (const outfit of result.outfits) {
        expect(validateOutfit(outfit.entries, ctx.checkItems)).toEqual({ ok: true });
        expect(outfit.entries).toEqual(sortBySlot(outfit.entries));

        const mid = ctx.items.get(outfit.entries.find((entry) => entry.slot === "mid_layer")?.itemId ?? "");
        if (mid !== undefined) expect(topKind(mid)).not.toBe("tee");

        const shoesItem = ctx.items.get(outfit.entries.find((entry) => entry.slot === "shoes")?.itemId ?? "");
        const hasSocks = outfit.entries.some((entry) => entry.slot === "socks");
        if (shoesItem !== undefined && footwearKind(shoesItem) === "closed") expect(hasSocks).toBe(true);
        if (shoesItem !== undefined && footwearKind(shoesItem) === "open") expect(hasSocks).toBe(false);

        if (outfit.rain_ok) expect(keepsDry(outfit.entries, ctx.items)).toBe(true);
        expect(outfit.score).toEqual(scoreOutfit(outfit.entries, ctx));
      }
    }
    // The generator is rough on purpose; enough replies must still get through.
    expect(accepted).toBeGreaterThan(100);
  });

  it("ignores the order the candidates arrive in", () => {
    for (let seed = 500; seed < 520; seed += 1) {
      const candidates = randomCandidates(seed, 6);
      const ctx = selection(ALL, weathers[seed % weathers.length]);
      expect(selectSuggestions([...candidates].reverse(), ctx)).toEqual(selectSuggestions(candidates, ctx));
    }
  });
});

// ---------------------------------------------------------------------------
// Repairs and drops
// ---------------------------------------------------------------------------

describe("selectSuggestions repairs and drops", () => {
  it("turns a lone hoodie into a hoodie over a tee and lists the repairs", () => {
    const [, second, third] = threeGood();
    const hoodie = candidate(0, entriesOf(["top", W.hoodie], ["bottom", W.jeans], ["shoes", W.sneakers], ["socks", W.runSocks]));
    const ctx = selection();
    const result = okResult(selectSuggestions([hoodie, second, third], ctx));
    const repaired = result.outfits.find((outfit) => outfit.candidateIndex === 0);
    expect(repaired?.repairs).toEqual(["moved_to_mid", "base_top_added"]);
    expect(repaired?.entries.find((entry) => entry.slot === "mid_layer")?.itemId).toBe(W.hoodie.id);
    const top = ctx.items.get(repaired?.entries.find((entry) => entry.slot === "top")?.itemId ?? "");
    expect(top === undefined ? null : topKind(top)).toBe("tee");
    expect(top?.id).not.toBe(W.teeRed.id);
    expect(result.report).toEqual({ received: 3, usable: 3, repaired: 1, dropped: {} });
  });

  it("adds socks to closed shoes and drops a layering mistake it cannot repair", () => {
    const bare = candidate(0, entriesOf(["top", W.teeWhite], ["bottom", W.jeans], ["shoes", W.chelsea]));
    const teeOverShirt = candidate(3, entriesOf(["mid_layer", W.teeNavy], ["top", W.oxford], ["bottom", W.chinos], ["shoes", W.derbies]));
    const [, second, third] = threeGood();
    const result = okResult(selectSuggestions([bare, second, third, teeOverShirt], selection()));
    expect(result.outfits.find((outfit) => outfit.candidateIndex === 0)?.repairs).toEqual(["socks_added"]);
    expect(result.report).toEqual({ received: 4, usable: 3, repaired: 1, dropped: { layering: 1 } });
  });

  it("rejects a reply with fewer usable candidates than needed, naming the drops", () => {
    const [good] = threeGood();
    const noBottom = candidate(1, entriesOf(["top", W.teeWhite], ["shoes", W.sneakers], ["socks", W.runSocks]));
    const teeOverShirt = candidate(2, entriesOf(["mid_layer", W.teeNavy], ["top", W.oxford], ["bottom", W.chinos]));
    const copy = candidate(3, [...good.entries].reverse());
    const result = selectSuggestions([good, noBottom, teeOverShirt, copy], selection());
    expect(result).toEqual({
      ok: false,
      report: { received: 4, usable: 1, repaired: 0, dropped: { invalid_outfit: 1, layering: 1, duplicate: 1 } },
      detail: "1 of 4 candidates usable: 1 invalid_outfit, 1 layering, 1 duplicate",
    });
  });

  it("names the drops high to low", () => {
    const [good, second] = threeGood();
    const teeOver = (index: number, top: StyleItem) =>
      candidate(index, entriesOf(["mid_layer", W.teeNavy], ["top", top], ["bottom", W.chinos]));
    const result = selectSuggestions(
      [good, second, teeOver(2, W.oxford), teeOver(3, W.teeWhite), candidate(4, entriesOf(["top", W.teeWhite]))],
      selection(),
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.detail).toBe("2 of 5 candidates usable: 2 layering, 1 invalid_outfit");
  });

  it("counts an outfit that becomes a duplicate only once repaired", () => {
    const ctx = selection();
    const lone = candidate(0, entriesOf(["top", W.hoodie], ["bottom", W.jeans], ["shoes", W.sneakers], ["socks", W.runSocks]));
    const repaired = repairOutfit(lone.entries, assessLayering(lone.entries, ctx.items, wardrobeCounts(ctx.items.values())), ctx);
    const [, second, third] = threeGood();
    const result = okResult(
      selectSuggestions([lone, candidate(1, repaired.entries), { ...second, index: 2 }, { ...third, index: 3 }], ctx),
    );
    expect(result.report).toEqual({ received: 4, usable: 3, repaired: 1, dropped: { duplicate: 1 } });
  });

  describe("companions across outfits", () => {
    // Two lone hoodies over chelsea boots without socks: each repair adds a tee and a pair of socks.
    // Twins score alike, so only the item id would tell the companions apart.
    const hoodieB = twin(W.hoodie, "b");
    const jeansB = twin(W.jeans, "b");
    const chelseaB = twin(W.chelsea, "b");
    const teeA = twin(W.teeWhite, "a");
    const teeB = twin(W.teeWhite, "b");
    const socksA = twin(W.cottonSocks, "a");
    const socksB = twin(W.cottonSocks, "b");
    const lone = [
      candidate(0, entriesOf(["top", W.hoodie], ["bottom", W.jeans], ["shoes", W.chelsea])),
      candidate(1, entriesOf(["top", hoodieB], ["bottom", jeansB], ["shoes", chelseaB])),
    ];
    const base = [W.hoodie, hoodieB, W.jeans, jeansB, W.chelsea, chelseaB];

    /** The item in `slot` of each pick, by candidate index. */
    function companions(items: readonly StyleItem[], slot: "top" | "socks"): (string | undefined)[] {
      const result = okResult(selectSuggestions(lone, selection(items, day(6, 12), EMPTY_HISTORY, 2)));
      expect(result.outfits.map((outfit) => outfit.repairs)).toEqual([
        ["moved_to_mid", "base_top_added", "socks_added"],
        ["moved_to_mid", "base_top_added", "socks_added"],
      ]);
      return [...result.outfits]
        .sort((a, b) => a.candidateIndex - b.candidateIndex)
        .map((outfit) => outfit.entries.find((entry) => entry.slot === slot)?.itemId);
    }

    it("gives each repaired outfit its own tee and socks when the wardrobe has two of each", () => {
      const items = [...base, teeA, teeB, socksA, socksB];
      expect(companions(items, "top")).toEqual([teeA.id, teeB.id]);
      expect(companions(items, "socks")).toEqual([socksA.id, socksB.id]);
    });

    it("gives both the same tee when the wardrobe has only one", () => {
      const items = [...base, teeA, socksA, socksB];
      expect(companions(items, "top")).toEqual([teeA.id, teeA.id]);
      expect(companions(items, "socks")).toEqual([socksA.id, socksB.id]);
    });
  });

  it("still yields three from a wardrobe without socks or base tops", () => {
    const items = [W.hoodie, W.sweater, W.jeans, W.chinos, W.sneakers, W.chelsea, W.coat];
    const candidates = [
      candidate(0, entriesOf(["top", W.hoodie], ["bottom", W.jeans], ["shoes", W.sneakers])),
      candidate(1, entriesOf(["top", W.sweater], ["bottom", W.chinos], ["shoes", W.chelsea])),
      candidate(2, entriesOf(["outerwear", W.coat], ["top", W.hoodie], ["bottom", W.chinos], ["shoes", W.chelsea])),
    ];
    const result = okResult(selectSuggestions(candidates, selection(items)));
    expect(result.outfits.map((outfit) => outfit.candidateIndex).sort()).toEqual([0, 1, 2]);
    expect(result.outfits.every((outfit) => outfit.repairs.length === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

/** Items like `item` under new ids: equal scores, no shared pieces. */
function twin(item: StyleItem, suffix: string): StyleItem {
  return { ...item, id: `${item.id}-${suffix}` };
}

describe("selectSuggestions picking", () => {
  it("is deterministic", () => {
    const ctx = selection();
    expect(selectSuggestions(threeGood(), ctx)).toEqual(selectSuggestions(threeGood(), ctx));
  });

  it("scores an outfit suggested today lower in novelty, and picks an equal fresh one instead", () => {
    const teeA = twin(W.teeWhite, "a");
    const teeB = twin(W.teeWhite, "b");
    const items = [...ALL, teeA, teeB];
    const stale = candidate(0, entriesOf(["top", teeA], ["bottom", W.jeans], ["shoes", W.sneakers], ["socks", W.runSocks]));
    const fresh = candidate(1, entriesOf(["top", teeB], ["bottom", W.jeans], ["shoes", W.sneakers], ["socks", W.runSocks]));
    const today: VarietyHistory = {
      ...EMPTY_HISTORY,
      suggested: [{ itemIds: stale.entries.map((entry) => entry.itemId), ageDays: 0, direction: "classic_balanced" }],
    };
    const ctx = selection(items, day(6, 12), today, 1);

    const staleScore = scoreOutfit(stale.entries, ctx);
    const freshScore = scoreOutfit(fresh.entries, ctx);
    expect(staleScore.novelty).toBeLessThan(freshScore.novelty);
    expect({ ...staleScore, novelty: 0, total: 0 }).toEqual({ ...freshScore, novelty: 0, total: 0 });

    const result = okResult(selectSuggestions([stale, fresh], ctx));
    expect(result.outfits.map((outfit) => outfit.candidateIndex)).toEqual([1]);
  });

  it("picks wool trousers over linen shorts on a cold day when the outfits are otherwise equal", () => {
    // The same trousers cut short in summer linen: only the warmth differs.
    const shorts: StyleItem = { ...W.trousers, id: "shorts-linen", subcategory: "linen shorts", warmthLevel: 1 };
    const outfit = (index: number, bottom: StyleItem) =>
      candidate(
        index,
        entriesOf(["outerwear", W.coat], ["mid_layer", W.sweater], ["top", W.oxford], ["bottom", bottom], ["shoes", W.chelsea], ["socks", W.woolSocks]),
      );
    const inShorts = outfit(0, shorts);
    const inTrousers = outfit(1, W.trousers);
    const ctx = selection([...ALL, shorts], day(2, 8), EMPTY_HISTORY, 1);

    const shortsScore = scoreOutfit(inShorts.entries, ctx);
    const trousersScore = scoreOutfit(inTrousers.entries, ctx);
    expect(trousersScore.weather).toBe(1);
    expect(shortsScore.weather).toBeLessThan(trousersScore.weather);
    expect({ ...shortsScore, weather: 0, total: 0 }).toEqual({ ...trousersScore, weather: 0, total: 0 });

    // The lower index would win a tie.
    const result = okResult(selectSuggestions([inShorts, inTrousers], ctx));
    expect(result.outfits.map((picked) => picked.candidateIndex)).toEqual([1]);
  });

  it("drops a second copy of the same core pieces with other socks or a scarf, and picks a distinct fourth", () => {
    const core = entriesOf(["mid_layer", W.hoodie], ["top", W.teeWhite], ["bottom", W.jeans], ["shoes", W.sneakers]);
    const candidates = [
      candidate(0, [...core, { slot: "socks", itemId: W.runSocks.id }]),
      candidate(1, [...core, { slot: "socks", itemId: W.cottonSocks.id }]),
      candidate(2, entriesOf(["outerwear", W.coat], ["mid_layer", W.sweater], ["top", W.oxford], ["bottom", W.chinos], ["shoes", W.chelsea], ["socks", W.woolSocks])),
      candidate(3, [...core, { slot: "socks", itemId: W.woolSocks.id }, { slot: "scarf", itemId: W.scarf.id }]),
      candidate(4, entriesOf(["top", W.longSleeve], ["bottom", W.trousers], ["shoes", W.derbies], ["socks", W.dressSocks])),
    ];
    const ctx = selection();
    expect(scoreOutfit(candidates[0]?.entries ?? [], ctx)).toEqual(scoreOutfit(candidates[1]?.entries ?? [], ctx));
    const result = okResult(selectSuggestions(candidates, ctx));
    expect(result.outfits.map((outfit) => outfit.candidateIndex).sort()).toEqual([0, 2, 4]);
    expect(result.report).toEqual({ received: 5, usable: 3, repaired: 0, dropped: { duplicate: 2 } });
  });

  it("rejects a reply whose third outfit only repeats another's core pieces", () => {
    const core = entriesOf(["mid_layer", W.hoodie], ["top", W.teeWhite], ["bottom", W.jeans], ["shoes", W.sneakers]);
    const candidates = [
      candidate(0, [...core, { slot: "socks", itemId: W.runSocks.id }]),
      candidate(1, entriesOf(["top", W.longSleeve], ["bottom", W.trousers], ["shoes", W.derbies], ["socks", W.dressSocks])),
      candidate(2, [...core, { slot: "socks", itemId: W.cottonSocks.id }]),
    ];
    expect(selectSuggestions(candidates, selection())).toEqual({
      ok: false,
      report: { received: 3, usable: 2, repaired: 0, dropped: { duplicate: 1 } },
      detail: "2 of 3 candidates usable: 1 duplicate",
    });
  });

  it("spreads the directions when the outfits are otherwise equal", () => {
    const sets = ["a", "b", "c", "d"].map((suffix) => [twin(W.teeWhite, suffix), twin(W.jeans, suffix), twin(W.chelsea, suffix), twin(W.cottonSocks, suffix)]);
    const items = sets.flat();
    const make = (directions: (DirectionKey | null)[]) =>
      sets.map(([top, bottom, shoes, socks], index) =>
        candidate(
          index,
          entriesOf(["top", top as StyleItem], ["bottom", bottom as StyleItem], ["shoes", shoes as StyleItem], ["socks", socks as StyleItem]),
          { direction: directions[index] ?? null },
        ),
      );
    const ctx = selection(items);
    const picked = (directions: (DirectionKey | null)[]) =>
      okResult(selectSuggestions(make(directions), ctx)).outfits.map((outfit) => outfit.candidateIndex);

    expect(picked([null, null, null, null])).toEqual([0, 1, 2]);
    expect(picked(["tonal_neutrals", "tonal_neutrals", "earth_tones", "sporty_clean"])).toEqual([0, 2, 3]);
    // Null directions never count as the same direction.
    expect(picked([null, null, "earth_tones", "earth_tones"])).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Rain
// ---------------------------------------------------------------------------

describe("selectSuggestions in the rain", () => {
  const notDry = [
    candidate(0, entriesOf(["outerwear", W.coat], ["mid_layer", W.hoodie], ["top", W.teeWhite], ["bottom", W.jeans], ["shoes", W.sneakers], ["socks", W.runSocks])),
    candidate(1, entriesOf(["mid_layer", W.sweater], ["top", W.oxford], ["bottom", W.chinos], ["shoes", W.chelsea], ["socks", W.woolSocks])),
    candidate(2, entriesOf(["top", W.teeNavy], ["bottom", W.trousers], ["shoes", W.derbies], ["socks", W.dressSocks])),
  ];
  const dry = candidate(
    3,
    entriesOf(["outerwear", W.shell], ["top", W.longSleeve], ["bottom", W.trousers], ["shoes", W.rainBoots], ["socks", W.woolSocks]),
  );
  const dryIds = dry.entries.map((entry) => entry.itemId);
  // The dry outfit was suggested today, worn yesterday and disliked: it would never make the cut on merit.
  const tired: VarietyHistory = {
    ...EMPTY_HISTORY,
    suggested: [{ itemIds: dryIds, ageDays: 0, direction: null }],
    worn: [{ itemIds: dryIds, ageDays: 1 }],
    disliked: [{ itemIds: dryIds, rating: 1, timesWorn: 1, source: "ai" }],
  };

  it("swaps the lowest-ranked pick for the best dry outfit when no pick keeps the owner dry", () => {
    const ctx = selection(ALL, day(8, 13, RAIN), tired);
    const totals = [...notDry, dry].map((entry) => scoreOutfit(entry.entries, ctx).total);
    expect(Math.min(...totals)).toBe(totals[3]);

    const result = okResult(selectSuggestions([...notDry, dry], ctx));
    const picked = result.outfits.map((outfit) => outfit.candidateIndex);
    expect(picked).toHaveLength(3);
    expect(picked[2]).toBe(3);
    expect(result.outfits.filter((outfit) => keepsDry(outfit.entries, ctx.items))).toHaveLength(1);
    // Claude marked every candidate rain_ok false; the dry pick still shows as rain-ready.
    expect(result.outfits.map((outfit) => outfit.rain_ok)).toEqual([false, false, true]);

    // On a dry day the same candidates leave it out.
    const sunny = okResult(selectSuggestions([...notDry, dry], selection(ALL, day(8, 13), tired)));
    expect(sunny.outfits.map((outfit) => outfit.candidateIndex).sort()).toEqual([0, 1, 2]);
  });

  it("swaps nothing when a pick already keeps the owner dry", () => {
    const ctx = selection(ALL, day(8, 13, RAIN), tired);
    const shellOutfit = candidate(
      4,
      entriesOf(["outerwear", W.shell], ["mid_layer", W.hoodie], ["top", W.teeRed], ["bottom", W.chinos], ["shoes", W.sneakers], ["socks", W.runSocks]),
    );
    const result = okResult(selectSuggestions([...notDry, dry, shellOutfit], ctx));
    const picked = result.outfits.map((outfit) => outfit.candidateIndex);
    expect(picked).toContain(4);
    expect(picked).not.toContain(3);
  });

  it("sets rain_ok from whether the repaired outfit keeps the owner dry, whatever Claude said", () => {
    const ctx = selection(ALL, day(8, 13, RAIN));
    const candidates = [
      { ...notDry[0], rain_ok: true },
      { ...dry, index: 1, rain_ok: true },
      candidate(2, entriesOf(["outerwear", W.coat], ["top", W.teeNavy], ["bottom", W.chinos], ["shoes", W.rainBoots], ["socks", W.woolSocks]), {
        rain_ok: false,
      }),
    ];
    const result = okResult(selectSuggestions(candidates, ctx));
    const rainOk = Object.fromEntries(result.outfits.map((outfit) => [outfit.candidateIndex, outfit.rain_ok]));
    expect(rainOk).toEqual({ 0: false, 1: true, 2: true });
  });
});
