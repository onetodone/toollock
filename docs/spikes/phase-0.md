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
