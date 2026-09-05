import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prompt, Tool } from "@modelcontextprotocol/sdk/types.js";
import { computePromptHashes, computeToolHashes } from "./hash.js";

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "search",
    description: "Searches for things",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "the search query" },
      },
      required: ["query"],
    },
    ...overrides,
  } as Tool;
}

function prompt(overrides: Partial<Prompt> = {}): Prompt {
  return {
    name: "greet",
    description: "Greets someone",
    arguments: [{ name: "who", description: "who to greet", required: true }],
    ...overrides,
  } as Prompt;
}

// --- Definition of Done, Tool ---

test("tool: description-only change moves promptHash, leaves schemaHash stable", () => {
  const before = computeToolHashes(tool());
  const after = computeToolHashes(
    tool({
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "a different description" } },
        required: ["query"],
      },
    }),
  );
  assert.equal(before.schemaHash, after.schemaHash);
  assert.notEqual(before.promptHash, after.promptHash);
});

test("tool: top-level description change also moves promptHash only", () => {
  const before = computeToolHashes(tool());
  const after = computeToolHashes(tool({ description: "Searches for other things" }));
  assert.equal(before.schemaHash, after.schemaHash);
  assert.notEqual(before.promptHash, after.promptHash);
});

test("tool: a new optional param moves schemaHash", () => {
  const before = computeToolHashes(tool());
  const after = computeToolHashes(
    tool({
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "the search query" },
          limit: { type: "number", description: "max results" },
        },
        required: ["query"],
      },
    }),
  );
  assert.notEqual(before.schemaHash, after.schemaHash);
});

test("tool: reordering required[] or an enum[] leaves schemaHash stable", () => {
  const before = computeToolHashes(
    tool({
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          mode: { type: "string", enum: ["fast", "accurate"] },
        },
        required: ["query", "mode"],
      },
    }),
  );
  const after = computeToolHashes(
    tool({
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          mode: { type: "string", enum: ["accurate", "fast"] },
        },
        required: ["mode", "query"],
      },
    }),
  );
  assert.equal(before.schemaHash, after.schemaHash);
});

test("tool: hashing identical input twice is byte-identical", () => {
  const t = tool();
  const a = computeToolHashes(t);
  const b = computeToolHashes(t);
  assert.equal(a.schemaHash, b.schemaHash);
  assert.equal(a.promptHash, b.promptHash);
});

test("tool: annotations changes move promptHash, not schemaHash (decision #4)", () => {
  const before = computeToolHashes(tool({ annotations: { readOnlyHint: true } }));
  const after = computeToolHashes(tool({ annotations: { readOnlyHint: false } }));
  assert.equal(before.schemaHash, after.schemaHash);
  assert.notEqual(before.promptHash, after.promptHash);
});

test("tool: $ref inlining is applied before hashing — an inlined-equivalent schema hashes the same as the pre-inlined one", () => {
  const direct = computeToolHashes(
    tool({
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }),
  );
  const viaRef = computeToolHashes(
    tool({
      inputSchema: {
        type: "object",
        properties: { query: { $ref: "#/$defs/queryType" } },
        required: ["query"],
        $defs: { queryType: { type: "string" } },
      },
    }),
  );
  assert.equal(direct.schemaHash, viaRef.schemaHash);
});

// --- Definition of Done, Prompt (mirrors the tool invariants) ---

test("prompt: description-only change on an argument moves promptHash, leaves schemaHash stable", () => {
  const before = computePromptHashes(prompt());
  const after = computePromptHashes(
    prompt({ arguments: [{ name: "who", description: "a different description", required: true }] }),
  );
  assert.equal(before.schemaHash, after.schemaHash);
  assert.notEqual(before.promptHash, after.promptHash);
});

test("prompt: a new argument moves schemaHash", () => {
  const before = computePromptHashes(prompt());
  const after = computePromptHashes(
    prompt({
      arguments: [
        { name: "who", description: "who to greet", required: true },
        { name: "language", description: "greeting language", required: false },
      ],
    }),
  );
  assert.notEqual(before.schemaHash, after.schemaHash);
});

test("prompt: a required-flag flip on an argument moves schemaHash", () => {
  const before = computePromptHashes(prompt());
  const after = computePromptHashes(prompt({ arguments: [{ name: "who", description: "who to greet", required: false }] }));
  assert.notEqual(before.schemaHash, after.schemaHash);
});

test("prompt: hashing identical input twice is byte-identical", () => {
  const p = prompt();
  const a = computePromptHashes(p);
  const b = computePromptHashes(p);
  assert.equal(a.schemaHash, b.schemaHash);
  assert.equal(a.promptHash, b.promptHash);
});
