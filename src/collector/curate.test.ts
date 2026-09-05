import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAllNpmCriteria, checkNpmCriteria, summarizeCuration, withinLastMonths, type CriteriaResult } from "./curate.js";
import type { NpmCandidate } from "./registry.js";

function npmResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

test("withinLastMonths: a date 6 months ago is within 12, 18 months ago is not", () => {
  const now = new Date("2026-09-05T00:00:00Z");
  assert.equal(withinLastMonths(new Date("2026-03-05T00:00:00Z"), 12, now), true);
  assert.equal(withinLastMonths(new Date("2025-03-01T00:00:00Z"), 12, now), false);
});

test("checkNpmCriteria: a 404 fails resolution, and recency is null (nothing to check)", async () => {
  const fakeFetch = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
  const candidate: NpmCandidate = { name: "x", packageName: "does-not-exist", repositoryUrl: "https://github.com/x/x" };
  const result = await checkNpmCriteria(candidate, fakeFetch);
  assert.deepEqual(result, {
    packageName: "does-not-exist",
    resolves: false,
    publishedWithin12Months: null,
    hasRepositoryLink: true,
    survives: false,
  });
});

test("checkNpmCriteria: resolves, recent, has a repo link — survives", async () => {
  const now = new Date("2026-09-05T00:00:00Z");
  const fakeFetch = (async () =>
    npmResponse({ "dist-tags": { latest: "1.0.0" }, time: { "1.0.0": "2026-06-01T00:00:00Z" } })) as unknown as typeof fetch;
  const candidate: NpmCandidate = { name: "x", packageName: "@scope/x", repositoryUrl: "https://github.com/x/x" };
  const result = await checkNpmCriteria(candidate, fakeFetch, now);
  assert.equal(result.resolves, true);
  assert.equal(result.publishedWithin12Months, true);
  assert.equal(result.hasRepositoryLink, true);
  assert.equal(result.survives, true);
});

test("checkNpmCriteria: resolves but stale, and no repository link — fails both, still resolves", async () => {
  const now = new Date("2026-09-05T00:00:00Z");
  const fakeFetch = (async () =>
    npmResponse({ "dist-tags": { latest: "1.0.0" }, time: { "1.0.0": "2020-01-01T00:00:00Z" } })) as unknown as typeof fetch;
  const candidate: NpmCandidate = { name: "x", packageName: "stale-pkg" };
  const result = await checkNpmCriteria(candidate, fakeFetch, now);
  assert.equal(result.resolves, true);
  assert.equal(result.publishedWithin12Months, false);
  assert.equal(result.hasRepositoryLink, false);
  assert.equal(result.survives, false);
});

test("checkNpmCriteria: falls back to time.modified when dist-tags.latest is missing", async () => {
  const now = new Date("2026-09-05T00:00:00Z");
  const fakeFetch = (async () => npmResponse({ time: { modified: "2026-08-01T00:00:00Z" } })) as unknown as typeof fetch;
  const candidate: NpmCandidate = { name: "x", packageName: "no-dist-tags", repositoryUrl: "https://github.com/x/x" };
  const result = await checkNpmCriteria(candidate, fakeFetch, now);
  assert.equal(result.publishedWithin12Months, true);
});

test("checkAllNpmCriteria: runs every candidate exactly once, order preserved, across a bounded worker pool", async () => {
  const candidates: NpmCandidate[] = Array.from({ length: 25 }, (_, i) => ({ name: `n${i}`, packageName: `pkg-${i}` }));
  const seen: string[] = [];
  const fakeFetch = (async (url: string) => {
    seen.push(url);
    return npmResponse({ "dist-tags": { latest: "1.0.0" }, time: { "1.0.0": new Date().toISOString() } });
  }) as unknown as typeof fetch;

  const results = await checkAllNpmCriteria(candidates, 5, fakeFetch);
  assert.equal(results.length, 25);
  assert.equal(seen.length, 25);
  assert.deepEqual(
    results.map((r) => r.packageName),
    candidates.map((c) => c.packageName),
  );
});

test("summarizeCuration: cascading drop counts, each criterion counted only among survivors of the previous one", () => {
  const results: CriteriaResult[] = [
    { packageName: "a", resolves: false, publishedWithin12Months: null, hasRepositoryLink: true, survives: false },
    { packageName: "b", resolves: true, publishedWithin12Months: false, hasRepositoryLink: true, survives: false },
    { packageName: "c", resolves: true, publishedWithin12Months: true, hasRepositoryLink: false, survives: false },
    { packageName: "d", resolves: true, publishedWithin12Months: true, hasRepositoryLink: true, survives: true },
  ];
  const summary = summarizeCuration(results);
  assert.equal(summary.totalCandidates, 4);
  assert.equal(summary.failedResolve, 1);
  assert.equal(summary.failedRecency, 1);
  assert.equal(summary.failedRepository, 1);
  assert.deepEqual(summary.survivors, ["d"]);
});
