# PROGRESS.md

## Current state

Planning complete, including a correction pass after review: cadence
(daily during build, weekly only from Phase 6), prompt-schema hashing
(previously undefined), and lock-schema version fields (`observedVersion`
replacing a "pinned version" that would have made drift undetectable) are
now specified in PLAN.md/DECISIONS.md. No code has been written yet —
that starts in Phase 1. Phase 0 (spikes, 7 items) is complete: all 7 have
a documented outcome, no open loose ends. See `docs/spikes/phase-0.md`
for full spike notes.

## Phase log

- **Phase 0 (spikes) — complete.** All 7 unknowns have a documented
  outcome in `docs/spikes/phase-0.md`. Two findings forced real changes
  to the plan rather than just confirming it: token counting splits into
  two kept-apart bases (`canonicalTokens`/`wireTokens`/`schemaReuseRatio`,
  DECISIONS.md #5) instead of the original single count, and
  `github-mcp-server` was dropped as the auth-bucket promotion example
  (ships OCI/Docker-only, no npm package — DECISIONS.md #12) in favor of
  `sentry-mcp-server`. Everything else confirmed as designed, with minor
  corrections recorded in PLAN.md/DECISIONS.md #3/#6 along the way.

## Open threads

Resolution narrative for each Phase 0 spike lives in
`docs/spikes/phase-0.md`, not duplicated here — this section is only
what's genuinely still unresolved.

- SDK exact-version pin (see DECISIONS.md #15) isn't set yet — no
  `package.json` exists. Set it when Phase 1 scaffolds the package; check
  `npm view @modelcontextprotocol/sdk dist-tags` at that time in case it's
  moved past `1.30.0`.
- `cost-drift` threshold (DECISIONS.md #16) is a stub default, pending
  real data from Phase 5.
- The `enforceStrictCapabilities` false-positive risk (a sloppily-declared
  server misclassified as `list-auth-required`) was checked for across
  Phase 0 spike 3's 10 candidates and not observed — stays open for the
  larger Phase 5 seed list, where it hasn't been ruled out.
- The README's ~42k-token `github-mcp-server` citation traces to a
  secondary aggregator (getunblocked.com); the primary source it names
  (a dev.to post) 404s as of 2026-09-05 and couldn't be independently
  verified. Flagged in case a stronger primary citation surfaces later —
  not blocking, since the README already attributes it as a third-party
  number, not a `toollock` measurement.
- Whether the collector's `schedule` trigger fires reliably unattended is
  verified in Phase 2.5 against the real collector, not by Phase 0's
  throwaway workflow (see `docs/spikes/phase-0.md` spike 6). A related
  constraint to carry in: GitHub disables a public repo's scheduled
  workflow after 60 days with no new commits (DECISIONS.md #11) — inert
  during active development, but worth a line in Phase 2.5/6's
  operational notes once commit cadence drops to weekly.

## Do not retry

(none yet — no attempts made this session beyond planning)
