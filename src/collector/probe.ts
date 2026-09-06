import { capture } from "../mcp/capture.js";
import { connect, killTransport, npxServerSpec, withTimeout, type ConnectedServer } from "../mcp/connect.js";

/**
 * The automated `tools/list` enumeration probe (DECISIONS.md #12, Phase 0
 * spike 3's method) run at scale over Phase 5's seeded random sample.
 * Three buckets come out of the automated probe — `list-open`,
 * `list-auth-required`, `list-timeout`; `list-env-gated` is a separate
 * manual promotion step (≤5 servers), not something the probe produces.
 *
 * Built to survive an unattended batch of unvetted npm packages:
 * `probeCandidate` never throws, every failure is recorded and bucketed,
 * and `probeAll` enforces a total wall-time ceiling so one pathological
 * package (a hung postinstall, a proxy that never answers) can't stall
 * the whole job — the servers it didn't reach are reported, not lost.
 */

export type ProbeBucket = "list-open" | "list-auth-required" | "list-timeout";

export interface ProbeOutcome {
  package: string;
  bucket: ProbeBucket;
  tools: number | null;
  prompts: number | null;
  serverName: string | null;
  serverVersion: string | null;
  durationMs: number;
  /** Error text for the two failure buckets; `null` for `list-open`. */
  detail: string | null;
}

/** A connect/capture failure is `list-timeout` when it's one of our own timeouts firing, `list-auth-required` otherwise (server exited or failed `initialize`). */
export function classifyProbeError(err: unknown): { bucket: "list-auth-required" | "list-timeout"; detail: string } {
  const detail = err instanceof Error ? err.message : String(err);
  return { bucket: /Timed out after \d+ms|hard ceiling/.test(detail) ? "list-timeout" : "list-auth-required", detail };
}

/** Per-candidate hard ceiling — a backstop above `connect`'s own 30s/15s SDK-level timeouts, for the case where those don't fire (a wedged postinstall). */
export const PROBE_HARD_CEILING_MS = 120_000;

export async function probeCandidate(pkg: string, hardCeilingMs: number = PROBE_HARD_CEILING_MS): Promise<ProbeOutcome> {
  const start = Date.now();
  let connected: ConnectedServer | null = null;

  try {
    const open = await withTimeout(
      (async () => {
        connected = await connect(npxServerSpec(pkg)); // no env — the zero-env probe (DECISIONS.md #12)
        const result = await capture(connected);
        return {
          bucket: "list-open" as const,
          tools: result.tools.length,
          prompts: result.prompts?.length ?? null,
          serverName: result.serverInfo?.name ?? null,
          serverVersion: result.serverInfo?.version ?? null,
          detail: null,
        };
      })(),
      hardCeilingMs,
      `hard ceiling for ${pkg}`,
    );
    return { package: pkg, ...open, durationMs: Date.now() - start };
  } catch (err) {
    const { bucket, detail } = classifyProbeError(err);
    return { package: pkg, bucket, tools: null, prompts: null, serverName: null, serverVersion: null, detail, durationMs: Date.now() - start };
  } finally {
    if (connected) killTransport((connected as ConnectedServer).transport);
  }
}

export interface ProbeBatchResult {
  probed: ProbeOutcome[];
  /** Packages the wall-time ceiling was hit before reaching — recorded, never silently dropped. */
  notProbed: string[];
  byBucket: Record<ProbeBucket, number>;
  wallTimeMs: number;
  wallCeilingHit: boolean;
}

export interface ProbeAllOptions {
  concurrency?: number;
  /** Total batch wall-time ceiling. Once crossed, in-flight probes finish and no new ones start. */
  wallCeilingMs?: number;
  onResult?: (outcome: ProbeOutcome, done: number, total: number) => void;
  /** Injectable for tests — defaults to the real `probeCandidate`. */
  probeFn?: (pkg: string) => Promise<ProbeOutcome>;
}

const EMPTY_BUCKETS: Record<ProbeBucket, number> = { "list-open": 0, "list-auth-required": 0, "list-timeout": 0 };

export function tallyBuckets(outcomes: ProbeOutcome[]): Record<ProbeBucket, number> {
  const counts = { ...EMPTY_BUCKETS };
  for (const o of outcomes) counts[o.bucket]++;
  return counts;
}

export async function probeAll(packages: string[], options: ProbeAllOptions = {}): Promise<ProbeBatchResult> {
  const concurrency = options.concurrency ?? 4;
  const wallCeilingMs = options.wallCeilingMs ?? 40 * 60_000;
  const probeFn = options.probeFn ?? ((pkg: string) => probeCandidate(pkg));
  const start = Date.now();

  const probed: ProbeOutcome[] = [];
  let index = 0;
  let wallCeilingHit = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (Date.now() - start > wallCeilingMs) {
        wallCeilingHit = true;
        return;
      }
      const i = index++;
      if (i >= packages.length) return;
      const outcome = await probeFn(packages[i]);
      probed.push(outcome);
      options.onResult?.(outcome, probed.length, packages.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, packages.length) }, worker));

  const probedSet = new Set(probed.map((p) => p.package));
  return {
    probed,
    notProbed: packages.filter((p) => !probedSet.has(p)),
    byBucket: tallyBuckets(probed),
    wallTimeMs: Date.now() - start,
    wallCeilingHit,
  };
}
