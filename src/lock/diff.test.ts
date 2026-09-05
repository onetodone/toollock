import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyServerDrift, hasFailingDrift, type DriftFinding } from "./diff.js";
import type { LockedPrompt, LockedServer, LockedTool } from "./schema.js";

function tool(overrides: Partial<LockedTool> = {}): LockedTool {
  return {
    name: "search",
    description: "Searches for things",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    schemaHash: "schema-a",
    promptHash: "prompt-a",
    canonicalTokens: 100,
    wireTokens: 150,
    wireBasisTokens: 100,
    refCount: 0,
    ...overrides,
  };
}

function prompt(overrides: Partial<LockedPrompt> = {}): LockedPrompt {
  return {
    name: "greet",
    description: "Greets someone",
    arguments: [{ name: "who", description: "who to greet", required: true }],
    schemaHash: "pschema-a",
    promptHash: "pprompt-a",
    ...overrides,
  };
}

function server(overrides: Partial<LockedServer> = {}): LockedServer {
  return {
    id: "@scope/pkg",
    command: "npx",
    args: ["-y", "@scope/pkg"],
    serverName: "pkg",
    serverVersion: "1.0.0",
    observedVersion: "1.0.0",
    tools: [tool()],
    prompts: [],
    canonicalTokens: 100,
    wireTokens: 150,
    wireBasisTokens: 100,
    frameTokens: 2,
    contextBudget: 152,
    refCount: 0,
    schemaReuseRatio: 1,
    ...overrides,
  };
}

function findingsFor(findings: DriftFinding[], cls: string) {
  return findings.filter((f) => f.class === cls);
}

test("classifyServerDrift: identical servers produce zero findings", () => {
  const a = server();
  const b = server();
  assert.deepEqual(classifyServerDrift(a, b), []);
});

test("classifyServerDrift: tool removed is schema-breaking (fail)", () => {
  const oldS = server({ tools: [tool()] });
  const newS = server({ tools: [] });
  const findings = classifyServerDrift(oldS, newS);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "schema-breaking");
  assert.equal(findings[0].severity, "fail");
  assert.match(findings[0].message, /removed/);
  assert.equal(hasFailingDrift(findings), true);
});

test("classifyServerDrift: new tool is schema-additive (warn)", () => {
  const oldS = server({ tools: [tool()] });
  const newS = server({ tools: [tool(), tool({ name: "other", schemaHash: "s2", promptHash: "p2" })] });
  const findings = classifyServerDrift(oldS, newS);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "schema-additive");
  assert.equal(findings[0].severity, "warn");
  assert.equal(hasFailingDrift(findings), false);
});

test("classifyServerDrift: description-only change is prompt-drift (fail), schema untouched", () => {
  const oldS = server({ tools: [tool()] });
  const newS = server({ tools: [tool({ description: "Searches for other things", promptHash: "prompt-b" })] });
  const findings = classifyServerDrift(oldS, newS);
  assert.deepEqual(findings, [
    { class: "prompt-drift", severity: "fail", scope: "tool", name: "search", message: "description text changed" },
  ]);
  assert.equal(hasFailingDrift(findings), true);
});

