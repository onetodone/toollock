import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { computeServerTokenCounts } from "./tokens.js";

// Synthetic fixtures only — Phase 2's test plan is "no network/spawn
// required" (PLAN.md). Real-server verification of the wire tee itself
// already lives in capture.test.ts (Phase 1) and in the pre-Phase-2
// measurement recorded in DECISIONS.md #5/docs/spikes/phase-0.md.

const echoTool: Tool = {
  name: "echo",
  description: "Echoes back the input string",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string", description: "Message to echo" } },
    required: ["message"],
  },
} as Tool;

// Wire-order object carrying non-schema fields, matching what real
// current-spec servers send (title/annotations/execution/outputSchema) —
// the exact shape that motivated wireBasisTokens.
const echoWireRaw = {
  name: "echo",
  title: "Echo Tool",
  description: "Echoes back the input string",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string", description: "Message to echo" } },
    required: ["message"],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  execution: { taskSupport: "forbidden" },
};

test("computeServerTokenCounts: wireRaw null makes every wire-derived field null, canonicalTokens still computed", () => {
  const result = computeServerTokenCounts([echoTool], null);
  assert.ok(result.canonicalTokens > 0);
  assert.equal(result.wireTokens, null);
  assert.equal(result.wireBasisTokens, null);
  assert.equal(result.frameTokens, null);
  assert.equal(result.contextBudget, null);
  assert.equal(result.schemaReuseRatio, null);
  assert.equal(result.perTool[0]?.wireTokens, null);
  assert.equal(result.perTool[0]?.wireBasisTokens, null);
});

test("computeServerTokenCounts: wireBasisTokens excludes non-schema fields that wireTokens includes", () => {
  const result = computeServerTokenCounts([echoTool], [echoWireRaw]);
  assert.ok(result.wireTokens !== null && result.wireBasisTokens !== null);
  assert.ok(result.wireBasisTokens! < result.wireTokens!, "wireBasisTokens must be smaller once non-schema fields exist on the wire");
});

test("computeServerTokenCounts: a $ref-free tool's schemaReuseRatio is ~1.0 (wireBasisTokens vs. canonicalTokens, both scoped the same)", () => {
  const result = computeServerTokenCounts([echoTool], [echoWireRaw]);
  assert.ok(result.schemaReuseRatio !== null);
  assert.ok(
    Math.abs(result.schemaReuseRatio! - 1) < 0.1,
    `expected schemaReuseRatio near 1.0 for a $ref-free tool, got ${result.schemaReuseRatio}`,
  );
  assert.equal(result.refCount, 0);
});

test("computeServerTokenCounts: frameTokens is the whole-array total minus the per-tool sum", () => {
  const tools = [echoTool, { ...echoTool, name: "echo2" } as Tool];
  const raws = [echoWireRaw, { ...echoWireRaw, name: "echo2" }];
  const result = computeServerTokenCounts(tools, raws);
  const perToolSum = result.perTool.reduce((sum, t) => sum + (t.wireTokens ?? 0), 0);
  assert.equal(result.wireTokens, perToolSum);
  assert.equal(result.contextBudget, (result.wireTokens ?? 0) + (result.frameTokens ?? 0));
});

test("computeServerTokenCounts: a $ref-bearing tool's schemaReuseRatio is meaningfully above 1.0", () => {
  const richText = { type: "object", properties: { text: { type: "string" } } };
  const notionShaped: Tool = {
    name: "update-page",
    description: "Updates a page",
    inputSchema: {
      type: "object",
      properties: {
        title: { $ref: "#/$defs/richTextRequest" },
        body: { $ref: "#/$defs/richTextRequest" },
      },
      required: ["title"],
      $defs: {
        richTextRequest: richText,
        unusedA: { type: "string" },
        unusedB: { type: "number" },
        unusedC: { type: "boolean" },
      },
    },
  } as Tool;
  const wireRaw = { ...notionShaped };
  const result = computeServerTokenCounts([notionShaped], [wireRaw]);
  assert.ok(result.refCount >= 2);
  assert.ok(result.schemaReuseRatio !== null && result.schemaReuseRatio! > 1.2);
});
