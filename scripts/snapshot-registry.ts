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
 * Reports both `totalEntries` (raw, as fetched) and `distinctEntryKeys`/
 * `distinctLatestNames` (deduplicated) — three figures across sessions
 * (~50k capped, "4,000+" partial, then 64k+ and climbing) didn't
 * reconcile on first run, exactly the kind of thing an overlapping-page
 * pagination bug would produce. If the raw and distinct counts diverge,
 * the distinct count is the real one; the gap itself is logged, not
 * silently resolved in either direction.
 *
 * Usage: npx tsx scripts/snapshot-registry.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkAllNpmCriteria, summarizeCuration } from "../src/collector/curate.js";
import { fetchAllRegistryEntries, summarizeRegistry } from "../src/collector/registry.js";

async function main() {
  console.log("Fetching the full MCP registry (registry.modelcontextprotocol.io/v0/servers)...");
  const { entries, pages, cappedByMaxPages } = await fetchAllRegistryEntries(fetch, {
    onPage: ({ page, entriesSoFar, cursor, nextCursor }) => {
      if (page === 1 || page % 20 === 0) {
        console.log(`  page ${page}: ${entriesSoFar} raw entries so far, cursor ${cursor ?? "(none)"} -> ${nextCursor ?? "(done)"}`);
      }
    },
  });
  if (cappedByMaxPages) {
    console.warn(`WARNING: crawl stopped at the ${pages}-page cap with more data still available — not a complete crawl.`);
  }
  console.log(`Fetched ${entries.length} raw entries across ${pages} pages.`);

  const { tally, npmCandidates } = summarizeRegistry(entries);
  console.log(`Distinct entries (name@version): ${tally.distinctEntryKeys} (raw was ${tally.totalEntries}).`);
  if (tally.distinctEntryKeys !== tally.totalEntries) {
    console.warn(
      `WARNING: raw entry count and distinct entry count diverge by ${tally.totalEntries - tally.distinctEntryKeys} — ` +
        `pagination likely returned overlapping pages. Treat distinctEntryKeys as the real number.`,
    );
  }
  console.log(`Latest servers: ${tally.latestEntries} (distinct names: ${tally.distinctLatestNames}).`);
  if (tally.distinctLatestNames !== tally.latestEntries) {
    console.warn(
      `WARNING: ${tally.latestEntries - tally.distinctLatestNames} server name(s) have more than one entry flagged isLatest — a data bug, not extra servers.`,
    );
  }
  console.log(`By registryType: ${JSON.stringify(tally.byRegistryType)}.`);
  console.log(`npm candidates: ${npmCandidates.length}.`);

  console.log(`Checking DECISIONS.md #17's curation bar against ${npmCandidates.length} npm candidates (bounded concurrency)...`);
  const criteriaResults = await checkAllNpmCriteria(npmCandidates, 20);
  console.log(`Checked ${criteriaResults.length} candidates.`);
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
    pages,
    cappedByMaxPages,
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

  // The pinned survivor list — decision #17's Phase 5 addition. The
  // registry moves, so a reproducible seeded draw (decision #17) has to
  // run against the exact list it was drawn from, not a later re-crawl.
  // Sorted by packageName for a stable order the draw's shuffle is a
  // deterministic function of. Kept as its own file (decision #18): a
  // ~7,700-entry array is large, but it's write-once and rarely changes.
  const byPackage = new Map(npmCandidates.map((c) => [c.packageName, c]));
  const survivors = [...curation.survivors]
    .sort((a, b) => a.localeCompare(b))
    .map((packageName) => {
      const c = byPackage.get(packageName);
      return { packageName, name: c?.name ?? null, repositoryUrl: c?.repositoryUrl ?? null };
    });
  const survivorsPath = path.join(outDir, `${date}-survivors.json`);
  writeFileSync(
    survivorsPath,
    `${JSON.stringify({ date, sourceSnapshot: `${date}.json`, count: survivors.length, survivors }, null, 2)}\n`,
  );
  console.log(`Wrote ${survivorsPath} (${survivors.length} survivors)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
