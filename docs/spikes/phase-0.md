# Phase 0 spike notes

One entry per unknown from PLAN.md's Phase 0 list. Each records the
outcome as pass or the specific fallback/correction it forces. Throwaway
spike scripts lived under a scratch workspace, not in this repo; only the
findings are kept here.

## 1. Stdio hygiene — PASS

Real SDK `Client` over `StdioClientTransport`, spawned via `npx -y`
against 5 real candidates: `@modelcontextprotocol/server-filesystem`,
`@modelcontextprotocol/server-memory`, `@modelcontextprotocol/server-everything`,
`@modelcontextprotocol/server-sequential-thinking`, `@upstash/context7-mcp`.
25s timeout per server; `tools/list` always called, `prompts/list` called
only when the server declared the `prompts` capability.

All 5 connected, listed tools (counts ranged 1–14), closed cleanly, zero
stray bytes on stdout (all human-readable logging went to stderr, as the
SDK's stdio contract requires), and left no lingering processes after
exit. No hangs, no crashes.

## 2. Capability gating — PASS, with a correction to PLAN.md

PLAN.md originally claimed `Client.listPrompts()` throws by default via
`assertCapabilityForMethod` when a server hasn't declared the `prompts`
capability. Measured against `server-memory` (declares only
`{resources, tools}`), that's incomplete: `assertCapabilityForMethod` is
only invoked when the Client is constructed with
`enforceStrictCapabilities: true` — which is **not** the default.

Two measured paths:

- Default construction (`new Client(info, {capabilities:{}})`): calling
  `listPrompts()` sends the request over the wire regardless of declared
  capabilities. The throw the caller sees (`MCP error -32601: Method not
  found`) is the *server's* JSON-RPC response, not a client-side guard —
  it depends on the server correctly returning a spec-compliant error for
  an unimplemented method rather than hanging or misbehaving.
- `enforceStrictCapabilities: true` at construction: `listPrompts()`
  throws locally (`Server does not support prompts (required for
  prompts/list)`) before anything reaches the wire.

**Forces:** the collector must construct the Client with
`enforceStrictCapabilities: true` explicitly, and still capability-check
before calling — not rely on a server-returned `-32601` as the primary
path, since that was never a guaranteed contract. Folded into Phase 1's
deliverables and PLAN.md's SDK-verification section.

Caveat carried into spike 3: `enforceStrictCapabilities: true` isn't
prompts-specific — it gates every method, including `tools/list`. A
third-party server with sloppily-declared capabilities could now throw
locally on `tools/list` too. Spike 3's probing must distinguish that
failure mode from actual auth failures, or it will misclassify a sloppy
server as `auth-required` and quietly corrupt the bucket distribution.

## 3. Auth-bucket probing + candidate sourcing — PASS on mechanism, one open fork

**Seed source, decided:** the official registry at
`registry.modelcontextprotocol.io` (`/v0/servers`, paginated via
`nextCursor`, filterable with `?search=`). Live, returns both
`packages` (npm/pypi/oci, with `registryType`) and `remotes` (hosted
HTTP) entries. Filtering to `registryType: npm` matches the collector's
`npx -y <pkg>` spawn model. Caveat worth carrying forward: the long tail
is noisy — large numbers of single-purpose, near-duplicate, or
low-effort namespaces alongside legitimate servers. Phase 2.5/5 seed
curation needs a quality bar beyond "exists in the registry," not just a
raw pull of the first N results.

**Environment-var-free probe, ~~empty-environment~~ corrected:** read
`stdio.js` before running anything — the SDK unconditionally computes
`env` as `{...getDefaultEnvironment(), ...serverParams.env}`.
`getDefaultEnvironment()` (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`,
`USER` on POSIX) is merged in *underneath* whatever `env` is passed, so
even `env: {}` cannot produce a literally empty environment — there is no
public-API way to unset those six keys. This isn't a problem: it's
exactly the environment the probe wants (`npx` needs `PATH`/`HOME` to
function; none of the six are credential-shaped). "Empty-environment
probe" in the plan should be read as "no explicit env passed," which is
what was actually tested.

Probed 10 real candidates (Client built with `enforceStrictCapabilities:
true`, per spike 2) — 5 expected no-auth, 5 expected auth-required:

| Server | Expected | Result |
| --- | --- | --- |
| server-filesystem, server-memory, server-everything, server-sequential-thinking, context7-mcp | no-auth | no-auth (all 5, as spike 1) |
| `@notionhq/notion-mcp-server` | auth-required | **no-auth** — connects and lists 24 tools with zero env vars set |
| `mcp-server-linear` | auth-required | **no-auth** — connects and lists 24 tools with zero env vars set |
| `@sentry/mcp-server` | auth-required | auth-required — exits before completing initialize, clear stderr naming the missing var |
| `@modelcontextprotocol/server-brave-search` | auth-required | auth-required — exits before completing initialize, clear stderr naming the missing var |
| `@stripe/mcp` | auth-required | auth-required — exits before completing initialize, clear stderr naming the missing var |

**Finding, not a bug:** Notion's and Linear's MCP servers both hand out
their full tool schema with no credentials at all — auth is enforced at
`tools/call` time, not `tools/list` time. The probe's binary bucket, as
specified, measures "is the schema capturable without credentials," which
is the actual question `toollock` needs answered — but that is narrower
than what the bucket names in DECISIONS.md #12 (`no-auth` /
`auth-required`) imply to a reader. Two real "you need an account to use
this" servers will land in the `no-auth` bucket as currently named. This
is a naming/semantics question for DECISIONS.md #12, not a probe failure
— flagging for a decision rather than renaming unilaterally.

**`enforceStrictCapabilities` false-positive risk (flagged before this
spike):** checked for, not observed. All 7 candidates that reached
`listTools` had correctly declared their `tools` capability; none of the
3 real auth failures got far enough to reach `listTools` at all (they
exited during/before `initialize`). The risk is real (confirmed
mechanically in spike 2) but this sample of 10 didn't happen to contain a
sloppy-declaration case — stays open for the larger Phase 5 seed list.

**Promotion path — fork, not a clean pass.** The plan named
`github-mcp-server` as the first promotion target. It doesn't fit the
collector's spawn model at all, independent of auth: the *official*
package (`io.github.github/github-mcp-server` in the registry, confirmed
against its own README) ships only as an OCI image
(`ghcr.io/github/github-mcp-server`, run via `docker run`) or a remote
hosted endpoint — there is no npm package. (`@modelcontextprotocol/
server-github`, the old npm package, is dead: `npm view` returns
"Package no longer supported.") `npx -y <pkg>` cannot spawn it. This is a
transport mismatch one layer beneath auth-bucketing, and it isn't
something this spike can resolve by itself — see "Open fork" below.

Tested the placeholder-promotion *mechanism* instead against the 3
real npm-packaged auth-required servers this spike found:

- `server-brave-search`: promotes cleanly — placeholder `BRAVE_API_KEY`
  passes the server's local presence check, server starts, lists 2 tools.
- `@sentry/mcp-server`: promotes cleanly — placeholder
  `SENTRY_ACCESS_TOKEN` passes, server starts, lists 9 tools.
- `@stripe/mcp`: does **not** promote, and not the way expected. It's a
  local stdio process that itself forwards `tools/list` to Stripe's real
  hosted MCP endpoint over HTTP. The placeholder key gets a real `401`
  from that live endpoint, and instead of failing fast, the process never
  completes the MCP `initialize` handshake — it just hangs, logging the
  401 to stderr, until the collector's own timeout kills it. Confirms
  placeholder-promotion only works for servers that generate their tool
  schema locally, not ones that proxy `tools/list` to an authenticated
  remote API — and confirms the collector's per-server timeout+kill isn't
  optional hardening, it's load-bearing (this is the second real hang
  found in spike work, after none in spike 1's happy-path sample).

**Open fork — needs a call before Phase 2.5 designs the bucket schema
around it:**

1. Add a `docker run` spawn path alongside `npx -y` so `github-mcp-server`
   itself can be captured — reopens DECISIONS.md #1's stdio/npx-only
   stack decision.
2. Drop `github-mcp-server` as the headline promotion example; substitute
   a real npm-packaged auth-required server (`brave-search` or
   `sentry-mcp-server`, both already confirmed to promote cleanly above).
3. Keep `github-mcp-server` in the seed list under a new
   `unsupported-transport` bucket, distinct from the auth buckets, and
   accept losing the headline example from the live dataset (it remains
   available as a manual README demo only).

**Resolved:** option 2. `sentry-mcp-server` (confirmed above to promote
cleanly with a placeholder env var) replaces `github-mcp-server` as the
headline promotion example; a `docker run`/OCI spawn path is explicitly
rejected (PLAN.md's "Considered and deferred"); option 3's dedicated
bucket turned out to be unnecessary — the seed list is npm-filtered at
sourcing time, so non-npm servers never reach the probe at all, and the
npm filter instead records how many registry entries it excludes as its
own dataset finding. The `github-mcp-server` ~42k-token figure is cited
in the README as a third-party measurement, not a `toollock` dataset
entry. The `no-auth`/`auth-required` bucket names are also renamed to
`list-open`/`list-env-gated`/`list-auth-required`/`list-timeout` — see
DECISIONS.md #12 (revised) and #17 for full reasoning.

## 4. Canonicalization against a real `$ref`-bearing schema — PASS, plus a real fork for decision #5

**`$ref` existence, and a correction to where it comes from:** PLAN.md's
spike description said "find one from a Zod-based server," on the
assumption that `$ref` would show up via `zod-to-json-schema`'s structural
sharing. Tested 5 real servers' full `tools/list` output
(`server-everything`, `@notionhq/notion-mcp-server`, `mcp-server-linear`,
`@sentry/mcp-server`, `server-sequential-thinking`). None of the
Zod/SDK-native servers emitted a single `$ref`. `@notionhq/notion-mcp-server`
did — heavily — but it's OpenAPI-derived (Notion's OpenAPI spec converted
to JSON Schema), not Zod-based. 152 `$ref` occurrences across its 24
tools, up to 9 `$defs` entries per tool, one entry (`richTextRequest`)
referenced up to 51 times within a single tool's schema.

**Cycle detection:** ran a real cycle-detector (DFS, white/gray/black)
against the `$defs` graph of all 24 tools. **Zero cycles found.** Max
`$ref` nesting depth observed is 2 (e.g. `blockObjectRequest` →
`paragraphBlockRequest` → `richTextRequest`, a leaf). Each tool's `$defs`
dictionary is self-contained — no cross-tool or external reference
resolution needed, simpler than the plan assumed. Inlining + defensive
cycle detection (even though this sample never exercised it) is
confirmed tractable; PLAN.md's "hash `$ref` as opaque" fallback isn't
needed for this real case.

**Unplanned finding, real fork for DECISIONS.md #5:** while inlining
Notion's schemas to check for exponential blowup from the 51x-reused
def, found the opposite problem. Every one of Notion's 24 tools ships
the *entire* 9-entry `$defs` dictionary regardless of what that specific
tool's schema actually references — e.g. `API-get-user`'s real schema
body is 617 characters and references exactly one def
(`richTextRequest`), but the server sends all 2,509 characters of
`$defs` anyway. Measured with `gpt-tokenizer` (also confirms spike 5's
sync/offline claim in passing) across all 24 tools, comparing raw
canonical bytes against reachable-only-inlined canonical bytes:

- Every single tool's inlined form is **smaller** than its raw form —
  never larger, even the tool that reuses `richTextRequest` most
  heavily (`API-update-page-markdown`, ratio 0.57).
- Totals across all 24 tools: **17,430 raw tokens vs. 4,882 inlined
  tokens** — inlined is 28% of raw. The extreme case
  (`API-get-self`) inlines to 7% of its raw size.

DECISIONS.md #5 currently specifies tokenizing "the same bytes being
hashed" — i.e. the post-inline, canonical, dead-`$defs`-eliminated form.
But a real MCP client receives the **raw** wire response, `$defs`
padding included, and that's what actually loads into a model's context.
For a server shaped like this one, token-counting the canonical basis
would report roughly a **quarter** of the real wire-level cost — a
large, systematic understatement, not noise, for the exact command
(`toollock budget`) whose entire pitch is making token cost visible.
This is unresolved here — it changes what spike 5 ("fix the exact
tokenized string") is actually supposed to fix, so it's flagged before
running spike 5 rather than after.

**Resolved:** keep both, they measure different things. `canonicalTokens`
(post-inline JCS bytes, hash-coupled, basis for `cost-drift`) and
`wireTokens` (raw `tools/list` `tools` array only — not the JSON-RPC
envelope — basis for `budget` and `contextBudget`) are both recorded, plus
a derived `schemaReuseRatio = wireTokens / canonicalTokens` per server per
snapshot. Canonical-only would understate `budget` by ~4x on
Notion-shaped servers; wire-only would break the hash/count coupling
spike 5 exists to guarantee. Full reasoning in DECISIONS.md #5 (revised).
Also folded in: `$ref` showing up only in the OpenAPI-derived server and
none of the Zod/SDK-native ones is now a line in DECISIONS.md #3.

## 5. Token-count determinism — PASS, with a real reproducibility hazard found and closed

**`gpt-tokenizer` offline/sync:** confirmed both ways — empirically (used
synchronously, no `await`, dozens of times across every spike script this
session, no network involved) and declaratively (`package.json` lists
zero runtime `dependencies`).

**`canonicalTokens`'s fixed string:** JCS-canonical bytes of `{name,
description, inputSchema}` after `$ref` inlining (Phase 0 spike 4's
inliner). Ran the full pipeline twice against two independent process
spawns of the real Notion server: byte-identical canonical strings
(sha256-compared), identical per-server total (4,882 tokens) both times.

**`wireTokens`'s fixed string — the real finding.** Naively computing
this from `Client.listTools()`'s return value seemed reasonable, but
isn't reproducible: the SDK Zod-validates every incoming JSON-RPC message
(`JSONRPCMessageSchema.parse`, in `shared/stdio.js`'s `deserializeMessage`)
*before* the `Client` ever sees it, and Zod's `.parse()` rebuilds the
result object following the SDK's own internal schema field order — not
the order the server actually sent. Verified directly: tee'd the child
process's raw stdout independently of the SDK's own internal listener
(Node streams support multiple `'data'` listeners on the same stream, so
this doesn't interfere with normal operation) and compared the literal
wire bytes against `Client.listTools()`'s re-serialized return value for
the same response. Both are content-identical (same length, 76,215
characters) but differently ordered — e.g. `$defs` appears first in the
real wire bytes, last in the SDK-reconstructed object — and that
reordering changes the token count: **17,500 tokens (real wire bytes) vs.
17,476 tokens (SDK-reconstructed)**, a difference caused entirely by
which SDK version's internal schema shape happens to be running the
collector, not by anything the target server did. Using
`Client.listTools()` for `wireTokens` would have made the number silently
dependent on `toollock`'s own SDK version — exactly the kind of
unreproducible measurement this spike exists to rule out.

**Fixed instead:** `wireTokens` is computed from an independent tee of
the raw child-process stdout stream (captured in parallel with, not
instead of, the normal `Client` call), taking the untouched line whose
parsed shape is `{result: {tools: [...]}}}` and re-serializing
`JSON.parse(rawLine).result.tools` directly — parse-then-immediate-
restringify preserves the server's original key order because no Zod
reconstruction happens in between. Scope confirmed exactly: the raw line
was 76,259 characters including the JSON-RPC envelope; the extracted
`tools` array alone was 76,215 characters — the ~44-byte envelope
(`{"jsonrpc":"2.0","id":N,"result":{"tools":` plus its closing) is
excluded, exactly as decided. Full determinism check (two independent
spawns): byte-identical raw-tee strings (sha256-compared), identical
token count (17,500) both times.

**`schemaReuseRatio`:** stable given the two fixed strings —
`17,500 / 4,882 = 3.5846`, identical to 4 decimal places across both
spawns.

**Forces:** Phase 1's `capture.ts` cannot get `wireTokens` from
`Client.listTools()`; it needs its own raw-stdout tee, documented in
PLAN.md's Phase 1 deliverables and DECISIONS.md #5's exact-boundary note.
