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

Unverified — explicitly a Phase 0 spike, not assumed:

- Whether `$ref` actually shows up in real-world MCP `inputSchema` output.
- Whether `github-mcp-server` responds to `tools/list` with placeholder
  env vars, or validates credentials first.
- Real-world stdio hygiene (clean stdout, clean exit) of candidate seed
  servers — the SDK's contract is clear, third-party packages don't
  always honor it.
- Whether the actual npm version that `npx -y <pkg>` resolved for a given
  spawn is obtainable at all (e.g. via a pre-resolution `npm view <pkg>
version` call, or inspecting the npx cache) — needed to populate
  `tools.lock`'s `observedVersion` field (see Phase 3, DECISIONS.md #6).

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
   made here, not left as a loose thread). Confirm an empty-environment
   probe cleanly splits `no-auth` from `auth-required` against those ~10
   candidates, and confirm the promotion path (hand-sourced env var names
   - placeholder values) works for `github-mcp-server` itself.
4. Canonicalization against a real `$ref`-bearing schema (find one from a
   Zod-based server) — confirms inlining + cycle detection is tractable,
   or forces a scope-down (hash `$ref` as an opaque structural marker).
5. Token-count determinism: confirm `gpt-tokenizer` o200k is synchronous/
   offline, and fix the exact tokenized string — JCS-canonical bytes of
   `{name, description, inputSchema}`, not a fresh `JSON.stringify`, so
   the reported number is tied to the same bytes being hashed.
6. GitHub Actions bot-commit mechanics: a trivial no-op scheduled workflow
   that stages `data/`, commits as a bot identity, pushes, using only the
   automatic `GITHUB_TOKEN` and `permissions: contents: write`.
7. Version introspection: confirm whether the npm version `npx -y <pkg>`
   actually resolved is obtainable from (or alongside) the spawn. If not
   cheaply obtainable, decide the fallback (e.g. recording only
   `serverInfo.version` from `initialize`, with a documented gap) before
   Phase 3 designs the lock schema around it.

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
server-returned `-32601` for gating, see Phase 0 spike 2); `src/mcp/
capture.ts` (paginated `tools/list` + guarded `prompts/list` → raw JSON);
`toollock capture <server-spec>` CLI stub.
**Definition of done:** `capture` prints valid JSON for a real no-auth
reference server, and does not throw against a server with no `prompts`
capability.
**Test:** integration test spawning two real reference servers (one with
prompts, one without).

## Phase 2 — Canonicalization + dual hashing + token counting (~2 days)

**Deliverables:** `$ref` inlining with cycle detection, `required[]`/
`enum[]` sort, JCS wrapper, `schemaHash`/`promptHash` (sha256 of the split
canonical bytes), token counter on the fixed serialization from Phase 0
spike 5.

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

**Deliverables:** seed list v1 (sourced and auto-probed via Phase 0 spike
3's method); `.github/workflows/collect.yml` scheduled **daily**
(`cron: '0 6 * * *'`) for the remainder of the build window — not
weekly yet, see the cadence note below — zero configured secrets,
`permissions: contents: write` only, explicit `git add data/`; a snapshot
writer only — capture + canonicalize + hash + token count per server,
appended to `data/` as a dated entry. No drift computation yet; the
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

**Deliverables:** `toollock budget` (context-tax table, sorted by token
share — makes the "42k tokens" pitch concrete for any server); classifier
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
candidates (all auto-probed `no-auth` servers kept; up to 5
`auth-required` servers promoted to `env-gated` via the timeboxed
hand-research path, `github-mcp-server` first); the bucket column and
env-gated caveat flag recorded per dataset entry.
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
| Real servers misbehave on stdio (stdout logging, hangs) — could double Phase 1/2.5 time                       | Phase 0 spike against real candidates first; swap out any misbehaving server rather than debugging it                                              |
| `$ref`/cycles more complex than expected                                                                      | Phase 0 spike with a real recursive-schema fixture; fallback is hashing `$ref` as opaque rather than full inlining, documented as a limitation     |
| Env-gated promotion research (github-mcp-server and up to 4 others) takes longer than timeboxed               | Hard timebox per server; a server that doesn't promote in time just stays `auth-required` — the bucket count absorbs the overrun, not the schedule |
| GitHub Actions bot-commit permissions/identity subtleties eat a day                                           | Phase 0 spike with a trivial no-op workflow before Phase 2.5's real collector                                                                      |
| Non-determinism in JCS/token counts causes noisy no-op lockfile diffs — undermines the "human-diffable" pitch | Phase 2 fixture explicitly hash-twice-and-byte-compare                                                                                             |
| Scope creep polishing the security-scanner positioning comparison                                             | Cut-line protects this; one honest paragraph, not a feature matrix                                                                                 |
| `@modelcontextprotocol/sdk` v2 beta reaches npm `latest` mid-build                                            | Exact version pin in `package.json`, not a caret range                                                                                             |
| The actual npm-resolved version of an `npx -y <pkg>` spawn turns out not to be cheaply obtainable             | Phase 0 spike 7 checks this before Phase 3 designs the lock schema around it; fallback is `serverInfo.version` only, documented as a known gap     |

## Considered and deferred

Not in scope for this plan, not silently folded into a phase above:

- `outputSchema` hashing/token-counting (structured tool output).
- Publishing to npm — Phase 6 produces a publish-ready tarball only.
- A hosted GitHub App / Marketplace Action — Phase 4 ships copy-paste
  YAML only.
- `resources/list` capture — original scope was tools + prompts only.
- Final `cost-drift` threshold tuning — ships with a stub default, marked
  TBD pending real dataset numbers.
