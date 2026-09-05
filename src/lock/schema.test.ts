import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyLockFile, findServer, sortedStringify, upsertServer, type LockedServer } from "./schema.js";

function minimalServer(id: string): LockedServer {
  return {
    id,
    command: "npx",
    args: ["-y", id],
    serverName: null,
    serverVersion: null,
    observedVersion: null,
    tools: [],
    prompts: [],
    canonicalTokens: 0,
    wireTokens: 0,
    wireBasisTokens: 0,
    frameTokens: 0,
    contextBudget: 0,
    refCount: 0,
    schemaReuseRatio: null,
  };
}

test("sortedStringify: key order in the input doesn't affect output", () => {
  const a = sortedStringify({ b: 1, a: { d: 2, c: 3 } });
  const b = sortedStringify({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b);
});

test("sortedStringify: does not reorder array elements, only object keys within them", () => {
  const out = sortedStringify({ list: [{ b: 1, a: 2 }, { z: 1 }] });
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.list, [{ a: 2, b: 1 }, { z: 1 }]);
});

test("sortedStringify: calling it twice on the same value is byte-identical", () => {
  const value = { z: 1, a: [3, 1, 2], nested: { y: true, x: null } };
  assert.equal(sortedStringify(value), sortedStringify(value));
});

test("upsertServer: inserts into an empty lock file", () => {
  const lock = upsertServer(emptyLockFile(), minimalServer("b"));
  assert.equal(lock.servers.length, 1);
  assert.equal(findServer(lock, "b")?.id, "b");
});

test("upsertServer: replaces an existing entry by id rather than duplicating", () => {
  let lock = upsertServer(emptyLockFile(), minimalServer("a"));
  lock = upsertServer(lock, { ...minimalServer("a"), canonicalTokens: 42 });
  assert.equal(lock.servers.length, 1);
  assert.equal(findServer(lock, "a")?.canonicalTokens, 42);
});

test("upsertServer: keeps servers sorted by id regardless of insertion order", () => {
  let lock = emptyLockFile();
  lock = upsertServer(lock, minimalServer("z"));
  lock = upsertServer(lock, minimalServer("a"));
  lock = upsertServer(lock, minimalServer("m"));
  assert.deepEqual(
    lock.servers.map((s) => s.id),
    ["a", "m", "z"],
  );
});
