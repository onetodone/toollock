# Proxy servers: `tools/list` is not a function of the package version

**Date:** 2026-09-06
**Server:** `@sentry/mcp-server@0.39.0`
**Status:** first real measurement the dataset produced; recorded here
because the raw detail (three tool counts, timestamps, hashes) will be
gone from the live registry in a week.

## Observation

`@sentry/mcp-server` returned three different tool lists inside 24 hours
from **the same npm artifact**, with `serverInfo.version` and
`observedVersion` both reporting `0.39.0` at every point:

| When (UTC)             | How                                              | Tools | `contextBudget` | `canonicalTokens` |
| --------------------- | ------------------------------------------------ | ----: | --------------: | ----------------: |
| 2026-09-05 16:09:55   | `npm run collect` (manual, commit `3a604d4`)     | **9** |           6,086 |             5,439 |
| 2026-09-06 10:22:03   | scheduled CI (`gh run 34027191061`, `7d99cd3`)   | **22**|          14,379 |            13,841 |
| 2026-09-06 16:15–16:22| manual re-probe ×4 (2× `snapshotServer`, 2× raw) | **9** |           6,086 |             5,439 |

All seven tools common to the 9- and 22-tool sets had a **different
`schemaHash`** between the 09-05 and 09-06 snapshots — not just the set
size changed, the shared tools' structures did too.

Package facts, checked not assumed:
- `npm view @sentry/mcp-server time` — `0.39.0` published
  `2026-08-27T06:47Z`; `0.38.0` the day before; **nothing published on
  09-05 or 09-06**. No release explains the change.
- `serverInfo.version` (from `initialize`) and `observedVersion` (read
  from the npx cache's `package.json`, `src/lock/observedVersion.ts`)
  were both `0.39.0` in every 9-tool probe. The 22-tool run's package
  was the same artifact, so its `serverInfo.version` was `0.39.0` too.

## The two shapes

- **9-tool ("compact") set:** `analyze_issue_with_seer`,
  `execute_sentry_tool`, `find_organizations`, `find_projects`,
  `get_sentry_resource`, `search_events`, `search_issues`,
  `search_sentry_tools`, `update_issue`. Note `execute_sentry_tool` and
  `search_sentry_tools` — meta-tools that reach the rest of the catalog
  indirectly.
- **22-tool ("full") set:** drops the two meta-tools, adds 15 explicit
  ones (`create_dsn`, `create_project`, `create_team`, `find_dsns`,
  `find_releases`, `find_teams`, `get_doc`, `get_event_attachment`,
  `get_issue_tag_values`, `get_profile_details`, `get_replay_details`,
  `search_docs`, `search_issue_events`, `update_project`, `whoami`).

## Why this happens

`@sentry/mcp-server` is a **proxy** — the local process forwards
`tools/list` to Sentry's hosted MCP backend (the same architecture as
`@stripe/mcp`, which is why Stripe is bucketed `list-timeout`: its
backend 401s a placeholder token and the local process hangs). The tool
list is whatever that remote backend returns at request time. It is not
baked into the npm package, so it is not pinned by version, `npx -y`
resolution, or anything `toollock` can see. The compact/full split is
most likely a backend rollout, regional routing, or load-shedding
behaviour; the invalid placeholder token doesn't change the outcome
(all four 9-tool re-probes used it).

## Consequences for the project

1. **It breaks the lockfile's implicit premise** that identical input
   yields identical output. For locally-generated schemas the premise
   holds — `@modelcontextprotocol/server-everything` and
   `@upstash/context7-mcp` were byte-stable across independent spawns in
   Phase 2's `check-hash-determinism` run, and `@notionhq/notion-mcp-server`
   held across spawns in the Phase 2.5 pass. For a proxy it does not,
   and `toollock verify` would fail on an **unchanged** server for every
   user who locked one during a "compact" window and re-verifies during
   a "full" one (or vice versa).

2. **`toollock` cannot tell a proxy's backend changing from the server
   itself changing** — both are just a different `tools/list` response
   over the same transport. There is no field in the MCP protocol that
   distinguishes them. Recorded as a known limitation in DECISIONS.md.

3. **The bucket is not the predictor.** Sentry is `list-env-gated` and
   unstable; Notion is `list-open` and stable — but that correlation is
   incidental. A `list-open` proxy would behave exactly like Sentry.
   Stability has to be **measured per server**, not inferred from the
   bucket — hence the `stableAcrossSpawns` dataset field (decision #20).

## Reproduce

```
SENTRY_ACCESS_TOKEN=placeholder-not-a-real-credential \
  npx -y @sentry/mcp-server
```
then send `initialize` + `tools/list` (or `npm run collect` with only
this server in the seed list). Expect either 9 or 22 tools depending on
what the backend serves that minute.
