# DECISIONS.md — @onetodone/toollock

One entry per decision. Each has a **Decision**, **Alternatives rejected**,
and **Why**. Entries 1–11 and 14–16 are stubs seeded from context already
gathered — the bullet points under "Why" are starting points, not finished
reasoning; expand them. Entries 12 and 13 were actually reasoned through
during planning, so they carry real content rather than stubs.

## 1. Stack

**Decision:** TypeScript/Node, `@modelcontextprotocol/sdk`, stdio
transport, spawn via `npx -y <pkg>`.

**Alternatives rejected:**

- Python + the Python MCP SDK.
- HTTP/SSE transport instead of stdio (would only cover remote servers,
  not the common local/npx-spawned case).

**Why:**

- (expand: why TS specifically for a portfolio piece — ecosystem fit with
  MCP tooling, npm distribution)
- (expand: why stdio-first — matches how most public MCP servers are
  actually consumed today)

## 2. Capture scope

**Decision:** capture both `tools/list` and `prompts/list`. Not
`resources/list`.

**Alternatives rejected:**

- Tools only.
- All three list endpoints (tools/prompts/resources).

**Why:**

- (expand: why prompts matter for the rug-pull story too, not just tools)
- (expand: why resources was excluded — scope discipline, or resources
  don't carry the same "executable prompt" risk)

## 3. Canonicalization

**Decision:** RFC 8785 (JCS) plus custom normalization before hashing:
inline `$ref`, sort `required[]` and `enum[]`, split descriptions out from
structure.

**Alternatives rejected:**

- Plain `JSON.stringify` with manual key sorting (no RFC backing, edge
  cases in number/string encoding).
- Hashing the raw JSON-RPC response verbatim (order-sensitive, noisy
  diffs on semantically-identical output).

**Why:**

- (expand: why JCS specifically over a hand-rolled canonicalizer)
- JCS sorts object keys only, not array contents — confirmed by reading
  the spec — which is exactly why the custom pre-pass for `required[]`/
  `enum[]` is necessary, not optional.

## 4. Dual hash, never one

**Decision:** `schemaHash` (structure only: types, required, enum,
descriptions excluded) and `promptHash` (human-readable text only: name,
description, parameter descriptions, annotations), computed and stored
separately.

**Alternatives rejected:**

- A single combined hash over the whole tool definition.

**Why:**

- Schema changes break compatibility; description changes alter model
  behavior and are the rug-pull surface. A combined hash conflates "added
  an optional parameter" with "appended an instruction to a description" —
  this was the stated reason for the split and is the core of the pitch.
- (expand: any cases where the split itself is ambiguous — e.g. does
  `annotations.title` belong in promptHash or somewhere else? Decided:
  promptHash, per the SDK's `ToolAnnotations` shape being entirely
  descriptive/hint fields.)

The split applies to `PromptSchema` too, not just `ToolSchema` — the
original design named `prompts/list` as in scope (#2) but never said how
a prompt's hash was divided. Defined in Phase 2:

- `schemaHash` (prompt): argument names + argument `required` flags.
- `promptHash` (prompt): prompt name, prompt description, argument
  descriptions.
  Golden fixtures mirror the tool invariants: a description-only change on
  a prompt argument moves `promptHash` and leaves `schemaHash` stable.

## 5. Token counting

**Decision:** `gpt-tokenizer` (o200k), offline, serializing `{name,
description, inputSchema}`. Absolute numbers are tokenizer-dependent; only
relative ratios are claimed.

**Alternatives rejected:**

- Calling a real tokenizer API at runtime (adds a network dependency and
  breaks offline/CI use).
- A different encoding (cl100k) or a rough character-count heuristic.

**Why:**

- (expand: why o200k specifically — matches current-generation model
  tokenizers, is the gpt-tokenizer default)
- Fixed to tokenize the _canonical_ (JCS) bytes of the serialized object,
  not a fresh `JSON.stringify` — otherwise the reported count isn't tied
  to the same bytes being hashed, and would drift with formatting.

## 6. `tools.lock` format

**Decision:** JSON, sorted keys, human-diffable in a PR. Stores server id,
transport, both hashes, per-tool token counts, a total `contextBudget`,
and version information — but **not** a pinned package version (corrected
during planning, see below). Instead:

- `serverInfo.version` — self-reported by the server in its `initialize`
  response. Free to capture, unverifiable.
- `observedVersion` — the npm package version `npx` actually resolved for
  that run, if Phase 0 spike 7 confirms this is obtainable; otherwise
  omitted and the gap is documented rather than faked.

**Alternatives rejected:**

- YAML (less universally diffable in GitHub's PR UI for this use case).
- A binary or compressed format (defeats the "readable in a PR diff" goal).
- A "pinned package version" field, as originally drafted — rejected
  because the tool spawns via `npx -y <pkg>`, which always resolves
  whatever npm currently calls latest. Storing a "pin" would misdescribe
  what the field actually is, and pinning the _spawn itself_ to an exact
  version would make drift undetectable — `verify` would re-spawn the
  identical artifact every run, by construction. The field's job is to
  record what was last observed, not to control what gets installed.

**Why:**

- (expand: why this mirrors `package-lock.json`/`Gemfile.lock` conventions
  deliberately — familiarity is part of the pitch)
- Deterministic serialization (sorted keys, stable formatting) is required
  so a no-op re-run of `init` produces zero git diff — otherwise the
  lockfile itself becomes a source of noise.
- **This is where the package-lock analogy breaks**, and the README says
  so rather than leaving a reviewer to find the gap: `package-lock.json`
  pins a version and _installs_ exactly that artifact on every run;
  `toollock` cannot do that without defeating its own purpose, so it
  records what it _observed_ and re-checks that against what it sees
  next time. Same shape (a committed, diffable lockfile), different
  mechanism underneath. See #9.

## 7. Drift classifier + per-class policy

**Decision:**

- `schema-breaking` (tool removed, type changed, required widened) → fail
- `schema-additive` (new tool, new optional param) → warn
- `prompt-drift` (description text changed) → fail
- `cost-drift` (token growth over threshold) → warn

**Alternatives rejected:**

- A single pass/fail signal with no classes.
- Making all drift classes fail (too strict — would break on every
  legitimate additive change).

**Why:**

- (expand: why prompt-drift fails rather than warns — this is the
  rug-pull surface, so silence is the wrong default)
- (expand: the exact `cost-drift` threshold — currently a stub, see #16)

## 8. Commands

**Decision:** `init`, `verify` (exit 1 on drift), `update` (accept with
diff shown), `budget` (context tax table).

**Alternatives rejected:**

- A single combined command with flags instead of subcommands.

**Why:**

- (expand: why this mirrors the init/verify/update shape from other
  lockfile tools users already know)

## 9. Positioning

**Decision:** this is a lockfile mechanism, not a security scanner. It
never judges intent; it makes change visible and requires explicit
approval. Snyk Agent Scan (formerly Invariant Labs mcp-scan) overlaps
partially — the README acknowledges this openly rather than hiding it.

**Alternatives rejected:**

- Marketing this as a security/threat-detection tool.
- Ignoring the overlap with existing scanners.

**Why:**

- (expand: why "lockfile" is the more defensible and more differentiated
  frame — scanners judge intent and can be wrong; a lockfile just tracks
  change, which is a narrower and more honest claim)
- (expand: what specifically Snyk Agent Scan/mcp-scan does that this
  doesn't, and vice versa, for the README's honest-comparison paragraph)
- Part of positioning this honestly is naming where the `package-lock`
  analogy itself breaks (see #6): a real lockfile pins and installs a
  fixed artifact; `toollock` can't, because pinning the spawn would make
  drift undetectable. State this plainly in the README (Phase 6) rather
  than letting a reader assume `toollock` behaves like `npm ci`.

## 10. Dataset layer as the moat

**Decision:** a scheduled GitHub Actions workflow runs the core against a
seed list of public MCP servers and commits results to `data/` as a
versioned time series. The CLI is cloneable in a weekend; the history is
not.

**Alternatives rejected:**

- No dataset layer — ship the CLI alone.
- A dataset generated once, not continuously updated.

**Why:**

- (expand: why accumulated time-series history is a harder-to-fake signal
  of engineering judgment than a well-written README)
- Sequencing note: the collector was deliberately pulled forward to Phase
  2.5 (before `tools.lock` even exists) specifically because this data
  can't be backfilled — every day it isn't running is lost history.

## 11. Collector security

**Decision:** the collector executes arbitrary npm packages. Ephemeral
GitHub Actions runner only, zero secrets in the environment,
`permissions: contents: write` and nothing else.

**Alternatives rejected:**

- Running the collector on a persistent self-hosted runner.
- Granting broader workflow permissions "to be safe."

**Why:**

- (expand: why ephemeral + minimal permissions is the correct default
  when the workflow's whole job is to spawn untrusted third-party code)
- This constraint is what forced decision #12 below — auth-gated servers
  can't use real credentials under this model, full stop.

## 12. Auth-gated server handling (resolved this session)

**Decision:** two-stage, mostly-automatic classification.

- **Stage one (automatic, zero research):** probe every seed candidate
  with an empty environment. Success → bucket `no-auth`. Failure → bucket
  `auth-required`, kept in the seed list with no measurements. The count
  of servers stuck in this bucket is itself a dataset finding — the
  fraction of the public registry that can't be audited without
  credentials — not an error to hide.
- **Stage two (manual, timeboxed):** applies only to a shortlist of ≤5
  high-value `auth-required` servers (`github-mcp-server` first).
  Hand-source that server's real required env var _names_ from its docs,
  set them to placeholder values, and retest. Success promotes it to
  bucket `env-gated` — placeholders aren't credentials, so the zero-secrets
  guarantee still holds. It joins the dataset with a caveat flag: its real
  tool list could vary by credential scope from what the placeholder probe
  saw.

**Alternatives rejected:**

- Excluding all auth-gated servers from the dataset entirely (loses the
  headline `github-mcp-server` example from the real, committed dataset —
  it would only ever be a manual README demo).
- Adding real scoped CI secrets for a small allowlist of servers (breaks
  the zero-secrets guarantee; the security write-up would need to become
  "no secrets except an explicit allowlist," a weaker and harder-to-defend
  claim).
- Fully manual per-server env-var research for the whole seed list (not
  feasible at 50–60 candidates in the time budget — only the split at
  scale needed to be automatic).

**Why:** the empty-env/placeholder-env split needs zero manual research
and scales to a large seed list; only the promotion step needs hand
research, and capping that at 5 servers keeps it inside the time budget
while still capturing the pitch's own headline example.

## 13. Dataset repo location and commit convention (resolved this session)

**Decision:** the dataset lives in the same repo as the CLI (`toollock`),
not a separate repo. Automated commits are bot-authored and enforced —
not just conventioned — to touch only `data/`:

- The scheduled workflow stages exclusively via `git add data/`, never a
  broad `git add -A`, enforced in the workflow YAML itself.
- Commit messages follow a fixed, boring format — but **not from day
  one**: the cadence is phased, corrected during planning (see below).

**Cadence, corrected during planning:** the message format below was
originally specified as fixed from the start of collection. That's wrong
at the cadence the plan implies: Phase 2.5 (the collector bootstrap) was
deliberately pulled forward to roughly day 5 specifically so the dataset
would have time to accumulate — but at _weekly_ cadence, day 5 through
publication yields exactly one snapshot, which defeats the reason it was
moved. So collection runs **daily** through the build window and only
flips to weekly in Phase 6, immediately before publication:

- Phase 2.5: daily (`cron: '0 6 * * *'`), `data: snapshot <ISO date>
(<N> servers)` — no drift count yet, no "weekly".
- Phase 5: still daily, drift count added — `data: snapshot <ISO date>
(<N> servers, <M> drifted)` — still no "weekly".
- Phase 6: cron flips to weekly, message becomes `data: weekly snapshot
<ISO date> (<N> servers, <M> drifted)` — the last step before
  publication, logged as its own PROGRESS.md phase-log line.

**Alternatives rejected:**

- A separate `toollock-data` repo linked from the README (keeps the
  primary repo's history 100% hand-authored, but a reviewer has to follow
  a link to see the moat evidence at all, and it's a second repo to
  maintain in the same 10–14 day window).
- Committing to `data/` by convention only, without a path restriction
  enforced in the workflow.
- Weekly cadence from the start (rejected once the day-5-to-day-11 math
  was checked — see cadence note above).

**Why:** a single repo means the reviewer who already opened it can see
the mechanism running without leaving the page; a distinct bot author
lets `git log --author` cleanly separate hand-written commits from
automated snapshots, so the two goals (clean human history, visible
automation) don't actually conflict. Putting the drift count in the
commit message means the commit log itself becomes a readable result —
nobody has to open a file to see the mechanism working. Daily-then-weekly
cadence exists so the accumulated history is actually substantial by the
time anyone sees it, rather than one lonely commit.

## 14. `outputSchema` excluded from v1

**Decision:** the SDK's optional `Tool.outputSchema` field (structured
tool output) is not part of `schemaHash`, `promptHash`, or the token
count in v1.

**Alternatives rejected:**

- Including it in `schemaHash` alongside `inputSchema`.

**Why:** surfaced during SDK verification, not in the original design.
Deferred rather than silently dropped — see known limitations below.
(expand: whether this should be a v1.1 addition once structured tool
output sees wider adoption)

## 15. Exact SDK version pin

**Decision:** pin `@modelcontextprotocol/sdk` to an exact version in
`package.json`, not a caret range.

**Alternatives rejected:**

- A caret range (`^1.30.0`), the npm default.

**Why:** a `v2.0.0-beta.1` exists upstream on GitHub and is not yet npm
`latest`, but could become so mid-build. A caret range risks an API shift
under the plan's feet during the 10–14 day window; an exact pin doesn't.

## 16. `cost-drift` threshold

**Decision:** ships with a stub default (e.g. warn at +15% token growth
on a tool, or +10% on total context budget), explicitly flagged
TBD-pending-real-data.

**Alternatives rejected:**

- Inventing a "final" threshold now with no real data to justify it.

**Why:** Phase 5's dataset provides real token-growth distributions across
many servers over time; tuning before that data exists would be a guess
dressed up as a decision. (expand once Phase 5 has run: what the actual
threshold ends up being, and why)

## Known limitations

- A legitimate upstream server version bump can trigger `prompt-drift`
  (rewritten descriptions with no behavior change) exactly the same way a
  malicious rug-pull would. **Mitigation:** `toollock update` shows the
  full diff for human review; nothing ever auto-approves. This is
  unavoidable by design — the tool can't distinguish intent, only change.
- An env-gated server's enumerated tool list could in principle differ by
  real credential scope from what the placeholder-value probe saw.
  **Mitigation:** env-gated dataset entries carry a caveat flag and are
  never presented as equivalent to a fully no-auth measurement.
- `outputSchema` (structured tool output) is invisible to this tool in v1
  — a server could rug-pull its output contract undetected. **Mitigation:**
  documented explicitly as out of scope (decision #14), not silently
  dropped; a candidate for a later version.
- `$ref` inlining assumes non-pathological schemas. **Mitigation:** deeply
  cyclic or externally-referenced schemas fall back to hashing the `$ref`
  as an opaque structural marker rather than full inlining — a coarser
  signal than full structural hashing, documented in PLAN.md's risk table.