test("classifyServerDrift: new optional property is schema-additive", () => {
  const oldS = server({ tools: [tool()] });
  const newTool = tool({
    schemaHash: "schema-b",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
  });
  const findings = classifyServerDrift(oldS, server({ tools: [newTool] }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "schema-additive");
  assert.match(findings[0].message, /limit/);
});

test("classifyServerDrift: new required property is schema-breaking", () => {
  const oldS = server({ tools: [tool()] });
  const newTool = tool({
    schemaHash: "schema-b",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query", "limit"],
    },
  });
  const findings = classifyServerDrift(oldS, server({ tools: [newTool] }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "schema-breaking");
  assert.match(findings[0].message, /new required property "limit"/);
});

test("classifyServerDrift: property removed is schema-breaking", () => {
  const oldS = server({ tools: [tool()] });
  const newTool = tool({ schemaHash: "schema-b", inputSchema: { type: "object", properties: {}, required: [] } });
  const findings = classifyServerDrift(oldS, server({ tools: [newTool] }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "schema-breaking");
  assert.match(findings[0].message, /query.*removed/);
});

test("classifyServerDrift: property type changed is schema-breaking", () => {
  const oldS = server({ tools: [tool()] });
  const newTool = tool({
    schemaHash: "schema-b",
    inputSchema: { type: "object", properties: { query: { type: "number" } }, required: ["query"] },
  });
  const findings = classifyServerDrift(oldS, server({ tools: [newTool] }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "schema-breaking");
  assert.match(findings[0].message, /type changed/);
});

test("classifyServerDrift: required widened (optional -> required) is schema-breaking", () => {
  const oldS = server({
    tools: [tool({ inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } })],
  });
  const newS = server({
    tools: [
      tool({
        schemaHash: "schema-b",
        inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query", "limit"] },
      }),
    ],
  });
  const findings = classifyServerDrift(oldS, newS);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "schema-breaking");
  assert.match(findings[0].message, /became required/);
});

test("classifyServerDrift: required narrowed (required -> optional) is schema-additive", () => {
  const oldS = server({
    tools: [tool({ inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query", "limit"] } })],
  });
  const newS = server({
    tools: [
      tool({
        schemaHash: "schema-b",
        inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
      }),
    ],
  });
  const findings = classifyServerDrift(oldS, newS);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "schema-additive");
  assert.match(findings[0].message, /no longer required/);
});

test("classifyServerDrift: unrecognized schema change defaults to schema-breaking, not silently passing", () => {
  // Same properties/required/types, but schemaHash differs anyway (e.g. a
  // nested change this v1 classifier doesn't specifically decompose).
  const oldS = server({ tools: [tool({ schemaHash: "schema-a" })] });
  const newS = server({ tools: [tool({ schemaHash: "schema-b" })] });
  const findings = classifyServerDrift(oldS, newS);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "schema-breaking");
  assert.match(findings[0].message, /not covered/);
});

test("classifyServerDrift: tool canonicalTokens growth over 15% is cost-drift (warn)", () => {
  const oldS = server({ tools: [tool({ canonicalTokens: 100 })] });
  const newS = server({ tools: [tool({ canonicalTokens: 120 })] });
  const findings = classifyServerDrift(oldS, newS);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "cost-drift");
  assert.equal(findings[0].severity, "warn");
});

test("classifyServerDrift: tool canonicalTokens growth under 15% is not cost-drift", () => {
  const oldS = server({ tools: [tool({ canonicalTokens: 100 })] });
  const newS = server({ tools: [tool({ canonicalTokens: 110 })] });
  assert.deepEqual(classifyServerDrift(oldS, newS), []);
});

test("classifyServerDrift: server contextBudget growth over 10% is cost-drift at server scope", () => {
  const oldS = server({ contextBudget: 100 });
  const newS = server({ contextBudget: 115 });
  const findings = classifyServerDrift(oldS, newS);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "cost-drift");
  assert.equal(findings[0].scope, "server");
});

// --- Prompts mirror the tool invariants ---

test("classifyServerDrift: prompt removed is schema-breaking", () => {
  const oldS = server({ prompts: [prompt()] });
  const newS = server({ prompts: [] });
  const findings = classifyServerDrift(oldS, newS);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "schema-breaking");
  assert.equal(findings[0].scope, "prompt");
});

test("classifyServerDrift: new prompt is schema-additive", () => {
  const oldS = server({ prompts: [] });
  const newS = server({ prompts: [prompt()] });
  const findings = classifyServerDrift(oldS, newS);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "schema-additive");
  assert.equal(findings[0].scope, "prompt");
});

test("classifyServerDrift: prompt argument description-only change is prompt-drift", () => {
  const oldS = server({ prompts: [prompt()] });
  const newS = server({
    prompts: [prompt({ promptHash: "pprompt-b", arguments: [{ name: "who", description: "who to greet, warmly", required: true }] })],
  });
  const findings = classifyServerDrift(oldS, newS);
  assert.deepEqual(findingsFor(findings, "prompt-drift").map((f) => f.scope), ["prompt"]);
});

test("classifyServerDrift: new required prompt argument is schema-breaking", () => {
  const oldS = server({ prompts: [prompt()] });
  const newS = server({
    prompts: [
      prompt({
        schemaHash: "pschema-b",
        arguments: [
          { name: "who", description: "who to greet", required: true },
          { name: "language", description: "language", required: true },
        ],
      }),
    ],
  });
  const findings = classifyServerDrift(oldS, newS);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "schema-breaking");
  assert.match(findings[0].message, /language/);
});

test("classifyServerDrift: new optional prompt argument is schema-additive", () => {
  const oldS = server({ prompts: [prompt()] });
  const newS = server({
    prompts: [
      prompt({
        schemaHash: "pschema-b",
        arguments: [
          { name: "who", description: "who to greet", required: true },
          { name: "language", description: "language", required: false },
        ],
      }),
    ],
  });
  const findings = classifyServerDrift(oldS, newS);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "schema-additive");
});

test("classifyServerDrift: everything at once — findings are independent per tool/prompt", () => {
  const oldS = server({ tools: [tool()], prompts: [prompt()] });
  const newS = server({
    tools: [tool({ description: "Searches for other things", promptHash: "prompt-b" }), tool({ name: "extra", schemaHash: "s2", promptHash: "p2" })],
    prompts: [],
  });
  const findings = classifyServerDrift(oldS, newS);
  assert.equal(findingsFor(findings, "prompt-drift").length, 1);
  assert.equal(findingsFor(findings, "schema-additive").length, 1);
  assert.equal(findingsFor(findings, "schema-breaking").length, 1); // the removed prompt
  assert.equal(hasFailingDrift(findings), true);
});
