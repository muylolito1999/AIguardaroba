import { describe, expect, it } from "vitest";

import type { ItemCategory, OutfitSlot } from "@/lib/db/enums";
import type { FootwearKind, SockStyle, StyleItem, TopKind, WardrobeCounts } from "@/lib/outfits/style/types";

import { entriesOf, makeStyleItem, styleMap } from "../../../../test/style-fixtures";
import {
  BASE_TOP_PREFERENCE,
  WARM_SOCK_MIN_WARMTH,
  assessLayering,
  firstItemInSlot,
  foldText,
  footwearKind,
  isSneaker,
  layerRole,
  sockStyle,
  topKind,
  wardrobeCounts,
  type LayerVerdict,
} from "./layering";

function named(category: ItemCategory, subcategory: string | null, name: string | null = null) {
  return { category, subcategory, name };
}

describe("foldText", () => {
  it.each([
    ["T-Shirt", "t shirt"],
    ["  long_sleeve / TEE  ", "long sleeve tee"],
    ["Füßlinge-Set", "fusslinge set"],
    ["Décolleté", "decollete"],
    ["1/4-zip", "1 4 zip"],
    ["", ""],
  ])("folds %j to %j", (text, folded) => {
    expect(foldText(text)).toBe(folded);
  });

  it("folds null to an empty string", () => {
    expect(foldText(null)).toBe("");
  });
});

