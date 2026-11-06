// Layering knowledge for outfit suggestions (D-256): what kind of top, shoe or
// sock an item is, read from its subcategory and name, and whether an outfit's
// top, mid layer, shoes and socks sit together the way people dress. A hoodie
// goes over a t-shirt, not on its own in the top slot; closed shoes want socks;
// sandals do not. Pure and client-safe, so scoring, selection and the prompt
// share one set of rules.
//
// Every rule is conditional on two things. First, the kinds must be confident:
// an item the vocabulary cannot place (a turtleneck, a bare "vest", an unknown
// word) never triggers a fix or a drop. Second, the wardrobe must offer what a
// fix needs: an owner with no t-shirts or shirts is never asked for a base top,
// and one with no socks is never asked for socks.

import type { OutfitSlot } from "@/lib/db/enums";
import type {
  FootwearKind,
  LayerRole,
  SockStyle,
  StyleItem,
  StyleOutfit,
  TopKind,
  WardrobeCounts,
} from "@/lib/outfits/style/types";

type Named = Pick<StyleItem, "category" | "subcategory" | "name">;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * One row of a keyword table: the kind an item is when any phrase matches.
 * Phrases are regular-expression sources matched against folded text
 * (foldText): lowercase, accents removed, ß as ss, every run of other
 * characters a single space. So "T-Shirt", "t shirt" and "T_SHIRT" all read
 * "t shirt", and a phrase writes " ?" where the words may also be joined
 * ("t ?shirts?" also takes "tshirt"). Each phrase covers whole words.
 */
export type KeywordRule<K> = { readonly kind: K; readonly phrases: readonly string[] };

/** Any letters, for German and Italian compounds: `${LETTERS}strick${LETTERS}` takes Strickjacke and Feinstrick. */
const LETTERS = String.raw`\p{L}*`;

/**
 * The top vocabulary in matching order: the first row with a matching phrase
 * wins. Specific phrases come before the words they contain: "sweatshirt",
 * "overshirt", "t-shirt" and "polo shirt" are read before a plain "shirt".
 * Rows of kind unknown are stops: a turtleneck can be a thin base or a chunky
 * knit, a bare "vest" is a waistcoat, a sweater vest or (in British English)
 * an undershirt, and a puffer or rain jacket filed as a top goes over
 * anything, so they end the scan rather than fall through to a guess. English
 * first, then Italian and German.
 */
