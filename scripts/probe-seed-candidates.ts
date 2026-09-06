/**
 * Phase 5's bucket probe over the seeded draw. This is the batch that
 * spawns unvetted npm packages, so it is meant to run on decision #11's
 * ephemeral GitHub Actions runner (.github/workflows/probe-seed-candidates.yml,
 * workflow_dispatch) — never locally: 100 packages with arbitrary
 * postinstall scripts belong in the isolated environment that exists for
 * exactly this, and the runner's cold npm cache / real network latency
 * are the conditions Phase 1's timeouts were sized for.
 *
 * Survives an unattended run over a hostile population: probeCandidate
 * never throws, every failure is bucketed, and probeAll enforces a total
 * wall-time ceiling. Partial results are still written if the ceiling is
 * hit — the packages not reached are listed, not lost.
 *
 * Usage: npx tsx scripts/probe-seed-candidates.ts [data/seed-candidates-<date>.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { probeAll, type ProbeBucket } from "../src/collector/probe.js";

interface DrawFile {
  date: string;
  seed: string;
  drawSize: number;
  survivorFile: string;
  survivorFileSha256: string;
  candidates: { packageName: string }[];
}

const WALL_CEILING_MS = 45 * 60_000;
const CONCURRENCY = 4;

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const drawPath = process.argv[2] ?? path.join("data", `seed-candidates-${today}.json`);
  const draw = JSON.parse(readFileSync(drawPath, "utf8")) as DrawFile;
  const packages = draw.candidates.map((c) => c.packageName);

  console.log(`Probing ${packages.length} candidates from ${drawPath} (concurrency ${CONCURRENCY}, wall ceiling ${WALL_CEILING_MS / 60_000}min)...`);

  const result = await probeAll(packages, {
    concurrency: CONCURRENCY,
    wallCeilingMs: WALL_CEILING_MS,
    onResult: (o, done, total) => {
      const suffix = o.bucket === "list-open" ? `${o.tools} tool(s)` : (o.detail ?? "").slice(0, 80);
      console.log(`  [${done}/${total}] ${o.package}: ${o.bucket} (${(o.durationMs / 1000).toFixed(1)}s) — ${suffix}`);
    },
  });

  const outcomes = [...result.probed].sort((a, b) => a.package.localeCompare(b.package));
  const out = {
    date: today,
    probedAt: new Date().toISOString(),
    drawFile: drawPath.replaceAll(path.sep, "/"),
    seed: draw.seed,
    drawSize: draw.drawSize,
    survivorFile: draw.survivorFile,
    survivorFileSha256: draw.survivorFileSha256,
    concurrency: CONCURRENCY,
    wallTimeMs: result.wallTimeMs,
    wallCeilingHit: result.wallCeilingHit,
    byBucket: result.byBucket,
    notProbed: result.notProbed,
    outcomes,
  };

  const outPath = path.join("data", `seed-candidates-${today}-results.json`);
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);

  const b = result.byBucket;
  const summary = (["list-open", "list-auth-required", "list-timeout"] as ProbeBucket[]).map((k) => `${b[k]} ${k}`).join(", ");
  console.log(`\n${result.probed.length}/${packages.length} probed in ${(result.wallTimeMs / 60_000).toFixed(1)}min — ${summary}`);
  if (result.notProbed.length > 0) console.log(`NOT probed (wall ceiling): ${result.notProbed.length}`);
  console.log(`Wrote ${outPath}`);

  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `date=${today}\nsummary=${summary}${result.wallCeilingHit ? `, ${result.notProbed.length} not probed` : ""}\n`, { flag: "a" });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
