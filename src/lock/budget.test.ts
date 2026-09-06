import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBudget, formatBudgetForAll } from "./budget.js";
import type { LockedServer, LockedTool } from "./schema.js";

function tool(name: string, overrides: Partial<LockedTool> = {}): LockedTool {
  return {
    name,
    description: `${name} does a thing`,
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: null,
    schemaHash: `s-${name}`,
    promptHash: `p-${name}`,
    canonicalTokens: 50,
    wireTokens: 100,
    wireBasisTokens: 48,
    refCount: 0,
    ...overrides,
  };
}

function server(overrides: Partial<LockedServer> = {}): LockedServer {
  return {
    id: "@scope/pkg",
    command: "npx",
    args: ["-y", "@scope/pkg"],
    serverName: "pkg",
    serverVersion: "2.1.0",
    observedVersion: "2.1.0",
    tools: [tool("alpha"), tool("beta")],
    prompts: [],
    canonicalTokens: 100,
    wireTokens: 200,
    wireBasisTokens: 96,
    frameTokens: 2,
    contextBudget: 202,
    refCount: 0,
    schemaReuseRatio: 1,
    ...overrides,
  };
}

test("formatBudget: tools are sorted by wire cost, highest first", () => {
  const out = formatBudget(
    server({
      tools: [tool("cheap", { wireTokens: 30 }), tool("expensive", { wireTokens: 500 }), tool("mid", { wireTokens: 120 })],
      contextBudget: 650,
      frameTokens: 0,
    }),
  );
  const lines = out.split("\n").filter((l) => /^\s{2}(expensive|mid|cheap)\b/.test(l));
  assert.deepEqual(
    lines.map((l) => l.trim().split(/\s+/)[0]),
    ["expensive", "mid", "cheap"],
  );
});

test("formatBudget: the TOTAL row is the server contextBudget, and SHARE sums to 100%", () => {
  const out = formatBudget(server({ tools: [tool("a", { wireTokens: 150 }), tool("b", { wireTokens: 50 })], contextBudget: 202, frameTokens: 2 }));
  assert.match(out, /TOTAL\s+202\s+100\.0%/);
  assert.match(out, /\(framing\)\s+2\b/);
  assert.match(out, /202 context tokens \(billed on every call\)/);
});

test("formatBudget: wire measurement unavailable falls back to canonical, and says so", () => {
  const out = formatBudget(
    server({
      tools: [tool("a", { wireTokens: null, canonicalTokens: 40 }), tool("b", { wireTokens: null, canonicalTokens: 60 })],
      wireTokens: null,
      wireBasisTokens: null,
      frameTokens: null,
      contextBudget: null,
    }),
  );
  assert.match(out, /wire-token measurement unavailable/);
  assert.match(out, /100 canonical tokens/);
  assert.match(out, /TOTAL\s+100\s+100\.0%/);
  assert.doesNotMatch(out, /billed on every call/);
});

test("formatBudget: the schemaReuseRatio footer only shows when the server actually has $refs", () => {
  assert.doesNotMatch(formatBudget(server({ refCount: 0, schemaReuseRatio: 1 })), /schemaReuseRatio/);
  const withRefs = formatBudget(server({ refCount: 152, schemaReuseRatio: 3.52 }));
  assert.match(withRefs, /schemaReuseRatio 3\.52 · 152 \$ref occurrences/);
  assert.match(withRefs, /ships its shared\s+\$defs to every tool/);
});

test("formatBudget: large counts render with thousands separators", () => {
  const out = formatBudget(server({ tools: [tool("big", { wireTokens: 17500 })], contextBudget: 17500, frameTokens: 0 }));
  assert.match(out, /17,500/);
});

test("formatBudgetForAll: empty tools.lock points the user at init", () => {
  const out = formatBudgetForAll([]);
  assert.match(out, /tools\.lock has no servers/);
  assert.match(out, /toollock init/);
});

test("formatBudgetForAll: multi-server roll-up totals context tokens and tool counts, ranked by cost", () => {
  const out = formatBudgetForAll([
    server({ id: "@scope/small", tools: [tool("x")], contextBudget: 300 }),
    server({ id: "@scope/big", tools: [tool("a"), tool("b"), tool("c")], contextBudget: 17000 }),
  ]);
  const allServersIdx = out.indexOf("ALL LOCKED SERVERS");
  assert.ok(allServersIdx > 0);
  const rollup = out.slice(allServersIdx);
  // big before small (ranked by contextBudget desc)
  assert.ok(rollup.indexOf("@scope/big") < rollup.indexOf("@scope/small"));
  assert.match(rollup, /TOTAL\s+4\s+17,300/);
});

test("formatBudgetForAll: a single locked server prints its table without the roll-up", () => {
  const out = formatBudgetForAll([server()]);
  assert.doesNotMatch(out, /ALL LOCKED SERVERS/);
  assert.match(out, /@scope\/pkg/);
});