export const TOP_KIND_RULES: readonly KeywordRule<TopKind>[] = [
  // Tailored first: an overshirt or a knit blazer is still worn like a jacket.
  {
    kind: "tailored",
    phrases: [
      "blazers?",
      "sports? ?coats?",
      "sports? jackets?",
      "suit jackets?",
      "over ?shirts?",
      "shirt ?jackets?",
      "shirt ?jacs?",
      "shackets?",
      "waistcoats?",
      "sakkos?",
    ],
  },
  // Sweat before knit: a fleece cardigan or a hoodie sweater layers like a sweatshirt.
  {
    kind: "sweat",
    phrases: [
      "hoodies?",
      "hoodys?",
      "hooded (?:sweatshirts?|tops?|pullovers?|jackets?)",
      "sweat ?shirts?",
      "crew ?neck sweats?",
      "sweat ?jack(?:ets?|e|en)",
      // Fleeces and their compounds: Fleecejacke, Fleecepullover.
      `fleece${LETTERS}`,
      "track (?:tops?|jackets?)",
      "felp(?:a|e|ina|ine)",
      `kapuzen${LETTERS}`,
    ],
  },
  // Knit nouns, German compounds included: Strickjacke, Feinstrickpullover, Rollkragenpullover.
  {
    kind: "knit",
    phrases: [
      "sweaters?",
      "jumpers?",
      `${LETTERS}pullovers?`,
      `${LETTERS}pullis?`,
      "pullunder",
      "troyers?",
      "cardigans?",
      "cardis?",
      "cardy",
      "knitwear",
      "maglion(?:e|i|cino|cini)",
      `${LETTERS}strick${LETTERS}`,
    ],
  },
  // Zip tops, after the knit nouns so a "quarter-zip sweater" stays a knit.
  { kind: "sweat", phrases: ["quarter ?zips?", "half ?zips?", "1 4 zips?", "zip ?ups?"] },
  // Before "shirt": "t-shirt" folds to "t shirt" and "polo shirt" holds "shirt".
  {
    kind: "tee",
    phrases: [
      "t ?shirts?",
      "tees?",
      "tank ?tops?",
      "tanks?",
      "vest ?tops?",
      "camisoles?",
      "camis?",
      "bodysuits?",
      "henleys?",
      // A long-sleeve top or tee; a "long-sleeve shirt", "long sleeve linen shirt" or
      // "long sleeve oxford" is a button shirt (a "long sleeve t-shirt" still meets "t shirt" above).
      "long ?sleeves?(?!.* (?:shirts?|blouses?|button ?downs?|button ?ups?|oxfords?|flannels?|chambray)(?: |$))",
      // A polo is a tee; a "polo neck" is British for a turtleneck (a stop below).
      "polos?(?! ?necks?(?: |$))",
      "polo ?shirts?",
      "golf shirts?",
      "crop ?tops?",
      "tube tops?",
      "singlets?",
      "magli(?:etta|ette|ettina|ettine)",
      "canott(?:a|e|iera|iere)",
      "unterhemd(?:en)?",
    ],
  },
  {
    kind: "unknown",
    phrases: [
      "turtle ?necks?",
      "roll ?necks?",
      "polo ?necks?",
      "mock ?necks?",
      "funnel ?necks?",
      "dolcevit[ae]",
      `rollkragen${LETTERS}`,
    ],
  },
  // Knit as a modifier: after the tees ("knit polo" is a polo), before "shirt".
  // Italian "golf" is a knit; an English "golf shirt" or "golf polo" is a tee (above).
  { kind: "knit", phrases: ["knits?", "knitted", "cable ?knits?", "golf"] },
  { kind: "unknown", phrases: ["vests?", "gilets?", "westen?"] },
  {
    kind: "shirt",
    phrases: [
      "shirts?",
      "button ?downs?",
      "button ?ups?",
      "oxfords?",
      "flannels?",
      "blouses?",
      "chambray",
      "camici(?:a|e|etta|ette)",
      `${LETTERS}hemd(?:en)?`,
      "blus(?:a|e|en)",
    ],
  },
  // Weather jackets filed as tops (a puffer, a rain shell) are worn over anything and are no
  // blazer: a stop, before the plain jacket below reads them tailored.
  {
    kind: "unknown",
    phrases: [
      "(?:puffer|down|padded|quilted|insulated|rain|shell|hard ?shell|soft ?shell|wind|ski) ?jackets?",
      `${LETTERS}(?:puffer|daunen|stepp|regen|softshell|hardshell|wind|ski|outdoor|funktions)jacken?`,
      "giacc(?:a|he) (?:a vento|imbottit[ae]|impermeabil[ei]|da pioggia|da sci)",
    ],
  },
  // A jacket filed as a top is worn over one: tailored, after every more specific word.
  { kind: "tailored", phrases: ["jackets?", `${LETTERS}jacken?`, "giacc(?:a|he|hetta|hette|hetto|hetti)"] },
];

/**
 * The footwear vocabulary in matching order. Open shoes never take socks;
 * sockless shoes (loafers, espadrilles, heels) look right with or without
 * them. Explicit closed words (boots, sneakers) come before the sockless ones
 * so "block heel boots" stay closed. Anything unmatched is closed.
 */
export const FOOTWEAR_RULES: readonly KeywordRule<FootwearKind>[] = [
  {
    kind: "open",
    phrases: [
      `${LETTERS}sandal${LETTERS}`,
      "slides?",
      "sliders?",
      "flip ?flops?",
      "thongs?",
      "birkenstocks?",
      "infradito",
      "ciabatt(?:a|e|ina|ine)",
      "zehentrenner",
      "badelatschen",
      "pantolett(?:e|en)",
    ],
  },
  {
    kind: "closed",
    phrases: [
      `${LETTERS}boots?`,
      "booties",
      `${LETTERS}stiefel${LETTERS}`,
      "stival(?:i|e|etti|etto)",
      `${LETTERS}sneakers?`,
      "trainers?",
    ],
  },
  {
    kind: "sockless",
    phrases: [
      "loafers?",
      "boat ?shoes?",
      "deck ?shoes?",
      "moccasins?",
      "mocassin[oi]",
      "mokassins?",
      "espadrill(?:es?|as)",
      "ballet ?flats?",
      "ballerin(?:a|as|e)",
      "pumps?",
      "heels?",
      "stilett(?:os?|oes|i)",
      "mules?",
      "slingbacks?",
      "decollet(?:e|es)",
      "tacchi",
    ],
  },
];

