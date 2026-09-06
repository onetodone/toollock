# DECISIONS.md — @onetodone/toollock

One entry per decision. Each has a **Decision**, **Alternatives rejected**,
and **Why**. Fully reasoned, no stub markers remaining: 1, 2, 4, 7, 8, 9,
12, 13, 15, 17, 18, 19. Phase 0's spikes substantially rewrote 3, 5, 6,
and 11 with real, measured content — each still carries at most one
narrower `(expand: ...)` note on a point the spikes didn't touch. The
rest — 10, 14, 16 — still carry stub markers: 14 and 16 are deliberately
deferred (a scope cut and a pending-Phase-5-data threshold respectively),
so their "Why" sections stay short on purpose; 10 gets its final pass in
Phase 6.

## 1. Stack

**Decision:** TypeScript/Node, `@modelcontextprotocol/sdk`, stdio
transport, spawn via `npx -y <pkg>`.

**Alternatives rejected:**

- Python + the Python MCP SDK.
- HTTP/SSE transport instead of stdio (would only cover remote servers,
  not the common local/npx-spawned case).

**Why:**

- TypeScript/Node because the thing being measured is a TypeScript/Node
  ecosystem: the reference MCP SDK is TS-first, the servers this tool
  spawns are overwhelmingly npm packages run with `npx`, and the output
  is a lockfile that belongs next to `package-lock.json` in the same kind
  of repo. A Python port would have to reimplement the SDK's stdio
  framing and schema types against a moving target for no gain in
  coverage.
