// The relocation prompts (D-025, D-028). Every request of a run has three
// parts, in this order:
// 1. RELOCATION_SYSTEM_PROMPT: fixed text (callStructured puts the cache
//    breakpoint on it), shared by every run.
// 2. buildSharedContext(): the climate, constraints, budget, wardrobe summary
//    and line legend. Identical for every part of one run, so the service
//    sends it as the first user text block with its own cache_control and
//    parallel chunks can share it.
// 3. One instruction: a chunk, a repair or the synthesis.
// prompts.test.ts pins, per version, the system prompt's sha256 and one over
// the other templates (shared context, instructions, legend, wire schemas): an
// edit to any of them must bump RELOC_PROMPT_VERSION, which is the cache key's
// only view of the prompt (D-140). reloc-v2 states the gap_note and extras
// limits the strict check enforces (D-160). reloc-v3 defines the decisions by
// where an item ends up (shipped items are bring), keeps enough of the items
// worn in rotation, and marks items already at the run's own destination
// (now:there) instead of assuming Hamburg (D-170, D-171). reloc-v4 gives the
// chunk instruction's leave the system prompt's meaning for items marked
// now:there or now:in_transit, "not needed there" (D-179).
// Pure: no `server-only`, env or Node APIs.

import { MONTH_NAMES } from "@/lib/climate/range";
import { normalizeConstraints, type RelocationDecision, type RelocationPriority } from "@/lib/relocation/contracts";
import { RELOCATION_LIMITS } from "@/lib/relocation/schemas";

export const RELOC_PROMPT_VERSION = "reloc-v4";

