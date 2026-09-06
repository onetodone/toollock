/**
 * Deterministic seeded sampling for Phase 5's seed-list expansion
 * (DECISIONS.md #17). A ranking would be a quality claim that has to be
 * defended and is gameable; a seeded pseudorandom draw only has to be
 * *reproducible*. `xmur3` + `mulberry32` are the standard tiny,
 * dependency-free pair: `xmur3` hashes the seed string into a 32-bit
 * state, `mulberry32` is the PRNG. Anyone with the seed string and the
 * pinned survivor list reproduces the identical shuffle on any platform
 * — every operation is 32-bit integer / `Math.imul`, no locale, no
 * float accumulation beyond the final divide.
 */

export const PRNG_NAME = "xmur3+mulberry32";

/** xmur3 string hash — produces a 32-bit state generator to seed mulberry32. */
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32 PRNG — single 32-bit state, returns floats in [0, 1). */
export function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher–Yates shuffle of `items` driven entirely by a `mulberry32`
 * stream seeded from `seed`. Pure — same `items` + same `seed` yields
 * the same order. Does not mutate `items`.
 */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const seedGen = xmur3(seed);
  const rand = mulberry32(seedGen());
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The shuffled prefix of length `n` — the draw. `n` past the list length just returns the whole shuffle. */
export function seededSample<T>(items: readonly T[], seed: string, n: number): T[] {
  return seededShuffle(items, seed).slice(0, n);
}
