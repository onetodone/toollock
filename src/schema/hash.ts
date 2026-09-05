import { createHash } from "node:crypto";
import type { Prompt, Tool } from "@modelcontextprotocol/sdk/types.js";
import { canonicalizeInputSchema, splitDescriptions, toCanonicalString, type JsonValue } from "./canonicalize.js";

export interface Hashes {
  /** Structure only — types, `required[]`, `enum[]`; descriptions excluded (DECISIONS.md #4). */
  schemaHash: string;
  /** Human-readable text only — name, description(s), annotations (tools) (DECISIONS.md #4). */
  promptHash: string;
}

export interface CanonicalStrings {
  /** The exact bytes `schemaHash` is a sha256 of. */
  schemaCanonical: string;
  /** The exact bytes `promptHash` is a sha256 of. */
  promptCanonical: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashesOf({ schemaCanonical, promptCanonical }: CanonicalStrings): Hashes {
  return { schemaHash: sha256(schemaCanonical), promptHash: sha256(promptCanonical) };
}

/**
 * The canonical strings behind a tool's hashes, exposed separately so a
 * cross-spawn hash mismatch (scripts/check-hash-determinism.ts) can be
 * root-caused by diffing these instead of just seeing two different
 * digests.
 */
export function computeToolCanonical(tool: Tool): CanonicalStrings {
  const sorted = canonicalizeInputSchema((tool.inputSchema ?? {}) as JsonValue);
  const { structure, descriptions } = splitDescriptions(sorted);

  return {
    schemaCanonical: toCanonicalString({ inputSchema: structure }),
    promptCanonical: toCanonicalString({
      name: tool.name,
      description: tool.description ?? null,
      paramDescriptions: descriptions ?? null,
      annotations: (tool.annotations as JsonValue | undefined) ?? null,
    }),
  };
}

/**
 * Tool split (DECISIONS.md #4): `schemaHash` covers `inputSchema`'s
 * structure only (post-inline, `required[]`/`enum[]` sorted, descriptions
 * stripped); `promptHash` covers name, description, every extracted
 * parameter description, and `annotations` (hint fields are descriptive,
 * not structural, per decision #4's `annotations.title` resolution).
 */
export function computeToolHashes(tool: Tool): Hashes {
  return hashesOf(computeToolCanonical(tool));
}

/**
 * Prompt split (DECISIONS.md #4): `schemaHash` covers each argument's name
 * and `required` flag only; `promptHash` covers prompt name, prompt
 * description, and every argument's description. Argument order is kept
 * as given — nothing in decision #4 calls for sorting the `arguments`
 * array itself (unlike a JSON-Schema `required[]`/`enum[]` array, this
 * isn't a set of interchangeable values; reordering it changes template
 * position).
 */
export function computePromptCanonical(prompt: Prompt): CanonicalStrings {
  const args = prompt.arguments ?? [];

  return {
    schemaCanonical: toCanonicalString({
      arguments: args.map((arg) => ({ name: arg.name, required: arg.required ?? false })),
    }),
    promptCanonical: toCanonicalString({
      name: prompt.name,
      description: prompt.description ?? null,
      argumentDescriptions: args.map((arg) => ({ name: arg.name, description: arg.description ?? null })),
    }),
  };
}

export function computePromptHashes(prompt: Prompt): Hashes {
  return hashesOf(computePromptCanonical(prompt));
}
