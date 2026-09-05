# PLAN.md — @onetodone/toollock

Scope: a lockfile for MCP tool/prompt definitions. `tools/list` and
`prompts/list` output gets canonicalized, split into a structural hash and
a human-readable-text hash, token-counted, and committed to a `tools.lock`
file that CI can verify against on every run — the same shape as
`package-lock.json`, applied to the part of an MCP server that can change
silently between runs. See DECISIONS.md for the reasoning behind each
choice below, PROGRESS.md for current state.

## Verified against the SDK (not assumed)

Checked against `@modelcontextprotocol/sdk` tag `v1.29.0` on GitHub
(npm `dist-tags.latest` is `1.30.0`, same 1.x line; a `v2.0.0-beta.1` tag
exists upstream but is **not** npm-latest yet — tracked as a risk below):

- `Client.listTools()` / `Client.listPrompts()` exist, paginate via
  `nextCursor` (`docs/client.md`, `README.md`).
- `StdioClientTransport({ command, args, env?, stderr? })` spawns a child
  process with `stdio: ['pipe','pipe', stderr ?? 'inherit']` — stdout is
  reserved exclusively for JSON-RPC framing (`src/client/stdio.ts`).
- `Client.listPrompts()` **throws** if the server didn't declare the
  `prompts` capability at `initialize` — but only when the Client is
  constructed with `enforceStrictCapabilities: true`, which is **not**
  the default (`assertCapabilityForMethod`, `src/client/index.ts`, gated
  on `this._options?.enforceStrictCapabilities === true` in
  `shared/protocol.ts`). Without that flag, `listPrompts()` sends the
  request over the wire regardless of declared capabilities and surfaces
  whatever the server returns. Confirmed against `server-memory`
  (declares no `prompts` capability, Phase 0 spike 2,
  `docs/spikes/phase-0.md`): default construction round-trips over stdio
  and relays the server's own `-32601: Method not found`; constructing
  with `enforceStrictCapabilities: true` throws locally (`Server does not
  support prompts (required for prompts/list)`) before anything reaches
  the wire. The collector must construct the Client with
  `enforceStrictCapabilities: true` explicitly and still capability-check
  before calling — not rely on a server-returned `-32601` as the primary
  path, since that was never a guaranteed contract to begin with.
- `ToolSchema` (`src/types.ts`): `name`, `description?`, `inputSchema`
  (`{type:'object', properties?, required?}` + catchall), **`outputSchema?`**
  (same shape, optional — out of scope for v1, see below), `annotations?`
  (`title?, readOnlyHint?, destructiveHint?, idempotentHint?,
openWorldHint?`), `execution?` (`taskSupport?`), `_meta?`.
- `PromptSchema`: `name`, `description?`, `arguments?: {name, description?,
required?}[]`. `prompts/list` returns metadata only — rendering the
  actual prompt text requires `prompts/get` with arguments, which is out
  of scope.
- `gpt-tokenizer`: `o200k_base` is the default export, offline, no runtime
  download.
- RFC 8785 JCS: `canonicalize` npm package is the RFC's own listed
  reference implementation. JCS sorts object keys only — it does not
  reorder array contents, confirming the need for a custom pre-pass to
  sort `required[]`/`enum[]` before JCS serialization.

Verified via Phase 0 spikes (not left assumed — all 7 have an outcome in
`docs/spikes/phase-0.md`):

- ~~Whether `$ref` actually shows up in real-world MCP `inputSchema`
  output.~~ Resolved in spike 4: yes, in an OpenAPI-derived server (not a
  Zod one, as originally assumed) — zero cycles across the 24 real tools
  tested. See DECISIONS.md #3.
