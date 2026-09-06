import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProbeError, probeAll, tallyBuckets, type ProbeOutcome } from "./probe.js";

function outcome(pkg: string, bucket: ProbeOutcome["bucket"]): ProbeOutcome {
  return { package: pkg, bucket, tools: bucket === "list-open" ? 3 : null, prompts: null, serverName: null, serverVersion: null, durationMs: 10, detail: null };
}

test("classifyProbeError: our own timeout message is list-timeout, anything else is list-auth-required", () => {
  assert.equal(classifyProbeError(new Error("Timed out after 30000ms: connect")).bucket, "list-timeout");
  assert.equal(classifyProbeError(new Error("Timed out after 120000ms: hard ceiling for x")).bucket, "list-timeout");
  assert.equal(classifyProbeError(new Error("MCP error -32000: missing GITHUB_TOKEN")).bucket, "list-auth-required");
  assert.equal(classifyProbeError("server exited with code 1").bucket, "list-auth-required");
});

test("tallyBuckets: always returns all three keys, zero-filled", () => {
  assert.deepEqual(tallyBuckets([]), { "list-open": 0, "list-auth-required": 0, "list-timeout": 0 });
  assert.deepEqual(tallyBuckets([outcome("a", "list-open"), outcome("b", "list-open"), outcome("c", "list-timeout")]), {
    "list-open": 2,
    "list-auth-required": 0,
    "list-timeout": 1,
  });
});

test("probeAll: runs every package once and tallies by bucket", async () => {
  const packages = ["a", "b", "c", "d", "e"];
  const buckets: Record<string, ProbeOutcome["bucket"]> = { a: "list-open", b: "list-auth-required", c: "list-open", d: "list-timeout", e: "list-open" };
  const seen: string[] = [];
  const result = await probeAll(packages, {
    concurrency: 2,
    probeFn: async (pkg) => {
      seen.push(pkg);
      return outcome(pkg, buckets[pkg]);
    },
  });
  assert.deepEqual(seen.sort(), packages);
  assert.equal(result.probed.length, 5);
  assert.deepEqual(result.notProbed, []);
  assert.deepEqual(result.byBucket, { "list-open": 3, "list-auth-required": 1, "list-timeout": 1 });
  assert.equal(result.wallCeilingHit, false);
});

test("probeAll: the wall-time ceiling stops new probes and reports what wasn't reached — never aborts", async () => {
  const packages = Array.from({ length: 20 }, (_, i) => `pkg-${i}`);
  const result = await probeAll(packages, {
    concurrency: 1,
    wallCeilingMs: 25,
    probeFn: async (pkg) => {
      await new Promise((r) => setTimeout(r, 10));
      return outcome(pkg, "list-open");
    },
  });
  assert.ok(result.wallCeilingHit, "ceiling should have been hit");
  assert.ok(result.probed.length > 0 && result.probed.length < 20, "some probed, not all");
  assert.equal(result.probed.length + result.notProbed.length, 20, "every package is either probed or explicitly not-probed");
  assert.deepEqual(
    [...result.probed.map((p) => p.package), ...result.notProbed].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))),
    packages,
  );
});

test("probeAll: one slow package doesn't block the others (concurrency)", async () => {
  const result = await probeAll(["slow", "fast1", "fast2", "fast3"], {
    concurrency: 4,
    probeFn: async (pkg) => {
      await new Promise((r) => setTimeout(r, pkg === "slow" ? 60 : 5));
      return outcome(pkg, "list-open");
    },
  });
  assert.equal(result.probed.length, 4);
  // the three fast ones resolve before the slow one
  assert.equal(result.probed[3].package, "slow");
});