describe("topKind", () => {
  it.each<[string, TopKind]>([
    // English tees
    ["t-shirt", "tee"],
    ["T Shirt", "tee"],
    ["tshirt", "tee"],
    ["graphic tees", "tee"],
    ["long-sleeve t-shirt", "tee"],
    ["long sleeve top", "tee"],
    ["long sleeve tee shirt", "tee"],
    ["long sleeve polo shirt", "tee"],
    ["longsleeve", "tee"],
    ["tank top", "tee"],
    ["vest top", "tee"],
    ["camisole", "tee"],
    ["cami", "tee"],
    ["bodysuit", "tee"],
    ["henley", "tee"],
    ["crop top", "tee"],
    ["polo", "tee"],
    ["polo shirt", "tee"],
    ["knit polo", "tee"],
    ["golf shirt", "tee"],
    // English shirts
    ["shirt", "shirt"],
    ["long-sleeve shirt", "shirt"],
    ["Blue long-sleeve linen shirt", "shirt"],
    ["Long sleeve oxford", "shirt"],
    ["long sleeve button-down", "shirt"],
    ["long sleeve checked flannel", "shirt"],
    ["button-down", "shirt"],
    ["button up shirt", "shirt"],
    ["oxford shirt", "shirt"],
    ["flannel shirt", "shirt"],
    ["dress shirt", "shirt"],
    ["blouse", "shirt"],
    ["chambray", "shirt"],
    // English knits
    ["sweater", "knit"],
    ["crewneck sweater", "knit"],
    ["v-neck sweater", "knit"],
    ["jumper", "knit"],
    ["cardigan", "knit"],
    ["cable-knit jumper", "knit"],
    ["knitwear", "knit"],
    ["sweater vest", "knit"],
    ["turtleneck sweater", "knit"],
    ["quarter-zip sweater", "knit"],
    ["knitted vest", "knit"],
    // English sweats: "sweatshirt" is not a shirt
    ["hoodie", "sweat"],
    ["zip-up hoodie", "sweat"],
    ["hooded sweatshirt", "sweat"],
    ["sweatshirt", "sweat"],
    ["crewneck sweatshirt", "sweat"],
    ["sweat shirt", "sweat"],
    ["fleece", "sweat"],
    ["quarter-zip", "sweat"],
    ["half zip", "sweat"],
    ["1/4-zip", "sweat"],
    ["zip-up", "sweat"],
    ["track top", "sweat"],
    // English tailored: "overshirt" is not a shirt
    ["blazer", "tailored"],
    ["sport coat", "tailored"],
    ["suit jacket", "tailored"],
    ["overshirt", "tailored"],
    ["over-shirt", "tailored"],
    ["shirt jacket", "tailored"],
    ["shacket", "tailored"],
    ["denim jacket", "tailored"],
    // Fleece, compounds included, layers like a sweatshirt
    ["fleece jacket", "sweat"],
    ["Fleecejacke", "sweat"],
    ["Fleecepullover", "sweat"],
    // Weather jackets filed as tops are no blazer: no confident kind
    ["puffer jacket", "unknown"],
    ["down jacket", "unknown"],
    ["padded jacket", "unknown"],
    ["quilted jacket", "unknown"],
    ["rain jacket", "unknown"],
    ["shell jacket", "unknown"],
    ["softshell jacket", "unknown"],
    ["Daunenjacke", "unknown"],
    ["Steppjacke", "unknown"],
    ["Regenjacke", "unknown"],
    ["Softshelljacke", "unknown"],
    ["giacca a vento", "unknown"],
    ["giacca imbottita", "unknown"],
    // A plain jacket filed as a top still reads tailored.
    ["Jeansjacke", "tailored"],
    ["Sweatjacke", "sweat"],
    // Either way round: no confident kind
    ["turtleneck", "unknown"],
    ["roll-neck", "unknown"],
    ["mock neck", "unknown"],
    ["polo neck", "unknown"],
    ["turtleneck shirt", "unknown"],
    ["vest", "unknown"],
    ["top", "unknown"],
    ["tunic", "unknown"],
    // Italian
    ["maglietta", "tee"],
    ["canotta", "tee"],
    ["camicia", "shirt"],
    ["maglione", "knit"],
    ["golf", "knit"],
    ["felpa", "sweat"],
    ["giacca", "tailored"],
    ["dolcevita", "unknown"],
    // German
    ["T-Shirt", "tee"],
    ["Poloshirt", "tee"],
    ["Unterhemd", "tee"],
    ["Hemd", "shirt"],
    ["Bluse", "shirt"],
    ["Pullover", "knit"],
    ["Strickjacke", "knit"],
    ["Rollkragenpullover", "knit"],
    ["Feinstrickpullover", "knit"],
    ["Kapuzenpullover", "sweat"],
    ["Sweatshirt", "sweat"],
    ["Fleece", "sweat"],
    ["Sakko", "tailored"],
  ])("reads the subcategory %j as %s", (subcategory, kind) => {
    expect(topKind(named("top", subcategory))).toBe(kind);
  });

  it.each<[string | null, string | null, TopKind]>([
    [null, "Grey hoodie", "sweat"],
    ["top", "White linen shirt", "shirt"],
    ["turtleneck", "Merino turtleneck sweater", "knit"],
    ["", "Striped Breton tee", "tee"],
    // A confident subcategory wins over the name.
    ["sweater", "Navy t-shirt", "knit"],
    ["top", "Silk top", "unknown"],
    [null, null, "unknown"],
  ])("falls back from the subcategory %j to the name %j: %s", (subcategory, name, kind) => {
    expect(topKind(named("top", subcategory, name))).toBe(kind);
  });

  it("is unknown for anything that is not a top, a dress included", () => {
    expect(topKind(named("dress", "shirt dress"))).toBe("unknown");
    expect(topKind(named("outerwear", "blazer"))).toBe("unknown");
    expect(topKind(named("base_layer", "thermal t-shirt"))).toBe("unknown");
  });
});

describe("layerRole", () => {
  it.each([
    ["t-shirt", "base"],
    ["shirt", "base"],
    ["sweater", "mid"],
    ["hoodie", "mid"],
    ["blazer", "mid"],
    ["turtleneck", "either"],
    ["vest", "either"],
    ["top", "either"],
    ["puffer jacket", "either"],
    ["Fleecejacke", "mid"],
  ] as const)("gives a %j the role %s", (subcategory, role) => {
    expect(layerRole(named("top", subcategory))).toBe(role);
  });

  it("is null for anything that is not a top", () => {
    expect(layerRole(named("dress", "knit dress"))).toBeNull();
    expect(layerRole(named("outerwear", "fleece"))).toBeNull();
    expect(layerRole(named("shoes", "sneakers"))).toBeNull();
  });
});

