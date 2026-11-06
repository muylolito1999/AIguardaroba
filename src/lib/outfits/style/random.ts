// A small seeded random source for the style library (D-256): the same day,
// city and run always rotate the style directions the same way, so a
// suggestion can be reproduced from its inputs and tests can pin the order.
// Not for anything secret. Pure and client-safe: no clock, no Math.random.

/**
 * A 32-bit seed from text: FNV-1a over the UTF-8 bytes, unsigned. FNV-1a is
 * tiny, spreads short keys that differ by one character (a run index) well,
 * and has published test vectors ("" -> 0x811c9dc5, "a" -> 0xe40c292c).
 */
export function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * mulberry32: a fast 32-bit generator whose output is uniform enough for
 * shuffling a handful of directions, with a period of 2^32. Values are in
 * [0, 1). The seed is taken modulo 2^32 (a non-integer is truncated). The
 * state wraps at 32 bits, so the sequence matches the reference
 * implementation however many values are drawn.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
