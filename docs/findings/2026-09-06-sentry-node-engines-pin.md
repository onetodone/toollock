# Sentry's 9 → 22 → 9 tools: two package versions, not a proxy

**Date:** 2026-09-06 (observation), corrected 2026-10-08
**Server:** `@sentry/mcp-server`
**Status:** first real drift the dataset recorded. Originally written up
as proxy instability ("`tools/list` is not a function of the package
version"). That explanation was wrong. The tool list is a function of
the package version, and the collector was measuring a different version
on CI than locally. The original observation table is kept below
unchanged, followed by the actual cause.

## Observation (2026-09-06)

| When (UTC)             | How                                              | Tools | `contextBudget` | `canonicalTokens` |
| --------------------- | ------------------------------------------------ | ----: | --------------: | ----------------: |
| 2026-09-05 16:09:55   | `npm run collect` (manual, commit `3a604d4`)     | **9** |           6,086 |             5,439 |
| 2026-09-06 10:22:03   | scheduled CI (`gh run 34027191061`, `7d99cd3`)   | **22**|          14,379 |            13,841 |
| 2026-09-06 16:15–16:22| manual re-probe ×4 (2× `snapshotServer`, 2× raw) | **9** |           6,086 |             5,439 |

All seven tools common to the 9- and 22-tool sets had a different
`schemaHash` between the 09-05 and 09-06 snapshots.

- **9-tool set:** `analyze_issue_with_seer`, `execute_sentry_tool`,
  `find_organizations`, `find_projects`, `get_sentry_resource`,
  `search_events`, `search_issues`, `search_sentry_tools`,
  `update_issue`. `execute_sentry_tool`/`search_sentry_tools` are
  meta-tools that reach the rest of the catalog indirectly.
- **22-tool set:** drops the two meta-tools, adds 15 explicit ones
  (`create_dsn`, `create_project`, `create_team`, `find_dsns`,
  `find_releases`, `find_teams`, `get_doc`, `get_event_attachment`,
  `get_issue_tag_values`, `get_profile_details`, `get_replay_details`,
  `search_docs`, `search_issue_events`, `update_project`, `whoami`).

What the original write-up got wrong: it stated the 22-tool CI run used
the same `0.39.0` artifact. That was assumed, not checked. The 9-tool
runs' version was read from the local npx cache, and the CI run's
version was never recorded anywhere.

## What actually happened (2026-10-08)

Every 9-tool run was local, on Node 22. The 22-tool run was the first
scheduled CI run, on Node 20 (`collect.yml`'s `node-version: '20'`).

`@sentry/mcp-server` declares `engines.node >=20` up to 0.36.0 and
`>=22.13` from 0.37.0 on. For a bare `npx -y @sentry/mcp-server`, npm
picks the newest version whose `engines.node` accepts the running Node,
not simply the `latest` tag. So:

- local, Node 22 → `latest` (0.39.0 at the time) → **9 tools**
- CI, Node 20 → **0.36.0** → **22 tools**

Checked on 2026-10-08, not inferred:

- Under Node 20, `npm view @sentry/mcp-server version` reports `0.42.0`,
  and `npx` installs `0.36.0`.
- Capturing `@sentry/mcp-server@0.36.0` explicitly reproduces the CI
  snapshot: 22 tools, every `schemaHash`/`promptHash` identical.
- Capturing `@latest` (0.42.0) gives the 9-tool set. Its hashes match
  09-05's (0.39.0) for every tool except `update_issue` (schema and
  description changed) and `search_events` (description changed).
- In 0.42.0 the 9-tool list is a hardcoded constant in the package
  (`TOP_LEVEL_TOOL_NAMES`). The server registers those tools locally and
  answers `tools/list` itself. Nothing is forwarded to a backend.

The same pin explains the following month. 31 scheduled runs
(2026-09-07 → 2026-10-07) all reported `0 drifted`, with Sentry at 22
tools every day, while 0.40.0, 0.41.0 and 0.42.0 were published. CI was
capturing 0.36.0 the whole time.

## Consequences for the project

1. **The lockfile premise holds for this server.** The same version gives
   the same `tools/list`. Repeated captures of 0.36.0 and of 0.42.0 are
   each byte-stable. No server in the seed list has been observed
   returning different tools for the same package version.
2. **The collector now spawns an exact version and records it**
   (DECISIONS.md #21). Both workflows run Node 22. Each snapshot server
   resolves the `latest` dist-tag and spawns `<pkg>@<version>`, so
   neither the runner's Node nor a warm npx cache can substitute an older
   release, and `observedVersion` is in every snapshot record.
3. **`stableAcrossSpawns` and the per-bucket drift count stay**
   (DECISIONS.md #20). They're cheap, and a genuine proxy server would
   need them. But they're precautions now, not responses to an observed
   instance.
4. **The first run after the fix will show Sentry drifting 22 → 9.** That
   is the real 0.36.0 → 0.42.0 change landing once, not instability.

## Reproduce

```
SENTRY_ACCESS_TOKEN=placeholder-not-a-real-credential npx -y @sentry/mcp-server@0.36.0   # 22 tools
SENTRY_ACCESS_TOKEN=placeholder-not-a-real-credential npx -y @sentry/mcp-server@0.42.0   # 9 tools
```

Then send `initialize` + `tools/list`. Either result is the same on any
Node and on every run. To see the resolution difference itself, run a
bare `npx -y @sentry/mcp-server` under Node 20 and then under Node 22
with an empty npx cache.
