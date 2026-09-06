import assert from "node:assert/strict";
import { test } from "node:test";
import { diffHashSets, type HashPair } from "./determinism.js";

const h = (schema: string, prompt: string): HashPair => ({ schemaHash: schema, promptHash: prompt });

test("diffHashSets: identical maps produce no variance", () => {
  const a = new Map([["x", h("s1", "p1")], ["y", h("s2", "p2")]]);
  const b = new Map([["y", h("s2", "p2")], ["x", h("s1", "p1")]]);
  assert.deepEqual(diffHashSets("tool", a, b), []);
});

test("diffHashSets: a member missing on respawn is flagged", () => {
  const ref = new Map([["x", h("s1", "p1")], ["y", h("s2", "p2")]]);
  const respawn = new Map([["x", h("s1", "p1")]]);
  const v = diffHashSets("tool", ref, respawn);
  assert.equal(v.length, 1);
  assert.match(v[0], /tool "y" was in the snapshot capture, gone on the immediate respawn/);
});

test("diffHashSets: a member new on respawn is flagged", () => {
  const ref = new Map([["x", h("s1", "p1")]]);
  const respawn = new Map([["x", h("s1", "p1")], ["z", h("s3", "p3")]]);
  const v = diffHashSets("prompt", ref, respawn);
  assert.equal(v.length, 1);
  assert.match(v[0], /prompt "z" appeared on the immediate respawn/);
});

test("diffHashSets: a moved schemaHash and a moved promptHash are reported separately", () => {
  const ref = new Map([["x", h("s1", "p1")]]);
  const respawn = new Map([["x", h("s2", "p2")]]);
  const v = diffHashSets("tool", ref, respawn);
  assert.deepEqual(v, [
    'tool "x" schemaHash varies between two adjacent spawns',
    'tool "x" promptHash varies between two adjacent spawns',
  ]);
});

test("diffHashSets: the Sentry case — set size changed and shared members moved", () => {
  // The shape docs/findings/2026-09-06-sentry-proxy-instability.md records:
  // 9 tools one spawn, more the next, and the shared ones' hashes differ.
  const ref = new Map([
    ["search_events", h("a", "a")],
    ["search_issues", h("b", "b")],
    ["execute_sentry_tool", h("c", "c")],
  ]);
  const respawn = new Map([
    ["search_events", h("A", "a")],
    ["search_issues", h("b", "B")],
    ["whoami", h("d", "d")],
    ["create_dsn", h("e", "e")],
  ]);
  const v = diffHashSets("tool", ref, respawn);
  assert.ok(v.some((m) => /execute_sentry_tool.*gone/.test(m)));
  assert.ok(v.some((m) => /search_events.*schemaHash varies/.test(m)));
  assert.ok(v.some((m) => /search_issues.*promptHash varies/.test(m)));
  assert.ok(v.some((m) => /whoami.*appeared/.test(m)));
  assert.ok(v.some((m) => /create_dsn.*appeared/.test(m)));
});
