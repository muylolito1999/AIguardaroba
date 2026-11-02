import { describe, expect, it } from "vitest";

import {
  WINTER_READINESS_KEYS,
  computeWinterReadiness,
  countsForReadiness,
  type WinterReadinessItem,
  type WinterReadinessKey,
  type WinterReadinessRow,
} from "./winter-readiness";

let nextId = 0;

/** A confirmed, undecided item with no weather flags; tests set what a rule reads. */
function item(overrides: Partial<WinterReadinessItem> = {}): WinterReadinessItem {
  nextId += 1;
  return {
    id: `item-${nextId}`,
    name: null,
    subcategory: null,
    category: "top",
    status: "confirmed",
    decision: "undecided",
    materials: [],
    materialGuess: null,
    warmthLevel: 2,
    waterproof: false,
    windproof: false,
    insulated: false,
    ...overrides,
  };
}

function rowFor(rows: WinterReadinessRow[], key: WinterReadinessKey): WinterReadinessRow {
  const row = rows.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`no row for ${key}`);
  return row;
}

describe("computeWinterReadiness", () => {
  it("returns every rule in checklist order, all missing for an empty wardrobe", () => {
    const rows = computeWinterReadiness([]);
    expect(rows.map((row) => row.key)).toEqual([...WINTER_READINESS_KEYS]);
    for (const row of rows) {
      expect(row.satisfied).toBe(false);
      expect(row.evidenceIds).toEqual([]);
      expect(row.evidence).toEqual([]);
      expect(row.need).not.toBe("");
      expect(row.label).not.toBe("");
    }
  });

  it("needs outerwear that is waterproof for the shell", () => {
    const shell = item({ category: "outerwear", waterproof: true, name: "Rain shell" });
    const coat = item({ category: "outerwear", waterproof: false, name: "Wool coat" });
    const wetTop = item({ category: "top", waterproof: true });

    expect(rowFor(computeWinterReadiness([coat, wetTop]), "waterproof_shell")).toMatchObject({
      satisfied: false,
      evidenceIds: [],
      need: "A waterproof jacket or coat for the frequent drizzle.",
    });
    expect(rowFor(computeWinterReadiness([coat, shell, wetTop]), "waterproof_shell")).toEqual({
      key: "waterproof_shell",
      label: "Waterproof shell",
      satisfied: true,
      evidenceIds: [shell.id],
      evidence: [{ id: shell.id, name: "Rain shell" }],
      need: "",
    });
  });

  it("needs shoes that are both insulated and waterproof", () => {
    const boots = item({ category: "shoes", insulated: true, waterproof: true });
    const wellies = item({ category: "shoes", insulated: false, waterproof: true });
    const slippers = item({ category: "shoes", insulated: true, waterproof: false });
    const parka = item({ category: "outerwear", insulated: true, waterproof: true });

    const missing = rowFor(computeWinterReadiness([wellies, slippers, parka]), "insulated_waterproof_footwear");
    expect(missing).toMatchObject({ satisfied: false, evidenceIds: [] });
    expect(missing.need).toMatch(/insulated and waterproof/);

    const met = rowFor(computeWinterReadiness([wellies, boots, slippers, parka]), "insulated_waterproof_footwear");
    expect(met).toMatchObject({ satisfied: true, evidenceIds: [boots.id], need: "" });
  });

  it("needs gloves that are windproof", () => {
    const knitted = item({ category: "gloves", windproof: false });
    const shell = item({ category: "gloves", windproof: true });
    const windbreaker = item({ category: "outerwear", windproof: true });

    expect(rowFor(computeWinterReadiness([knitted, windbreaker]), "windproof_gloves")).toMatchObject({
      satisfied: false,
      evidenceIds: [],
    });
    expect(rowFor(computeWinterReadiness([knitted, shell, windbreaker]), "windproof_gloves")).toMatchObject({
      satisfied: true,
      evidenceIds: [shell.id],
    });
  });

  it("needs a hat or beanie with warmth 3 or more", () => {
    const cap = item({ category: "hat_beanie", warmthLevel: 2 });
    const untagged = item({ category: "hat_beanie", warmthLevel: null });
    const beanie = item({ category: "hat_beanie", warmthLevel: 3 });
    const trapper = item({ category: "hat_beanie", warmthLevel: 5 });

    const missing = rowFor(computeWinterReadiness([cap, untagged]), "warm_beanie");
    expect(missing).toMatchObject({ satisfied: false, evidenceIds: [] });
    expect(missing.need).toMatch(/warmth 3 or more/);

    expect(rowFor(computeWinterReadiness([cap, beanie, trapper]), "warm_beanie")).toMatchObject({
      satisfied: true,
      evidenceIds: [beanie.id, trapper.id],
    });
  });

  it("takes any scarf", () => {
    const scarf = item({ category: "scarf", warmthLevel: 1 });
    expect(rowFor(computeWinterReadiness([item()]), "scarf").satisfied).toBe(false);
    expect(rowFor(computeWinterReadiness([scarf]), "scarf")).toMatchObject({
      satisfied: true,
      evidenceIds: [scarf.id],
    });
  });

  it("needs two base layers in merino, wool or thermal, found in any tag text", () => {
    const merino = item({ category: "base_layer", materials: ["Merino wool"] });
    const guessed = item({ category: "base_layer", materialGuess: "lambswool blend" });
    const bySubcategory = item({ category: "base_layer", subcategory: "Thermal leggings" });
    const byName = item({ category: "base_layer", name: "Long thermals" });
    const cotton = item({ category: "base_layer", materials: ["cotton"], name: "Cotton undershirt" });
    const woolJumper = item({ category: "top", materials: ["wool"] });

    const none = rowFor(computeWinterReadiness([cotton, woolJumper]), "base_layers");
    expect(none).toMatchObject({
      satisfied: false,
      evidenceIds: [],
      need: "At least 2 base layers in merino, wool or a thermal fabric.",
    });

    // One is not enough: the row stays missing but shows the one there is.
    const one = rowFor(computeWinterReadiness([cotton, merino, woolJumper]), "base_layers");
    expect(one).toMatchObject({
      satisfied: false,
      evidenceIds: [merino.id],
      need: "1 more base layer in merino, wool or a thermal fabric (1 of 2 so far).",
    });

    const two = rowFor(computeWinterReadiness([merino, guessed]), "base_layers");
    expect(two).toMatchObject({ satisfied: true, evidenceIds: [merino.id, guessed.id], need: "" });

    const all = rowFor(computeWinterReadiness([merino, cotton, guessed, bySubcategory, byName]), "base_layers");
    expect(all.evidenceIds).toEqual([merino.id, guessed.id, bySubcategory.id, byName.id]);
  });

  it.each(["leave", "donate", "sell"] as const)(
    "never counts an item marked %s, since it will not be in Hamburg",
    (decision) => {
      const items = [
        item({ category: "outerwear", waterproof: true, decision }),
        item({ category: "shoes", insulated: true, waterproof: true, decision }),
        item({ category: "gloves", windproof: true, decision }),
        item({ category: "hat_beanie", warmthLevel: 4, decision }),
        item({ category: "scarf", decision }),
        item({ category: "base_layer", materials: ["merino"], decision }),
        item({ category: "base_layer", materials: ["merino"], decision }),
      ];
      for (const row of computeWinterReadiness(items)) {
        expect(row, row.key).toMatchObject({ satisfied: false, evidenceIds: [] });
      }
    },
  );

  it("counts items marked bring or undecided", () => {
    const bring = item({ category: "scarf", decision: "bring" });
    const undecided = item({ category: "scarf", decision: "undecided" });
    const sold = item({ category: "scarf", decision: "sell" });
    expect(rowFor(computeWinterReadiness([bring, sold, undecided]), "scarf").evidenceIds).toEqual([
      bring.id,
      undecided.id,
    ]);
  });

  it("ignores pending and archived items, whose tags cannot be trusted or which are gone", () => {
    const pending = item({ category: "scarf", status: "pending_tagging" });
    const archived = item({ category: "scarf", status: "archived" });
    const tagged = item({ category: "scarf", status: "tagged" });
    expect(rowFor(computeWinterReadiness([pending, archived]), "scarf").satisfied).toBe(false);
    expect(rowFor(computeWinterReadiness([pending, tagged, archived]), "scarf").evidenceIds).toEqual([tagged.id]);
  });

  it("names evidence by name, then subcategory, then category label", () => {
    const named = item({ category: "scarf", name: "  Grey cashmere scarf ", subcategory: "scarf" });
    const bySubcategory = item({ category: "scarf", name: " ", subcategory: "snood" });
    const byCategory = item({ category: "scarf", name: null, subcategory: null });
    expect(rowFor(computeWinterReadiness([named, bySubcategory, byCategory]), "scarf").evidence).toEqual([
      { id: named.id, name: "Grey cashmere scarf" },
      { id: bySubcategory.id, name: "snood" },
      { id: byCategory.id, name: "Scarf" },
    ]);
  });
});

describe("countsForReadiness", () => {
  it("accepts tagged and confirmed items going to Hamburg or not yet decided", () => {
    expect(countsForReadiness({ status: "tagged", decision: "bring" })).toBe(true);
    expect(countsForReadiness({ status: "confirmed", decision: "undecided" })).toBe(true);
    expect(countsForReadiness({ status: "confirmed", decision: "donate" })).toBe(false);
    expect(countsForReadiness({ status: "pending_tagging", decision: "bring" })).toBe(false);
    expect(countsForReadiness({ status: "archived", decision: "bring" })).toBe(false);
  });
});