- ~~Real-world stdio hygiene (clean stdout, clean exit) of candidate seed
  servers~~ Resolved in spike 1: clean across all 5 real candidates
  tested. (Spike 3 later found a real hang under a different condition —
  `@stripe/mcp` on an invalid placeholder credential — which is why
  Phase 1's timeout+kill wrapper exists regardless of this result.)
- ~~Whether the actual npm version that `npx -y <pkg>` resolved for a
  given spawn is obtainable at all~~ Resolved in spike 7: yes, cheaply —
  read `version` from the resolved package's own `package.json` in the
  npx cache after the spawn, found by globbing on the known package name
  rather than a pre-resolution `npm view` query. See DECISIONS.md #6.

## Phase 0 — Spikes (~1.5 days)

Before any package scaffold. Seven concrete unknowns, each a go/no-go
before committing later phases to a design:

1. Stdio hygiene against 3–5 real candidate servers by hand (clean stdout,
   clean exit, no hangs).
2. Capability-gating empirically against one server that lacks `prompts`.
3. Auth-bucket probing, **plus sourcing the candidate list itself**: pick
   the public MCP directory/registry the seed list will be drawn from
   (closes the open question of where servers come from — this spike
   needs ~10 real candidates to test against anyway, so the choice is
   made here, not left as a loose thread). Confirm a probe run with no
   explicit env vars set cleanly splits enumeration outcomes into the
   four `list-*` buckets (`list-open` / `list-env-gated` /
   `list-auth-required` / `list-timeout`, DECISIONS.md #12) against those
   ~10 candidates, and confirm the placeholder-env promotion path works
   for a real npm-packaged auth-required server. (Originally targeted
   `github-mcp-server` itself; spike 3 found it ships only as an
   OCI/Docker image with no npm package, outside this collector's spawn
   model — `sentry-mcp-server` is the promotion example instead. See
   `docs/spikes/phase-0.md` and DECISIONS.md #12.)
4. Canonicalization against a real `$ref`-bearing schema (find one from a
   Zod-based server) — confirms inlining + cycle detection is tractable,
   or forces a scope-down (hash `$ref` as an opaque structural marker).
   (Spike 4 found the real example is OpenAPI-derived, not Zod-based —
   see `docs/spikes/phase-0.md`. Inlining/cycle-detection confirmed
   tractable, but the same data forced an open question for decision #5:
   whether token counting should use raw wire bytes or post-inline
   canonical bytes — they diverge by ~3.6x on the real example found.)
5. Token-count determinism: confirm `gpt-tokenizer` o200k is synchronous/
   offline, and fix the exact tokenized string for **both** of decision
   #5's bases (revised in Phase 0 spike 4, which found the two diverge by
   ~3.6x on a real server) — `canonicalTokens` (JCS-canonical bytes of
   `{name, description, inputSchema}` after `$ref` inlining, tied to the
   same bytes being hashed) and `wireTokens` (the raw `tools/list`
   response's `tools` array only, before any normalization — explicitly
   not the surrounding JSON-RPC envelope, since a client never loads RPC
   framing into context). Confirm `schemaReuseRatio = wireBasisTokens /
   canonicalTokens` is stable given the same fixed strings —
   `wireBasisTokens` being `wireTokens`'s own tee, scoped to just
   `{name, description, inputSchema}` so the ratio isn't polluted by
   non-schema fields (`title`, `annotations`, `outputSchema`,
   `execution`) that `canonicalTokens` never counted in the first place
   (corrected post-Phase-1, DECISIONS.md #5).
6. GitHub Actions bot-commit mechanics: a trivial no-op scheduled workflow
   that stages `data/`, commits as a bot identity, pushes, using only the
   automatic `GITHUB_TOKEN` and `permissions: contents: write`.
7. Version introspection: confirm whether the npm version `npx -y <pkg>`
   actually resolved is obtainable from (or alongside) the spawn. If not
   cheaply obtainable, decide the fallback (e.g. recording only
   `serverInfo.version` from `initialize`, with a documented gap) before
   Phase 3 designs the lock schema around it. (Confirmed obtainable —
   see `docs/spikes/phase-0.md` and DECISIONS.md #6; the fallback wasn't
   needed.)

**Deliverables:** a short written note per unknown (pass, or the scope-down
it forces). Throwaway spike scripts only, nothing production.
**Definition of done:** all seven have a documented outcome.
**Test:** manual — each spike runs against a real server/schema and either
confirms the assumption or documents the fallback it forces.

## Phase 1 — Project skeleton + MCP client core (~1.5 days)

**Deliverables:** npm package scaffold (`package.json` with an exact,
non-caret SDK version pin — see DECISIONS.md #15); `src/mcp/connect.ts`
(spawn + capability-checked connect — Client constructed with
`enforceStrictCapabilities: true` explicitly, not by relying on a
server-returned `-32601` for gating, see Phase 0 spike 2); a per-server
timeout+kill wrapper around every spawn, used by `connect.ts` and reused
by the Phase 2.5 collector rather than bolted on separately: 30s on
`connect()` (sized for a cold `npx -y` install with no local npm cache —
the actual condition on Phase 2.5's ephemeral runner, not this project's
warm-cache spike environment) and 15s per `list*` call after that,
SIGKILL on expiry. Not speculative hardening — spike 3 hit a real hang
(`@stripe/mcp`, which proxies `tools/list` to a live authenticated
endpoint and never completes `initialize` on a bad key). `src/mcp/
capture.ts` (paginated `tools/list` + guarded `prompts/list` → raw JSON) —
capture must independently tee the child process's raw stdout stream for
the `tools/list` response line, in parallel with (not instead of) the
SDK's own `Client.listTools()` call, and extract `result.tools` from that
untouched raw text. `Client.listTools()`'s return value is **not** a
valid source for `wireTokens`: every incoming message is Zod-validated
before the Client ever sees it, and Zod's `.parse()` rebuilds the object
following the SDK's own schema field order, not the server's original
key order — confirmed on a real server (Phase 0 spike 5) to change the
token count (17,500 raw vs. 17,476 SDK-reconstructed) for reasons that
have nothing to do with the target server. The tee has a failure mode
`listTools()` doesn't: a server that logs non-JSON-RPC noise to stdout
(spike 1 sampled 5 clean servers; a larger seed list will find one that
isn't) would have `wireTokens` silently tokenize that noise while the
SDK path fails loudly on the same response. So after computing
`wireTokens` from the tee, `capture.ts` verifies the teed bytes parse to
the same tool set the `Client` returned — same names, same count. On
mismatch, `wireTokens` is recorded as `null` with a reason, never a
best-effort number: a missing measurement is recoverable, a wrong one in
the published dataset is not. `toollock capture <server-spec>` CLI stub.
**Definition of done:** `capture` prints valid JSON for a real no-auth
reference server, and does not throw against a server with no `prompts`
capability.
**Test:** integration test spawning two real reference servers (one with
prompts, one without).

## Phase 2 — Canonicalization + dual hashing + token counting (~2 days)

**Deliverables:** `$ref` inlining with cycle detection — a detected cycle
is a hard capture failure for that tool, not a silent fallback
(DECISIONS.md #3/known limitations) — `required[]`/`enum[]` sort, JCS
wrapper, `schemaHash`/`promptHash` (sha256 of the split canonical bytes);
three token counters at matching per-tool granularity — `canonicalTokens`
(post-inline JCS bytes, hash-coupled), `wireTokens` (each tool's own raw
JSON, original key order, envelope and array framing excluded), and
`wireBasisTokens` (the same raw tee, scoped to just `{name, description,
inputSchema}`, no normalization) — plus a server-level `frameTokens`
(whole-array `wireTokens` minus the per-tool sum), `refCount` (total
`$ref` occurrences pre-inlining, a free byproduct of the inliner), and
the derived `schemaReuseRatio = sum(wireBasisTokens) /
sum(canonicalTokens)` (`frameTokens` excluded from the ratio;
`wireBasisTokens` rather than `wireTokens` as the numerator so the ratio
isn't polluted by non-schema fields `canonicalTokens` never counted —
checked against three `$ref`-free servers reading ~1.0 before Phase 2
began, DECISIONS.md #5), all on the fixed serializations from Phase 0
spike 5 (DECISIONS.md #5).

The `ToolSchema`/`PromptSchema` split is defined explicitly, not left
implicit:

|        | `schemaHash` (structure)                  | `promptHash` (text)                                    |
| ------ | ----------------------------------------- | ------------------------------------------------------ |
| Tool   | types, `required[]`, `enum[]`             | name, description, param descriptions, annotations     |
| Prompt | argument names, argument `required` flags | prompt name, prompt description, argument descriptions |

**Definition of done:** golden-fixture unit tests prove the exact
scenarios the design depends on, for both tools and prompts —
description-only change moves `promptHash` and leaves `schemaHash`
stable; a new optional param (tool) or argument (prompt) moves
`schemaHash`; reordering `enum`/`required` leaves the hash stable;
hashing identical input twice is byte-identical. Prompt fixtures mirror
the tool invariants: a description-only change on a prompt argument moves
`promptHash` and leaves `schemaHash` stable.
**Test:** `npm test`, no network/spawn required.

## Phase 2.5 — Collector bootstrap (~0.5 day, borrowed from Phase 5)

Deliberately pulled forward, before `tools.lock` even exists, so the
dataset starts accumulating real history around day 5 instead of day 11 —
time-series data can't be backfilled later.

**Deliverables:** seed list v1 — sourced from the official MCP registry
filtered to `registryType: npm` (recording how many registry entries
that filter excludes, a dataset finding in its own right, DECISIONS.md
#12), then the mechanical curation bar from DECISIONS.md #17
(npm-resolvable, published within 12 months, repository link present —
recording each criterion's drop count), then auto-probed via Phase 0
spike 3's method into the four `list-*` buckets (DECISIONS.md #12);
`.github/workflows/collect.yml` scheduled **daily**
(`cron: '0 6 * * *'`) for the remainder of the build window — not
weekly yet, see the cadence note below — zero configured secrets,
`permissions: contents: write` only, explicit `git add data/`; a snapshot
writer only — capture + canonicalize + hash + all three token counts
(`canonicalTokens`, `wireTokens`, `wireBasisTokens`) + `schemaReuseRatio`
per server,
appended to `data/` as a dated entry (DECISIONS.md #5). No drift
computation yet; the
commit message for this phase is `data: snapshot <ISO date> (<N>
servers)` — no drift count, no "weekly" (both are inaccurate right now).
**Definition of done:** one real scheduled (or `workflow_dispatch`-
triggered) run lands in the repo's own history, touching only `data/`.
**Test:** inspect the resulting commit's diff and author by hand.

**Cadence note:** the commit-message format decided in DECISIONS.md #13
says "weekly", but at weekly cadence a Phase 2.5 that starts around day 5
would produce exactly one snapshot by Phase 6 — defeating the reason it
was pulled forward. So collection runs **daily** from Phase 2.5 through
Phase 5, and only flips to weekly in Phase 6 as the last step before
publication (see Phase 6 below). The message format tracks the real
cadence at each point — it never claims "weekly" while running daily.

## Phase 3 — `tools.lock` + `init` / `verify` / `update` (~2.5 days)

**First publicly-demoable milestone** (see below).

**Deliverables:** lock schema (sorted keys, deterministic serialization so
a no-op re-run produces zero git diff); `init`; `verify` (drift classifier

- exit codes — fail on schema-breaking/prompt-drift, warn on
  schema-additive/cost-drift); `update` (diff shown, never silent, never
  auto-approved); README v1 quickstart.

Lock schema version fields, corrected from the original design: there is
no "pinned package version" — every spawn is `npx -y <pkg>`, which always
resolves whatever npm currently calls latest. Pinning it would make drift
undetectable (`verify` would re-spawn the identical artifact every time,
by construction). So the schema records what was _observed_, not what is
_pinned_:

- `serverInfo.version` — self-reported by the server in its `initialize`
  response. Unverifiable, but free.
- `observedVersion` — the actual npm package version `npx` resolved for
  that run, if Phase 0 spike 7 confirms it's obtainable; otherwise this
  field is dropped and the gap is documented instead of faked.

**Definition of done:** end-to-end against a real public server — `init`
→ hand-mutate a local fixture server's description → `verify` exits 1 and
names the changed hash class → `update` shows the diff and rewrites
cleanly. A no-op re-run of `init`/`verify` produces zero diff.
**Test:** scripted end-to-end covering the drift-then-fix loop and the
determinism no-op case.

## Phase 4 — Drift classifier polish + `budget` + CI usability (~1.5 days)

**Deliverables:** `toollock budget` (context-tax table built from
`wireTokens` — what a real client's context window actually pays,
DECISIONS.md #5 — sorted by token share, makes the "42k tokens" pitch
concrete for any server); classifier
edge cases (renamed vs. redescribed tool, `required[]` widened vs.
narrowed); example consumer workflow
(`.github/workflows/toollock-verify.yml.example`); DECISIONS.md polished
for public reading, including the Snyk Agent Scan / mcp-scan positioning
paragraph.
**Definition of done:** `budget` runs against a real server and prints a
sane table; the example workflow YAML parses/lints.
**Test:** manual run of `budget`; YAML lint on the example workflow.

## Phase 5 — Dataset layer completion: drift-over-time + seed expansion (~1 day)

Builds on Phase 2.5's already-running collector.

**Deliverables:** drift computation across consecutive snapshots (reusing
Phase 2's hash comparison); the commit-message format gains the drift
count — `data: snapshot <ISO date> (<N> servers, <M> drifted)` — **still
daily, still no "weekly"** (see Phase 2.5's cadence note; the flip to
weekly is a Phase 6 step, not this one); seed list expanded toward 50–60
candidates (all auto-probed `list-open` servers kept; up to 5
`list-auth-required` servers promoted to `list-env-gated` via the
timeboxed hand-research path, `sentry-mcp-server` first — see
DECISIONS.md #12); the bucket column, the `list-env-gated` caveat flag,
and `list-timeout` counts recorded per dataset entry.
**Definition of done:** a scheduled run's commit message shows a real,
non-placeholder drift count computed against the previous snapshot; the
seed list documents each server's bucket.
**Test:** trigger two consecutive runs (or replay two saved snapshots) and
confirm the drift count in the resulting commit message matches a hand
count of changed hashes.

## Phase 6 — Polish for a 10-second-to-2-minute reviewer pass (~1 day)

**Deliverables:** flip `collect.yml`'s cron from daily to weekly and
switch the commit message to `data: weekly snapshot <ISO date> (<N>
servers, <M> drifted)` — the last step before publication, logged as its
own line in PROGRESS.md's phase log entry for this phase (not folded
silently into "polish"); README rewrite (problem stated in the first 3
lines, a terminal recording of `verify` catching drift, the positioning
paragraph, a link into the live `data/` history as social proof,
including an explicit note that `observedVersion` reflects what `npx`
last resolved, not a pinned artifact — see DECISIONS.md #6/#9); `npm pack
--dry-run` inspected (not published); `package.json` metadata pass; final
DECISIONS.md/PROGRESS.md pass.
**Definition of done / test:** README read top-to-bottom in under 2
minutes by the clock; `npm pack --dry-run` tarball contents reviewed by
hand; `collect.yml`'s cron and commit-message format both confirmed
switched to weekly before the repo is pointed at anyone.

---

**Total: ~11.5 working days** against a 10–14 day budget — leaves slack
matching the risk table below.

## First thing worth showing publicly

End of **Phase 3** (`init`/`verify` against a real server, catching real
drift, in a diffable lockfile) is the first thing worth _demoing_.
**Phase 2.5** (day ~5) produces something worth _pointing at_ earlier — the
first real bot commit in the repo's own history, proof the moat mechanism
runs unattended before the CLI it measures is even finished.

## Cut-line

Strict order — what gets dropped first, second, third if the schedule
slips, and what the project still is after each cut:

1. **First cut:** Phase 6 extras beyond a plain README (terminal
   recording, `npm pack --dry-run` polish). Project is still fully
   functional without them.
2. **Second cut:** Phase 5's _drift-over-time polish_ — ship without the
   cross-snapshot drift count or the seed-list expansion past whatever
   Phase 2.5 already auto-probed. The scheduled workflow from Phase 2.5
   keeps running and `data/` keeps accumulating raw snapshots regardless;
   only the "M drifted" analysis on top is lost, not the historical
   evidence itself.
3. **Third cut:** Phase 4's `budget` command and example consumer
   workflow. The project keeps its core thesis (lockfile + drift
   classification via `init`/`verify`/`update`) but loses the secondary
   "make token cost visible" pitch.

**Never cut:** Phases 1, 2, 2.5, 3. Phase 2.5 is cheap (0.5 day) and
time-series data can't be backfilled — cutting it later doesn't save time,
it just throws away days of accumulated history the project needs by
Phase 6. Phases 1–3 are the core thesis; without capture →
canonicalize/hash → lockfile commands, there is no project.

## Risk table

| Risk                                                                                                          | Mitigation                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A server hangs on stdio, or (new failure mode from the raw-stdout tee, absent from the original risk) logs non-JSON-RPC noise to stdout that the tee would silently mistokenize | Phase 1's per-server timeout+kill (30s connect/15s per list call — spike 3 found a real hang, `@stripe/mcp`) plus the tee/`Client` cross-check that nulls `wireTokens` with a reason on mismatch rather than trusting corrupted tee bytes (spike 5, DECISIONS.md #5) |
| A schema `$ref` cycle turns up in a server outside Phase 0's tested sample (zero found across the one real `$ref`-bearing server tested, 24 tools) | Phase 2's cycle detector treats a detected cycle as a hard capture failure for that tool, not a silent opaque-marker fallback — consistent with never guessing at a structural hash; revisit if a real cyclic schema surfaces (DECISIONS.md #3/known limitations) |
| `list-env-gated` promotion research (`sentry-mcp-server` and up to 4 others) takes longer than timeboxed       | Hard timebox per server; a server that doesn't promote in time just stays `list-auth-required` — the bucket count absorbs the overrun, not the schedule |
| The collector's `schedule` trigger doesn't fire reliably unattended, or a lapsed workflow silently stops the dataset | Identity, permissions override, scoped diff, and non-cross-triggering all confirmed via `workflow_dispatch` against the real repo (Phase 0 spike 6); the schedule's actual unattended reliability is verified in Phase 2.5 itself, and GitHub's 60-day scheduled-workflow auto-disable on inactivity (DECISIONS.md #11) is documented as an operational constraint to watch once commit cadence drops to weekly |
| Non-determinism in JCS/token counts causes noisy no-op lockfile diffs — undermines the "human-diffable" pitch | Phase 2 fixture explicitly hash-twice-and-byte-compare                                                                                             |
| Scope creep polishing the security-scanner positioning comparison                                             | Cut-line protects this; one honest paragraph, not a feature matrix                                                                                 |
| `@modelcontextprotocol/sdk` v2 beta reaches npm `latest` mid-build                                            | Exact version pin in `package.json`, not a caret range                                                                                             |
| ~~The actual npm-resolved version of an `npx -y <pkg>` spawn turns out not to be cheaply obtainable~~ — resolved, was obtainable | Phase 0 spike 7 confirmed it before Phase 3 designed the lock schema: read from the npx cache's `package.json` after spawn, no fallback needed     |

## Considered and deferred

Not in scope for this plan, not silently folded into a phase above:

- `outputSchema` hashing/token-counting (structured tool output).
- Publishing to npm — Phase 6 produces a publish-ready tarball only.
- A hosted GitHub App / Marketplace Action — Phase 4 ships copy-paste
  YAML only.
- `resources/list` capture — original scope was tools + prompts only.
- Final `cost-drift` threshold tuning — ships with a stub default, marked
  TBD pending real dataset numbers.
- A `docker run`/OCI spawn path alongside `npx -y`, to let OCI-only
  servers like `github-mcp-server` be captured directly. Rejected in
  Phase 0 spike 3 (DECISIONS.md #12): a second transport carries a
  different security profile than the npx-only story decision #11's
  collector security write-up is built on, and scope discipline says no
  to a second transport for the sake of one headline example.
  `github-mcp-server`'s widely-cited ~42k-token figure is noted only as
  unverified third-party context in DECISIONS.md #12 — its trail
  dead-ends at a 404'd primary source, so it doesn't appear in the
  README. The README leads with `toollock`'s own byte-reproduced number
  instead (Phase 0 spike 5).
