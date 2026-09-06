import assert from "node:assert/strict";
import { test } from "node:test";
import { mulberry32, seededSample, seededShuffle, xmur3 } from "./draw.js";

test("seededShuffle: same seed and input produce the same order, every time", () => {
  const items = Array.from({ length: 200 }, (_, i) => `pkg-${i}`);
  const a = seededShuffle(items, "seed-one");
  const b = seededShuffle(items, "seed-one");
  assert.deepEqual(a, b);
});

test("seededShuffle: a different seed produces a different order", () => {
  const items = Array.from({ length: 200 }, (_, i) => `pkg-${i}`);
  assert.notDeepEqual(seededShuffle(items, "seed-one"), seededShuffle(items, "seed-two"));
});

test("seededShuffle: it's a permutation — same multiset, no drops or dupes", () => {
  const items = Array.from({ length: 500 }, (_, i) => `pkg-${i}`);
  const shuffled = seededShuffle(items, "x");
  assert.equal(shuffled.length, items.length);
  assert.deepEqual([...shuffled].sort(), [...items].sort());
});

test("seededShuffle: does not mutate the input", () => {
  const items = ["a", "b", "c", "d"];
  const copy = [...items];
  seededShuffle(items, "x");
  assert.deepEqual(items, copy);
});

test("seededShuffle: a known seed against a fixed input is pinned (regression guard on the PRNG)", () => {
  // If this changes, the PRNG or shuffle changed and every committed
  // draw becomes unreproducible. It must not change silently.
  const items = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
  assert.deepEqual(seededShuffle(items, "toollock/seed-list/v2/2026-09"), [
    "foxtrot",
    "hotel",
    "bravo",
    "delta",
    "charlie",
    "golf",
    "echo",
    "alpha",
  ]);
});

test("seededSample: the sample is the prefix of the full shuffle", () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  const full = seededShuffle(items, "s");
  assert.deepEqual(seededSample(items, "s", 10), full.slice(0, 10));
});

test("seededSample: n past the list length returns the whole shuffle", () => {
  const items = [1, 2, 3];
  assert.equal(seededSample(items, "s", 99).length, 3);
});

test("mulberry32/xmur3: deterministic float stream in [0, 1)", () => {
  const r = mulberry32(xmur3("abc")());
  const xs = [r(), r(), r(), r()];
  for (const x of xs) assert.ok(x >= 0 && x < 1);
  const r2 = mulberry32(xmur3("abc")());
  assert.deepEqual([r2(), r2(), r2(), r2()], xs);
});