describe("footwearKind", () => {
  it.each<[string | null, string | null, FootwearKind]>([
    ["sneakers", null, "closed"],
    ["trainers", null, "closed"],
    ["chelsea boots", null, "closed"],
    ["derbies", null, "closed"],
    ["oxfords", null, "closed"],
    ["brogues", null, "closed"],
    ["block heel boots", null, "closed"],
    [null, null, "closed"],
    ["sandals", null, "open"],
    ["heeled sandals", null, "open"],
    ["slides", null, "open"],
    ["flip-flops", null, "open"],
    ["flip flops", null, "open"],
    ["Birkenstock", null, "open"],
    ["sandali", null, "open"],
    ["infradito", null, "open"],
    ["Sandalen", null, "open"],
    ["Trekkingsandalen", null, "open"],
    ["loafers", null, "sockless"],
    ["penny loafers", null, "sockless"],
    ["boat shoes", null, "sockless"],
    ["espadrilles", null, "sockless"],
    ["ballet flats", null, "sockless"],
    ["mocassini", null, "sockless"],
    ["Décolleté", null, "sockless"],
    ["pumps", null, "sockless"],
    ["mules", null, "sockless"],
    ["shoes", "Tan suede loafers", "sockless"],
    [null, "Leather sandals", "open"],
  ])("reads %j / %j as %s", (subcategory, name, kind) => {
    expect(footwearKind(named("shoes", subcategory, name))).toBe(kind);
  });

  it("is null for anything that is not shoes", () => {
    expect(footwearKind(named("socks", "sandal socks"))).toBeNull();
    expect(footwearKind(named("top", "loafers"))).toBeNull();
  });
});

describe("isSneaker", () => {
  it.each<[string | null, string | null, boolean]>([
    ["sneakers", null, true],
    ["Sneaker", null, true],
    ["high-top sneakers", null, true],
    ["Damensneaker", null, true],
    ["trainers", null, true],
    ["Crosstrainers", null, true],
    ["plimsolls", null, true],
    ["running shoes", null, true],
    ["tennis shoe", null, true],
    ["sport shoes", null, true],
    ["sports shoes", null, true],
    ["gym shoes", null, true],
    ["trail shoes", null, true],
    ["scarpe da ginnastica", null, true],
    ["scarpe ginnastica", null, true],
    ["scarpe sportive", null, true],
    ["Turnschuhe", null, true],
    ["Laufschuhe", null, true],
    ["Sportschuh", null, true],
    ["shoes", "White leather sneakers", true],
    ["loafers", null, false],
    ["chelsea boots", null, false],
    ["derbies", null, false],
    ["Halbschuhe", null, false],
    ["dress shoes", null, false],
    [null, null, false],
  ])("reads %j / %j as %s", (subcategory, name, sneaker) => {
    expect(isSneaker(named("shoes", subcategory, name))).toBe(sneaker);
  });

  it("is false for anything that is not shoes", () => {
    expect(isSneaker(named("socks", "sneaker socks"))).toBe(false);
    expect(isSneaker(named("top", "trainer top"))).toBe(false);
  });
});

describe("firstItemInSlot", () => {
  it("returns the first item in the slot that the map knows, skipping unknown ids", () => {
    const tee = makeStyleItem({ id: "tee" });
    const boots = makeStyleItem({ id: "boots", category: "shoes" });
    const entries = [
      { slot: "shoes" as const, itemId: "gone" },
      ...entriesOf(["top", tee], ["shoes", boots]),
    ];
    expect(firstItemInSlot(entries, styleMap(tee, boots), "shoes")).toBe(boots);
    expect(firstItemInSlot(entries, styleMap(tee, boots), "top")).toBe(tee);
    expect(firstItemInSlot(entries, styleMap(tee, boots), "outerwear")).toBeNull();
    expect(firstItemInSlot(entries, styleMap(tee), "shoes")).toBeNull();
  });
});

