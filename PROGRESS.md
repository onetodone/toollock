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
- Phase 0 spike 3 done; two threads it opened are unresolved:
  - **Decision needed before Phase 2.5:** `github-mcp-server`, the
    plan's named headline promotion example, ships only as an OCI/Docker
    image — no npm package exists, so `npx -y <pkg>` can't spawn it at
    all, independent of auth. Three options recorded in
    `docs/spikes/phase-0.md` spike 3 (add a `docker run` spawn path;
    substitute a different headline example — `brave-search` and
    `sentry-mcp-server` both confirmed to promote cleanly with a
    placeholder env var; or keep it seed-listed under a new
    `unsupported-transport` bucket). Not resolved — needs a call.
  - **Naming question for DECISIONS.md #12:** the empty-env probe
    correctly measures "is the schema capturable without credentials,"
    but two real servers requiring accounts to operate (Notion, Linear)
    hand out their full tool list with zero env vars set — auth is
    enforced at `tools/call`, not `tools/list`. Both land in the
    `no-auth` bucket as currently named, which overclaims. Not renamed
    unilaterally — recorded in spike 3 for a decision.
  - The `enforceStrictCapabilities` false-positive risk itself (a sloppy
    server misclassified as `auth-required`) was checked for across all
    10 spike-3 candidates and not observed — stays open for the larger
    Phase 5 seed list, where it hasn't been ruled out.

## Do not retry

(none yet — no attempts made this session beyond planning)