export const RELOCATION_SYSTEM_PROMPT = `You are a frugal relocation stylist working inside a personal wardrobe app. The owner is moving to another city (usually from Bologna, Italy, to Hamburg, Germany) and wants to know, for every clothing item and accessory they own, whether to bring it, leave it behind, donate it or sell it, and what little they still need to buy for the new climate. The owner reads your answer in the app, checks it and can override any decision, so be concrete and honest rather than reassuring.

Each request holds the destination's climate data, the owner's constraints and purchase budget, a summary of the wardrobe, and items as compact lines under short aliases. A request either decides a batch of items or, once every item has a decision, plans the whole move. Work only from this data and answer in the required JSON format.

READING THE CLIMATE
Reason from the numbers for the months of the stay, not from the city's reputation. The months are listed in order and the first is the arrival month, so the clothes for that month must be at hand in the first weeks.
- Temperature: tmax describes the daytime; tmin describes early mornings, evenings and the commute. Rough bands:
  below 0 °C, freezing: insulated outer layer, thermal base layer, hat, gloves, scarf, insulated footwear with grip.
  0 to 5 °C, cold: a warm coat, or a shell over an insulating mid layer, plus hat and gloves.
  5 to 10 °C, chilly: a mid layer under a wind- and waterproof jacket.
  10 to 15 °C, cool: a light jacket or a knit, in layers that come off.
  15 to 20 °C, mild: a light layer for evenings and wind.
  above 20 °C, warm: breathable clothes, plus a light shell where rain is frequent.
- Rain: count rain days (at least 1 mm) before millimetres. About 15 or more rain days in a month means rain on most days: daily rain gear, meaning a breathable waterproof shell with a hood and waterproof footwear, is essential, not optional. Frequent light rain and drizzle favour a breathable shell over an umbrella, above all on a bike, where an umbrella is useless.
- Wind: persistent wind and storm days (gusts of 62 km/h or more) make the air feel several degrees colder, wreck umbrellas, and raise the value of windproof outer layers, hoods and a hat that stays on. A 30 km/h wind near freezing feels well below 0 °C.
- Humidity: damp cold (winter humidity above about 80 %) feels colder than dry cold and soaks into cotton. Prefer wool, merino and synthetic fills that stay warm when damp, and layers that dry overnight.
- Daylight: short winter days (under about 8 hours of daylight, little sunshine) mean commuting in the dark. On a bike or on foot, visibility matters: bright or reflective outer layers and reflective details.
- Snow and frost: frost days and snow cover call for footwear with grip and insulation, not only waterproofing.
- Use every note in the climate data; remarks about drizzle, wind or footwear are deliberate. When the data is marked PLACEHOLDER, say so, reason more cautiously and never cite a number shown as ?.

DECISIONS
Decide by where the item ends up, not by how it travels.
- bring: goes to the destination for life in the new climate (the commute, the dress code at work, free time), in the luggage, worn on the travel day, or shipped later when the constraints allow it. Versatile layering pieces, weather gear and items the owner clearly relies on.
- leave: worth keeping but not moved in this relocation; it stays behind (with family, in storage). Typical: clothes that suit the old climate far better than the new one, bulky items that neither the luggage nor any shipping the constraints allow can take, sentimental or valuable pieces not needed there. For an item already at the destination or on its way, leave means it is not needed there.
- donate: unlikely to be worn again and of little resale value: worn out, a weaker duplicate, a poor fit for the new climate and daily life.
- sell: unlikely to be worn again but with resale value: new or good condition, recognisable quality, formal or specialist pieces with no use ahead.
Weigh warmth, weather protection, condition, formality and how the item combines with the rest of the wardrobe; never decide from a single field. Most items are clear-cut: decide those quickly and give the borderline ones your care.
Priority, 1 to 3:
- for bring: 1 = needed in the first weeks (suitcase, carry-on or worn on the travel day); 2 = useful soon; 3 = nice to have if space allows. Items to ship later are bring, usually priority 2 or 3.
- for leave, donate and sell: 1 = clear-cut; 2 = likely; 3 = borderline, worth a second look by the owner.

PRINCIPLES
- Prefer layering over single heavy items. A base layer, an insulating mid layer and a windproof, waterproof shell cover a wider range of weather than one heavy coat, and they pack smaller.
- Be frugal. Never recommend buying what the wardrobe already effectively covers: an owned item of the same type, warmth and weather protection counts even if it is not perfect. Recommend a purchase only for a real gap, and justify it from the climate numbers.
- Respect the constraints: number and weight of suitcases, what can be shipped later, the purchase budget, the commute and the dress code. When space is tight, put what is versatile or hard to replace in the luggage, ship (bring) what is bulky and needed later, and leave what is bulky or easy to replace.
- Duplicates: when several items do the same job, bring as many as the stay needs, the best first, and let the surplus go. Items worn in rotation (socks, underwear, base layers, shirts for a working week) are needed several at a time: keep enough for about a week between washes.
- Condition: worn or needs_repair items are weak candidates to move unless they are hard to replace.
- The purchase budget, when given, is the total for all new purchases. When none is given, use a budget stated in the constraints; otherwise buy only what the climate makes necessary.

ITEM LINES
Each item is one line of pipe-separated fields, explained by the legend in the request.
- Use only the aliases given. Never invent items, aliases or attributes.
- A field shown as ? is unknown; do not treat a guess about it as a fact.
- lc: lists tags the automatic tagging was unsure about. They may be wrong, so lean on the other fields and the name.
- Tag status tagged means AI tags the owner has not checked yet; trust them a little less than confirmed ones.
- now:there or now:in_transit marks an item that is already at the destination or on its way there. Decide it like any other item, but never put it in a packing checklist: it needs no packing.

WRITING
- Reasons are terse: at most 120 characters, specific to the item and the climate, such as "Breathable waterproof shell for 16-18 rain days a month" or "Third similar navy knit; the two better ones go". No filler, no item name, no alias.
- Plain English, metric units, prices in whole euros.
- Every field of the format is required; use null only where the format allows it.`;

// ---------------------------------------------------------------------------
// The shared context
// ---------------------------------------------------------------------------

export type SharedContextInput = {
  /** describeClimateForPrompt(profile, months). */
  climateText: string;
  /** Months in range order, arrival first. */
  months: readonly number[];
  constraints: string;
  purchaseBudgetEur: number | null;
  /** RelocationSnapshot.summaryText. */
  summaryText: string;
  /** RelocationSnapshot.legend. */
  legend: string;
};

const EUR = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** "Nov (arrival), Dec, Jan". */
export function describeStayMonths(months: readonly number[]): string {
  return months
    .map((month, index) => {
      const name = MONTH_NAMES[month - 1];
      if (name === undefined) throw new RangeError(`Month ${month} is not between 1 and 12.`);
      return index === 0 ? `${name} (arrival)` : name;
    })
    .join(", ");
}

