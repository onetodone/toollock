/**
 * Phase 5's seeded draw (DECISIONS.md #17). Deterministic and free — it
 * runs locally and its output is committed *before* the probe batch, so
 * if the probe dies halfway the sample still exists and nobody has to
 * redraw against a registry that has moved.
 *
 * Reads the pinned survivor list (data/registry/<date>-survivors.json,
 * written by snapshot-registry.ts), shuffles it with xmur3+mulberry32
 * seeded from a recorded seed string, and writes the first `drawSize`
 * entries to data/seed-candidates-<date>.json along with everything
 * needed to reproduce the exact draw: the seed, the PRNG name, and the
 * survivor file's sha256.
 *
 * Usage: npx tsx scripts/draw-seed-candidates.ts [survivors.json] [--seed <s>] [--size <n>]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PRNG_NAME, seededSample } from "../src/collector/draw.js";

interface SurvivorEntry {
  packageName: string;
  name: string | null;
  repositoryUrl: string | null;
}
interface SurvivorFile {
  date: string;
  count: number;
  survivors: SurvivorEntry[];
}

const DEFAULT_SEED = "toollock/seed-list/v2/2026-09";
const DEFAULT_SIZE = 100;

function parseArgs(argv: string[]): { survivorsPath: string; seed: string; size: number } {
  let seed = DEFAULT_SEED;
  let size = DEFAULT_SIZE;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seed") seed = argv[++i];
    else if (argv[i] === "--size") size = Number(argv[++i]);
    else positional.push(argv[i]);
  }
  const today = new Date().toISOString().slice(0, 10);
  const survivorsPath = positional[0] ?? path.join("data", "registry", `${today}-survivors.json`);
  return { survivorsPath, seed, size };
}

function main() {
  const { survivorsPath, seed, size } = parseArgs(process.argv.slice(2));
  const raw = readFileSync(survivorsPath, "utf8");
  const survivorFile = JSON.parse(raw) as SurvivorFile;
  const survivorFileSha256 = createHash("sha256").update(raw).digest("hex");

  if (survivorFile.survivors.length !== survivorFile.count) {
    throw new Error(`survivor file count (${survivorFile.count}) != array length (${survivorFile.survivors.length})`);
  }

  const candidates = seededSample(survivorFile.survivors, seed, size);
  const date = new Date().toISOString().slice(0, 10);
  const out = {
    date,
    drawnAt: new Date().toISOString(),
    method: "seeded Fisher-Yates shuffle over the sorted survivor list (DECISIONS.md #17)",
    prng: PRNG_NAME,
    seed,
    survivorFile: survivorsPath.replaceAll(path.sep, "/"),
    survivorFileSha256,
    survivorCount: survivorFile.count,
    drawSize: candidates.length,
    candidates,
  };

  const outPath = path.join("data", `seed-candidates-${date}.json`);
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Drew ${candidates.length} of ${survivorFile.count} survivors (seed "${seed}", ${PRNG_NAME}).`);
  console.log(`Survivor file sha256: ${survivorFileSha256}`);
  console.log(`Wrote ${outPath}`);
  console.log(`\nFirst 10:`);
  for (const c of candidates.slice(0, 10)) console.log(`  ${c.packageName}`);
}

main();
