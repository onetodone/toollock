/**
 * The daily collector entrypoint (invoked by .github/workflows/collect.yml
 * and runnable by hand via `npm run collect`): reads data/seed-list.json,
 * captures every capturable server, computes drift against the previous
 * snapshot (Phase 5), and writes a dated snapshot under data/snapshots/.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computeSnapshotDrift, driftSummary, type SnapshotFile } from "../src/collector/drift.js";
import { snapshotServer, type SeedServerSpec } from "../src/collector/snapshot.js";

interface SeedList {
  version: number;
  servers: SeedServerSpec[];
}

/** The most recent snapshot file strictly older than `today` (by date-named filename), or null on the first run. */
function previousSnapshot(snapshotDir: string, today: string): SnapshotFile | null {
  if (!existsSync(snapshotDir)) return null;
  const dates = readdirSync(snapshotDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .filter((d) => d < today)
    .sort();
  const latest = dates.at(-1);
  return latest ? (JSON.parse(readFileSync(path.join(snapshotDir, `${latest}.json`), "utf8")) as SnapshotFile) : null;
}

async function main() {
  const seedListPath = path.join(process.cwd(), "data", "seed-list.json");
  const seedList = JSON.parse(readFileSync(seedListPath, "utf8")) as SeedList;

  const results = [];
  for (const spec of seedList.servers) {
    console.log(`Capturing ${spec.name} (${spec.package})...`);
    const snapshot = await snapshotServer(spec);
    if (snapshot.error) {
      console.log(`  ERROR: ${snapshot.error}`);
    } else if (snapshot.tools) {
      console.log(
        `  ${snapshot.tools.length} tool(s), ${snapshot.prompts?.length ?? 0} prompt(s), ` +
          `schemaReuseRatio=${snapshot.schemaReuseRatio ?? "null"}, stableAcrossSpawns=${snapshot.stableAcrossSpawns ?? "null"}`,
      );
      if (snapshot.spawnVariance) for (const v of snapshot.spawnVariance) console.log(`    spawn variance: ${v}`);
    } else {
      console.log(`  bucket=${snapshot.bucket}, no measurement attempted`);
    }
    results.push(snapshot);
  }

  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.join(process.cwd(), "data", "snapshots");
  mkdirSync(outDir, { recursive: true });

  const snapshotFile: SnapshotFile = { date, capturedAt: new Date().toISOString(), servers: results };

  const previous = previousSnapshot(outDir, date);
  let summary = "baseline (no previous snapshot)";
  if (previous) {
    const drift = computeSnapshotDrift(previous, snapshotFile);
    snapshotFile.drift = drift;
    summary = driftSummary(drift);
    console.log(`\nDrift vs ${drift.previousSnapshot}: ${summary}`);
    for (const s of drift.servers) {
      console.log(`  ${s.name} (${s.bucket}):`);
      for (const c of s.changes) console.log(`    - ${c}`);
    }
    for (const c of drift.captureStatusChanged) console.log(`  capture status: ${c}`);
    if (drift.seedListChanged.added.length || drift.seedListChanged.removed.length) {
      console.log(`  seed list changed: +[${drift.seedListChanged.added.join(", ")}] -[${drift.seedListChanged.removed.join(", ")}]`);
    }
  }

  const outPath = path.join(outDir, `${date}.json`);
  writeFileSync(outPath, `${JSON.stringify(snapshotFile, null, 2)}\n`);
  console.log(`\nWrote ${outPath} (${results.length} servers, ${summary})`);

  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `count=${results.length}\ndate=${date}\ndrift=${summary}\n`, { flag: "a" });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
