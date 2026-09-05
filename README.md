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

- [PLAN.md](PLAN.md) — phased build plan, cut-line, risks
- [DECISIONS.md](DECISIONS.md) — why each design choice was made
- [PROGRESS.md](PROGRESS.md) — current state