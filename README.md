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

- [PLAN.md](PLAN.md) — phased build plan, cut-line, risks
- [DECISIONS.md](DECISIONS.md) — why each design choice was made
- [PROGRESS.md](PROGRESS.md) — current state