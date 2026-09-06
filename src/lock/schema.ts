import type { JsonValue } from "../schema/canonicalize.js";

export interface LockedTool {
  name: string;
  description: string | null;
  /** Canonicalized (inlined `$ref`, `required[]`/`enum[]` sorted) — NOT description-stripped, unlike `schemaHash`'s basis, so a PR reviewer sees the real structure and text together, not an opaque hash. */
  inputSchema: JsonValue;
  /** The SDK's `ToolAnnotations` hint block (`readOnlyHint`, `destructiveHint`, `title`, …) verbatim, or `null`. Folded into `promptHash` (DECISIONS.md #4) and stored here too so `verify`'s text diff can name *which* hint changed, not just that `promptHash` moved (closes a Known-limitation gap in Phase 4). */
  annotations: JsonValue | null;
  schemaHash: string;
  promptHash: string;
  canonicalTokens: number;
  wireTokens: number | null;
  wireBasisTokens: number | null;
  refCount: number;
}

export interface LockedPromptArgument {
  name: string;
  description: string | null;
  required: boolean;
}

export interface LockedPrompt {
  name: string;
  description: string | null;
  arguments: LockedPromptArgument[];
  schemaHash: string;
  promptHash: string;
}

export interface LockedServer {
  /** The identifier this entry is keyed by — the npm package name, e.g. `@modelcontextprotocol/server-everything`. */
  id: string;
  /** The exact spawn recipe (`npx -y <id> ...args`), so `verify`/`update` can respawn without extra input. Never `env` — see DECISIONS.md #19: secrets are supplied at run time from the shell, never persisted. */
  command: string;
  args: string[];
  serverName: string | null;
  serverVersion: string | null;
  observedVersion: string | null;
  tools: LockedTool[];
  prompts: LockedPrompt[];
  canonicalTokens: number;
  wireTokens: number | null;
  wireBasisTokens: number | null;
  frameTokens: number | null;
  contextBudget: number | null;
  refCount: number;
  schemaReuseRatio: number | null;
}

export interface LockFile {
  version: 1;
  servers: LockedServer[];
}

export const LOCK_FILE_VERSION = 1 as const;

export function emptyLockFile(): LockFile {
  return { version: LOCK_FILE_VERSION, servers: [] };
}

/**
 * Deterministic serialization: keys sorted recursively, stable 2-space
 * indentation. No timestamps or other run-varying fields belong in
 * anything passed here — a no-op re-run must produce byte-identical
 * output (decision #6's "zero git diff" requirement), and a field that
 * changes every run regardless of server state would silently break
 * that guarantee.
 */
export function sortedStringify(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Replaces (or inserts) one server's entry by `id`, keeping `servers` sorted by `id` — `init`/`update` both go through this rather than appending, so re-running against an unchanged server reproduces the same array position. */
export function upsertServer(lockFile: LockFile, server: LockedServer): LockFile {
  const withoutExisting = lockFile.servers.filter((s) => s.id !== server.id);
  const servers = [...withoutExisting, server].sort((a, b) => a.id.localeCompare(b.id));
  return { ...lockFile, servers };
}

export function findServer(lockFile: LockFile, id: string): LockedServer | undefined {
  return lockFile.servers.find((s) => s.id === id);
}
