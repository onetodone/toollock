/**
 * One-time (not-daily) registry snapshot: crawls the full public MCP
 * registry, tallies it by registryType, and runs DECISIONS.md #17's
 * curation bar against every npm-type candidate found. This is the
 * denominator for every "X% of the public registry" claim the project
 * intends to make — a dated number that can't be reconstructed later,
 * so it's captured for real (no mocking) and committed under
 * data/registry/.
 *
 * Deliberately NOT part of collect.yml's daily job: a full crawl plus a
 * curation check against every npm candidate is a heavy, slow operation
 * (see PROGRESS.md — thousands of candidates, several minutes even at
 * bounded concurrency), not a "getting the cron running" task. Re-run by
 * hand when the registry's scale is worth re-measuring.
 *
 * Usage: npx tsx scripts/snapshot-registry.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkAllNpmCriteria, summarizeCuration } from "../src/collector/curate.js";
import { fetchAllRegistryEntries, summarizeRegistry } from "../src/collector/registry.js";

async function main() {
  console.log("Fetching the full MCP registry (registry.modelcontextprotocol.io/v0/servers)...");
  const records = await fetchAllRegistryEntries(fetch, (pages, entries) => {
    if (pages % 20 === 0) console.log(`  ...${pages} pages, ${entries} raw entries so far`);
  });
  console.log(`Fetched ${records.length} raw entries.`);

  const { tally, npmCandidates } = summarizeRegistry(records);
  console.log(`Latest servers: ${tally.latestEntries}. By registryType: ${JSON.stringify(tally.byRegistryType)}.`);
  console.log(`npm candidates: ${npmCandidates.length}.`);

  console.log(`Checking DECISIONS.md #17's curation bar against ${npmCandidates.length} npm candidates (bounded concurrency)...`);
  let done = 0;
  const criteriaResults = await checkAllNpmCriteria(npmCandidates, 20);
  done = criteriaResults.length;
  console.log(`Checked ${done} candidates.`);
  const curation = summarizeCuration(criteriaResults);
  console.log(
    `Curation: ${curation.survivors.length} survive of ${curation.totalCandidates} ` +
      `(failedResolve=${curation.failedResolve}, failedRecency=${curation.failedRecency}, failedRepository=${curation.failedRepository}).`,
  );

  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.join(process.cwd(), "data", "registry");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${date}.json`);

  const snapshot = {
    date,
    capturedAt: new Date().toISOString(),
    source: "https://registry.modelcontextprotocol.io/v0/servers",
    tally,
    curation: {
      totalNpmCandidates: curation.totalCandidates,
      failedResolve: curation.failedResolve,
      failedRecency: curation.failedRecency,
      failedRepository: curation.failedRepository,
      survivorCount: curation.survivors.length,
    },
  };
  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
