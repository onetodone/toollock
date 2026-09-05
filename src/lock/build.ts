import type { CaptureResult } from "../mcp/capture.js";
import { canonicalizeInputSchema, type JsonValue } from "../schema/canonicalize.js";
import { computePromptHashes, computeToolHashes } from "../schema/hash.js";
import { computeServerTokenCounts } from "../schema/tokens.js";
import { readObservedVersion } from "./observedVersion.js";
import type { LockedPrompt, LockedServer, LockedTool } from "./schema.js";

export interface BuildLockedServerParams {
  id: string;
  command: string;
  args: string[];
  result: CaptureResult;
}

/**
 * Reduces a live capture to its lockfile entry. Tools/prompts are sorted
 * by name — a server returning its own list in a different order between
 * two otherwise-identical captures must not show up as a diff (decision
 * #6's "no-op re-run produces zero git diff").
 */
export function buildLockedServer({ id, command, args, result }: BuildLockedServerParams): LockedServer {
  const tokenCounts = computeServerTokenCounts(result.tools, result.wireTools.raw);
  const tokensByName = new Map(tokenCounts.perTool.map((t) => [t.name, t]));

  const tools: LockedTool[] = result.tools
    .map((tool) => {
      const hashes = computeToolHashes(tool);
      const tokens = tokensByName.get(tool.name);
      if (!tokens) {
        throw new Error(`tokens.ts and hash.ts disagree on tool set — "${tool.name}" missing from token counts`);
      }
      return {
        name: tool.name,
        description: tool.description ?? null,
        inputSchema: canonicalizeInputSchema((tool.inputSchema ?? {}) as JsonValue),
        schemaHash: hashes.schemaHash,
        promptHash: hashes.promptHash,
        canonicalTokens: tokens.canonicalTokens,
        wireTokens: tokens.wireTokens,
        wireBasisTokens: tokens.wireBasisTokens,
        refCount: tokens.refCount,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const prompts: LockedPrompt[] = (result.prompts ?? [])
    .map((prompt) => {
      const hashes = computePromptHashes(prompt);
      return {
        name: prompt.name,
        description: prompt.description ?? null,
        arguments: (prompt.arguments ?? []).map((a) => ({
          name: a.name,
          description: a.description ?? null,
          required: a.required ?? false,
        })),
        schemaHash: hashes.schemaHash,
        promptHash: hashes.promptHash,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    id,
    command,
    args,
    serverName: result.serverInfo?.name ?? null,
    serverVersion: result.serverInfo?.version ?? null,
    observedVersion: readObservedVersion(id),
    tools,
    prompts,
    canonicalTokens: tokenCounts.canonicalTokens,
    wireTokens: tokenCounts.wireTokens,
    wireBasisTokens: tokenCounts.wireBasisTokens,
    frameTokens: tokenCounts.frameTokens,
    contextBudget: tokenCounts.contextBudget,
    refCount: tokenCounts.refCount,
    schemaReuseRatio: tokenCounts.schemaReuseRatio,
  };
}