describe("sockStyle", () => {
  function socks(subcategory: string | null, extra: { name?: string; materials?: string[]; warmthLevel?: number } = {}) {
    return makeStyleItem({
      category: "socks",
      subcategory,
      name: extra.name ?? null,
      materials: extra.materials ?? ["cotton"],
      warmthLevel: extra.warmthLevel ?? 2,
    });
  }

  it.each<[string | null, SockStyle]>([
    ["dress socks", "dress"],
    ["business socks", "dress"],
    ["sheer socks", "dress"],
    ["no-show socks", "no_show"],
    ["no show socks", "no_show"],
    ["invisible socks", "no_show"],
    ["sock liners", "no_show"],
    ["fantasmini", "no_show"],
    ["Füßlinge", "no_show"],
    ["sports socks", "athletic"],
    ["running socks", "athletic"],
    ["Sportsocken", "athletic"],
    ["wool socks", "warm"],
    ["merino hiking socks", "warm"],
    ["ski socks", "warm"],
    ["thermal socks", "warm"],
    ["calze di lana", "warm"],
    ["crew socks", "everyday"],
    ["socks", "everyday"],
    [null, "everyday"],
  ])("reads %j as %s", (subcategory, style) => {
    expect(sockStyle(socks(subcategory))).toBe(style);
  });

  it.each<[string, SockStyle]>([
    ["no-show running socks", "no_show"],
    ["merino no-show socks", "no_show"],
    ["merino dress socks", "dress"],
    ["dress running socks", "dress"],
    ["thin running socks", "athletic"],
    ["wool running socks", "athletic"],
    ["fine merino socks", "dress"],
  ])("orders no_show, dress, athletic, thin/fine, warm: %j is %s", (subcategory, style) => {
    expect(sockStyle(socks(subcategory))).toBe(style);
  });

  it("is warm from the warmth level or the materials when no word decides", () => {
    expect(sockStyle(socks("socks", { warmthLevel: WARM_SOCK_MIN_WARMTH }))).toBe("warm");
    expect(sockStyle(socks("socks", { warmthLevel: WARM_SOCK_MIN_WARMTH - 1 }))).toBe("everyday");
    expect(sockStyle(socks("socks", { materials: ["cotton", "merino wool"] }))).toBe("warm");
    expect(sockStyle(socks("socks", { materials: ["lambswool"] }))).toBe("warm");
    expect(sockStyle(socks("socks", { materials: ["cashmere"] }))).toBe("warm");
    // A telling word wins over warmth and materials.
    expect(sockStyle(socks("running socks", { warmthLevel: 4, materials: ["merino"] }))).toBe("athletic");
  });

  it("reads the name when the subcategory says nothing", () => {
    expect(sockStyle(socks("socks", { name: "Black dress socks" }))).toBe("dress");
    expect(sockStyle(socks(null, { name: "Merino hiking socks" }))).toBe("warm");
    // The subcategory decides when it does say something.
    expect(sockStyle(socks("sports socks", { name: "No-show trainer socks" }))).toBe("athletic");
  });

  it("is null for anything that is not socks", () => {
    expect(sockStyle(makeStyleItem({ category: "shoes", subcategory: "dress shoes" }))).toBeNull();
  });
});

