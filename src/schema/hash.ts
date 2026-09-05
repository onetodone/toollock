import { createHash } from "node:crypto";
import type { Prompt, Tool } from "@modelcontextprotocol/sdk/types.js";
import { canonicalizeInputSchema, splitDescriptions, toCanonicalString, type JsonValue } from "./canonicalize.js";

export interface Hashes {
  /** Structure only — types, `required[]`, `enum[]`; descriptions excluded (DECISIONS.md #4). */
  schemaHash: string;
  /** Human-readable text only — name, description(s), annotations (tools) (DECISIONS.md #4). */
  promptHash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Tool split (DECISIONS.md #4): `schemaHash` covers `inputSchema`'s
 * structure only (post-inline, `required[]`/`enum[]` sorted, descriptions
 * stripped); `promptHash` covers name, description, every extracted
 * parameter description, and `annotations` (hint fields are descriptive,
 * not structural, per decision #4's `annotations.title` resolution).
 */
export function computeToolHashes(tool: Tool): Hashes {
  const sorted = canonicalizeInputSchema((tool.inputSchema ?? {}) as JsonValue);
  const { structure, descriptions } = splitDescriptions(sorted);

  const schemaCanonical = toCanonicalString({ inputSchema: structure });
  const promptCanonical = toCanonicalString({
    name: tool.name,
    description: tool.description ?? null,
    paramDescriptions: descriptions ?? null,
    annotations: (tool.annotations as JsonValue | undefined) ?? null,
  });

  return { schemaHash: sha256(schemaCanonical), promptHash: sha256(promptCanonical) };
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
export function computePromptHashes(prompt: Prompt): Hashes {
  const args = prompt.arguments ?? [];

  const schemaCanonical = toCanonicalString({
    arguments: args.map((arg) => ({ name: arg.name, required: arg.required ?? false })),
  });
  const promptCanonical = toCanonicalString({
    name: prompt.name,
    description: prompt.description ?? null,
    argumentDescriptions: args.map((arg) => ({ name: arg.name, description: arg.description ?? null })),
  });

  return { schemaHash: sha256(schemaCanonical), promptHash: sha256(promptCanonical) };
}
