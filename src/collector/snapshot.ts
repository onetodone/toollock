import { capture } from "../mcp/capture.js";
import { connect, killTransport, npxServerSpec } from "../mcp/connect.js";
import { computePromptHashes, computeToolHashes } from "../schema/hash.js";
import { computeServerTokenCounts } from "../schema/tokens.js";

export type SeedBucket = "list-open" | "list-env-gated" | "list-auth-required" | "list-timeout";

export interface SeedServerSpec {
  name: string;
  package: string;
  bucket: SeedBucket;
  /** Extra `npx -y <pkg> ...` args, e.g. server-filesystem's allowed directory. */
  spawnArgs?: string[];
  /** Placeholder-only env vars for a `list-env-gated` promotion (DECISIONS.md #12) — never real credentials. */
  promotionEnv?: Record<string, string>;
  note?: string;
  caveat?: string;
  reason?: string;
}

export interface ToolRecord {
  name: string;
  schemaHash: string;
  promptHash: string;
  canonicalTokens: number;
  wireTokens: number | null;
  wireBasisTokens: number | null;
  refCount: number;
}

export interface PromptRecord {
  name: string;
  schemaHash: string;
  promptHash: string;
}

export interface ServerSnapshot {
  name: string;
  package: string;
  bucket: SeedBucket;
  capturedAt: string;
  note?: string;
  caveat?: string;
  reason?: string;
  tools?: ToolRecord[];
  prompts?: PromptRecord[];
  canonicalTokens?: number;
  wireTokens?: number | null;
  wireBasisTokens?: number | null;
  frameTokens?: number | null;
  contextBudget?: number | null;
  refCount?: number;
  schemaReuseRatio?: number | null;
  error?: string;
}

/**
 * Captures one seed server and reduces it to the dataset's per-server
 * record. `list-auth-required`/`list-timeout` entries are never spawned —
 * no measurement is attempted, matching DECISIONS.md #12's "kept in the
 * seed list with no measurements" for the former and the fact that the
 * latter has already demonstrated it won't complete `initialize`.
 */
export async function snapshotServer(spec: SeedServerSpec): Promise<ServerSnapshot> {
  const base: ServerSnapshot = {
    name: spec.name,
    package: spec.package,
    bucket: spec.bucket,
    capturedAt: new Date().toISOString(),
    ...(spec.note ? { note: spec.note } : {}),
    ...(spec.caveat ? { caveat: spec.caveat } : {}),
    ...(spec.reason ? { reason: spec.reason } : {}),
  };

  if (spec.bucket === "list-auth-required" || spec.bucket === "list-timeout") {
    return base;
  }

  try {
    const server = await connect({ ...npxServerSpec(spec.package, spec.spawnArgs ?? []), env: spec.promotionEnv });
    try {
      const result = await capture(server);
      const tokenCounts = computeServerTokenCounts(result.tools, result.wireTools.raw);
      const tokensByName = new Map(tokenCounts.perTool.map((t) => [t.name, t]));

      const tools: ToolRecord[] = result.tools.map((tool) => {
        const hashes = computeToolHashes(tool);
        const tokens = tokensByName.get(tool.name);
        if (!tokens) {
          throw new Error(`tokens.ts and hash.ts disagree on tool set — "${tool.name}" missing from token counts`);
        }
        return {
          name: tool.name,
          schemaHash: hashes.schemaHash,
          promptHash: hashes.promptHash,
          canonicalTokens: tokens.canonicalTokens,
          wireTokens: tokens.wireTokens,
          wireBasisTokens: tokens.wireBasisTokens,
          refCount: tokens.refCount,
        };
      });

      const prompts: PromptRecord[] = (result.prompts ?? []).map((prompt) => {
        const hashes = computePromptHashes(prompt);
        return { name: prompt.name, schemaHash: hashes.schemaHash, promptHash: hashes.promptHash };
      });

      return {
        ...base,
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
    } finally {
      killTransport(server.transport);
    }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}