- stdio-first because that is how the public MCP ecosystem is actually
  consumed today: an editor or agent spawns `npx -y <pkg>` and talks
  JSON-RPC over the child's stdin/stdout. HTTP/SSE transport only reaches
  remote-hosted servers, a smaller and differently-shaped slice (its
  drift story is a deployment's problem, not a dependency's). Starting
  narrow keeps the security model (decision #11) and the capture path
  (decision #5's raw-stdout tee) simple enough to actually get right.
- The npx/stdio-only scope is stated as a limitation in the README, not
  buried — it means `toollock` cannot see roughly 70% of the public
  registry (decision #12, and the README's scope note).

## 2. Capture scope

**Decision:** capture both `tools/list` and `prompts/list`. Not
`resources/list`.

**Alternatives rejected:**

- Tools only.
- All three list endpoints (tools/prompts/resources).

**Why:**

- Prompts are in scope because an MCP prompt is a server-supplied
  template that a client renders straight into the model's context — the
  same rug-pull surface a tool description is. A server that quietly
  rewrites a prompt's text, or changes which arguments it interpolates,
  changes model behavior with no code change on the client side; that is
  exactly the change `toollock` exists to make reviewable. The
  `schemaHash`/`promptHash` split (decision #4) is defined for prompts
  too, not just tools.
- `resources/list` is excluded because a resource is addressable content
  the client chooses to fetch, not text auto-loaded into context — it
  doesn't carry the "executed without anyone deciding to" property that
  makes tool and prompt drift dangerous. Capturing it would roughly
  double the surface for a category whose contents legitimately change
  all the time (that's what resources are *for*), producing drift noise
  with no rug-pull signal underneath it. Listed in PLAN.md's "Considered
  and deferred," not silently dropped.

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
- `$ref` risk is concentrated in OpenAPI-derived servers, not Zod/
  SDK-native ones. Phase 0 spike 4 found `$ref` in the one OpenAPI-derived
  server tested (`@notionhq/notion-mcp-server`, 152 occurrences across 24
  tools) and in none of the four Zod/SDK-native servers tested.
  `zod-to-json-schema` output doesn't structurally share definitions the
  way an OpenAPI→JSON-Schema converter does — the inlining and cycle-
  detection code exists for a real but narrower slice of the ecosystem
  than "any MCP server" might suggest.

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
  Concretely: it is what lets `verify` fail a description rewrite while
  passing a new optional parameter in the same run (decision #7's
  per-class policy), instead of forcing one exit code onto both.
- **Where the split's boundary needed a call:** `annotations` (the SDK's
  `ToolAnnotations` — `title`, `readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`) go in `promptHash`, not `schemaHash`.
  Every field there is a descriptive or behavioral hint a client acts on,
  not a wire-compatibility constraint: `readOnlyHint` flipping to `false`
  doesn't break a call, it changes whether a client auto-approves one —
  behavioral, so it belongs with the text the model and client read.
  Phase 4 also stores `annotations` verbatim in `tools.lock` (not just
  folded into the hash) so `verify` can name which hint changed, not just
  report that `promptHash` moved.
- **What stays out of both hashes in v1:** `outputSchema` (decision #14)
  and `_meta`. Both are deferred deliberately, documented in known
  limitations, not silently ignored.

The split applies to `PromptSchema` too, not just `ToolSchema` — the
original design named `prompts/list` as in scope (#2) but never said how
a prompt's hash was divided. Defined in Phase 2:

- `schemaHash` (prompt): argument names + argument `required` flags.
- `promptHash` (prompt): prompt name, prompt description, argument
  descriptions.
  Golden fixtures mirror the tool invariants: a description-only change on
  a prompt argument moves `promptHash` and leaves `schemaHash` stable.

## 5. Token counting — three bases, not one (revised in Phase 0 spike 4; `wireBasisTokens` added post-Phase-1)

**Decision:** `gpt-tokenizer` (o200k), offline, computing separate
token counts, kept side by side rather than collapsed into one:

- `canonicalTokens` — tokenizes the JCS-canonical bytes of `{name,
  description, inputSchema}` *after* `$ref` inlining (decision #3's
  pipeline). Tied to exactly the same bytes `schemaHash`/`promptHash` are
  computed from — deterministic, and the basis for `cost-drift`
  (decision #7): a change here means the structurally-hashed content
  actually changed.
- `wireTokens` — tokenizes each tool's own raw JSON *before* any
  normalization: no `$ref` inlining, no `required[]`/`enum[]` sort, no
  JCS, original key order preserved. **Granularity matches
  `canonicalTokens`: per tool, not per response.** Each array element is
  tokenized on its own — the same unit `canonicalTokens` uses — so a
  per-server `wireTokens` total is the sum across tools, directly
  comparable to the sum of `canonicalTokens` for the same tools. Scope is
  exact, for reproducibility: each tool's own JSON only, **never** the
  surrounding JSON-RPC envelope (`jsonrpc`, `id`, the `result` wrapper,
  or the array's own brackets/commas) — a client never loads RPC framing
  into its context window, only the array's contents.

  **`frameTokens`, tracked separately, not folded into either base:** a
  real client loads the *whole* `tools` array as one JSON value, and
  tokenizing that one string isn't exactly equal to summing each
  element's independently-tokenized count — array punctuation
  (brackets, inter-element commas) plus ordinary BPE boundary effects at
  each element's edges add a small amount that only exists at the
  whole-array level. Measured on the real 24-tool server: whole-array
  `wireTokens` is 17,500; the sum of per-tool `wireTokens` is 17,498;
  `frameTokens = 2`. `frameTokens` is computed once per server (whole-
  array total minus the per-tool sum) and added into `contextBudget` —
  the one number meant to equal what a client actually pays — but it is
  **excluded** from `schemaReuseRatio` and from any per-tool comparison,
  so the ratio measures the server's own `$defs`/schema shape, not
  tokenizer arithmetic. `tools.lock`'s `contextBudget` is therefore
  `sum(wireTokens) + frameTokens`, which is what a real MCP client
  actually pays for on every call; the per-tool `wireTokens` values feed
  `toollock budget`'s table.

  **Exact source, not `Client.listTools()`'s return value:** Phase 0
  spike 5 found the SDK Zod-validates every incoming message
  (`JSONRPCMessageSchema.parse`) before the `Client` ever sees it, and
  Zod's `.parse()` rebuilds the result object following the SDK's own
  schema field order — not the server's original key order. Measured on
  a real server: content-identical (same length) but reordered
  (`$defs` first in the real wire bytes, last in the SDK-reconstructed
  object), and the reordering measurably changes the token count (17,500
  raw vs. 17,476 SDK-reconstructed — a difference caused entirely by
  which SDK version's schema shape happens to be running, not by
  anything the target server did). So `wireTokens` is computed from an
  independent tee of the child process's raw stdout stream, captured in
  parallel with (not instead of) the normal `Client` call, taking the
  untouched line whose parsed shape is `{result: {tools: [...]}}` and
  re-serializing `JSON.parse(rawLine).result.tools` — the parse-then-
  immediate-restringify round-trip preserves original key order because
  no Zod reconstruction happens in between, unlike going through the
  Client.

  **The tee can fail where `listTools()` doesn't.** A server that writes
  non-JSON-RPC noise to stdout — logging that should have gone to
  stderr — would corrupt the tee's line-splitting while the SDK's own
  `Client` (which validates every message) fails loudly on the same
  response. Spike 1 sampled 5 real servers and found none doing this,
  but 5 isn't 50. `capture.ts` verifies the teed tools array parses to
  the same tool set `Client.listTools()` returned (same names, same
  count) before trusting `wireTokens`. On mismatch, `wireTokens` is
  recorded as `null` with a reason, never a best-effort number — a
  missing measurement is recoverable; a wrong one in a published dataset
  isn't.

- `wireBasisTokens` — sourced from the same raw-stdout tee as
  `wireTokens`, same no-normalization rule, but scoped down to exactly
  the three canonical-basis keys (`name`, `description`, `inputSchema`),
  preserving whatever relative order those three had on the wire.
  Every other field the tool carries — `title`, `annotations`,
  `outputSchema`, `execution`, or anything else a server attaches — is
  dropped, not counted. Exists solely to give `schemaReuseRatio` (below)
  an apples-to-apples numerator; `wireTokens` itself is untouched and
  stays the full-object count `contextBudget` needs, since a real client
  loads the whole tool object, not just its schema-hashed subset.

**`schemaReuseRatio`, corrected post-Phase-1 (caught before Phase 2's
implementation, not after):** `schemaReuseRatio = sum(wireBasisTokens) /
sum(canonicalTokens)` — both sums at the same per-tool granularity,
`frameTokens` excluded from both sides — recorded per server per
snapshot in the dataset (Phase 2.5/5).

The original formula (`sum(wireTokens) / sum(canonicalTokens)`, full
tool object over the hash-coupled subset) was checked against three
servers confirmed to carry zero `$ref`s (`server-everything`,
`server-filesystem`, `@upstash/context7-mcp`) on the assumption that a
`$ref`-free server should read ~1.0. It didn't: 1.5594, 1.6802, 1.0682.
The gap wasn't key-order noise — decomposing it per server showed JCS
reordering contributes next to nothing (single digits, sometimes
slightly negative), while the entire remainder traced to `title`,
`annotations`, `outputSchema`, and `execution` — current, spec-legal
MCP `Tool` fields that `canonicalTokens`'s basis has always excluded (by
design, for hash-coupling — decision #4 already puts `annotations` in
`promptHash`'s text bucket, not the structural one) but that the old
`wireTokens`-based numerator was still counting. `server-filesystem`
sends `outputSchema` on all 14 of its tools, which is why it read
highest; `context7-mcp` sends only a small `annotations` block, which is
why it read closest to 1.0. None of that is `$defs` waste — it's normal
current-spec tool metadata — so the old ratio's "this server wastes X%
of its tokens" framing was wrong by construction for any server that
populates those fields, not just as noise at the margins.

Re-measured with `wireBasisTokens` as the numerator, the same three
servers read **0.9909**, **0.9911**, and **1.0000** — the field-set
mismatch was the entire effect; what's left is canonicalization's own
tokenizer-boundary noise, consistent with `frameTokens`'s earlier
single-digit finding. `@notionhq/notion-mcp-server` (152 `$ref`s across
24 tools) recomputed under the corrected formula reads **3.5152**
(17,161 / 4,882 — down slightly from the old 17,498 numerator now that
non-schema fields are excluded from it too), still clearly elevated:
confirms real `$defs` duplication remains the dominant signal once the
field-set mismatch is removed, rather than being an artifact of it.

A `refCount` (total `$ref` occurrences across a server's tool input
schemas, pre-inlining — a free byproduct of the inliner) travels
alongside the ratio in the dataset so a reading can be attributed
correctly: `refCount = 0` with `schemaReuseRatio` near 1.0 confirms the
metric is clean for that server; `refCount > 0` with an elevated ratio
is the actual "specific, fixable inefficiency" claim this field is meant
to support — e.g. `@notionhq/notion-mcp-server`, which ships its entire
`$defs` dictionary to every tool regardless of what that tool's own
schema actually references. This is a measurement of the *server*, not
of `toollock` itself — recorded as a dataset field precisely because
it's evidence, not an artifact of the tool's own choices, and not an
artifact of mismatched tokenization granularity or field scope either.

Absolute numbers are tokenizer-dependent; only relative ratios (between
servers, or between `wireTokens` and `canonicalTokens` for the same
server) are claimed as meaningful across implementations.

**Alternatives rejected:**

- Calling a real tokenizer API at runtime (adds a network dependency and
  breaks offline/CI use).
- A different encoding (cl100k) or a rough character-count heuristic.
- `canonicalTokens` only — the original design, before Phase 0 spike 4
  measured the real gap on `@notionhq/notion-mcp-server`: 17,498 wire
  tokens vs. 4,882 canonical tokens across its 24 tools, same per-tool
  granularity both sides. (Spike 4's first pass at this number, 17,430,
  used JCS-sorted-but-not-inlined bytes rather than true wire-order
  bytes — a mislabeled third quantity, not actually `wireTokens`;
  corrected once spike 5 established the real wire-order string. The
  true per-tool sum turned out close to spike 5's whole-array figure —
  17,498 vs. 17,500 — meaning the earlier ~70-token gap was mostly
  JCS key-reordering, not array framing, which is only 2 tokens.)
  Reporting only the canonical number in `budget` would still understate
  the real wire-level cost by roughly 3.6x for a server shaped like that
  one — not noise, for the one command whose entire pitch is honest
  token cost.
- `wireTokens` only — rejected because it breaks the hash/token coupling
  Phase 0 spike 5 exists to fix: an unnormalized number drifts with
  formatting and key-order noise that has no bearing on `schemaHash`,
  which would make `cost-drift` fire (or fail to fire) on the wrong
  signal.

**Why:**

- (expand: why o200k specifically — matches current-generation model
  tokenizers, is the gpt-tokenizer default)
- The two numbers answer different questions and neither substitutes for
  the other. `canonicalTokens` stays deterministic and hash-coupled, so
  `cost-drift` fires on real structural growth, not formatting noise.
  `wireTokens` stays truthful to what a model's context window is
  actually billed for, so `budget` and `contextBudget` aren't quietly
  wrong by a multiple.
- `schemaReuseRatio` costs nothing extra to compute once `wireBasisTokens`
  and `canonicalTokens` both exist, and it's the kind of concrete,
  per-server finding — "this specific server wastes ~72% of its
  tool-definition tokens on unused shared `$defs`" — that makes the
  published dataset more than a hash log. That claim only holds once the
  ratio's numerator excludes non-schema fields (`wireBasisTokens`, not
  raw `wireTokens`) — confirmed by checking three `$ref`-free servers
  read ~1.0 under the corrected formula before trusting it on servers
  that do have `$ref`s.

## 6. `tools.lock` format

**Decision:** JSON, sorted keys, human-diffable in a PR. Stores server id,
transport, both hashes, per-tool token counts — `canonicalTokens`,
`wireTokens`, and `wireBasisTokens` each, same per-tool granularity
(decision #5; `wireTokens`/`wireBasisTokens` are `null` with a reason
string when the tee/`Client` cross-check fails, never a best-effort
guess) — a server-level `frameTokens` (the small whole-array-vs-per-tool-
sum gap, decision #5) and `refCount` (total `$ref` occurrences across the
server's tool schemas pre-inlining, a free byproduct of the inliner,
decision #5), a total `contextBudget` (`sum(wireTokens) + frameTokens`,
since that's what a real client's context window pays; `canonicalTokens`
stays coupled to the hashes instead, see decision #5), and version
information — but **not** a pinned package version (corrected during
planning, see below). Instead:

- `serverInfo.version` — self-reported by the server in its `initialize`
  response. Free to capture, unverifiable.
- `observedVersion` — the npm package version `npx` actually resolved for
  that run. Confirmed cheaply obtainable in Phase 0 spike 7 and
  implemented for real in Phase 3 (`src/lock/observedVersion.ts`): after
  `npx -y <pkg>` completes, npm has already written the resolved
  package's real `package.json` to `<npm cache>/_npx/<hash>/
  node_modules/<pkg>/package.json` — read directly by globbing that path
  for the package name already known to have been spawned (no hash
  prediction, no extra network call), picking the most-recently-written
  match if more than one hash directory has it. `null` only when the
  glob finds nothing at all (the package failed to resolve/install),
  distinct from a server that installs fine but fails at the
  MCP-protocol level.

**Also stores each tool's `description` and canonicalized `inputSchema`
(post-inline, `required[]`/`enum[]` sorted — the same bytes `canonicalTokens`
is computed from) directly, not just its hashes — same for each prompt's
`description` and `arguments`.** Realized during Phase 3's implementation,
not the original plan: a hash-only lockfile can't actually be
"human-diffable in a PR" as this decision already claimed — a PR diff on
`"schemaHash": "abc" -> "def"` tells a reviewer nothing about *what*
changed, and `update`'s "diff shown" (decision #8) would have nothing to
diff against on a later run once the real server has already moved on.
The hashes stay too, as a fast equality check and for anything that wants
to compare without parsing structure. This also makes decision #19's
drift classifier possible: it needs the actual old shape to diff against
the new one, not just a hash telling it *that* something changed.

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
- `cost-drift` (`canonicalTokens` growth over threshold) → warn

**Alternatives rejected:**

- A single pass/fail signal with no classes.
- Making all drift classes fail (too strict — would break on every
  legitimate additive change).

**Why:**

- Prompt-drift fails rather than warns because it's the rug-pull
  surface: a server rewriting a tool's description is exactly the attack
  this project exists to catch, so warning-and-continuing would defeat
  the point. Schema-additive warns because most additive changes are
  ordinary, healthy evolution (a new optional param) — failing CI on
  every one of those would train users to ignore `verify`, the same
  alert-fatigue failure mode a scanner that flags everything falls into.
- `canonicalTokens`, not `wireTokens`, is the basis (decision #5) — so
  `cost-drift` fires on real structural token growth, not on wire-format
  noise that has nothing to do with `schemaHash`.
- `cost-drift`'s exact threshold is decision #16's stub, applied as-is in
  Phase 3's implementation (`COST_DRIFT_TOOL_THRESHOLD`/
  `COST_DRIFT_BUDGET_THRESHOLD`, `src/lock/diff.ts`) rather than left
  unimplemented — see decision #19 for the concrete algorithm.

## 8. Commands

**Decision:** `init`, `verify` (exit 1 on drift), `update` (accept with
diff shown), `budget` (context-tax table). Plus `capture` — a raw JSON
dump of one server's `tools/list` + `prompts/list` response and wire
token counts, kept from Phase 1 as a debugging/inspection primitive,
not part of the lockfile workflow.

**Alternatives rejected:**

- A single combined command with flags instead of subcommands
  (`toollock --check` / `--fix`).
- Folding `budget` into `verify` as a `--budget` flag.

**Why:**

- `init`/`verify`/`update` deliberately mirror the shape every lockfile
  tool already uses — `npm install`/`npm ci`, `bundle install`/`--frozen`,
  `cargo build`/`--locked`: capture once, check against the capture in
  CI, take an explicit human step to move the baseline. A user doesn't
  learn a new mental model, only a new target for one they have. `verify`
  is the CI verb and never writes; `update` is the only command besides
  `init` that writes, and only after showing the full diff (decisions
  #6/#7).
- No combined `--check`/`--fix` command: the verbs carry different
  permissions (`verify` is read-only, `update` writes) and different
  audiences (`verify` runs unattended in CI, `update` is always
  interactive), and collapsing them behind flags hides exactly the
  distinction that matters — that accepting drift is never automatic.
- `budget` is its own verb, not a flag on `verify`, because it answers a
  different question on a different cadence: not "did this change" (every
  CI run) but "what does this cost" (when deciding whether to add a
  server, or hunting for what's filling a context window). It reads
  `wireTokens` — what a client's context window is actually billed for,
  decision #5 — and takes a package directly (`toollock budget <pkg>`, a
  fresh capture, no `tools.lock` needed) so the number is reachable
  before committing to anything; with no argument it prints the same
  table for every server already locked, plus a roll-up. It has no
  security dimension at all, which is another reason not to entangle it
  with `verify`.

## 9. Positioning

**Decision:** this is a lockfile mechanism, not a security scanner. It
never judges intent; it makes change visible and requires explicit
approval. Snyk Agent Scan (which absorbed Invariant Labs' `mcp-scan`)
overlaps partially — the README names the overlap and the difference
openly rather than talking around it.

**Alternatives rejected:**

- Marketing this as a security/threat-detection tool.
- Ignoring the overlap with existing scanners, or overstating the
  difference to manufacture a gap.

**Why:**

- **"Lockfile" is the more defensible frame because it makes a narrower
  claim.** A scanner asserts something about *intent* — "this
  description looks like a prompt injection," "this tool is unsafe" — and
  can be wrong in both directions: a false positive trains users to
  ignore it, a false negative is the breach it existed to prevent.
  `toollock` asserts only "these bytes are not the bytes you approved,"
  which is either true or false and never a judgment call. It cannot be
  wrong about intent because it never forms a view on intent.

- **What Snyk Agent Scan / `mcp-scan` does that `toollock` doesn't:**
  static analysis of tool descriptions for prompt-injection and
  tool-poisoning patterns; detection of tool shadowing (one server
  redefining another's tool) and cross-server "toxic flows"; an optional
  runtime proxy that inspects live MCP traffic and can block calls; a
  policy engine and hosted classification. That is a security product
  with a large surface, and `toollock` replaces none of it.

- **The overlap, named precisely:** `mcp-scan` also hashes tool
  descriptions and warns when they change between runs — its
  "tool-pinning" / rug-pull check. The differences are (a) its pins live
  in `~/.mcp-scan/` on one developer's machine, not in the repo, so
  they're never reviewed in a PR, shared across a team, or evaluated in
  CI; (b) it emits a single changed/unchanged signal, where `toollock`
  splits structural from behavioral change (decision #4) and classifies
  each into a pass/warn/fail policy (decision #7) with CI exit codes;
  (c) it says nothing about token cost, which `toollock budget`
  (decision #8) treats as a first-class axis with no security dimension.
  `toollock` is *only* the committed-artifact-plus-classified-diff
  mechanism — no proxy, no classifier, no hosted component.

- **Where `toollock` is weaker, stated too:** a scanner that reads
  descriptions can flag a plausible injection on the *first* run, before
  any baseline exists. `toollock` has nothing to say about a server's
  first capture — it only ever reports change *from* an approved state.
  The two are complementary: scan to judge what you're about to trust,
  lock to notice when it changes underneath you.

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

**Scope, added in Phase 3: this constraint is the collector's, not
`toollock`'s CLI in general.** `init`/`verify`/`update` (`src/lock/
commands.ts`) spawn with the *real* ambient environment
(`{...process.env}`), not the collector's placeholder-only env — a user
running `toollock verify` locally against their own configured,
credentialed server expects it to behave like any other child process
and inherit their shell's environment; withholding it would silently
break every auth-gated server a real user actually runs against, for a
zero-secrets guarantee that only ever needed to apply to the unattended
dataset workflow. The two code paths intentionally diverge here — see
`src/collector/snapshot.ts` (placeholder-only) vs `src/lock/commands.ts`
(ambient environment) if the difference looks like an inconsistency
rather than a deliberate one.

**Known constraint, unrelated to this decision but belongs here as an
operational note:** GitHub automatically disables a `schedule`-triggered
workflow on a public repo after 60 days with no new commits to the
repository — only commits reset the clock; issues, PRs, releases, and
tags don't. Disabling also takes `workflow_dispatch` on that same
workflow file down with it, so a lapsed collector can't even be
manually re-triggered without first re-enabling it via the UI/API. Not a
risk during the active build window (commits are frequent), but the
dataset's entire value proposition (decision #10) depends on the
schedule surviving unattended for the life of the project — worth a line
in the collector's own operational notes (Phase 2.5/6) so a future
maintainer isn't surprised by a silently-stopped dataset after a quiet
stretch, particularly once Phase 6 flips to weekly cadence and the
collector's own commits are the only thing normally resetting the timer.

## 12. `tools/list` enumeration probe (resolved this session, revised in Phase 0 spike 3)

**Decision:** classify every seed candidate by how `tools/list` — not
`tools/call` — responds, with four buckets:

- `list-open` — lists tools with **zero** env vars set.
- `list-env-gated` — lists tools once a **placeholder** value is set for
  a hand-sourced env var name. Promotion is manual and timeboxed (≤5
  servers, `sentry-mcp-server` first — not `github-mcp-server`; see
  below). Placeholders aren't credentials, so the zero-secrets guarantee
  still holds. Joins the dataset with a caveat flag: its real tool list
  could vary by credential scope from what the placeholder probe saw.
- `list-auth-required` — fails cleanly (a real error, at or before
  `initialize`) with no placeholder promotion attempted or successful.
  Kept in the seed list with no measurements; the count in this bucket is
  itself a dataset finding — the fraction of the public registry that
  can't be audited without credentials — not an error to hide.
- `list-timeout` — no response within the probe's timeout (Phase 1's
  30s-connect/15s-list wrapper). Kept as its own bucket, **never** folded
  into `list-auth-required`: a hang and a clean `-32601`/startup error
  are different facts about the server, and collapsing them would corrupt
  the distribution this project intends to publish. Confirmed non-
  hypothetical in spike 3: `@stripe/mcp` proxies `tools/list` to a live
  authenticated HTTP endpoint, so a placeholder key gets a real `401` and
  the local process just hangs instead of failing fast.

**This classifies enumeration, not authentication.** A server can be
`list-open` and still require a real account to *use* it — spike 3 found
this is not hypothetical: Notion's and Linear's MCP servers both hand out
their complete tool schema with zero env vars set, because they enforce
credentials at `tools/call` time, not `tools/list` time. The bucket names
must not be read as "does this server need auth" in general; they answer
the narrower question `toollock` actually needs — "is the schema
capturable without credentials" — and that's the only claim the dataset
makes.

**Alternatives rejected:**

- The original two-bucket `no-auth`/`auth-required` split — replaced
  because `no-auth` reads as "doesn't need auth" when it only ever meant
  "listed tools without credentials," and spike 3 produced two real
  counterexamples (Notion, Linear) where that gap isn't hypothetical.
- A `docker run`/OCI spawn path alongside `npx -y`, so `github-mcp-server`
  itself could be captured (it turned out to ship only as an OCI image,
  no npm package — spike 3, `docs/spikes/phase-0.md`). Rejected: a second
  transport carries a different security profile than the npx-only story
  decision #11's collector security write-up is built on. Recorded in
  PLAN.md's "Considered and deferred," not silently added. A commonly
  repeated figure puts `github-mcp-server`'s tool definitions at
  ~42,000 tokens — noted here only as unverified third-party context,
  **not** in the README: the trail (a getunblocked.com post attributing
  it to a Nebulagg measurement) dead-ends at a 404'd primary source, so
  it doesn't meet the bar for a reproducible-measurement project's own
  front page. The README instead leads with `toollock`'s own
  byte-reproduced number — `@notionhq/notion-mcp-server` at 17,500 wire
  tokens across 24 tools (Phase 0 spike 5) — smaller, but ours and
  independently reproducible.
- A dedicated `unsupported-transport` bucket for non-npm registry entries
  — unnecessary, since the seed list is filtered to `registryType: npm`
  at sourcing time; non-npm servers never reach the probe. Instead, the
  npm filter records *how many* registry entries it excludes at filter
  time — that count is a dataset finding in its own right, the same way
  the bucket distribution is. This filter's real size (npm is ~30% of the
  registry, per Phase 2.5's crawl — decision #17) outgrew being a
  filtering-mechanics footnote here; it's now an explicit scope statement
  in the README, not just implied by this rejected alternative.
- Collapsing `list-timeout` into `list-auth-required` — rejected, see
  above; Phase 1's per-server timeout+kill exists specifically so this
  bucket's data is trustworthy rather than a symptom of a crashed probe.
- Excluding all `list-auth-required`/`list-env-gated` servers from the
  dataset entirely (loses real headline examples from the committed
  dataset — they'd only ever be manual README demos).
- Adding real scoped CI secrets for a small allowlist of servers (breaks
  the zero-secrets guarantee; the security write-up would need to become
  "no secrets except an explicit allowlist," a weaker and harder-to-defend
  claim).
- Fully manual per-server env-var research for the whole seed list (not
  feasible at 50–60 candidates in the time budget — only the split at
  scale needed to be automatic).

**Why:** the no-env/placeholder-env split still needs zero manual
research and scales to a large seed list; only the promotion step needs
hand research, and capping that at 5 servers keeps it inside the time
budget. Splitting out `list-timeout` and being precise about what
`list-open` actually measures costs nothing at build time and directly
protects the credibility of the published dataset — the pitch depends on
these numbers being read literally, not generously.

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

## 17. Seed list curation bar (resolved this session)

**Decision:** three mechanical criteria, no judgment calls:

1. Resolves in the npm registry (survives the `registryType: npm` filter
   from decision #12).
2. Last publish within 12 months.
3. A repository link present in the package's registry metadata.

Each criterion's drop count is recorded alongside the seed list, the same
way the auth-bucket distribution and the npm-filter exclusion count are —
a dataset finding, not a discarded intermediate.

**Alternatives rejected:**

- Hand-curating "quality" servers by judgment — subjective, not
  reproducible, and not something a scheduled unattended workflow can do.
- No quality bar at all — rejected after spike 3's registry sourcing work
  found a noisy long tail of near-duplicate, low-effort namespaces; a raw
  pull of the first N results would let that noise dominate the seed
  list.
- A popularity/download-count threshold — not returned by the registry's
  list endpoint, so it would need an extra per-package lookup at
  seed-list-build time; deferred rather than adding an unbounded number
  of extra API calls to a workflow that already probes every candidate.

**Why:** every criterion is answerable from data the registry already
returns per server (or, for criterion 1, from the filter already applied)
— no extra research, no subjective call — and each drop count is itself
evidence about the state of the public registry, the same spirit as
decision #12's "the count is itself a dataset finding."

**Correction, Phase 2.5:** criterion 1 as originally written ("survives
the `registryType: npm` filter") is trivially 100%-true by construction —
every candidate reaching the curation bar already passed that filter to
get there, so it measured nothing. Implemented instead as a real
`registry.npmjs.org` lookup: the MCP registry's self-reported
`registryType: npm` + `identifier` is one registry's claim about another,
and a stale or typo'd `identifier` would otherwise sail through
undetected. One extra HTTP call per candidate, bounded-concurrency
batched (20 at a time) rather than one at a time, given the real
candidate count turned out to be in the thousands (see below) — cheap
individually, not free in aggregate at that scale.

**Also found, not anticipated when this decision was written: real
registry scale.** A live crawl (`scripts/snapshot-registry.ts`, Phase
2.5) found several thousand `registryType: npm` "latest" candidates —
Phase 5's "seed list expanded toward 50–60 candidates" (PLAN.md) assumed
a pool not much larger than that target; the real pool is roughly two
orders of magnitude bigger, mostly the noisy long tail spike 3 already
warned about (near-duplicate, single-purpose, low-effort namespaces).
This curation bar alone won't get from thousands down to 50–60 — Phase 5
will need an additional selection step on top of it (the drop counts
recorded here narrow the field but don't fully rank it). Not resolved
here — flagged for whoever scopes Phase 5's actual seed-expansion method.
Exact numbers recorded in `data/registry/2026-09-05.json` and
PROGRESS.md, not restated here since the registry's size will move.

**Also found, running the bar for real: it barely filters anything —
that's the finding, not a failed filter.** 7,745 of 8,186 npm candidates
survive all three criteria — 95%. Spike 3 observed a visibly noisy long
tail by eye (near-duplicate, single-purpose, low-effort namespaces), but
none of these three mechanical signals actually catches that kind of
noise: a one-off wrapper published last week still resolves on npm,
still passes the 12-month recency check by construction (it's brand new),
and adding a repository link costs a publisher nothing. The 5% this bar
does drop (35 unresolvable, 406 missing a repo link, 0 failing recency)
is real and worth keeping, but it answers "is this minimally
well-formed," not "is this worth including in a curated dataset" — those
turned out to be different questions. Recorded here rather than treated
as a bug in the bar: **metadata-based quality signals don't separate
signal from noise in this ecosystem.** Phase 5's selection method (see
below, and PLAN.md's Phase 5 section) needs to account for this rather
than assume a stronger curation bar would fix it.

## 18. Dataset file layout, and v1's seed list is 10 servers by design

**Decision:** three separate artifacts under `data/`, not one:

- `data/seed-list.json` — the fixed, hand-committed v1 seed list (not
  regenerated by the daily workflow). Each entry: `name`, `package` (the
  real `npx -y` target — the registry's own namespaced `name` is never
  this), `bucket`, and bucket-specific context (`spawnArgs`,
  `promotionEnv`, `note`/`caveat`/`reason`).
- `data/snapshots/<ISO-date>.json` — the daily collector's output
  (`scripts/run-collector.ts`, wired into `collect.yml`): one dated file
  per run, each server reduced to its per-tool/per-prompt hashes and the
  three token counts plus `frameTokens`/`contextBudget`/`schemaReuseRatio`
  server-wide. `list-auth-required`/`list-timeout` entries carry only
  their bucket + reason, no measurement fields, per decision #12.
- `data/registry/<ISO-date>.json` — the occasional, hand-triggered
  registry-scale snapshot (`scripts/snapshot-registry.ts`, decision #17's
  correction above): total/latest/by-registryType tallies and the
  curation-bar drop counts. Counts only, not the multi-thousand-entry
  candidate list itself — keeps the file small and diffable (decision
  #13), and the raw list is reproducible from a re-run if ever needed.

**v1's seed list is Phase 0 spike 3's already-probed 10 servers, reused
verbatim (bucket assignments hand-transcribed from `docs/spikes/phase-0.md`,
not re-probed) — a scope decision, not a limitation left for later.**

**Alternatives rejected:**

- Auto-probing a fresh slice of the real registry for v1 (e.g. the first
  ~100 npm candidates encountered) — rejected: that spawns real,
  never-before-run third-party code on the same run where the collector
  meets GitHub Actions for the first time, mixing two independent
  failure sources (a bad candidate vs. a broken workflow) on a job with
  no track record yet. The already-probed 10 carry zero new spawn risk
  and already cover all four buckets (7 `list-open`, 2 promoted
  `list-env-gated`, 1 `list-timeout`).
- One combined `data/` file instead of three — rejected: the registry
  snapshot and the daily collector snapshot are on different cadences
  (occasional vs. daily) and answer different questions (how big/noisy is
  the public registry vs. what did the seed list's own servers report
  today); folding them together would make the daily diff noisy with a
  number that isn't changing daily.

**Why:** Phase 2.5's stated job is getting the cron running, not building
a representative sample (PLAN.md's own ~0.5-day budget for this phase
assumes reusing known-good data, not a fresh probe at scale) — Phase 5
already owns seed-list expansion, now informed by the real registry-scale
finding in decision #17's correction above. Recording this explicitly in
PROGRESS.md too, so a later session doesn't read "10 servers" as an
unfinished seed list and expand it out of phase.

## 19. Drift classifier algorithm (Phase 3)

**Decision:** `src/lock/diff.ts` implements decision #7's four classes as
a real structural diff, not just a hash-equality check:

- **Text drift** (`prompt-drift`) is computed from the stored
  `description` text directly — the tool/prompt's own description, plus
  each property's/argument's description, but **only for properties or
  arguments present on both sides of the comparison.** Deliberately not
  driven by `promptHash` equality: `promptHash`'s payload includes every
  property's description, including ones that exist on only one side, so
  a brand-new optional property (which necessarily introduces a new
  description too) would move `promptHash` and get double-counted as
  prompt-drift on top of its own correct schema-additive finding. Caught
  by Phase 3's own end-to-end test failing against exactly this case
  before it shipped — not a hypothetical.
- **Structural drift** (`schema-breaking`/`schema-additive`) walks
  `inputSchema.properties` (tools) or `arguments` (prompts), only when
  `schemaHash` differs: a removed property/argument, a new property/
  argument (required → breaking, optional → additive), a property's
  `type` changing, a `required[]` membership flip (added → breaking,
  removed → additive), or — added in Phase 4 — an `enum` membership
  change (a value removed → breaking, values only added → additive).
  **A `schemaHash` change matching none of these known patterns defaults
  to `schema-breaking`** rather than passing silently — the same
  "silence is the wrong default" stance decision #7 already takes for
  prompt-drift, applied to the classifier's own blind spots. PLAN.md's
  Phase 4 ("classifier edge cases") owns narrowing this default further
  as new cases are found.
- **Rename detection** (Phase 4): a disappeared tool/prompt and a new
  one that carries an *identical* `schemaHash` are reported as one
  `schema-breaking` "renamed from …" finding, not an unrelated
  `tool removed` + `new tool` pair (the additive half of which was
  always misleading — a rename is not a new capability). A 256-bit
  structural-hash collision between a removed and an added entry of the
  same server isn't a coincidence worth guarding against, and the
  severity is `fail` either way, so a wrong inference costs a clearer
  message, never a wrong CI outcome. A rename that also rewrites the
  description still reports the `prompt-drift` separately.
- **Annotation drift** (Phase 4): `tools.lock` now stores each tool's
  `annotations` block verbatim (decision #4), so a `readOnlyHint` flip
  or a `title` reword is reported as `prompt-drift` (fail) naming the
  changed hint — not left as an unexplained `promptHash` move. Compared
  via JCS so key-order noise doesn't register.
- **Cost drift** applies decision #16's stub thresholds literally
  (`COST_DRIFT_TOOL_THRESHOLD = 0.15`, `COST_DRIFT_BUDGET_THRESHOLD =
  0.10`): per-tool `canonicalTokens` growth over 15%, or server-wide
  `contextBudget` growth over 10%.

**Alternatives rejected:**

- Driving all four classes off hash equality alone (`schemaHash`/
  `promptHash` changed → fire) — cheaper, but can't distinguish
  `schema-breaking` from `schema-additive` at all (both just move
  `schemaHash`), which decision #7 requires distinguishing by definition.
  This is exactly why decision #6 was amended to store full tool/prompt
  content, not just hashes — the classifier needs the old shape, not
  just proof that it changed.
- Silently passing on an unrecognized `schemaHash` change (only report
  what's explicitly matched) — rejected for the same reason a rug-pulled
  description can't be allowed to warn-and-continue: an unclassified
  structural change is exactly the case where staying quiet is most
  dangerous, so it fails loud by default instead.

**Why:** decision #7 named the four classes and their pass/fail policy
but didn't specify how to tell them apart from two lockfile snapshots —
this decision fills that in with the concrete algorithm actually
shipped, verified against a real spawned fixture server (not just unit
fixtures) in Phase 3's end-to-end test.

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
- `$ref` inlining assumes non-cyclic schemas. Phase 0 spike 4 tested the
  one real `$ref`-bearing server found and ran an actual cycle detector
  against all 24 of its tools: zero cycles, max nesting depth 2. Given
  that, Phase 2's cycle detector treats a detected cycle as a **hard
  capture failure** for that tool — loud and specific, not a silent
  opaque-`$ref`-marker fallback (an earlier idea, dropped: guessing at a
  structural hash for content we couldn't actually inline is the same
  mistake `wireTokens`'s null-on-mismatch rule (decision #5) exists to
  avoid elsewhere). **Mitigation:** if a real cyclic schema surfaces
  later, this gets revisited with real data instead of speculative
  handling now; documented in PLAN.md's risk table.
- ~~`annotations` factor into `promptHash` but aren't stored in
  `tools.lock`, so an annotations-only change moves `promptHash` with no
  way for `verify` to say what changed.~~ **Closed in Phase 4:**
  `LockedTool` gained an `annotations` field (the SDK block verbatim, or
  `null`), `build.ts` populates it, and decision #19's classifier reports
  an annotation change as `prompt-drift` naming the changed hint. See
  decision #4 and decision #19's Phase 4 amendments.
- The classifier's rename detection (decision #19, Phase 4) infers a
  rename from `schemaHash` equality alone. A server that legitimately
  removes one tool and adds a structurally-identical unrelated one in the
  same release will be reported as a rename. **Mitigation:** severity is
  `fail` either way, so CI behaviour is unaffected; `update`'s diff shows
  the real before/after for a human to read. Low stakes by construction,
  not a gap left open by omission.
