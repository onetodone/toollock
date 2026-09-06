import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runBudget, runInit, runUpdate, runVerify, type ServerTarget } from "./commands.js";

// Phase 3's own Definition of Done, run for real: init -> hand-mutate a
// local fixture server's description -> verify exits 1 and names the
// changed hash class -> update shows the diff and rewrites cleanly. Plus
// the equally load-bearing zero-diff case: a no-op re-run of init/verify
// must produce byte-identical tools.lock, or the "human-diffable
// lockfile" claim breaks on every run for every user.
//
// A real npm package can't be hand-mutated reproducibly between two
// captures, so this spawns test/fixtures/fixture-server.ts directly via
// `node` (no npx, no network) with its one tool's shape driven by env
// vars set in this process before each capture.

const fixturePath = fileURLToPath(new URL("../../test/fixtures/fixture-server.ts", import.meta.url));

function target(): ServerTarget {
  return { id: "fixture-server", command: "node", args: ["--import", "tsx", fixturePath] };
}

function withFixtureEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Phase 3 DoD: init -> mutate -> verify fails and names the class -> update rewrites cleanly", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "toollock-e2e-"));
  const lockPath = path.join(dir, "tools.lock");
  try {
    // init
    const initResult = await withFixtureEnv({ FIXTURE_DESCRIPTION: "Echoes the input string", FIXTURE_LIMIT_PARAM: undefined }, () =>
      runInit(target(), lockPath),
    );
    assert.equal(initResult.exitCode, 0);
    const afterInit = readFileSync(lockPath, "utf8");
    assert.match(afterInit, /"echo"/);

    // no-op re-run of init against an unchanged server produces a
    // byte-identical file — the zero-diff guarantee, checked directly
    // rather than assumed.
    await withFixtureEnv({ FIXTURE_DESCRIPTION: "Echoes the input string", FIXTURE_LIMIT_PARAM: undefined }, () => runInit(target(), lockPath));
    assert.equal(readFileSync(lockPath, "utf8"), afterInit, "a no-op re-run of init must not change tools.lock at all");

    // verify against an unchanged server: exit 0, no drift, and it must
    // not have touched the file (read-only).
    const cleanVerify = await withFixtureEnv({ FIXTURE_DESCRIPTION: "Echoes the input string", FIXTURE_LIMIT_PARAM: undefined }, () =>
      runVerify(null, lockPath),
    );
    assert.equal(cleanVerify.exitCode, 0);
    assert.match(cleanVerify.output, /no drift/);
    assert.equal(readFileSync(lockPath, "utf8"), afterInit, "verify must never write to tools.lock");

    // mutate the fixture's description, then verify: exits 1, names
    // prompt-drift specifically (not just "something changed").
    const driftedVerify = await withFixtureEnv({ FIXTURE_DESCRIPTION: "Echoes the input string, loudly", FIXTURE_LIMIT_PARAM: undefined }, () =>
      runVerify(null, lockPath),
    );
    assert.equal(driftedVerify.exitCode, 1);
    assert.match(driftedVerify.output, /prompt-drift/);
    assert.match(driftedVerify.output, /FAIL/);
    assert.equal(readFileSync(lockPath, "utf8"), afterInit, "a failed verify must still never write to tools.lock");

    // update: shows the same finding, then rewrites — the file must
    // actually change this time.
    const update = await withFixtureEnv({ FIXTURE_DESCRIPTION: "Echoes the input string, loudly", FIXTURE_LIMIT_PARAM: undefined }, () =>
      runUpdate(null, lockPath),
    );
    assert.equal(update.exitCode, 0);
    assert.match(update.output, /prompt-drift/);
    const afterUpdate = readFileSync(lockPath, "utf8");
    assert.notEqual(afterUpdate, afterInit);
    assert.match(afterUpdate, /Echoes the input string, loudly/);

    // verify again against the now-current (post-update) description:
    // clean, and — again — a no-op verify changes nothing on disk.
    const verifyAfterUpdate = await withFixtureEnv(
      { FIXTURE_DESCRIPTION: "Echoes the input string, loudly", FIXTURE_LIMIT_PARAM: undefined },
      () => runVerify(null, lockPath),
    );
    assert.equal(verifyAfterUpdate.exitCode, 0);
    assert.equal(readFileSync(lockPath, "utf8"), afterUpdate);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 3: a new optional property is schema-additive — verify warns but exits 0", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "toollock-e2e-additive-"));
  const lockPath = path.join(dir, "tools.lock");
  try {
    await withFixtureEnv({ FIXTURE_DESCRIPTION: "Echoes the input string", FIXTURE_LIMIT_PARAM: undefined }, () => runInit(target(), lockPath));

    const verify = await withFixtureEnv({ FIXTURE_DESCRIPTION: "Echoes the input string", FIXTURE_LIMIT_PARAM: "true" }, () =>
      runVerify(null, lockPath),
    );
    assert.equal(verify.exitCode, 0, "schema-additive is warn-severity — must not fail verify");
    assert.match(verify.output, /schema-additive/);
    assert.match(verify.output, /WARN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerify: a package not in tools.lock is a clean error, not a crash", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "toollock-e2e-missing-"));
  const lockPath = path.join(dir, "tools.lock");
  try {
    const result = await runVerify(["not-locked"], lockPath);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /not-locked/);
    assert.match(result.output, /init/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 4: a tool rename (inputSchema untouched) is caught as a rename, not remove+add", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "toollock-e2e-rename-"));
  const lockPath = path.join(dir, "tools.lock");
  try {
    await withFixtureEnv({ FIXTURE_TOOL_NAME: "echo", FIXTURE_DESCRIPTION: "Echoes the input string", FIXTURE_LIMIT_PARAM: undefined }, () =>
      runInit(target(), lockPath),
    );

    const verify = await withFixtureEnv(
      { FIXTURE_TOOL_NAME: "shout", FIXTURE_DESCRIPTION: "Echoes the input string", FIXTURE_LIMIT_PARAM: undefined },
      () => runVerify(null, lockPath),
    );
    assert.equal(verify.exitCode, 1);
    assert.match(verify.output, /renamed from "echo"/);
    assert.doesNotMatch(verify.output, /new tool/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 4: budget prints a sane table for a real spawned server", { timeout: 60_000 }, async () => {
  const result = await withFixtureEnv(
    { FIXTURE_TOOL_NAME: "echo", FIXTURE_DESCRIPTION: "Echoes the input string", FIXTURE_LIMIT_PARAM: "true" },
    () => runBudget(target()),
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /toollock-fixture-server/);
  assert.match(result.output, /context tokens \(billed on every call\)/);
  assert.match(result.output, /^ {2}echo\s+\d+\s+\d+\.\d+%\s+\d+/m);
  assert.match(result.output, /TOTAL\s+\d+\s+100\.0%/);
});