describe("wardrobeCounts", () => {
  it("counts tees and shirts as base tops, and socks and shoes", () => {
    const items = [
      makeStyleItem({ subcategory: "t-shirt" }),
      makeStyleItem({ subcategory: "oxford shirt" }),
      makeStyleItem({ subcategory: null, name: "White tee" }),
      makeStyleItem({ subcategory: "hoodie" }),
      makeStyleItem({ subcategory: "turtleneck" }),
      makeStyleItem({ subcategory: "overshirt" }),
      makeStyleItem({ category: "dress", subcategory: "shirt dress" }),
      makeStyleItem({ category: "base_layer", subcategory: "thermal t-shirt" }),
      makeStyleItem({ category: "socks", subcategory: "wool socks" }),
      makeStyleItem({ category: "shoes", subcategory: "sneakers" }),
      makeStyleItem({ category: "shoes", subcategory: "sandals" }),
      makeStyleItem({ category: "bottom", subcategory: "jeans" }),
    ];
    expect(wardrobeCounts(items)).toEqual({ baseTops: 3, socks: 1, shoes: 2 });
  });

  it("takes any iterable and is all zeros for an empty wardrobe", () => {
    expect(wardrobeCounts([])).toEqual({ baseTops: 0, socks: 0, shoes: 0 });
    const tee = makeStyleItem({ subcategory: "t-shirt" });
    expect(wardrobeCounts(styleMap(tee).values())).toEqual({ baseTops: 1, socks: 0, shoes: 0 });
  });
});

