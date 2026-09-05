# PROGRESS.md

## Current state

**Phase 1 is complete; Phase 2 is next.** `src/mcp/connect.ts` and
`src/mcp/capture.ts` exist and are tested against two real reference
servers; `toollock capture <pkg>` runs end to end and prints raw JSON.
No canonicalization, hashing, or token counting yet — that's Phase 2.
See `docs/spikes/phase-0.md` for Phase 0's spike notes and the Phase log
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
- Whether the collector's `schedule` trigger fires reliably unattended is
  verified in Phase 2.5 against the real collector, not by Phase 0's
  throwaway workflow (see `docs/spikes/phase-0.md` spike 6). A related
  constraint to carry in: GitHub disables a public repo's scheduled
  workflow after 60 days with no new commits (DECISIONS.md #11) — inert
  during active development, but worth a line in Phase 2.5/6's
  operational notes once commit cadence drops to weekly.

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
