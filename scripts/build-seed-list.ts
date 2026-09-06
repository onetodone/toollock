/**
 * Builds data/seed-list.json v2 from v1 (Phase 0's 10 hand-probed
 * servers) plus every `list-open` server in the Phase 5 draw's probe
 * results. Mechanical and re-runnable — the judgement-free half of
 * decision #17's expansion (the seeded draw picked the candidates; the
 * probe assigned the buckets; this just unions the results). The ≤5
 * `list-env-gated` promotions are hand-added afterward, not here.
 *
 * Usage: npx tsx scripts/build-seed-list.ts data/seed-candidates-<date>-results.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface SeedServerSpec {
  name: string;
  package: string;
  bucket: string;
  spawnArgs?: string[];
  promotionEnv?: Record<string, string>;
  note?: string;
  caveat?: string;
  reason?: string;
}
interface SeedListV1 {
  version: number;
  createdAt?: string;
  source?: string;
  servers: SeedServerSpec[];
}
interface ProbeResults {
  date: string;
  seed: string;
  drawSize: number;
  drawFile: string;
  survivorFile: string;
  survivorFileSha256: string;
  byBucket: Record<string, number>;
  notProbed: string[];
  wallCeilingHit: boolean;
  outcomes: { package: string; bucket: string; tools: number | null; serverName: string | null }[];
}

function main() {
  const resultsPath = process.argv[2];
  if (!resultsPath) throw new Error("usage: build-seed-list.ts <probe-results.json>");

  const seedListPath = path.join("data", "seed-list.json");
  const v1 = JSON.parse(readFileSync(seedListPath, "utf8")) as SeedListV1;
  const results = JSON.parse(readFileSync(resultsPath, "utf8")) as ProbeResults;

  const v1Packages = new Set(v1.servers.map((s) => s.package));
  const drawn = results.outcomes
    .filter((o) => o.bucket === "list-open" && !v1Packages.has(o.package))
    .sort((a, b) => a.package.localeCompare(b.package))
    .map<SeedServerSpec>((o) => ({
      name: o.package,
      package: o.package,
      bucket: "list-open",
      note: `Added in Phase 5's seeded draw (${results.seed}); auto-probed list-open with ${o.tools ?? "?"} tools, zero env. Not hand-vetted — see DECISIONS.md #17.`,
    }));

  const v2: SeedListV1 & { expansion: unknown } = {
    version: 2,
    createdAt: "2026-09-06",
    source: v1.source,
    expansion: {
      method: "seeded pseudorandom draw over the curation-bar survivors, then bucket probe (DECISIONS.md #17)",
      seed: results.seed,
      prng: "xmur3+mulberry32",
      survivorFile: results.survivorFile,
      survivorFileSha256: results.survivorFileSha256,
      drawFile: results.drawFile,
      probeResults: resultsPath.replaceAll(path.sep, "/"),
      drawSize: results.drawSize,
      probeDistribution: results.byBucket,
      wallCeilingHit: results.wallCeilingHit,
      notProbed: results.notProbed.length,
      keptListOpen: drawn.length,
      finding: `docs/findings/${results.date}-random-sample-bucket-distribution.md`,
    },
    servers: [...v1.servers, ...drawn],
  };

  writeFileSync(seedListPath, `${JSON.stringify(v2, null, 2)}\n`);
  console.log(`seed-list.json v2: ${v1.servers.length} v1 servers + ${drawn.length} drawn list-open = ${v2.servers.length} total`);
  console.log(`probe distribution: ${JSON.stringify(results.byBucket)}${results.wallCeilingHit ? ` (+${results.notProbed.length} not probed)` : ""}`);
}

main();
