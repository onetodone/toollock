# PROGRESS.md

## Current state

**Phase 2 is complete; Phase 2.5 is next.** `src/schema/` now has
canonicalization (`$ref` inlining + cycle detection + required[]/enum[]
sort + description-splitting), dual hashing (`schemaHash`/`promptHash`
for both tools and prompts), and token counting (`canonicalTokens`,
`wireTokens`, `wireBasisTokens`, `frameTokens`, `refCount`,
`schemaReuseRatio`) — all pure functions over `Tool`/`Prompt` plus the
raw wire tee, not yet wired into the CLI (`tools.lock` writing is
Phase 3). See `docs/spikes/phase-0.md` for Phase 0's spike notes and the
Phase log below for how each phase concluded.

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
