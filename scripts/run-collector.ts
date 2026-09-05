/**
 * The daily collector entrypoint (invoked by .github/workflows/collect.yml
 * and runnable by hand via `npm run collect`): reads data/seed-list.json,
 * captures every capturable server, and writes a dated snapshot under
 * data/snapshots/. Phase 2.5's own scope — snapshot writer only, no drift
 * computation yet (that's Phase 5).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { snapshotServer, type SeedServerSpec } from "../src/collector/snapshot.js";

interface SeedList {
  version: number;
  servers: SeedServerSpec[];
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
          `schemaReuseRatio=${snapshot.schemaReuseRatio ?? "null"}`,
      );
    } else {
      console.log(`  bucket=${snapshot.bucket}, no measurement attempted`);
    }
    results.push(snapshot);
  }

  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.join(process.cwd(), "data", "snapshots");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${date}.json`);
  writeFileSync(outPath, `${JSON.stringify({ date, capturedAt: new Date().toISOString(), servers: results }, null, 2)}\n`);
  console.log(`Wrote ${outPath} (${results.length} servers)`);

  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `count=${results.length}\ndate=${date}\n`, { flag: "a" });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