describe("assessLayering", () => {
  const tee = makeStyleItem({ id: "tee", subcategory: "t-shirt" });
  const tee2 = makeStyleItem({ id: "tee2", subcategory: "tank top" });
  const shirt = makeStyleItem({ id: "shirt", subcategory: "oxford shirt" });
  const shirt2 = makeStyleItem({ id: "shirt2", subcategory: "flannel shirt" });
  const sweater = makeStyleItem({ id: "sweater", subcategory: "crewneck sweater" });
  const cardigan = makeStyleItem({ id: "cardigan", subcategory: "cardigan" });
  const hoodie = makeStyleItem({ id: "hoodie", subcategory: "hoodie" });
  const blazer = makeStyleItem({ id: "blazer", subcategory: "blazer" });
  const turtleneck = makeStyleItem({ id: "turtleneck", subcategory: "turtleneck" });
  const plainTop = makeStyleItem({ id: "plain-top", subcategory: "top" });
  const dress = makeStyleItem({ id: "dress", category: "dress", subcategory: "midi dress" });
  const jeans = makeStyleItem({ id: "jeans", category: "bottom", subcategory: "jeans" });
  const sneakers = makeStyleItem({ id: "sneakers", category: "shoes", subcategory: "sneakers" });
  const mysteryShoes = makeStyleItem({ id: "mystery-shoes", category: "shoes", subcategory: null });
  const sandals = makeStyleItem({ id: "sandals", category: "shoes", subcategory: "sandals" });
  const loafers = makeStyleItem({ id: "loafers", category: "shoes", subcategory: "loafers" });
  const socks = makeStyleItem({ id: "socks", category: "socks", subcategory: "crew socks" });

  const items = styleMap(
    tee,
    tee2,
    shirt,
    shirt2,
    sweater,
    cardigan,
    hoodie,
    blazer,
    turtleneck,
    plainTop,
    dress,
    jeans,
    sneakers,
    mysteryShoes,
    sandals,
    loafers,
    socks,
  );
  const wardrobe: WardrobeCounts = { baseTops: 4, socks: 1, shoes: 4 };
  const fine: LayerVerdict = { drop: false, fixes: [], note: null };

  /** An outfit with these top pieces over jeans, with sneakers and socks, so only the layers are judged. */
  function layered(top: StyleItem, mid?: StyleItem) {
    const pairs: [OutfitSlot, StyleItem][] = [["top", top]];
    if (mid !== undefined) pairs.push(["mid_layer", mid]);
    pairs.push(["bottom", jeans], ["shoes", sneakers], ["socks", socks]);
    return entriesOf(...pairs);
  }

  describe("a layer top alone in the top slot", () => {
    it("moves a hoodie to the mid layer over a tee, or a shirt", () => {
      expect(assessLayering(layered(hoodie), items, wardrobe)).toEqual({
        drop: false,
        fixes: [{ kind: "move_top_to_mid" }, { kind: "add_base_top", prefer: ["tee", "shirt"] }],
        note: "sweat top worn without a base top",
      });
    });

    it("moves a knit over a shirt, or a tee", () => {
      expect(assessLayering(layered(sweater), items, wardrobe).fixes).toEqual([
        { kind: "move_top_to_mid" },
        { kind: "add_base_top", prefer: ["shirt", "tee"] },
      ]);
    });

    it("moves a blazer over a shirt, or a tee", () => {
      expect(assessLayering(layered(blazer), items, wardrobe).fixes).toEqual([
        { kind: "move_top_to_mid" },
        { kind: "add_base_top", prefer: ["shirt", "tee"] },
      ]);
      expect(BASE_TOP_PREFERENCE).toEqual({
        sweat: ["tee", "shirt"],
        knit: ["shirt", "tee"],
        tailored: ["shirt", "tee"],
      });
    });

    it("leaves a hoodie or a knit over a thermal base layer alone, but still puts a shirt under a blazer", () => {
      const thermal = makeStyleItem({ id: "thermal", category: "base_layer", subcategory: "thermal top" });
      const withThermal = new Map([...items, [thermal.id, thermal]]);
      const overThermal = (top: StyleItem) => [...layered(top), { slot: "base_layer" as const, itemId: thermal.id }];
      expect(assessLayering(overThermal(hoodie), withThermal, wardrobe)).toEqual(fine);
      expect(assessLayering(overThermal(sweater), withThermal, wardrobe)).toEqual(fine);
      expect(assessLayering(overThermal(blazer), withThermal, wardrobe)).toEqual({
        drop: false,
        fixes: [{ kind: "move_top_to_mid" }, { kind: "add_base_top", prefer: ["shirt", "tee"] }],
        note: "tailored top worn without a base top",
      });
    });

    it("leaves a lone hoodie alone when the wardrobe has no base tops", () => {
      expect(assessLayering(layered(hoodie), items, { ...wardrobe, baseTops: 0 })).toEqual(fine);
    });

    it("leaves a tee, a shirt and a dress alone", () => {
      expect(assessLayering(layered(tee), items, wardrobe)).toEqual(fine);
      expect(assessLayering(layered(shirt), items, wardrobe)).toEqual(fine);
      expect(assessLayering(layered(dress), items, wardrobe)).toEqual(fine);
    });
  });

  describe("a tee in the mid layer", () => {
    it("swaps places with a layer top in the top slot", () => {
      expect(assessLayering(layered(hoodie, tee), items, wardrobe)).toEqual({
        drop: false,
        fixes: [{ kind: "swap_top_and_mid" }],
        note: "tee in mid layer over a sweat top, swapped",
      });
      expect(assessLayering(layered(blazer, tee), items, wardrobe).fixes).toEqual([{ kind: "swap_top_and_mid" }]);
    });

    it("is dropped over a tee or a shirt", () => {
      expect(assessLayering(layered(tee2, tee), items, wardrobe)).toEqual({
        drop: true,
        fixes: [],
        note: "tee in mid layer over a tee",
      });
      expect(assessLayering(layered(shirt, tee), items, wardrobe)).toMatchObject({ drop: true, fixes: [] });
    });
  });

  describe("a shirt in the mid layer", () => {
    it("is fine open over a tee", () => {
      expect(assessLayering(layered(tee, shirt), items, wardrobe)).toEqual(fine);
    });

    it("is dropped over another shirt", () => {
      expect(assessLayering(layered(shirt2, shirt), items, wardrobe)).toEqual({
        drop: true,
        fixes: [],
        note: "shirt in mid layer over a shirt",
      });
    });

    it("swaps places with a layer top in the top slot", () => {
      expect(assessLayering(layered(sweater, shirt), items, wardrobe)).toEqual({
        drop: false,
        fixes: [{ kind: "swap_top_and_mid" }],
        note: "shirt in mid layer over a knit, swapped",
      });
    });
  });

  describe("two layer tops", () => {
    it("is fine as the proper layering: a hoodie or knit over a tee or shirt", () => {
      expect(assessLayering(layered(tee, hoodie), items, wardrobe)).toEqual(fine);
      expect(assessLayering(layered(shirt, sweater), items, wardrobe)).toEqual(fine);
      expect(assessLayering(layered(shirt, blazer), items, wardrobe)).toEqual(fine);
    });

    it("drops a hoodie over a knit and a blazer over a hoodie", () => {
      expect(assessLayering(layered(sweater, hoodie), items, wardrobe)).toEqual({
        drop: true,
        fixes: [],
        note: "sweat top in mid layer over a knit",
      });
      expect(assessLayering(layered(hoodie, blazer), items, wardrobe)).toMatchObject({ drop: true, fixes: [] });
      expect(assessLayering(layered(sweater, cardigan), items, wardrobe)).toMatchObject({ drop: true, fixes: [] });
    });

    it("keeps a blazer over a knit, and swaps a knit over a blazer", () => {
      expect(assessLayering(layered(sweater, blazer), items, wardrobe)).toEqual(fine);
      expect(assessLayering(layered(blazer, sweater), items, wardrobe)).toEqual({
        drop: false,
        fixes: [{ kind: "swap_top_and_mid" }],
        note: "knit in mid layer over a tailored top, swapped",
      });
    });
  });

  describe("a dress with a mid layer", () => {
    it("takes a cardigan, a blazer or a sweatshirt", () => {
      expect(assessLayering(layered(dress, cardigan), items, wardrobe)).toEqual(fine);
      expect(assessLayering(layered(dress, blazer), items, wardrobe)).toEqual(fine);
      expect(assessLayering(layered(dress, hoodie), items, wardrobe)).toEqual(fine);
    });

    it("is dropped with a tee or a shirt over it", () => {
      expect(assessLayering(layered(dress, tee), items, wardrobe)).toEqual({
        drop: true,
        fixes: [],
        note: "tee in mid layer over a dress",
      });
      expect(assessLayering(layered(dress, shirt), items, wardrobe)).toMatchObject({ drop: true, fixes: [] });
    });
  });

  describe("kinds the vocabulary cannot place", () => {
    it("never trigger a fix or a drop", () => {
      expect(assessLayering(layered(turtleneck), items, wardrobe)).toEqual(fine);
      expect(assessLayering(layered(plainTop), items, wardrobe)).toEqual(fine);
      expect(assessLayering(layered(turtleneck, tee), items, wardrobe)).toEqual(fine);
      expect(assessLayering(layered(plainTop, shirt), items, wardrobe)).toEqual(fine);
      expect(assessLayering(layered(hoodie, turtleneck), items, wardrobe)).toEqual(fine);
      expect(assessLayering(layered(sweater, plainTop), items, wardrobe)).toEqual(fine);
      expect(assessLayering(layered(dress, turtleneck), items, wardrobe)).toEqual(fine);
    });

    it("treat a mid-layer item missing from the map as unknown, not as an empty slot", () => {
      const entries = [...layered(hoodie), { slot: "mid_layer" as const, itemId: "gone" }];
      expect(assessLayering(entries, items, wardrobe)).toEqual(fine);
    });

    it("say nothing when the top slot is empty or its item is missing", () => {
      expect(assessLayering(entriesOf(["bottom", jeans], ["shoes", sneakers], ["socks", socks]), items, wardrobe)).toEqual(
        fine,
      );
      const entries = [{ slot: "top" as const, itemId: "gone" }, ...entriesOf(["mid_layer", tee], ["bottom", jeans])];
      expect(assessLayering(entries, items, { ...wardrobe, shoes: 0 })).toEqual(fine);
    });
  });

  describe("shoes and socks", () => {
    const outfit = (...feet: [OutfitSlot, StyleItem][]) => entriesOf(["top", tee], ["bottom", jeans], ...feet);

    it("adds socks to closed shoes, unknown shoes counting as closed", () => {
      expect(assessLayering(outfit(["shoes", sneakers]), items, wardrobe)).toEqual({
        drop: false,
        fixes: [{ kind: "add_socks" }],
        note: "closed shoes without socks",
      });
      expect(assessLayering(outfit(["shoes", mysteryShoes]), items, wardrobe).fixes).toEqual([{ kind: "add_socks" }]);
      expect(assessLayering(outfit(["shoes", sneakers], ["socks", socks]), items, wardrobe)).toEqual(fine);
    });

    it("never asks for socks when the wardrobe has none", () => {
      const sockless = { ...wardrobe, socks: 0 };
      expect(assessLayering(outfit(["shoes", sneakers]), items, sockless)).toEqual(fine);
      expect(assessLayering(outfit(), items, sockless)).toEqual({
        drop: false,
        fixes: [{ kind: "add_shoes" }],
        note: "no shoes",
      });
    });

    it("removes socks from open shoes", () => {
      expect(assessLayering(outfit(["shoes", sandals], ["socks", socks]), items, wardrobe)).toEqual({
        drop: false,
        fixes: [{ kind: "remove_socks" }],
        note: "socks with open shoes",
      });
      expect(assessLayering(outfit(["shoes", sandals]), items, wardrobe)).toEqual(fine);
    });

    it("leaves sockless shoes alone either way", () => {
      expect(assessLayering(outfit(["shoes", loafers]), items, wardrobe)).toEqual(fine);
      expect(assessLayering(outfit(["shoes", loafers], ["socks", socks]), items, wardrobe)).toEqual(fine);
    });

    it("adds shoes, and socks for them, to an outfit without shoes", () => {
      expect(assessLayering(outfit(), items, wardrobe)).toEqual({
        drop: false,
        fixes: [{ kind: "add_shoes" }, { kind: "add_socks" }],
        note: "no shoes or socks",
      });
      expect(assessLayering(outfit(["socks", socks]), items, wardrobe)).toEqual({
        drop: false,
        fixes: [{ kind: "add_shoes" }],
        note: "no shoes",
      });
    });

    it("never asks for shoes when the wardrobe has none", () => {
      expect(assessLayering(outfit(), items, { ...wardrobe, shoes: 0 })).toEqual(fine);
    });

    it("says nothing about a shoes entry whose item is missing", () => {
      expect(assessLayering(outfit(), items, wardrobe).fixes).not.toEqual([]);
      const entries = [...outfit(), { slot: "shoes" as const, itemId: "gone" }];
      expect(assessLayering(entries, items, wardrobe)).toEqual(fine);
    });
  });

  describe("combined", () => {
    it("lists layer fixes before feet fixes, with both notes", () => {
      const entries = entriesOf(["top", hoodie], ["bottom", jeans], ["shoes", sneakers]);
      expect(assessLayering(entries, items, wardrobe)).toEqual({
        drop: false,
        fixes: [
          { kind: "move_top_to_mid" },
          { kind: "add_base_top", prefer: ["tee", "shirt"] },
          { kind: "add_socks" },
        ],
        note: "sweat top worn without a base top; closed shoes without socks",
      });
    });

    it("clears every fix when the outfit is dropped", () => {
      const entries = entriesOf(["top", tee2], ["mid_layer", tee], ["bottom", jeans], ["shoes", sneakers]);
      expect(assessLayering(entries, items, wardrobe)).toEqual({
        drop: true,
        fixes: [],
        note: "tee in mid layer over a tee",
      });
    });
  });

  it("is deterministic and leaves its inputs alone", () => {
    const entries = entriesOf(["top", hoodie], ["bottom", jeans]);
    const before = JSON.stringify([entries, [...items.entries()], wardrobe]);
    const first = assessLayering(entries, items, wardrobe);
    const second = assessLayering(entries, items, wardrobe);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(JSON.stringify([entries, [...items.entries()], wardrobe])).toBe(before);
    expect(topKind(hoodie)).toBe(topKind(hoodie));
    expect(footwearKind(sneakers)).toBe(footwearKind(sneakers));
  });
});
