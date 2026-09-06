# PROGRESS.md

## Current state

**Phase 4 is complete; Phase 5 is next.** `toollock init`/`verify`/
`update` are real and working end to end: `init` captures a server and
writes `tools.lock` (sorted keys, deterministic — a no-op re-run is
byte-identical); `verify` re-captures and classifies drift into
DECISIONS.md #7's four classes, exiting 1 on schema-breaking/
prompt-drift and never writing the file; `update` shows the same
findings and rewrites. Phase 4 added `toollock budget` (the context-tax
table, built from `wireTokens` — proven against
`@notionhq/notion-mcp-server` at 17,500 wire tokens / schemaReuseRatio
3.52, byte-matching the README headline), hardened the drift classifier
(rename detection, `enum` widening/narrowing, `annotations` drift — the
last closing a DECISIONS.md Known-limitation gap), shipped
`.github/workflows/toollock-verify.yml.example` with a YAML lint test,
and gave DECISIONS.md #1/#2/#4/#8/#9 their real reasoning (the Snyk
Agent Scan / mcp-scan positioning paragraph included). The first
unattended scheduled collector run also fired during this phase
(2026-09-06, commit `7d99cd3`). Phase 5 owns drift-over-time across
snapshots and seed-list expansion. See `docs/spikes/phase-0.md` for
Phase 0's spike notes and the Phase log below for how each phase
concluded.

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
  Three documentation-only findings recorded before Phase 3 (commit
  `53c3471`): the curation bar passes 95% of npm candidates (7,745 of
  8,186) despite spike 3's visibly noisy long tail — a real result about
  this ecosystem's metadata, not a bug in the filter (DECISIONS.md #17);
  the README now states the ~70%-of-the-registry blind spot explicitly
  rather than leaving a reviewer to compute it; PLAN.md's Phase 5 section
  now requires its selection method to be named, since 50-60 is ~0.8% of
  the real 7,745-server survivor pool, not most of it.
- **Phase 3 (`tools.lock` + `init`/`verify`/`update`) — complete.**
  2026-09-05. Commits: `f485117` (schema + `observedVersion`), `393666a`
  (`buildLockedServer`), `95c22eb` (drift classifier), `382ae1e` (fixture
  server), `fc2a723` (commands + end-to-end test), `9961243` (CLI
  wiring), `cd09c62` (README), `b3e4fce` (DECISIONS.md #19). Verified by:
  `npm test` — 80 tests, all passing, including a real spawned-process
  end-to-end test (`src/lock/e2e.test.ts`) that runs Phase 3's actual
  Definition of Done against a local fixture server (never npx, no
  network): `init` → mutate the fixture's description → `verify` exits 1
  naming `prompt-drift` specifically → `update` shows it and rewrites →
  re-`verify` is clean — plus the equally load-bearing zero-diff case,
  checked directly rather than assumed (a no-op re-run of `init`
  produces a byte-identical `tools.lock`, and `verify` never writes to
  the file on either a clean or a failing run). Also manually
  smoke-tested against a real npm package end to end via the built CLI.
  A real classifier bug found and fixed by that same end-to-end test
  before it shipped: `promptHash` equality can't drive `prompt-drift`
  detection, because `promptHash`'s payload includes every property's
  description — including ones that exist on only one side of a
  comparison — so a brand-new optional property (schema-additive) was
  getting double-counted as prompt-drift too, turning a warn-only change
  into a failing `verify`. Fixed by comparing stored description text
  directly, only for properties/arguments present on both sides
  (DECISIONS.md #19); `annotations` aren't tracked in `tools.lock` at
  all yet, a real remaining gap recorded in Known limitations, not
  silently left for someone to discover.

- **Phase 4 (drift classifier polish + `budget` + CI usability) —
  complete.** 2026-09-06. Commits: `19bab93` (classifier edge cases —
  rename detection, `enum` drift, `annotations`), `e428b7a` (`toollock
  budget`), `6506083` (example consumer workflow + YAML lint test),
  `705171e` (DECISIONS.md #1/#2/#4/#8/#9). Verified by: `npm test` — 100
  tests, all passing (up from 80 at Phase 3's close; +20 covering the
  new classifier cases, `budget`'s formatting, both workflow files
  parsing under the `yaml` package, and two new spawned-fixture e2e
  cases — a real rename and a real `budget` run); `budget` run for real
  via the built CLI against `@notionhq/notion-mcp-server` (24 tools,
  **17,500 wire tokens — byte-identical to the README's headline and
  DECISIONS.md #5's figures**, `schemaReuseRatio` 3.52, 152 `$ref`s) and
  `@modelcontextprotocol/server-everything` (13 tools, 1,708), each
  printing a sane sorted table — Phase 4's own Definition of Done.
  `required[]` widened-vs-narrowed (a PLAN.md Phase 4 named case) turned
  out to have been fully handled in Phase 3 already — Phase 4 added
  explicit tests for it, not new code. The `annotations` gap DECISIONS.md
  flagged for "Phase 4's classifier-edge-case pass" is closed:
  `LockedTool` gained an `annotations` field, populated by `build.ts`,
  compared (JCS, so key-order isn't drift) by the classifier as
  `prompt-drift`. One layout bug caught in a visual check before the
  `budget` commit, not after: the `(framing)` row misaligned whenever its
  label was wider than the tool-name column — fixed by folding the
  literal row labels into the column-width computation rather than
  sizing on tool names alone.
  Also during this phase, unrelated to its deliverables: the first
  unattended `schedule`-triggered collector run fired
  (`gh run` `34027191061`, 2026-09-06T10:21Z — ~4h after the `0 6 * * *`
  cron slot, GitHub's usual scheduled-queue lag), committing `7d99cd3`
  "data: snapshot 2026-09-06 (10 servers)" touching only `data/`. Phase 4
  work was rebased onto it. This resolves the Phase 2.5 open thread below.

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
- ~~`collect.yml`'s first unattended `schedule` fire hasn't been observed
  yet.~~ **Observed 2026-09-06** (run `34027191061`, commit `7d99cd3`,
  scoped to `data/`, bot identity — all as designed). The mechanism is
  now proven both ways (spike 6's `workflow_dispatch` and this real
  scheduled run). Still to carry forward: GitHub disables a public repo's
  scheduled workflow after 60 days with no new commits (DECISIONS.md #11)
  — inert during active development, but worth a line in Phase 6's
  operational notes once commit cadence drops to weekly and the
  collector's own commits are the only thing resetting that timer.
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
