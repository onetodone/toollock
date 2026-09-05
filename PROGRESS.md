# PROGRESS.md

## Current state

**Phase 2.5 is complete; Phase 3 is next.** The collector is real and
armed: `.github/workflows/collect.yml` is pushed to `main` (daily
06:00 UTC cron + `workflow_dispatch`), `data/seed-list.json` (10
servers) drives `scripts/run-collector.ts`, and the first
`data/snapshots/2026-09-05.json` is committed. `src/collector/` also
has a real, verified full registry crawl (`registry.ts`/`curate.ts`) —
see the Phase 2.5 log entry for the numbers. `tools.lock` writing
(`init`/`verify`/`update`) is Phase 3, still not started. See
`docs/spikes/phase-0.md` for Phase 0's spike notes and the Phase log
below for how each phase concluded.

## Phase log

- **Planning** (pre-Phase 0). A correction pass after review fixed
  cadence (daily during build, weekly only from Phase 6), prompt-schema
  hashing (previously undefined), and lock-schema version fields
  (`observedVersion` replacing a "pinned version" that would have made
  drift undetectable) — all specified in PLAN.md/DECISIONS.md before
  Phase 0 began.
- **Phase 0 (spikes) — complete.** 2026-09-05. Commit: `6a1d2ae`.
  Verified by: all 7 spikes have a documented pass/fallback outcome in
  `docs/spikes/phase-0.md`, matching Phase 0's own Definition of Done.
  Two findings forced real changes to the plan rather than just
  confirming it: token counting splits into two kept-apart bases plus a
  derived ratio (`canonicalTokens`/`wireTokens`/`schemaReuseRatio`,
  DECISIONS.md #5) instead of the original single count, and
  `github-mcp-server` was dropped as the auth-bucket promotion example
  (ships OCI/Docker-only, no npm package — DECISIONS.md #12) in favor of
  `sentry-mcp-server`. Everything else confirmed as designed, with minor
  corrections recorded in PLAN.md/DECISIONS.md #3/#6/#11 along the way.
  A granularity mismatch between the two token bases (caught on review,
  after this commit) is corrected in DECISIONS.md #5 directly rather than
  logged as a separate phase-log line.
- **Phase 1 (project skeleton + MCP client core) — complete.** 2026-09-05.
  Commit: `caecefa`. Verified by: `npm test` passes both integration
  tests (spawning `server-memory`, no prompts, and `server-everything`,
  with prompts — Phase 1's own Test plan); `toollock capture <pkg>` runs
  end to end against each with a clean exit and no lingering process;
  `npm run build` + a direct run of the compiled `dist/cli.js` both
  checked by hand. `package.json` pins `@modelcontextprotocol/sdk` to the
  exact `1.30.0` (DECISIONS.md #15).
  A field-scope mismatch in `schemaReuseRatio` (caught post-Phase-1,
  before Phase 2's implementation began — the ratio read meaningfully
  above 1.0 on three confirmed `$ref`-free servers, traced to
  `title`/`annotations`/`outputSchema`/`execution` fields counted in the
  numerator but never in `canonicalTokens`'s basis) is corrected in
  DECISIONS.md #5/#6 directly, with a `wireBasisTokens` field added and
  Notion's recorded ratio updated to 3.5152, rather than logged as a
  separate phase-log line.
- **Phase 2 (canonicalization + dual hashing + token counting) —
  complete.** 2026-09-05. Commits: `6ab9a4c` (canonicalization),
  `8d38855` (hashing), `4f8483a` (token counting). Verified by: `npm
  test` — 31 tests total, all passing, zero network/spawn required for
  the 29 new ones (Phase 2's own Test plan); golden fixtures prove every
  scenario in Phase 2's Definition of Done for both tools and prompts
  (description-only change moves `promptHash` and leaves `schemaHash`
  stable; a new optional param/argument moves `schemaHash`; reordering
  `enum`/`required` leaves it stable; hashing identical input twice is
  byte-identical); `npm run build` clean. `gpt-tokenizer` and
  `canonicalize` added as runtime dependencies (caret ranges — no
  documented reproducibility risk analogous to decision #15's SDK pin
  was found for either).
  A gap caught on review, after this phase's own commits: the in-memory
  determinism test proves the canonicalizer is a pure function of an
  object already in memory, not that two real spawns of the same server
  produce that same object — which is what `verify` (Phase 3) actually
  depends on. Closed by `scripts/check-hash-determinism.ts` (commit
  `0abb476`, kept out of `npm test` since it spawns real processes): two
  independent spawns each of `server-everything` (first-party) and
  `context7-mcp` (third-party), full pipeline, every tool/prompt hash
  compared — both PASS, no drift found. `npm run check:hash-determinism
  [pkg ...]` re-runs it against any package; worth another pass against
  `@notionhq/notion-mcp-server` before Phase 2.5, given its schema is the
  most structurally complex one measured so far.
- **Phase 2.5 (collector bootstrap) — complete.** 2026-09-05. Commits:
  `4749432`/`8a245c1`/`0b0a623`/`3adbc4e`/`142e68a` (build-out),
  `57f7529` (crawl verification, see below), `3a604d4` (first server
  snapshot), `6b6c989` (registry snapshot). Verified by: `npm test` — 47
  tests, all passing; the notion-mcp-server determinism pass flagged in
  Phase 2's log run for real (PASS, 24 tools, 0 prompts); `npm run
  collect` run for real against all 10 seed servers with a clean exit,
  producing `data/snapshots/2026-09-05.json`; `.github/workflows/
  collect.yml` pushed to `main` (`git push` succeeded, `5a8db4d..3a604d4`
  then the follow-up commits) — the cron is armed, though an actual
  unattended scheduled fire hasn't been observed yet (Phase 0 spike 6
  deliberately didn't chase this either; a real fire is the thing to
  check next, not a re-test of the mechanism).
  A real-scale finding, caught and verified before it reached the
  dataset: the full registry crawl initially climbed past 64,000 raw
  entries against an earlier ~50,000-entry partial check and a
  "4,000+ npm candidates" estimate from that same partial check — three
  unreconciled figures from one source. Verified rather than trusted:
  `fetchAllRegistryEntries` now tracks every cursor and throws on a
  repeat, takes a hard page cap, and `summarizeRegistry` reports
  distinct counts (`name@version`, and distinct names among `isLatest`
  entries) alongside the raw ones. The real, verified numbers
  (`data/registry/2026-09-05.json`): **92,004 raw entries across 921
  pages, distinctEntryKeys and distinctLatestNames both equal their raw
  counterparts exactly** — no pagination overlap, a genuinely large
  registry. **27,231 distinct servers, 8,186 npm-type**, and DECISIONS.md
  #17's curation bar takes that to **7,745 survivors** (35 fail to
  resolve, 0 fail recency, 406 fail the repository-link check). This is
  roughly two orders of magnitude past what Phase 5's "seed list
  expanded toward 50-60" (PLAN.md) seems to assume — recorded in
  DECISIONS.md #17/#18 as a finding for whoever scopes Phase 5's actual
  seed-expansion method, not resolved here. **v1's seed list stays
  Phase 0's 10 already-probed servers, by design, not by limitation** —
  see DECISIONS.md #18; a later session should not read the small
  number as unfinished work and expand it out of phase.

## Open threads

Resolution narrative for each Phase 0 spike lives in
`docs/spikes/phase-0.md`, not duplicated here — this section is only
what's genuinely still unresolved.

- `cost-drift` threshold (DECISIONS.md #16) is a stub default, pending
  real data from Phase 5.
- The `enforceStrictCapabilities` false-positive risk (a sloppily-declared
  server misclassified as `list-auth-required`) was checked for across
  Phase 0 spike 3's 10 candidates and not observed — stays open for the
  larger Phase 5 seed list, where it hasn't been ruled out.
- `collect.yml` is live and armed (pushed 2026-09-05), but an actual
  unattended `schedule` fire hasn't been observed yet — the first
  scheduled run is the thing to check next (`gh run list --workflow
  collect.yml`), not a re-test of the mechanism, which Phase 0 spike 6
  already confirmed via `workflow_dispatch` (identity, permissions
  override, scoped diff, non-cross-triggering all real). A related
  constraint to carry in: GitHub disables a public repo's scheduled
  workflow after 60 days with no new commits (DECISIONS.md #11) — inert
  during active development, but worth a line in Phase 2.5/6's
  operational notes once commit cadence drops to weekly.
- Phase 5's seed-list expansion needs its own selection method beyond
  DECISIONS.md #17's curation bar — the real npm-candidate pool is 8,186
  (7,745 survive curation), not the small number the "50-60 candidates"
  target seems to have assumed. Not designed here; flagged in
  DECISIONS.md #17/#18 for whoever scopes Phase 5.

## Do not retry

- `npx --loglevel info` / `--loglevel verbose` to read the resolved
  package version off stdout/stderr — never prints it in any parseable
  form (spike 7).
- npm's own debug log (`~/.npm/_logs/*-debug-0.log`) for the same — no
  usable version line on a cache-revalidated fetch (spike 7).
- A pre-spawn `npm view <pkg> version` call to learn `observedVersion`
  ahead of time — works, but superseded by reading the npx cache's
  `package.json` after the spawn: same answer, zero extra network
  round-trip (spike 7).
- `Client.listTools()`'s return value as the source for `wireTokens` —
  the SDK Zod-validates every message first, and Zod's `.parse()`
  rebuilds key order from its own schema shape, making the token count
  depend on `toollock`'s own SDK version rather than the target server
  (spike 5).
- Passing a literally empty `env: {}` to the auth probe to get a
  credential-free spawn — impossible through the public API:
  `StdioClientTransport` always merges `getDefaultEnvironment()`
  underneath whatever `env` is given, so `HOME`/`LOGNAME`/`PATH`/`SHELL`/
  `TERM`/`USER` survive regardless (spike 3).

Full detail on each is in `docs/spikes/phase-0.md`; this list exists so
a later session doesn't spend time re-discovering the same dead ends.
