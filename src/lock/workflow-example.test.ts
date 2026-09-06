import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

// PLAN.md Phase 4 DoD: "the example workflow YAML parses/lints." Run for
// real against every workflow file the repo ships — the copy-paste
// consumer example and the collector's own workflow — so a stray tab or
// unclosed quote fails `npm test`, not a user's first CI run.

const workflowFile = (name: string): string =>
  fileURLToPath(new URL(`../../.github/workflows/${name}`, import.meta.url));

function parseWorkflow(name: string): Record<string, unknown> {
  const parsed = parse(readFileSync(workflowFile(name), "utf8")) as Record<string, unknown>;
  assert.ok(parsed && typeof parsed === "object", `${name} did not parse to a mapping`);
  return parsed;
}

test("toollock-verify.yml.example parses and has the shape a consumer needs", () => {
  const wf = parseWorkflow("toollock-verify.yml.example");

  // `on:` must survive as a real key — the yaml package's 1.2 schema
  // keeps it a string rather than folding it to boolean `true` the way
  // YAML 1.1 would.
  const on = wf.on as Record<string, unknown>;
  assert.ok(on, "no `on:` triggers");
  assert.ok("schedule" in on, "the scheduled trigger is the whole reason to run this — a server can drift with no commit to your repo");
  assert.ok("pull_request" in on);

  assert.deepEqual(wf.permissions, { contents: "read" }, "verify is read-only");

  const steps = ((wf.jobs as Record<string, { steps?: Array<Record<string, unknown>> }>).verify?.steps ?? []) as Array<Record<string, unknown>>;
  const runsToollock = steps.some((s) => typeof s.run === "string" && /toollock(@[^\s]+)?\s+verify/.test(s.run));
  assert.ok(runsToollock, "no step actually runs `toollock verify`");
});

test("collect.yml (the shipped collector workflow) parses and stays data/-scoped", () => {
  const wf = parseWorkflow("collect.yml");
  assert.deepEqual(wf.permissions, { contents: "write" });

  const steps = ((wf.jobs as Record<string, { steps?: Array<Record<string, unknown>> }>).collect?.steps ?? []) as Array<Record<string, unknown>>;
  const commitStep = steps.map((s) => s.run).filter((r): r is string => typeof r === "string").join("\n");
  assert.match(commitStep, /git add data\//, "the collector must stage only data/ (DECISIONS.md #13)");
  assert.doesNotMatch(commitStep, /git add -A|git add \.\s/, "a broad add would let the collector commit outside data/");
});
