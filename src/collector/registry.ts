const REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0/servers";
const OFFICIAL_META_KEY = "io.modelcontextprotocol.registry/official";

export interface RegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
}

export interface RegistryRepository {
  url: string;
  source?: string;
}

export interface RegistryServer {
  name: string;
  description?: string;
  version: string;
  repository?: RegistryRepository;
  packages?: RegistryPackage[];
  remotes?: unknown[];
}

export interface RegistryRecord {
  server: RegistryServer;
  _meta?: {
    [OFFICIAL_META_KEY]?: { isLatest?: boolean; status?: string };
  };
}

interface RegistryPage {
  servers: RegistryRecord[];
  metadata?: { nextCursor?: string; count?: number };
}

export interface PageInfo {
  page: number;
  entriesSoFar: number;
  cursor: string | undefined;
  nextCursor: string | undefined;
}

export interface FetchRegistryOptions {
  onPage?: (info: PageInfo) => void;
  /**
   * Hard stop so an unattended run terminates instead of looping forever
   * against a misbehaving or unbounded feed — this crawl has no operator
   * watching it once it's wired into anything scheduled. Default (5000
   * pages = 500,000 entries) is well above the real registry's observed
   * size (~920 pages) with headroom for real growth.
   */
  maxPages?: number;
}

export interface FetchRegistryResult {
  entries: RegistryRecord[];
  pages: number;
  /** True only if `maxPages` was hit with more data still available — distinct from a clean exhaustion of `nextCursor`. */
  cappedByMaxPages: boolean;
}

/**
 * Fetches every page of the public MCP registry (`nextCursor` pagination,
 * confirmed live in Phase 0 spike 3). Real network call, no offline
 * fixture substitutes for it — "how many entries does the registry have
 * today" is a dated number that can't be reconstructed later.
 *
 * Guards against the two ways a paginated crawl silently lies: a cursor
 * that repeats (the loop would never terminate, and every page in
 * between would be counted as if it were new data — a hard failure, not
 * a warning, since a lower-level `null`-out would let a corrupted count
 * reach the dataset) and a page count that just keeps climbing
 * (`maxPages` turns that into a flagged, visible stop instead of an
 * unattended process running indefinitely).
 */
export async function fetchAllRegistryEntries(
  fetchImpl: typeof fetch = fetch,
  options: FetchRegistryOptions = {},
): Promise<FetchRegistryResult> {
  const maxPages = options.maxPages ?? 5000;
  const all: RegistryRecord[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let cappedByMaxPages = false;

  do {
    const url = new URL(REGISTRY_BASE);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetchImpl(url.toString());
    if (!res.ok) {
      throw new Error(`registry fetch failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as RegistryPage;
    all.push(...body.servers);
    pages++;
    const nextCursor = body.metadata?.nextCursor;
    options.onPage?.({ page: pages, entriesSoFar: all.length, cursor, nextCursor });

    if (nextCursor !== undefined) {
      if (seenCursors.has(nextCursor)) {
        throw new Error(
          `registry pagination did not advance: cursor "${nextCursor}" repeated at page ${pages} — ` +
            `aborting rather than looping forever or double-counting entries`,
        );
      }
      seenCursors.add(nextCursor);
    }
    cursor = nextCursor;

    if (cursor && pages >= maxPages) {
      cappedByMaxPages = true;
      break;
    }
  } while (cursor);

  return { entries: all, pages, cappedByMaxPages };
}

/**
 * The registry lists every published version of every server as its own
 * entry — confirmed live (e.g. one name with 4 version entries, only one
 * `isLatest: true`). Every observed entry carried this flag explicitly,
 * so a strict `=== true` check (rather than treating a missing flag as
 * latest) is used deliberately: it can only under-count on a malformed
 * entry, never double-count a stale version as current.
 */
export function isLatest(record: RegistryRecord): boolean {
  return record._meta?.[OFFICIAL_META_KEY]?.isLatest === true;
}

export interface RegistryTally {
  totalEntries: number;
  /**
   * Distinct `name@version` keys among all entries. If this is less than
   * `totalEntries`, the crawl returned the same entry more than once —
   * an overlapping-page pagination bug, not a large registry. Compare
   * the two rather than trusting `totalEntries` alone.
   */
  distinctEntryKeys: number;
  latestEntries: number;
  /**
   * Distinct `server.name` values among entries flagged `isLatest`. If
   * this is less than `latestEntries`, more than one entry claims to be
   * the latest version of the same server — also a pagination/data bug,
   * not evidence of a bigger registry.
   */
  distinctLatestNames: number;
  /** One count per `packages[].registryType` value seen (npm, pypi, oci, ...), each latest server counted once per distinct type it lists. */
  byRegistryType: Record<string, number>;
  /** Latest servers with `remotes` but no `packages` at all — hosted-only, no npx spawn target. */
  remoteOnlyEntries: number;
  /** Latest servers with neither `packages` nor `remotes` — a data-quality edge case worth counting, not silently dropping. */
  neitherPackagesNorRemotes: number;
}

export interface NpmCandidate {
  /** The registry's own namespaced name (e.g. "io.github.x/y") — NOT the npx spawn target. */
  name: string;
  /** The real npm package identifier to `npx -y` — from `packages[].identifier`, never `server.name`. */
  packageName: string;
  description?: string;
  repositoryUrl?: string;
}

export interface RegistrySummary {
  tally: RegistryTally;
  npmCandidates: NpmCandidate[];
}

/**
 * Tallies the full registry by registryType and remote-only/neither, and
 * extracts the npm candidate list — one entry per latest server with at
 * least one `packages[].registryType === "npm"` package.
 */
export function summarizeRegistry(entries: RegistryRecord[]): RegistrySummary {
  const distinctEntryKeys = new Set(entries.map((e) => `${e.server.name}@${e.server.version}`)).size;

  const latest = entries.filter(isLatest);
  const distinctLatestNames = new Set(latest.map((e) => e.server.name)).size;

  const byRegistryType: Record<string, number> = {};
  let remoteOnlyEntries = 0;
  let neitherPackagesNorRemotes = 0;
  const npmCandidates: NpmCandidate[] = [];

  for (const record of latest) {
    const { packages, remotes } = record.server;
    const types = new Set((packages ?? []).map((p) => p.registryType));
    for (const type of types) {
      byRegistryType[type] = (byRegistryType[type] ?? 0) + 1;
    }
    const hasPackages = Boolean(packages && packages.length > 0);
    const hasRemotes = Boolean(remotes && remotes.length > 0);
    if (!hasPackages && hasRemotes) remoteOnlyEntries++;
    if (!hasPackages && !hasRemotes) neitherPackagesNorRemotes++;

    const npmPkg = (packages ?? []).find((p) => p.registryType === "npm");
    if (npmPkg) {
      npmCandidates.push({
        name: record.server.name,
        packageName: npmPkg.identifier,
        description: record.server.description,
        repositoryUrl: record.server.repository?.url,
      });
    }
  }

  return {
    tally: {
      totalEntries: entries.length,
      distinctEntryKeys,
      latestEntries: latest.length,
      distinctLatestNames,
      byRegistryType,
      remoteOnlyEntries,
      neitherPackagesNorRemotes,
    },
    npmCandidates,
  };
}
