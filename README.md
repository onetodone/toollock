# toollock

A lockfile for MCP tool and prompt definitions. Tool descriptions are prompts
injected into a model's context, they cost tokens on every call, and a server
can change them silently between runs. `toollock` records what it saw and
fails CI when it changes.

For scale: `@notionhq/notion-mcp-server`'s 24 tools cost 17,500 tokens of
wire-format tool definitions before a single prompt is sent — measured
first-hand and byte-reproduced across independent runs, not quoted from
elsewhere (see `docs/spikes/phase-0.md`).

**Status:** early, in active development. No usable release yet.

**Scope:** the collector spawns servers via `npx -y <pkg>` (stdio only).
Of the public MCP registry's 27,231 distinct servers (measured
2026-09-05, `data/registry/2026-09-05.json`), 8,186 — about 30% — ship an
npm package at all; the rest are OCI images, Python/PyPI packages, or
remote-only HTTP endpoints, none of which this collector can spawn.
`toollock` cannot see roughly 70% of the public registry by construction,
not by an oversight — see DECISIONS.md #1/#12 for why stdio/npx-only was
the deliberate starting scope.

## Quickstart

```
npx toollock init @your-org/your-mcp-server
```

Captures the server's tools and prompts, hashes and token-counts each
one, and writes `tools.lock` — commit it.

```
npx toollock verify
```

Re-captures every server in `tools.lock` and compares. Exits `1` if
anything **broke** (a tool was removed, a param became required, a
description's text changed) or `0` if it's clean or only **grew**
additively (a new tool, a new optional param) — run this in CI. Never
writes to `tools.lock`.

```
npx toollock update
```

Re-captures, shows exactly what changed, then rewrites `tools.lock` to
match. This is the only command that writes after `init` — nothing is
ever auto-approved.

`toollock verify [pkg ...]` / `toollock update [pkg ...]` accept one or
more package names to target a subset instead of every locked server.

**Where the `package-lock.json` analogy breaks:** a real lockfile pins a
version and *installs* exactly that artifact every run. `toollock` can't
— every spawn is `npx -y <pkg>`, which always resolves whatever npm
currently calls latest, so pinning the spawn itself would make drift
undetectable (`verify` would just re-spawn the same thing every time).
`tools.lock` instead records what was last **observed** and re-checks
that against what it sees next time. Same shape (a committed, diffable
lockfile), different mechanism underneath (DECISIONS.md #6/#9).

- [PLAN.md](PLAN.md) — phased build plan, cut-line, risks
- [DECISIONS.md](DECISIONS.md) — why each design choice was made
- [PROGRESS.md](PROGRESS.md) — current state