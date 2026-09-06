import { capture } from "../mcp/capture.js";
import { connect, killTransport, npxServerSpec } from "../mcp/connect.js";
import { computePromptHashes, computeToolHashes } from "../schema/hash.js";
import type { SeedServerSpec } from "./snapshot.js";

export interface HashPair {
  schemaHash: string;
  promptHash: string;
}

export interface SpawnStability {
  /**
   * `true`/`false` when both the snapshot capture and an immediate
   * second spawn completed; `null` when the recheck spawn failed and
   * stability could not be determined.
   */
  stableAcrossSpawns: boolean | null;
  /**
   * What differed between the snapshot capture and the immediate
   * respawn — or, when `stableAcrossSpawns` is `null`, why it couldn't
   * be measured. Omitted when stable.
   */
  spawnVariance?: string[];
}

/**
 * Lists every disagreement between two `{name -> {schemaHash,
 * promptHash}}` maps: a member gone, a member new, or a member whose
 * hash moved. Pure — the spawn plumbing is separate so this is
 * unit-testable without a process.
 */
export function diffHashSets(kind: "tool" | "prompt", reference: Map<string, HashPair>, respawn: Map<string, HashPair>): string[] {
  const variance: string[] = [];

  for (const [name, ref] of reference) {
    const got = respawn.get(name);
    if (!got) {
      variance.push(`${kind} "${name}" was in the snapshot capture, gone on the immediate respawn`);
      continue;
    }
    if (got.schemaHash !== ref.schemaHash) variance.push(`${kind} "${name}" schemaHash varies between two adjacent spawns`);
    if (got.promptHash !== ref.promptHash) variance.push(`${kind} "${name}" promptHash varies between two adjacent spawns`);
  }
  for (const name of respawn.keys()) {
    if (!reference.has(name)) variance.push(`${kind} "${name}" appeared on the immediate respawn, absent from the snapshot capture`);
  }
  return variance;
}

/**
 * Re-spawns a server once more, immediately after the snapshot capture,
 * and compares every tool/prompt hash against what the snapshot
 * recorded — `scripts/check-hash-determinism.ts`'s check, run inline as
 * part of collection (one extra spawn per server, negligible at 10;
 * revisit when Phase 5 expands the seed list).
 *
 * The premise `toollock verify` depends on is that spawning an unchanged
 * server twice yields the same hashes. Phase 0/2 confirmed it for
 * locally-generated schemas; `docs/findings/2026-09-06-sentry-proxy-instability.md`
 * is a proxy server where it doesn't hold. This measures it per server
 * rather than inferring it from the bucket (DECISIONS.md #20): two
 * adjacent spawns agreeing isn't proof of long-run stability, but two
 * disagreeing is proof of instability, and the cross-snapshot drift
 * count catches the slower case.
 */
export async function measureSpawnStability(
  spec: SeedServerSpec,
  reference: { tools: Map<string, HashPair>; prompts: Map<string, HashPair> },
): Promise<SpawnStability> {
  let respawnTools: Map<string, HashPair>;
  let respawnPrompts: Map<string, HashPair>;
  try {
    const server = await connect({ ...npxServerSpec(spec.package, spec.spawnArgs ?? []), env: spec.promotionEnv });
    try {
      const result = await capture(server);
      respawnTools = new Map(result.tools.map((t) => [t.name, computeToolHashes(t)]));
      respawnPrompts = new Map((result.prompts ?? []).map((p) => [p.name, computePromptHashes(p)]));
    } finally {
      killTransport(server.transport);
    }
  } catch (err) {
    return { stableAcrossSpawns: null, spawnVariance: [`recheck spawn failed: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const variance = [
    ...diffHashSets("tool", reference.tools, respawnTools),
    ...diffHashSets("prompt", reference.prompts, respawnPrompts),
  ];
  return variance.length === 0 ? { stableAcrossSpawns: true } : { stableAcrossSpawns: false, spawnVariance: variance };
}