/**
 * The run's context, identical for every part of the run (send it as the first
 * user text block with cache_control). Constraints are whitespace-normalised
 * exactly as in the cache key.
 */
export function buildSharedContext(input: SharedContextInput): string {
  const constraints = normalizeConstraints(input.constraints);
  const budget =
    input.purchaseBudgetEur === null
      ? "No purchase budget given."
      : `€${EUR.format(input.purchaseBudgetEur)} in total for all new purchases.`;
  return [
    "<climate>",
    input.climateText,
    "</climate>",
    "",
    `<stay months="${input.months.length}">`,
    describeStayMonths(input.months),
    "</stay>",
    "",
    "<owner_constraints>",
    constraints === "" ? "None given." : constraints,
    "</owner_constraints>",
    "",
    "<purchase_budget>",
    budget,
    "</purchase_budget>",
    "",
    "<wardrobe_summary>",
    input.summaryText,
    "</wardrobe_summary>",
    "",
    "<item_format>",
    input.legend,
    "</item_format>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

type LineLike = { text: string };

function itemsBlock(lines: readonly LineLike[]): string {
  return [`<items count="${lines.length}">`, ...lines.map((line) => line.text), "</items>"].join("\n");
}

function decisionsWord(count: number): string {
  return count === 1 ? "1 decision" : `${count} decisions`;
}

/** One chunk call: decide every listed item. */
export function buildChunkInstruction(lines: readonly LineLike[]): string {
  const count = lines.length;
  return [
    itemsBlock(lines),
    "",
    `Decide ${count === 1 ? "the item" : `each of the ${count} items`} above: bring, leave, donate or sell, with a priority and a terse reason.`,
    `- Return exactly ${decisionsWord(count)}: one per alias listed in <items>, each alias once, in the listed order.`,
    "- Only these items are decided in this request; the rest of the wardrobe is decided separately. " +
      "The wardrobe summary shows what else the owner has.",
    "- Compare these items with each other: when several do the same job, bring as many as the stay needs " +
      "(about a week's worth of items worn in rotation), the best first, and let the surplus go.",
    "- bring includes items to ship later; leave means the item is not moved, or, for an item marked now:there " +
      "or now:in_transit, that it is not needed there.",
  ].join("\n");
}

/** The one repair call of a chunk: decide only the items the reply left out. */
export function buildRepairInstruction(missingLines: readonly LineLike[]): string {
  const count = missingLines.length;
  const opening =
    count === 1
      ? "This item still has no decision. Decide it"
      : `These ${count} items still have no decision. Decide each of them`;
  return [
    itemsBlock(missingLines),
    "",
    `${opening}: bring, leave, donate or sell, with a priority and a terse reason.`,
    `- Return exactly ${decisionsWord(count)}: one per alias listed in <items>, each alias once, and no other aliases.`,
  ].join("\n");
}

/** "i12|bring|1": how the synthesis sees one chunk decision. */
export function formatDecisionLine(decision: {
  item: string;
  decision: RelocationDecision;
  priority: RelocationPriority;
}): string {
  return `${decision.item}|${decision.decision}|${decision.priority}`;
}

/** The synthesis call: plan the move around the decisions. */
export function buildSynthesisInstruction(input: { lines: readonly LineLike[]; decisions: readonly string[] }): string {
  return [
    itemsBlock(input.lines),
    "",
    "<decisions>",
    "alias|decision|priority, one line per item:",
    ...input.decisions,
    "</decisions>",
    "",
    "Every item above already has a decision, listed in <decisions>. Do not change or repeat the decisions; plan the move around them. " +
      "Use only aliases listed in <items>. Fill in:",
    "",
    "summary: at most 1,200 characters. First the climate of the stay in plain words, with the key numbers " +
      "(temperatures, rain days, wind, daylight). Then the three most important conclusions for this wardrobe.",
    "",
    "layering_systems: 3 to 5 layered outfits for typical weather of the stay, built from owned items, preferably ones decided bring. " +
      "Cover these conditions when the stay includes them: about 3 °C with drizzle and 30 km/h wind; about 12 °C and showery, as in April; " +
      "about 21 °C in July with a risk of rain. Add the stay's most demanding condition if it is not among them, such as a freezing, windy morning. " +
      "title: the condition in a few words. conditions: the weather in numbers. " +
      "item_aliases: the items worn together, from base layer to outer layer, then footwear and accessories. " +
      `gap_note: what is missing for this condition in at most ${RELOCATION_LIMITS.gapNoteMax} characters ` +
      "(it should match a gap below), or null when the owned items cover it.",
    "",
    "gaps: at most 12 purchases the wardrobe really needs, most important first; none that items decided bring already cover in the quantity needed. For each: " +
      'item_type, e.g. "waterproof breathable shell jacket"; category; ' +
      'why_needed, citing the climate numbers, e.g. "16-18 rain days a month from October to January, daily cycling"; ' +
      'specs as concrete, checkable features, e.g. "hood and taped seams, at least 10,000 mm water column", ' +
      '"insulated waterproof boots with a grippy sole", "windproof gloves", "merino base layer 150-250 g/m²", ' +
      '"wool or fleece-lined beanie covering the ears"; ' +
      "priority: 1 = needed for the first cold or wet weeks, 2 = within the first season, 3 = optional; quantity; " +
      "a realistic price range in whole euros for good mid-range quality; " +
      "buy_timing: before_move when it is needed on arrival or clearly cheaper before the move, " +
      "after_move when it is better bought there (local know-how, bulky to carry), either otherwise. " +
      "When a purchase budget is given, the minimum prices of the priority 1 and 2 gaps, times their quantities, " +
      "should add up to no more than the budget; if the essentials cost more, keep them, move the rest to priority 3 and say so in the summary.",
    "",
    "packing_checklist: one entry per group, in this order: suitcase, carry_on, wear_on_travel_day, ship_later. " +
      "item_aliases: items decided bring, each in exactly one group; items marked now:there or now:in_transit are never packed. " +
      "Wear the bulkiest warm items on the travel day (the heaviest coat, boots, a thick knit) to save luggage weight. " +
      "carry_on: what is needed on arrival day and anything fragile or valuable. " +
      "ship_later: items decided bring that are not needed in the first weeks, such as clothes for months later in the stay. " +
      `extras: up to ${RELOCATION_LIMITS.extrasMax} short, useful things to pack in that group that are not catalogued items, ` +
      `each at most ${RELOCATION_LIMITS.extraMax} characters, e.g. "bike lights"; [] when none.`,
    "",
    "warnings: what the owner should check, each naming the items concerned. " +
      "uncertain_tags: a decision that rests on lc: tags; duplicate: several items doing the same job; " +
      "poor_condition: worn or needs_repair items decided bring; other: anything else important. " +
      "message: at most 300 characters. [] when there is nothing to warn about.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Request parameters
// ---------------------------------------------------------------------------

/** When a part must be done with Claude, from the start of its request (D-145); the part route uses it. */
export const RELOCATION_PART_DEADLINE_MS = 270_000;

/** The slowest output speed assumed for Sonnet at medium effort (design.md), in tokens per second. */
export const RELOCATION_MIN_OUTPUT_TOKENS_PER_SECOND = 110;

/**
 * Output caps per call kind. Thinking shares the cap with the JSON. Each cap
 * is what a part can write in its 270 s at the slowest assumed speed, with
 * room for the time to the first token, and the ceiling equals the cap: the
 * doubled max_tokens retry of D-062 could never finish in time, so a
 * max_tokens stop ends the part at once with its own message (D-164). A
 * 70-item chunk writes about 4K visible tokens; the synthesis grows with the
 * items that could be decided bring (D-175).
 */
export const RELOCATION_CALL_PARAMS = {
  chunk: { purpose: "relocation_chunk", maxTokens: 24_000, maxTokensCeiling: 24_000 },
  repair: { purpose: "relocation_repair", maxTokens: 16_000, maxTokensCeiling: 16_000 },
  synthesis: { purpose: "relocation_synthesis", maxTokens: 24_000, maxTokensCeiling: 24_000 },
} as const;
