import type { PromptRecord, SeedBucket, ServerSnapshot, ToolRecord } from "./snapshot.js";

/**
 * Cross-snapshot drift: what moved between two dated collector runs.
 * Phase 5. Operates on the hash records the snapshot already stores — no
 * re-capture — so it's the same comparison `verify` does for `tools.lock`
 * (decision #7's hashes), applied across time instead of against a
 * committed baseline.
 *
 * The drift *count* is broken out by bucket in the commit message
 * (decision #20): a `list-open` server rewriting a description is the
 * rug-pull signal; a `list-env-gated` proxy's tool list shifting is
 * expected churn the caveat already predicted
 * (`docs/findings/2026-09-06-sentry-proxy-instability.md`). Collapsing
 * both into one number would misrepresent the finding.
 */

export interface SnapshotFile {
  date: string;
  capturedAt: string;
  servers: ServerSnapshot[];
  drift?: SnapshotDrift;
}

export interface ServerDrift {
  name: string;
  package: string;
  bucket: SeedBucket;
  /** Human-readable list of every hash/set change. Non-empty by construction. */
  changes: string[];
}

export interface SnapshotDrift {
  /** `date` of the snapshot this run was compared against. */
  previousSnapshot: string;
  /** Servers captured in both snapshots whose tool/prompt hashes or sets moved. */
  driftedCount: number;
  byBucket: Partial<Record<SeedBucket, number>>;
  servers: ServerDrift[];
  /** Servers present in only one of the two snapshots — the seed list itself changing, not drift. */
  seedListChanged: { added: string[]; removed: string[] };
  /** Servers that flipped between captured and not-captured (error / auth-gated) — an availability change, not drift. */
  captureStatusChanged: string[];
}

type HashRecord = Pick<ToolRecord, "name" | "schemaHash" | "promptHash"> | PromptRecord;

function hashSetChanges(kind: "tool" | "prompt", previous: HashRecord[], current: HashRecord[]): string[] {
  const changes: string[] = [];
  const prev = new Map(previous.map((r) => [r.name, r]));
  const cur = new Map(current.map((r) => [r.name, r]));

  const removed = [...prev.keys()].filter((n) => !cur.has(n));
  const added = [...cur.keys()].filter((n) => !prev.has(n));
  if (removed.length > 0) changes.push(`${kind}(s) removed: ${removed.sort().join(", ")}`);
  if (added.length > 0) changes.push(`${kind}(s) added: ${added.sort().join(", ")}`);

  for (const name of [...prev.keys()].filter((n) => cur.has(n)).sort()) {
    const p = prev.get(name)!;
    const c = cur.get(name)!;
    if (p.schemaHash !== c.schemaHash && p.promptHash !== c.promptHash) {
      changes.push(`${kind} "${name}": schemaHash and promptHash both changed`);
    } else if (p.schemaHash !== c.schemaHash) {
      changes.push(`${kind} "${name}": schemaHash changed`);
    } else if (p.promptHash !== c.promptHash) {
      changes.push(`${kind} "${name}": promptHash changed`);
    }
  }
  return changes;
}

function wasCaptured(s: ServerSnapshot): boolean {
  return Array.isArray(s.tools);
}

export function computeSnapshotDrift(previous: SnapshotFile, current: SnapshotFile): SnapshotDrift {
  const prevByName = new Map(previous.servers.map((s) => [s.name, s]));
  const curByName = new Map(current.servers.map((s) => [s.name, s]));

  const seedListChanged = {
    added: [...curByName.keys()].filter((n) => !prevByName.has(n)).sort(),
    removed: [...prevByName.keys()].filter((n) => !curByName.has(n)).sort(),
  };

  const servers: ServerDrift[] = [];
  const captureStatusChanged: string[] = [];

  for (const [name, cur] of curByName) {
    const prev = prevByName.get(name);
    if (!prev) continue;

    if (wasCaptured(prev) !== wasCaptured(cur)) {
      captureStatusChanged.push(
        `${name}: ${wasCaptured(prev) ? "captured" : "not captured"} -> ${wasCaptured(cur) ? "captured" : "not captured"}`,
      );
      continue;
    }
    if (!wasCaptured(prev) || !wasCaptured(cur)) continue;

    const changes = [
      ...hashSetChanges("tool", prev.tools ?? [], cur.tools ?? []),
      ...hashSetChanges("prompt", prev.prompts ?? [], cur.prompts ?? []),
    ];
    if (prev.bucket !== cur.bucket) changes.push(`bucket changed: ${prev.bucket} -> ${cur.bucket}`);

    if (changes.length > 0) {
      servers.push({ name, package: cur.package, bucket: cur.bucket, changes });
    }
  }

  servers.sort((a, b) => a.name.localeCompare(b.name));
  const byBucket: Partial<Record<SeedBucket, number>> = {};
  for (const s of servers) byBucket[s.bucket] = (byBucket[s.bucket] ?? 0) + 1;

  return {
    previousSnapshot: previous.date,
    driftedCount: servers.length,
    byBucket,
    servers,
    seedListChanged,
    captureStatusChanged,
  };
}

const BUCKET_ORDER: SeedBucket[] = ["list-open", "list-env-gated", "list-auth-required", "list-timeout"];

/** One-line drift summary for the collector's commit message: `0 drifted`, or `1 drifted — 1 list-env-gated`. */
export function driftSummary(drift: SnapshotDrift): string {
  if (drift.driftedCount === 0) return "0 drifted";
  const parts = BUCKET_ORDER.filter((b) => drift.byBucket[b]).map((b) => `${drift.byBucket[b]} ${b}`);
  return `${drift.driftedCount} drifted — ${parts.join(", ")}`;
}
