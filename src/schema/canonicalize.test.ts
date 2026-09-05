import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RefCycleError,
  canonicalizeInputSchema,
  countRefs,
  inlineRefs,
  sortStructuralArrays,
  splitDescriptions,
  toCanonicalString,
  type JsonValue,
} from "./canonicalize.js";

test("inlineRefs: resolves a $ref against $defs and drops $defs", () => {
  const schema: JsonValue = {
    type: "object",
    properties: {
      name: { $ref: "#/$defs/nameType" },
    },
    $defs: {
      nameType: { type: "string", description: "a name" },
    },
  };
  const inlined = inlineRefs(schema);
  assert.deepEqual(inlined, {
    type: "object",
    properties: {
      name: { type: "string", description: "a name" },
    },
  });
});

test("inlineRefs: resolves nested $refs (a $defs entry that itself contains a $ref)", () => {
  const schema: JsonValue = {
    type: "object",
    properties: { a: { $ref: "#/$defs/a" } },
    $defs: {
      a: { $ref: "#/$defs/b" },
      b: { type: "string" },
    },
  };
  assert.deepEqual(inlineRefs(schema), {
    type: "object",
    properties: { a: { type: "string" } },
  });
});

test("inlineRefs: sibling keys next to $ref win over the resolved target", () => {
  const schema: JsonValue = {
    properties: {
      a: { $ref: "#/$defs/a", description: "override" },
    },
    $defs: { a: { type: "string", description: "original" } },
  };
  const inlined = inlineRefs(schema);
  assert.deepEqual((inlined as { properties: { a: JsonValue } }).properties.a, {
    type: "string",
    description: "override",
  });
});

test("inlineRefs: reuse of the same def by multiple tools/properties never counts as a cycle", () => {
  const schema: JsonValue = {
    properties: {
      a: { $ref: "#/$defs/shared" },
      b: { $ref: "#/$defs/shared" },
    },
    $defs: { shared: { type: "string" } },
  };
  assert.doesNotThrow(() => inlineRefs(schema));
});

test("inlineRefs: throws RefCycleError on a genuine cycle", () => {
  const schema: JsonValue = {
    properties: { a: { $ref: "#/$defs/a" } },
    $defs: {
      a: { $ref: "#/$defs/b" },
      b: { $ref: "#/$defs/a" },
    },
  };
  assert.throws(() => inlineRefs(schema), RefCycleError);
});

test("countRefs: counts occurrences before inlining, zero on a $ref-free schema", () => {
  const withRefs: JsonValue = {
    properties: {
      a: { $ref: "#/$defs/x" },
      b: { $ref: "#/$defs/x" },
    },
    $defs: { x: { type: "string" } },
  };
  assert.equal(countRefs(withRefs), 2);

  const noRefs: JsonValue = { type: "object", properties: { a: { type: "string" } } };
  assert.equal(countRefs(noRefs), 0);
});

test("sortStructuralArrays: reordering required[] or enum[] is a no-op after sorting", () => {
  const a: JsonValue = { type: "object", required: ["b", "a", "c"], properties: { x: { enum: [3, 1, 2] } } };
  const b: JsonValue = { type: "object", required: ["c", "a", "b"], properties: { x: { enum: [1, 3, 2] } } };
  assert.deepEqual(sortStructuralArrays(a), sortStructuralArrays(b));
});

test("sortStructuralArrays: does not touch arrays under any other key", () => {
  const schema: JsonValue = { examples: [3, 1, 2] };
  assert.deepEqual(sortStructuralArrays(schema), schema);
});

test("splitDescriptions: separates description leaves from structure, mirroring shape", () => {
  const schema: JsonValue = {
    type: "object",
    description: "top",
    properties: {
      a: { type: "string", description: "param a" },
      b: { type: "number" },
    },
  };
  const { structure, descriptions } = splitDescriptions(schema);
  assert.deepEqual(structure, {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "number" } },
  });
  assert.deepEqual(descriptions, {
    description: "top",
    properties: { a: { description: "param a" } },
  });
});

test("splitDescriptions: a description-only change leaves structure identical", () => {
  const before: JsonValue = { type: "object", properties: { a: { type: "string", description: "old" } } };
  const after: JsonValue = { type: "object", properties: { a: { type: "string", description: "new" } } };
  assert.deepEqual(splitDescriptions(before).structure, splitDescriptions(after).structure);
  assert.notDeepEqual(splitDescriptions(before).descriptions, splitDescriptions(after).descriptions);
});

test("canonicalizeInputSchema: Notion-shaped reuse — every tool's inlined form is no larger than its $defs-padded form", () => {
  const richText: JsonValue = { type: "object", properties: { text: { type: "string" } } };
  const withDefs: JsonValue = {
    type: "object",
    properties: { title: { $ref: "#/$defs/richTextRequest" } },
    $defs: { richTextRequest: richText, unused1: { type: "string" }, unused2: { type: "number" } },
  };
  const inlinedTokenLength = toCanonicalString(canonicalizeInputSchema(withDefs)).length;
  const paddedTokenLength = toCanonicalString(withDefs).length;
  assert.ok(inlinedTokenLength < paddedTokenLength);
});

test("toCanonicalString: JCS sorts object keys, giving byte-identical output regardless of input key order", () => {
  const a = toCanonicalString({ b: 1, a: 2 });
  const b = toCanonicalString({ a: 2, b: 1 });
  assert.equal(a, b);
});

test("determinism: hashing the same schema twice through the full pipeline is byte-identical", () => {
  const schema: JsonValue = {
    type: "object",
    properties: { a: { $ref: "#/$defs/a" } },
    $defs: { a: { type: "string", description: "d" } },
    required: ["b", "a"],
  };
  const once = toCanonicalString(canonicalizeInputSchema(schema));
  const twice = toCanonicalString(canonicalizeInputSchema(schema));
  assert.equal(once, twice);
});
