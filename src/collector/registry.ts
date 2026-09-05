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

/**
 * Fetches every page of the public MCP registry (`nextCursor` pagination,
 * confirmed live in Phase 0 spike 3). Real network call, no offline
 * fixture substitutes for it — "how many entries does the registry have
 * today" is a dated number that can't be reconstructed later.
 */
export async function fetchAllRegistryEntries(
  fetchImpl: typeof fetch = fetch,
  onPage?: (pagesSoFar: number, entriesSoFar: number) => void,
): Promise<RegistryRecord[]> {
  const all: RegistryRecord[] = [];
  let cursor: string | undefined;
  let pages = 0;
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
    onPage?.(pages, all.length);
    cursor = body.metadata?.nextCursor;
  } while (cursor);
  return all;
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
  latestEntries: number;
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
  const latest = entries.filter(isLatest);
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
      latestEntries: latest.length,
      byRegistryType,
      remoteOnlyEntries,
      neitherPackagesNorRemotes,
    },
    npmCandidates,
  };
}
