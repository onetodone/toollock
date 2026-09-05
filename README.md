# toollock

A lockfile for MCP tool and prompt definitions. Tool descriptions are prompts
injected into a model's context, they cost tokens on every call, and a server
can change them silently between runs. `toollock` records what it saw and
fails CI when it changes.

For scale: GitHub's official MCP server has been reported elsewhere at
roughly 42,000 tokens of tool definitions before a single prompt is sent
([getunblocked.com](https://getunblocked.com/blog/github-mcp-token-cost/),
attributing the measurement to a third party). That's a cited external
number, not one of `toollock`'s own dataset entries — `github-mcp-server`
ships only as a Docker image and falls outside this project's npm-only
collector (see PLAN.md's "Considered and deferred").

**Status:** early, in active development. No usable release yet.

- [PLAN.md](PLAN.md) — phased build plan, cut-line, risks
- [DECISIONS.md](DECISIONS.md) — why each design choice was made
- [PROGRESS.md](PROGRESS.md) — current state