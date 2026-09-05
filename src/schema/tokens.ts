import { countTokens } from "gpt-tokenizer";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { canonicalizeInputSchema, countRefs, toCanonicalString, type JsonValue } from "./canonicalize.js";

export interface PerToolTokenCounts {
  name: string;
  /** JCS-canonical bytes of `{name, description, inputSchema}` after inlining + required/enum sort (DECISIONS.md #5). */
  canonicalTokens: number;
  /** Raw wire-order JSON of the whole tool object — `null` only when the caller has no wire tee for this server (DECISIONS.md #5). */
  wireTokens: number | null;
  /** Same wire tee, scoped to just `{name, description, inputSchema}`, no normalization — the `schemaReuseRatio` numerator (DECISIONS.md #5). */
  wireBasisTokens: number | null;
  /** `$ref` occurrences in this tool's `inputSchema`, pre-inlining. */
  refCount: number;
}

export interface ServerTokenCounts {
  perTool: PerToolTokenCounts[];
  canonicalTokens: number;
  wireTokens: number | null;
  wireBasisTokens: number | null;
  /** Whole-array `wireTokens` minus the per-tool sum (DECISIONS.md #5). `null` whenever `wireTokens` is. */
  frameTokens: number | null;
  /** `sum(wireTokens) + frameTokens` — what a real client's context window actually pays (DECISIONS.md #5/#6). */
  contextBudget: number | null;
  /** Total `$ref` occurrences across all tools, pre-inlining. */
  refCount: number;
  /** `sum(wireBasisTokens) / sum(canonicalTokens)`. `null` when wire data is unavailable or there's nothing to divide by. */
  schemaReuseRatio: number | null;
}

const WIRE_BASIS_KEYS = new Set(["name", "description", "inputSchema"]);

function wireBasisSubset(raw: Record<string, unknown>): JsonValue {
  const out: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(raw)) {
    if (WIRE_BASIS_KEYS.has(key)) {
      out[key] = raw[key] as JsonValue;
    }
  }
  return out;
}

export function computeCanonicalTokensForTool(tool: Tool): number {
  const sorted = canonicalizeInputSchema((tool.inputSchema ?? {}) as JsonValue);
  const canonicalStr = toCanonicalString({
    name: tool.name,
    description: tool.description ?? null,
    inputSchema: sorted,
  });
  return countTokens(canonicalStr);
}

/**
 * `tools` is the SDK's parsed list (safe for `canonicalTokens`, since JCS
 * re-sorts keys regardless of input order — decision #5). `wireRaw` must
 * come from the raw-stdout tee (`capture.ts`'s `WireTools.raw`), never
 * from `Client.listTools()` — `null` when that tee's cross-check failed,
 * in which case every wire-derived field here is `null` too, per
 * decision #5's "missing measurement is recoverable, a wrong one isn't."
 * When non-null, `wireRaw` is assumed to share `tools`' exact name set
 * 1:1 — `capture.ts`'s `crossCheckWireTools` is what guarantees that
 * before this function ever sees it.
 */
export function computeServerTokenCounts(tools: Tool[], wireRaw: unknown[] | null): ServerTokenCounts {
  const rawByName = new Map<string, Record<string, unknown>>();
  if (wireRaw) {
    for (const raw of wireRaw) {
      const name = (raw as { name?: unknown }).name;
      if (typeof name === "string") rawByName.set(name, raw as Record<string, unknown>);
    }
  }

  let sumCanonical = 0;
  let sumRefs = 0;
  let sumWire = wireRaw ? 0 : null;
  let sumWireBasis = wireRaw ? 0 : null;

  const perTool: PerToolTokenCounts[] = tools.map((tool) => {
    const canonicalTokens = computeCanonicalTokensForTool(tool);
    const refCount = countRefs((tool.inputSchema ?? {}) as JsonValue);
    sumCanonical += canonicalTokens;
    sumRefs += refCount;

    let wireTokens: number | null = null;
    let wireBasisTokens: number | null = null;
    const raw = rawByName.get(tool.name);
    if (raw) {
      wireTokens = countTokens(JSON.stringify(raw));
      wireBasisTokens = countTokens(JSON.stringify(wireBasisSubset(raw)));
      sumWire = (sumWire ?? 0) + wireTokens;
      sumWireBasis = (sumWireBasis ?? 0) + wireBasisTokens;
    }

    return { name: tool.name, canonicalTokens, wireTokens, wireBasisTokens, refCount };
  });

  const frameTokens = wireRaw && sumWire !== null ? countTokens(JSON.stringify(wireRaw)) - sumWire : null;
  const contextBudget = frameTokens !== null && sumWire !== null ? sumWire + frameTokens : null;
  const schemaReuseRatio = sumWireBasis !== null && sumCanonical > 0 ? sumWireBasis / sumCanonical : null;

  return {
    perTool,
    canonicalTokens: sumCanonical,
    wireTokens: sumWire,
    wireBasisTokens: sumWireBasis,
    frameTokens,
    contextBudget,
    refCount: sumRefs,
    schemaReuseRatio,
  };
}