/**
 * The sock vocabulary in matching order. The shape wins first (a no-show
 * sock is for low shoes whatever it is made of), then the strong dress words,
 * then sport, then the weak dress words (a "thin running sock" is a running
 * sock, a "fine merino sock" a dress sock), then warmth. Socks no word places
 * are warm when their warmth or materials say so (sockStyle), else everyday.
 */
export const SOCK_STYLE_RULES: readonly KeywordRule<SockStyle>[] = [
  {
    kind: "no_show",
    phrases: [
      "no ?shows?",
      "invisibl(?:e|i)",
      "liners?",
      "footies?",
      "footsies?",
      "ankle ?low",
      "low ?cut",
      "fantasmin(?:o|i)",
      "salvapiedi?",
      "fu(?:e)?sslinge?n?",
    ],
  },
  {
    kind: "dress",
    phrases: ["dress", `business${LETTERS}`, "suits?", "lisle", "filo di scozia", `elegant${LETTERS}`, `anzug${LETTERS}`],
  },
  {
    kind: "athletic",
    phrases: [
      `sport${LETTERS}`,
      "running",
      "runners?",
      "athletic",
      "gym",
      "trainers?",
      "training",
      "tennis",
      "cycling",
      `lauf${LETTERS}`,
    ],
  },
  { kind: "dress", phrases: ["thin", "sheer", "fine", "fine ?knit"] },
  {
    kind: "warm",
    phrases: [
      `${LETTERS}wool`,
      "wool(?:l)?en",
      "merino",
      "thermals?",
      `thermo${LETTERS}`,
      "hiking",
      "trekking",
      "skis?",
      "skiing",
      "boot ?socks?",
      "winter",
      "cashmere",
      "alpaca",
      "lana",
      "termic(?:a|he|o|i)",
      `${LETTERS}woll${LETTERS}`,
      `wander${LETTERS}`,
    ],
  },
];

/** A sock at this warmth level or above is warm when no word says otherwise (rubric 3: mid layer). */
export const WARM_SOCK_MIN_WARMTH = 3;

/** Materials that make a sock warm when no word says otherwise. Substring match: "merino wool", "lambswool". */
const WARM_SOCK_MATERIAL = /wool|merino|cashmere|alpaca/i;

type CompiledRule<K> = { kind: K; pattern: RegExp };

/** One pattern that matches any of the phrases as a whole phrase, between spaces or the text's ends. */
function wholePhrases(phrases: readonly string[]): RegExp {
  return new RegExp(`(?:^| )(?:${phrases.join("|")})(?= |$)`, "u");
}

/** Each row as one wholePhrases pattern. */
function compile<K>(rules: readonly KeywordRule<K>[]): readonly CompiledRule<K>[] {
  return rules.map(({ kind, phrases }) => ({ kind, pattern: wholePhrases(phrases) }));
}

const TOP_PATTERNS = compile(TOP_KIND_RULES);
const FOOTWEAR_PATTERNS = compile(FOOTWEAR_RULES);
const SOCK_PATTERNS = compile(SOCK_STYLE_RULES);

