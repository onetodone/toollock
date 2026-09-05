import jcsSerialize from "canonicalize";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Thrown when `$ref` resolution revisits a ref already open in the current
 * resolution chain (DFS gray-node hit). A hard capture failure for that
 * tool, never a silent fallback (DECISIONS.md #3, PLAN.md Phase 2).
 */
export class RefCycleError extends Error {
  constructor(public readonly ref: string) {
    super(`$ref cycle detected at "${ref}"`);
    this.name = "RefCycleError";
  }
}

function isObject(node: JsonValue): node is { [key: string]: JsonValue } {
  return node !== null && typeof node === "object" && !Array.isArray(node);
}

function resolvePointer(root: JsonValue, ref: string): JsonValue {
  if (!ref.startsWith("#/")) {
    throw new Error(`$ref "${ref}" is not a local pointer — unsupported`);
  }
  const path = ref
    .slice(2)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
  let target: JsonValue = root;
  for (const segment of path) {
    if (!isObject(target) || !(segment in target)) {
      throw new Error(`$ref "${ref}" does not resolve within the schema`);
    }
    target = target[segment];
  }
  return target;
}

/**
 * Replaces every local `$ref` with its resolved target, recursively, then
 * drops `$defs` (dead once nothing references it anymore — DECISIONS.md
 * #5's "dead $defs elimination"). Resolution is always against the
 * original, unmodified `schema` — recursive inlining of the target uses
 * the same root, so lookups are unaffected by inlining already performed
 * elsewhere in the tree.
 */
export function inlineRefs(schema: JsonValue): JsonValue {
  return inline(schema, schema, new Set());
}

function inline(node: JsonValue, root: JsonValue, openRefs: Set<string>): JsonValue {
  if (Array.isArray(node)) {
    return node.map((item) => inline(item, root, openRefs));
  }
  if (isObject(node)) {
    if (typeof node.$ref === "string") {
      const ref = node.$ref;
      if (openRefs.has(ref)) {
        throw new RefCycleError(ref);
      }
      const target = resolvePointer(root, ref);
      const nextOpen = new Set(openRefs).add(ref);
      const resolved = inline(target, root, nextOpen);
      // Sibling keys next to `$ref` (rare, but legal JSON Schema) win over
      // the resolved target's own values.
      const siblingKeys = Object.keys(node).filter((key) => key !== "$ref");
      if (siblingKeys.length === 0 || !isObject(resolved)) {
        return resolved;
      }
      const siblings: { [key: string]: JsonValue } = {};
      for (const key of siblingKeys) {
        siblings[key] = inline(node[key], root, openRefs);
      }
      return { ...resolved, ...siblings };
    }
    const out: { [key: string]: JsonValue } = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$defs") continue; // dead after full inlining
      out[key] = inline(value, root, openRefs);
    }
    return out;
  }
  return node;
}

/** Counts `$ref` occurrences in a schema, before inlining. Free byproduct used for `refCount` (DECISIONS.md #5/#6). */
export function countRefs(node: JsonValue): number {
  if (Array.isArray(node)) {
    return node.reduce<number>((sum, item) => sum + countRefs(item), 0);
  }
  if (isObject(node)) {
    let sum = typeof node.$ref === "string" ? 1 : 0;
    for (const value of Object.values(node)) {
      sum += countRefs(value);
    }
    return sum;
  }
  return 0;
}

function sortKey(value: JsonValue): string {
  return JSON.stringify(value);
}

/**
 * Sorts every `required` and `enum` array found anywhere in the tree.
 * JCS sorts object keys only, not array contents (DECISIONS.md #3) — this
 * is the custom pre-pass that makes a semantically-identical reordering of
 * either array a no-op for the resulting hash/token count.
 */
export function sortStructuralArrays(node: JsonValue): JsonValue {
  if (Array.isArray(node)) {
    return node.map((item) => sortStructuralArrays(item));
  }
  if (isObject(node)) {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, value] of Object.entries(node)) {
      if ((key === "required" || key === "enum") && Array.isArray(value)) {
        out[key] = [...value].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
      } else {
        out[key] = sortStructuralArrays(value);
      }
    }
    return out;
  }
  return node;
}

/** Runs the full decision #3 pipeline on an `inputSchema`: inline `$ref`, then sort `required[]`/`enum[]`. Description-splitting is a separate step (see hash.ts) since not every caller wants it (`canonicalTokens` keeps descriptions in place). */
export function canonicalizeInputSchema(schema: JsonValue): JsonValue {
  return sortStructuralArrays(inlineRefs(schema));
}

export interface DescriptionSplit {
  /** Same shape as the input, minus every `description` string leaf. */
  structure: JsonValue;
  /** Sparse tree mirroring `structure`'s shape, holding only the extracted `description` leaves. `undefined` when the subtree had none. */
  descriptions: JsonValue | undefined;
}

/**
 * Splits `description` string fields out of a schema tree, recursively,
 * so structure (`schemaHash`) and human-readable text (`promptHash`) can
 * be hashed separately (DECISIONS.md #3/#4).
 */
export function splitDescriptions(node: JsonValue): DescriptionSplit {
  if (Array.isArray(node)) {
    const structure: JsonValue[] = [];
    const descriptions: JsonValue[] = [];
    let any = false;
    for (const item of node) {
      const split = splitDescriptions(item);
      structure.push(split.structure);
      descriptions.push(split.descriptions === undefined ? null : split.descriptions);
      if (split.descriptions !== undefined) any = true;
    }
    return { structure, descriptions: any ? descriptions : undefined };
  }
  if (isObject(node)) {
    const structure: { [key: string]: JsonValue } = {};
    const descriptions: { [key: string]: JsonValue } = {};
    let any = false;
    for (const [key, value] of Object.entries(node)) {
      if (key === "description" && typeof value === "string") {
        descriptions[key] = value;
        any = true;
        continue;
      }
      const split = splitDescriptions(value);
      structure[key] = split.structure;
      if (split.descriptions !== undefined) {
        descriptions[key] = split.descriptions;
        any = true;
      }
    }
    return { structure, descriptions: any ? descriptions : undefined };
  }
  return { structure: node, descriptions: undefined };
}

/** RFC 8785 (JCS) wrapper. Throws if `value` isn't JSON-serializable (the `canonicalize` package returns `undefined` in that case — never expected for the JSON-Schema-shaped values this project feeds it). */
export function toCanonicalString(value: JsonValue): string {
  const result = jcsSerialize(value);
  if (result === undefined) {
    throw new Error("value is not JSON-serializable — cannot produce a canonical string");
  }
  return result;
}
