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
- Phase 0 spike 3, in progress: probing ~10 real candidates for the
  no-auth/auth-required split must also watch for a false positive
  introduced by spike 2's finding — `enforceStrictCapabilities: true`
  gates every method, not just `prompts/list`, so a server with sloppily
  declared capabilities could throw locally on `tools/list` and get
  misclassified as `auth-required` when the real cause is unrelated to
  auth. See `docs/spikes/phase-0.md` spike 2.

## Do not retry

(none yet — no attempts made this session beyond planning)
