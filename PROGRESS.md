# PROGRESS.md

## Current state

Planning complete, including a correction pass after review: cadence
(daily during build, weekly only from Phase 6), prompt-schema hashing
(previously undefined), and lock-schema version fields (`observedVersion`
replacing a "pinned version" that would have made drift undetectable) are
now specified in PLAN.md/DECISIONS.md. No code has been written yet —
that starts in Phase 1. Phase 0 (spikes, 7 items): 7 of 7 have a
documented outcome, though spike 6 has one loose end (see below) before
its throwaway workflows get deleted. See `docs/spikes/phase-0.md` for
full spike notes.

## Phase log

(none yet — no phase has been completed)

## Open threads

- SDK exact-version pin (see DECISIONS.md #15) isn't set yet — no
  `package.json` exists. Set it when Phase 1 scaffolds the package; check
  `npm view @modelcontextprotocol/sdk dist-tags` at that time in case it's
  moved past `1.30.0`.
- `cost-drift` threshold (DECISIONS.md #16) is a stub default, pending
  real data from Phase 5.
- `observedVersion` is confirmed obtainable (Phase 0 spike 7): read
  `version` from the npx cache's `package.json` after spawn, found by
  globbing on the known package name. No fallback needed; DECISIONS.md
  #6 updated to state the mechanism directly instead of conditionally.
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
- Phase 0 spike 4's token-count fork is resolved (DECISIONS.md #5
  revised): both `canonicalTokens` (hash-coupled, `cost-drift` basis) and
  `wireTokens` (raw `tools/list` array, `budget`/`contextBudget` basis)
  are kept, plus a derived `schemaReuseRatio` recorded per server per
  snapshot. `$ref` appearing only in the OpenAPI-derived server tested,
  never the Zod/SDK-native ones, is now a line in DECISIONS.md #3.
- Phase 0 spike 5 done: both fixed strings confirmed deterministic across
  independent process spawns. Found and closed a real reproducibility
  hazard along the way — `Client.listTools()`'s return value is Zod-
  reconstructed and doesn't preserve the server's original key order, so
  `wireTokens` can't be sourced from it (measured a 24-token difference
  from reordering alone, on a real server). `capture.ts` (Phase 1) now
  has to independently tee the child process's raw stdout for the
  `tools/list` line, not just call `listTools()` — see PLAN.md's Phase 1
  deliverables and DECISIONS.md #5's exact-boundary note.
- **Spike 6, one item still open:** bot-commit identity, scoped diff,
  `permissions: contents: write` overriding the repo's read-only default,
  branch-protection status (none configured on `main`), and non-cross-
  triggering of other `on: push` workflows are all confirmed against the
  real repo (`onetodone/toollock`) via a `workflow_dispatch` run of a
  throwaway `spike6-collector-test.yml`. Not yet observed: whether the
  same workflow's `schedule: '*/15 * * * *'` trigger actually fires on
  its own — checked ~4 minutes after setup, before the first boundary
  passed; the plan itself expected this could take hours on a new
  workflow. Not blocking anything (the job `workflow_dispatch` ran is
  identical to what `schedule` would run), but the throwaway workflows
  (`spike6-collector-test.yml`, `spike6-push-listener-test.yml`) and the
  test commit they produced (`data/spike6-test/`) are still live in the
  repo pending that observation, and need deleting/reverting once
  resolved either way.

## Do not retry

(none yet — no attempts made this session beyond planning)