/** Lowercase, accents and ß folded, every run of other characters one space: "Füßlinge-Set" -> "fusslinge set". */
export function foldText(text: string | null): string {
  if (text === null) return "";
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll("ß", "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The kind of the first row with a phrase in `text`, or null. */
function firstMatch<K>(text: string | null, rules: readonly CompiledRule<K>[]): K | null {
  const folded = foldText(text);
  if (folded === "") return null;
  for (const rule of rules) {
    if (rule.pattern.test(folded)) return rule.kind;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * What kind of top an item is: its subcategory decides, and its name only
 * when the subcategory says nothing confident ("top", "turtleneck"). Anything
 * that is not a top, a dress included, is unknown.
 */
export function topKind(item: Named): TopKind {
  if (item.category !== "top") return "unknown";
  const fromSubcategory = firstMatch(item.subcategory, TOP_PATTERNS) ?? "unknown";
  if (fromSubcategory !== "unknown") return fromSubcategory;
  return firstMatch(item.name, TOP_PATTERNS) ?? "unknown";
}

/** The kinds worn over another top. */
const MID_KINDS: ReadonlySet<TopKind> = new Set<TopKind>(["knit", "sweat", "tailored"]);
/** The kinds worn next to the skin or under a layer. */
const BASE_KINDS: ReadonlySet<TopKind> = new Set<TopKind>(["tee", "shirt"]);

/**
 * Where a top is worn: tees and shirts are base (a shirt can also hang open
 * over a tee, which assessLayering allows), knits, sweats and tailored tops are
 * mid, anything unplaced is either. Null for anything that is not a top.
 */
export function layerRole(item: Named): LayerRole | null {
  if (item.category !== "top") return null;
  const kind = topKind(item);
  if (BASE_KINDS.has(kind)) return "base";
  if (MID_KINDS.has(kind)) return "mid";
  return "either";
}

/** Open, sockless or closed (the default for anything unplaced); null for anything that is not shoes. */
export function footwearKind(item: Named): FootwearKind | null {
  if (item.category !== "shoes") return null;
  return firstMatch(item.subcategory, FOOTWEAR_PATTERNS) ?? firstMatch(item.name, FOOTWEAR_PATTERNS) ?? "closed";
}

/**
 * Sneaker and sport-shoe words, matched like the tables above (folded text,
 * whole words, compounds included): sneakers, trainers, plimsolls, running
 * or gym shoes; Italian scarpe da ginnastica; German Turnschuhe, Laufschuhe,
 * Sportschuhe.
 */
export const SNEAKER_PHRASES: readonly string[] = [
  `${LETTERS}sneakers?`,
  `${LETTERS}trainers?`,
  "plimsolls?",
  "(?:running|tennis|skate|sports?|athletic|gym|training|trail|basketball) shoes?",
  "scarpe (?:da )?(?:ginnastica|tennis|running|corsa)",
  "scarpe sportive",
  `${LETTERS}(?:turn|lauf|sport|trainings|tennis)schuhe?`,
];

const SNEAKER_PATTERN = wholePhrases(SNEAKER_PHRASES);

/**
 * Whether shoes are sneakers or sport shoes by their words (SNEAKER_PHRASES,
 * in the subcategory or the name). False for anything that is not shoes.
 * The formality tag is the caller's to weigh: athletic shoes count as sport
 * shoes in scoring and the wardrobe profile whatever they are called.
 */
export function isSneaker(item: Named): boolean {
  if (item.category !== "shoes") return false;
  return SNEAKER_PATTERN.test(foldText(item.subcategory)) || SNEAKER_PATTERN.test(foldText(item.name));
}

/**
 * The style of a pair of socks: the words decide (subcategory first, then the
 * name); without a telling word, a warmth of WARM_SOCK_MIN_WARMTH or a wool,
 * merino, cashmere or alpaca material makes them warm, else everyday. Null
 * for anything that is not socks.
 */
export function sockStyle(
  item: Pick<StyleItem, "category" | "subcategory" | "name" | "materials" | "warmthLevel">,
): SockStyle | null {
  if (item.category !== "socks") return null;
  const named = firstMatch(item.subcategory, SOCK_PATTERNS) ?? firstMatch(item.name, SOCK_PATTERNS);
  if (named !== null) return named;
  const warm =
    (item.warmthLevel !== null && item.warmthLevel >= WARM_SOCK_MIN_WARMTH) ||
    item.materials.some((material) => WARM_SOCK_MATERIAL.test(material));
  return warm ? "warm" : "everyday";
}

/**
 * What the wardrobe offers the layering fixes: base tops (tees and shirts,
 * whose role is always base), socks and shoes. Every item passed counts; the
 * caller decides which items are available today.
 */
export function wardrobeCounts(items: Iterable<StyleItem>): WardrobeCounts {
  const counts: WardrobeCounts = { baseTops: 0, socks: 0, shoes: 0 };
  for (const item of items) {
    if (item.category === "top" && BASE_KINDS.has(topKind(item))) counts.baseTops += 1;
    else if (item.category === "socks") counts.socks += 1;
    else if (item.category === "shoes") counts.shoes += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// The outfit check
// ---------------------------------------------------------------------------

/** A repair for selection to apply, in the order given. */
export type LayerFix =
  /** The knit, sweat or tailored top in `top` moves to mid_layer (add_base_top then fills `top`). */
  | { kind: "move_top_to_mid" }
  /** The top and mid_layer items trade slots. */
  | { kind: "swap_top_and_mid" }
  /** A base top must be added to `top`, of the preferred kinds first. */
  | { kind: "add_base_top"; prefer: readonly TopKind[] }
  | { kind: "add_socks" }
  | { kind: "remove_socks" }
  | { kind: "add_shoes" };

/** drop: the outfit cannot be repaired and is left out; fixes is then empty. note: a short English reason for logs. */
export type LayerVerdict = { drop: boolean; fixes: LayerFix[]; note: string | null };

type MidTopKind = "knit" | "sweat" | "tailored";

/**
 * The base top to put under a mid-layer top worn alone. A t-shirt under a
 * hoodie or sweatshirt; a shirt collar under a knit and under a blazer or
 * overshirt, the classic pairings, with a tee as the second choice.
 */
export const BASE_TOP_PREFERENCE: Readonly<Record<MidTopKind, readonly TopKind[]>> = {
  sweat: ["tee", "shirt"],
  knit: ["shirt", "tee"],
  tailored: ["shirt", "tee"],
};

/** What the top slot holds: a top's kind, or a dress. */
type TopPiece = TopKind | "dress";

/** How a piece reads in a note. */
const PIECE_NOUN: Readonly<Record<TopPiece, string>> = {
  tee: "tee",
  shirt: "shirt",
  knit: "knit",
  sweat: "sweat top",
  tailored: "tailored top",
  unknown: "top",
  dress: "dress",
};

function isMidKind(kind: TopPiece | null): kind is MidTopKind {
  return kind !== null && kind !== "dress" && MID_KINDS.has(kind);
}

function isBaseKind(kind: TopPiece | null): kind is "tee" | "shirt" {
  return kind !== null && kind !== "dress" && BASE_KINDS.has(kind);
}

/** The item of the first entry in `slot`: null when the slot is empty or that entry's item is not in `items`. */
function itemIn(entries: StyleOutfit, items: ReadonlyMap<string, StyleItem>, slot: OutfitSlot): StyleItem | null {
  const entry = entries.find((candidate) => candidate.slot === slot);
  return entry === undefined ? null : (items.get(entry.itemId) ?? null);
}

/**
 * The first item in `slot` that the map knows, or null; entries for unknown
 * ids are skipped. What weather fit, scoring and selection read a slot by.
 */
export function firstItemInSlot(
  entries: StyleOutfit,
  items: ReadonlyMap<string, StyleItem>,
  slot: OutfitSlot,
): StyleItem | null {
  for (const entry of entries) {
    if (entry.slot !== slot) continue;
    const item = items.get(entry.itemId);
    if (item !== undefined) return item;
  }
  return null;
}

/** What the top slot holds; null when it is empty or its item is not in `items`. */
function topPieceOf(entries: StyleOutfit, items: ReadonlyMap<string, StyleItem>): TopPiece | null {
  const item = itemIn(entries, items, "top");
  if (item === null) return null;
  return item.category === "dress" ? "dress" : topKind(item);
}

/** The kind in mid_layer: null when the slot is empty, unknown when its item is not in `items`. */
function midKindOf(entries: StyleOutfit, items: ReadonlyMap<string, StyleItem>): TopKind | null {
  if (!entries.some((entry) => entry.slot === "mid_layer")) return null;
  const item = itemIn(entries, items, "mid_layer");
  return item === null ? "unknown" : topKind(item);
}

/** One rule's outcome: a drop with its note, fixes with theirs, or nothing to say. */
type Finding = { drop: string } | { fixes: LayerFix[]; note: string } | null;

/**
 * The top and mid layer together (topPieceOf, midKindOf). An unknown kind on
 * either side, or an empty top slot, settles nothing. `baseLayer`: the outfit
 * has a base_layer entry (a thermal) under the top.
 */
function judgeLayers(top: TopPiece | null, mid: TopKind | null, baseLayer: boolean, wardrobe: WardrobeCounts): Finding {
  if (top === null || top === "unknown" || mid === "unknown") return null;
  if (mid === null) return judgeTopAlone(top, baseLayer, wardrobe);
  const note = `${PIECE_NOUN[mid]} in mid layer over a ${PIECE_NOUN[top]}`;
  // Over a dress: a cardigan, sweatshirt or blazer works; a tee or shirt does not.
  if (top === "dress") return isBaseKind(mid) ? { drop: note } : null;
  if (isBaseKind(mid)) return judgeBaseOver(top, mid, note);
  return isMidKind(top) ? judgeLayerOverLayer(top, mid, note) : null;
}

/**
 * A layer top alone in `top` moves out to the mid layer, and a base top goes
 * under it. Over a thermal base layer a hoodie or a knit is already layered
 * and stays; a blazer or overshirt still wants a collar or a tee under it.
 */
function judgeTopAlone(top: TopPiece, baseLayer: boolean, wardrobe: WardrobeCounts): Finding {
  if (!isMidKind(top) || wardrobe.baseTops === 0) return null;
  if (baseLayer && top !== "tailored") return null;
  return {
    fixes: [{ kind: "move_top_to_mid" }, { kind: "add_base_top", prefer: BASE_TOP_PREFERENCE[top] }],
    note: `${PIECE_NOUN[top]} worn without a base top`,
  };
}

/** A tee or shirt in mid_layer over a top. */
function judgeBaseOver(top: TopKind, mid: "tee" | "shirt", note: string): Finding {
  // The layers are the wrong way round: the base top belongs in `top`.
  if (isMidKind(top)) return { fixes: [{ kind: "swap_top_and_mid" }], note: `${note}, swapped` };
  // An open shirt over a tee is a look; a tee over any top, or a shirt over a shirt, is not.
  return mid === "shirt" && top === "tee" ? null : { drop: note };
}

/**
 * Two layer tops. A blazer over a knit is the one pairing that works, and the
 * same pair the wrong way round (a sweater over a blazer) is put right.
 */
function judgeLayerOverLayer(top: MidTopKind, mid: MidTopKind, note: string): Finding {
  if (mid === "tailored" && top === "knit") return null;
  if (mid === "knit" && top === "tailored") return { fixes: [{ kind: "swap_top_and_mid" }], note: `${note}, swapped` };
  return { drop: note };
}

/**
 * Shoes and socks. Closed shoes get socks, open shoes lose them, sockless
 * shoes are left alone. An outfit without shoes gets shoes and, since the
 * added shoes are taken to be closed, socks too.
 */
function judgeFeet(entries: StyleOutfit, items: ReadonlyMap<string, StyleItem>, wardrobe: WardrobeCounts): Finding {
  const hasSocks = entries.some((entry) => entry.slot === "socks");
  const canAddSocks = !hasSocks && wardrobe.socks > 0;

  if (!entries.some((entry) => entry.slot === "shoes")) {
    if (wardrobe.shoes === 0) return null;
    if (!canAddSocks) return { fixes: [{ kind: "add_shoes" }], note: "no shoes" };
    return { fixes: [{ kind: "add_shoes" }, { kind: "add_socks" }], note: "no shoes or socks" };
  }

  const shoes = itemIn(entries, items, "shoes");
  const kind = shoes === null ? null : footwearKind(shoes);
  if (kind === "closed" && canAddSocks) return { fixes: [{ kind: "add_socks" }], note: "closed shoes without socks" };
  if (kind === "open" && hasSocks) return { fixes: [{ kind: "remove_socks" }], note: "socks with open shoes" };
  return null;
}

/**
 * Whether an outfit's layers and feet make sense, and what would put them
 * right. Layers: a knit, sweat or tailored top alone in `top` moves to the mid
 * layer over a base top (a knit or sweat top over a base_layer entry, such as
 * a thermal, is left as it is); a tee or shirt in mid_layer over a layer top swaps
 * places with it, and so does a knit over a blazer; a tee over another top, a
 * shirt over a shirt, two layer tops (except a blazer over a knit) and a tee
 * or shirt over a dress are dropped. Feet: see judgeFeet. Each fix needs the
 * wardrobe to hold what it adds. A drop wins over every fix. Layer fixes come
 * before feet fixes. The first entry of each slot is read; slot problems are
 * validateOutfit's to report.
 */
export function assessLayering(
  entries: StyleOutfit,
  items: ReadonlyMap<string, StyleItem>,
  wardrobe: WardrobeCounts,
): LayerVerdict {
  const top = topPieceOf(entries, items);
  const mid = midKindOf(entries, items);
  const baseLayer = entries.some((entry) => entry.slot === "base_layer");

  const fixes: LayerFix[] = [];
  const notes: string[] = [];
  for (const finding of [judgeLayers(top, mid, baseLayer, wardrobe), judgeFeet(entries, items, wardrobe)]) {
    if (finding === null) continue;
    if ("drop" in finding) return { drop: true, fixes: [], note: finding.drop };
    fixes.push(...finding.fixes);
    notes.push(finding.note);
  }
  return { drop: false, fixes, note: notes.length === 0 ? null : notes.join("; ") };
}
