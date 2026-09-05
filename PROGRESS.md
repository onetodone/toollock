# PROGRESS.md

## Current state

Planning complete, including a correction pass after review: cadence
(daily during build, weekly only from Phase 6), prompt-schema hashing
(previously undefined), and lock-schema version fields (`observedVersion`
replacing a "pinned version" that would have made drift undetectable) are
now specified in PLAN.md/DECISIONS.md. No code has been written yet —
that starts in Phase 1. Phase 0 (spikes, 7 items) is in progress: 5 of 7
done (stdio hygiene, capability gating, auth-bucket probing, `$ref`
canonicalization, token-count determinism); spikes 6 (GitHub Actions
bot-commit mechanics) and 7 (version introspection) remain. See
`docs/spikes/phase-0.md` for full spike notes.

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

## Do not retry

(none yet — no attempts made this session beyond planning)
