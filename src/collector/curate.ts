import type { NpmCandidate } from "./registry.js";

/** DECISIONS.md #17's three mechanical criteria, checked in order. */
export interface CriteriaResult {
  packageName: string;
  /** Criterion 1: a real `registry.npmjs.org` lookup succeeds — stronger than trusting the MCP registry's self-reported `registryType: npm`, which can be stale or wrong. */
  resolves: boolean;
  /** Criterion 2: last publish within 12 months. `null` when `resolves` is false (nothing to check). */
  publishedWithin12Months: boolean | null;
  /** Criterion 3: repository link present — from the MCP registry's own `server.repository.url`, not a second npm lookup (already in hand, free). */
  hasRepositoryLink: boolean;
  /** All three true. */
  survives: boolean;
}

export function withinLastMonths(date: Date, months: number, now: Date = new Date()): boolean {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  return date >= cutoff;
}

interface NpmRegistryResponse {
  time?: Record<string, string>;
  "dist-tags"?: { latest?: string };
}

/** Real `registry.npmjs.org` lookup — no offline substitute; existence and last-publish date are exactly what criteria 1/2 ask about, live. */
export async function checkNpmCriteria(
  candidate: NpmCandidate,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<CriteriaResult> {
  const hasRepositoryLink = Boolean(candidate.repositoryUrl && candidate.repositoryUrl.trim().length > 0);

  const res = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(candidate.packageName)}`);
  if (!res.ok) {
    return { packageName: candidate.packageName, resolves: false, publishedWithin12Months: null, hasRepositoryLink, survives: false };
  }

  const body = (await res.json()) as NpmRegistryResponse;
  const latestVersion = body["dist-tags"]?.latest;
  const publishedAtStr = (latestVersion ? body.time?.[latestVersion] : undefined) ?? body.time?.modified;
  const publishedWithin12Months = publishedAtStr ? withinLastMonths(new Date(publishedAtStr), 12, now) : false;

  return {
    packageName: candidate.packageName,
    resolves: true,
    publishedWithin12Months,
    hasRepositoryLink,
    survives: publishedWithin12Months && hasRepositoryLink,
  };
}

/** Bounded-concurrency worker pool — thousands of candidates against a real registry needs a cap, not one request per candidate in parallel. */
export async function checkAllNpmCriteria(
  candidates: NpmCandidate[],
  concurrency = 20,
  fetchImpl: typeof fetch = fetch,
): Promise<CriteriaResult[]> {
  const results: CriteriaResult[] = new Array(candidates.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= candidates.length) return;
      results[i] = await checkNpmCriteria(candidates[i], fetchImpl);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return results;
}

export interface CurationSummary {
  totalCandidates: number;
  /** Fails criterion 1 (doesn't resolve on npm). */
  failedResolve: number;
  /** Resolves, but fails criterion 2 (stale > 12 months). */
  failedRecency: number;
  /** Resolves and recent, but fails criterion 3 (no repository link). */
  failedRepository: number;
  survivors: string[];
}

/** Cascading drop counts, criterion order matching DECISIONS.md #17 exactly — each count is "of what survived the previous criterion." */
export function summarizeCuration(results: CriteriaResult[]): CurationSummary {
  let failedResolve = 0;
  let failedRecency = 0;
  let failedRepository = 0;
  const survivors: string[] = [];

  for (const r of results) {
    if (!r.resolves) {
      failedResolve++;
      continue;
    }
    if (!r.publishedWithin12Months) {
      failedRecency++;
      continue;
    }
    if (!r.hasRepositoryLink) {
      failedRepository++;
      continue;
    }
    survivors.push(r.packageName);
  }

  return { totalCandidates: results.length, failedResolve, failedRecency, failedRepository, survivors };
}
