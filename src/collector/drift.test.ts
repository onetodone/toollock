import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { computeSnapshotDrift, driftSummary, type SnapshotFile } from "./drift.js";
import type { ServerSnapshot } from "./snapshot.js";

const snapshot = (name: string): SnapshotFile =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../data/snapshots/${name}.json`, import.meta.url)), "utf8")) as SnapshotFile;

// PLAN.md Phase 5 test: "replay two saved snapshots and confirm the
// drift count matches a hand count of changed hashes." The hand count
// is in docs/findings/2026-09-06-sentry-proxy-instability.md: exactly
// one server drifted (sentry-mcp-server, list-env-gated), 9 tools -> 22,
// all 7 shared tools' schemaHash moved.
test("computeSnapshotDrift: 2026-09-05 -> 2026-09-06 is exactly one list-env-gated server", () => {
  const drift = computeSnapshotDrift(snapshot("2026-09-05"), snapshot("2026-09-06"));

  assert.equal(drift.previousSnapshot, "2026-09-05");
  assert.equal(drift.driftedCount, 1);
  assert.deepEqual(drift.byBucket, { "list-env-gated": 1 });
  assert.deepEqual(drift.seedListChanged, { added: [], removed: [] });
  assert.deepEqual(drift.captureStatusChanged, []);

  const [sentry] = drift.servers;
  assert.equal(sentry.name, "sentry-mcp-server");
  assert.equal(sentry.bucket, "list-env-gated");
  assert.ok(sentry.changes.some((c) => /tool\(s\) added:/.test(c)));
  assert.ok(sentry.changes.some((c) => /tool\(s\) removed: execute_sentry_tool, search_sentry_tools/.test(c)));
  assert.ok(sentry.changes.some((c) => /tool "search_events": schemaHash/.test(c)));

  assert.equal(driftSummary(drift), "1 drifted — 1 list-env-gated");
});

test("computeSnapshotDrift: a snapshot against itself has zero drift", () => {
  const s = snapshot("2026-09-06");
  const drift = computeSnapshotDrift(s, s);
  assert.equal(drift.driftedCount, 0);
  assert.equal(driftSummary(drift), "0 drifted");
});

// --- synthetic cases ---

function server(overrides: Partial<ServerSnapshot>): ServerSnapshot {
  return {
    name: "srv",
    package: "@scope/srv",
    bucket: "list-open",
    capturedAt: "2026-01-01T00:00:00Z",
    tools: [{ name: "a", schemaHash: "s", promptHash: "p", canonicalTokens: 1, wireTokens: 1, wireBasisTokens: 1, refCount: 0 }],
    prompts: [],
    ...overrides,
  };
}

const file = (date: string, servers: ServerSnapshot[]): SnapshotFile => ({ date, capturedAt: `${date}T00:00:00Z`, servers });

test("computeSnapshotDrift: a description-only change (promptHash moves, schemaHash stable) counts as drift", () => {
  const prev = file("2026-01-01", [server({})]);
  const cur = file("2026-01-02", [
    server({ tools: [{ name: "a", schemaHash: "s", promptHash: "p2", canonicalTokens: 1, wireTokens: 1, wireBasisTokens: 1, refCount: 0 }] }),
  ]);
  const drift = computeSnapshotDrift(prev, cur);
  assert.equal(drift.driftedCount, 1);
  assert.ok(drift.servers[0].changes.some((c) => /promptHash changed/.test(c)));
});

test("driftSummary: multiple buckets are listed in list-open-first order", () => {
  const prev = file("2026-01-01", [
    server({ name: "open", bucket: "list-open" }),
    server({ name: "gated", bucket: "list-env-gated" }),
  ]);
  const cur = file("2026-01-02", [
    server({ name: "open", bucket: "list-open", tools: [{ name: "a", schemaHash: "x", promptHash: "p", canonicalTokens: 1, wireTokens: 1, wireBasisTokens: 1, refCount: 0 }] }),
    server({ name: "gated", bucket: "list-env-gated", tools: [{ name: "a", schemaHash: "y", promptHash: "p", canonicalTokens: 1, wireTokens: 1, wireBasisTokens: 1, refCount: 0 }] }),
  ]);
  assert.equal(driftSummary(computeSnapshotDrift(prev, cur)), "2 drifted — 1 list-open, 1 list-env-gated");
});

test("computeSnapshotDrift: a server that stopped capturing is captureStatusChanged, not drift", () => {
  const prev = file("2026-01-01", [server({})]);
  const cur = file("2026-01-02", [{ name: "srv", package: "@scope/srv", bucket: "list-open", capturedAt: "x", error: "spawn failed" }]);
  const drift = computeSnapshotDrift(prev, cur);
  assert.equal(drift.driftedCount, 0);
  assert.deepEqual(drift.captureStatusChanged, ["srv: captured -> not captured"]);
});

test("computeSnapshotDrift: seed-list additions/removals are tracked separately from drift", () => {
  const prev = file("2026-01-01", [server({ name: "old" })]);
  const cur = file("2026-01-02", [server({ name: "new" })]);
  const drift = computeSnapshotDrift(prev, cur);
  assert.equal(drift.driftedCount, 0);
  assert.deepEqual(drift.seedListChanged, { added: ["new"], removed: ["old"] });
});
