import { describe, expect, it } from "vitest";

import { seededRandom, seedFrom } from "@/lib/outfits/style/random";

/** The published mulberry32, verbatim apart from types: the reference the implementation must match. */
function referenceMulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const draw = (random: () => number, count: number) => Array.from({ length: count }, () => random());

describe("seedFrom", () => {
  it.each([
    ["", 0x811c9dc5],
    ["a", 0xe40c292c],
    ["foobar", 0xbf9cf968],
  ])("matches the FNV-1a 32-bit test vector for %j", (text, expected) => {
    expect(seedFrom(text)).toBe(expected);
  });

  it("pins the seeds of two runs on the same day", () => {
    expect(seedFrom("2026-11-06|hamburg|0")).toBe(4257773025);
    expect(seedFrom("2026-11-06|hamburg|1")).toBe(4240995406);
  });

  it("gives different strings different seeds", () => {
    const keys = Array.from({ length: 500 }, (_, index) => `2026-11-06|bologna|${index}`);
    expect(new Set(keys.map(seedFrom)).size).toBe(keys.length);
    expect(seedFrom("ab")).not.toBe(seedFrom("ba"));
  });

  it("is an unsigned 32-bit integer, for any text", () => {
    for (const text of ["", "Città", "naïve café", "\u{1F9E5} coat", "x".repeat(10_000)]) {
      const seed = seedFrom(text);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2 ** 32);
    }
  });

  it("hashes UTF-8 bytes, not UTF-16 code units", () => {
    // "é" is two bytes in UTF-8; the precomposed and decomposed forms differ.
    expect(seedFrom("café")).not.toBe(seedFrom("café"));
    expect(seedFrom("é")).toBe(seedFrom("é"));
  });
});

describe("seededRandom", () => {
  it("pins the first values of seed 1", () => {
    const random = seededRandom(1);
    expect(draw(random, 3)).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
  });

  it("matches the reference mulberry32 over a long run", () => {
    for (const seed of [0, 1, 42, 0x7fffffff, 0xffffffff, seedFrom("2026-11-06|hamburg|0")]) {
      expect(draw(seededRandom(seed), 5_000)).toEqual(draw(referenceMulberry32(seed), 5_000));
    }
  });

  it("is deterministic per seed, and seeds differ", () => {
    expect(draw(seededRandom(7), 100)).toEqual(draw(seededRandom(7), 100));
    expect(draw(seededRandom(7), 100)).not.toEqual(draw(seededRandom(8), 100));
  });

  it("takes the seed modulo 2^32", () => {
    expect(draw(seededRandom(2 ** 32 + 5), 10)).toEqual(draw(seededRandom(5), 10));
    expect(draw(seededRandom(-1), 10)).toEqual(draw(seededRandom(0xffffffff), 10));
  });

  it("stays in [0, 1) and is roughly uniform", () => {
    const values = draw(seededRandom(seedFrom("uniform")), 10_000);
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean).toBeGreaterThan(0.47);
    expect(mean).toBeLessThan(0.53);
    // Each tenth of the range gets about a tenth of the draws.
    const deciles = new Array<number>(10).fill(0);
    for (const value of values) deciles[Math.floor(value * 10)] = (deciles[Math.floor(value * 10)] ?? 0) + 1;
    for (const count of deciles) expect(count).toBeGreaterThan(850);
  });
});
