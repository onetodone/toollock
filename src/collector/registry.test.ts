import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchAllRegistryEntries, isLatest, summarizeRegistry, type RegistryRecord } from "./registry.js";

function record(overrides: Partial<RegistryRecord["server"]> & { isLatest?: boolean } = {}): RegistryRecord {
  const { isLatest: latest, ...server } = overrides;
  return {
    server: { name: "example/server", version: "1.0.0", ...server },
    _meta: { "io.modelcontextprotocol.registry/official": { isLatest: latest ?? true } },
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as unknown as Response;
}

test("fetchAllRegistryEntries: follows nextCursor across pages, stops when absent", async () => {
  const pages = [
    { servers: [record({ name: "a" })], metadata: { nextCursor: "a:1.0.0" } },
    { servers: [record({ name: "b" })], metadata: { nextCursor: "b:1.0.0" } },
    { servers: [record({ name: "c" })], metadata: {} },
  ];
  let call = 0;
  const fakeFetch = (async (url: string) => {
    const parsed = new URL(url);
    if (call === 0) assert.equal(parsed.searchParams.has("cursor"), false, "first call must not send a cursor");
    else assert.equal(parsed.searchParams.get("cursor"), pages[call - 1].metadata.nextCursor);
    return jsonResponse(pages[call++]);
  }) as typeof fetch;

  const result = await fetchAllRegistryEntries(fakeFetch);
  assert.equal(result.entries.length, 3);
  assert.equal(result.pages, 3);
  assert.equal(result.cappedByMaxPages, false);
  assert.deepEqual(
    result.entries.map((e) => e.server.name),
    ["a", "b", "c"],
  );
  assert.equal(call, 3);
});

test("fetchAllRegistryEntries: throws on a non-ok response", async () => {
  const fakeFetch = (async () => ({ ok: false, status: 500, statusText: "Internal Server Error" })) as unknown as typeof fetch;
  await assert.rejects(() => fetchAllRegistryEntries(fakeFetch));
});

test("fetchAllRegistryEntries: a repeating cursor throws instead of looping forever or double-counting", async () => {
  // Page 1 advances normally; page 2's nextCursor repeats page 1's own
  // nextCursor — an overlapping/non-advancing window, not a large registry.
  const fakeFetch = (async (url: string) => {
    const cursor = new URL(url).searchParams.get("cursor");
    if (cursor === null) return jsonResponse({ servers: [record({ name: "a" })], metadata: { nextCursor: "x:1.0.0" } });
    return jsonResponse({ servers: [record({ name: "b" })], metadata: { nextCursor: "x:1.0.0" } });
  }) as unknown as typeof fetch;

  await assert.rejects(() => fetchAllRegistryEntries(fakeFetch), /did not advance/);
});

test("fetchAllRegistryEntries: maxPages stops an unbounded feed and reports it was capped", async () => {
  let call = 0;
  const fakeFetch = (async () => {
    call++;
    // Always returns a fresh, ever-advancing cursor — a genuinely
    // unbounded (or just very large) feed, exactly what the cap exists for.
    return jsonResponse({ servers: [record({ name: `n${call}` })], metadata: { nextCursor: `n${call}:1.0.0` } });
  }) as unknown as typeof fetch;

  const result = await fetchAllRegistryEntries(fakeFetch, { maxPages: 5 });
  assert.equal(result.pages, 5);
  assert.equal(result.cappedByMaxPages, true);
  assert.equal(result.entries.length, 5);
});

test("isLatest: strict === true, a missing or false flag is not latest", () => {
  assert.equal(isLatest(record({ isLatest: true })), true);
  assert.equal(isLatest(record({ isLatest: false })), false);
  assert.equal(isLatest({ server: { name: "x", version: "1.0.0" } }), false);
});

test("summarizeRegistry: counts only latest entries, extracts npm candidates by packages[].identifier not server.name", () => {
  const entries: RegistryRecord[] = [
    record({ name: "x", version: "0.9.0", isLatest: false, packages: [{ registryType: "npm", identifier: "old-x" }] }),
    record({
      name: "x",
      version: "1.0.0",
      isLatest: true,
      packages: [{ registryType: "npm", identifier: "@scope/x" }],
      repository: { url: "https://github.com/scope/x" },
    }),
    record({ name: "y", isLatest: true, packages: [{ registryType: "pypi", identifier: "y-py" }] }),
    record({ name: "z", isLatest: true, remotes: [{ type: "streamable-http", url: "https://z.example" }] }),
    record({ name: "w", isLatest: true }),
  ];

  const { tally, npmCandidates } = summarizeRegistry(entries);

  assert.equal(tally.totalEntries, 5);
  assert.equal(tally.distinctEntryKeys, 5);
  assert.equal(tally.latestEntries, 4);
  assert.equal(tally.distinctLatestNames, 4);
  assert.deepEqual(tally.byRegistryType, { npm: 1, pypi: 1 });
  assert.equal(tally.remoteOnlyEntries, 1);
  assert.equal(tally.neitherPackagesNorRemotes, 1);

  assert.equal(npmCandidates.length, 1);
  assert.equal(npmCandidates[0].packageName, "@scope/x");
  assert.equal(npmCandidates[0].name, "x");
  assert.equal(npmCandidates[0].repositoryUrl, "https://github.com/scope/x");
});

test("summarizeRegistry: a server with two package registryTypes is counted once per type but once in npmCandidates", () => {
  const entries: RegistryRecord[] = [
    record({
      name: "multi",
      isLatest: true,
      packages: [
        { registryType: "npm", identifier: "@scope/multi" },
        { registryType: "oci", identifier: "ghcr.io/scope/multi" },
      ],
    }),
  ];
  const { tally, npmCandidates } = summarizeRegistry(entries);
  assert.deepEqual(tally.byRegistryType, { npm: 1, oci: 1 });
  assert.equal(npmCandidates.length, 1);
});

test("summarizeRegistry: duplicate raw entries (same name@version twice) surface as distinctEntryKeys < totalEntries", () => {
  const entries: RegistryRecord[] = [record({ name: "dup", version: "1.0.0" }), record({ name: "dup", version: "1.0.0" })];
  const { tally } = summarizeRegistry(entries);
  assert.equal(tally.totalEntries, 2);
  assert.equal(tally.distinctEntryKeys, 1, "an overlapping-page duplicate must not inflate the distinct count");
});

test("summarizeRegistry: two entries both flagged isLatest for the same name surface as distinctLatestNames < latestEntries", () => {
  const entries: RegistryRecord[] = [
    record({ name: "dup", version: "1.0.0", isLatest: true }),
    record({ name: "dup", version: "1.0.1", isLatest: true }),
  ];
  const { tally } = summarizeRegistry(entries);
  assert.equal(tally.latestEntries, 2);
  assert.equal(tally.distinctLatestNames, 1, "two entries claiming to be the latest version of the same server is a data bug, not two servers");
});
