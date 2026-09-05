# PROGRESS.md

## Current state

Planning complete, including a correction pass after review: cadence
(daily during build, weekly only from Phase 6), prompt-schema hashing
(previously undefined), and lock-schema version fields (`observedVersion`
replacing a "pinned version" that would have made drift undetectable) are
now specified in PLAN.md/DECISIONS.md. No code has been written and the
repo is not yet a git repository — that happens in Phase 1. Phase 0
(spikes, now 7 items) is next.

## Phase log

(none yet — no phase has been completed)

## Open threads

- SDK exact-version pin (see DECISIONS.md #15) isn't set yet — no
  `package.json` exists. Set it when Phase 1 scaffolds the package; check
  `npm view @modelcontextprotocol/sdk dist-tags` at that time in case it's
  moved past `1.30.0`.
- `cost-drift` threshold (DECISIONS.md #16) is a stub default, pending
  real data from Phase 5.
- Whether `observedVersion` (the npm version `npx` actually resolved) is
  obtainable at all is unresolved — Phase 0 spike 7. If it isn't,
  `tools.lock` drops that field and `serverInfo.version` is the only
  version data recorded.
- Phase 0 spike 3's two forks are resolved (DECISIONS.md #12 revised,
  #17 added; PLAN.md updated throughout): `sentry-mcp-server` replaces
  `github-mcp-server` as the headline `list-env-gated` promotion example;
  a `docker run`/OCI spawn path is explicitly rejected (PLAN.md's
  "Considered and deferred"); buckets renamed `list-open` /
  `list-env-gated` / `list-auth-required` / `list-timeout` to make clear
  they classify `tools/list` enumeration, not `tools/call` authentication;
  a new mechanical seed-curation bar (DECISIONS.md #17) is decided.
  Remaining open items from that work:
  - The `enforceStrictCapabilities` false-positive risk itself (a sloppy
    server misclassified as `list-auth-required` instead of just
    badly-declared) was checked for across all 10 spike-3 candidates and
    not observed — stays open for the larger Phase 5 seed list, where it
    hasn't been ruled out.
  - The README's ~42k-token `github-mcp-server` citation traces to a
    secondary aggregator (getunblocked.com); the primary source it names
    (a dev.to post) 404s as of 2026-09-05 and couldn't be independently
    verified. Flagged in case a stronger primary citation surfaces later
    — not blocking, since the README already attributes it as a
    third-party number, not a `toollock` measurement.

## Do not retry

(none yet — no attempts made this session beyond planning)
