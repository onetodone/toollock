import { capture } from "../mcp/capture.js";
import { connect, killTransport, type ServerSpec } from "../mcp/connect.js";
import { buildLockedServer } from "./build.js";
import { classifyServerDrift, hasFailingDrift } from "./diff.js";
import { DEFAULT_LOCK_FILE_PATH, readLockFile, writeLockFile } from "./io.js";
import { upsertServer, type LockedServer } from "./schema.js";

export interface ServerTarget {
  id: string;
  command: string;
  args: string[];
}

export interface RunResult {
  exitCode: number;
  output: string;
}

/**
 * Real ambient environment, filtered to defined values only. Deliberately
 * different from the collector (`src/collector/snapshot.ts`), which
 * passes only placeholder env vars to stay zero-secrets (DECISIONS.md
 * #11) — that constraint is specific to the unattended dataset workflow.
 * `init`/`verify`/`update` run locally, for a user checking their own
 * configured server, so they inherit the shell's environment the way any
 * normal child process would; withholding it would silently break every
 * auth-gated server a real user actually runs against.
 */
function currentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function captureServer(target: ServerTarget): Promise<LockedServer> {
  const spec: ServerSpec = { command: target.command, args: target.args, env: currentEnv() };
  const server = await connect(spec);
  try {
    const result = await capture(server);
    return buildLockedServer({ id: target.id, command: target.command, args: target.args, result });
  } finally {
    killTransport(server.transport);
  }
}

function formatFindings(id: string, findings: ReturnType<typeof classifyServerDrift>, indent = ""): string {
  return findings.map((f) => `${indent}${id}: [${f.severity.toUpperCase()}] ${f.class} (${f.scope} "${f.name}"): ${f.message}\n`).join("");
}

/** Captures a server fresh and writes it into tools.lock — a blind write, no diff shown, since a brand-new entry has nothing to diff against. Re-running against an already-locked id overwrites it the same way; `update` is the command that shows what changed first. */
export async function runInit(target: ServerTarget, lockFilePath: string = DEFAULT_LOCK_FILE_PATH): Promise<RunResult> {
  const locked = await captureServer(target);
  writeLockFile(upsertServer(readLockFile(lockFilePath), locked), lockFilePath);
  return { exitCode: 0, output: `Locked ${target.id}: ${locked.tools.length} tool(s), ${locked.prompts.length} prompt(s).\n` };
}

function selectTargets(lockFile: ReturnType<typeof readLockFile>, ids: string[] | null): { targets: LockedServer[]; missing: string[] } {
  if (!ids) {
    return { targets: lockFile.servers, missing: [] };
  }
  const byId = new Map(lockFile.servers.map((s) => [s.id, s]));
  const targets = ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  const missing = ids.filter((id) => !byId.has(id));
  return { targets, missing };
}

/** Read-only: re-captures every (or the named) locked server and classifies drift against what's stored. Never writes tools.lock. Exit 1 on any fail-severity finding (schema-breaking/prompt-drift) or a capture failure; exit 0 otherwise, including when there are only warn-severity findings. */
export async function runVerify(ids: string[] | null, lockFilePath: string = DEFAULT_LOCK_FILE_PATH): Promise<RunResult> {
  const lockFile = readLockFile(lockFilePath);
  const { targets, missing } = selectTargets(lockFile, ids);
  if (missing.length > 0) {
    return { exitCode: 1, output: `Not in tools.lock: ${missing.join(", ")}. Run "toollock init" first.\n` };
  }
  if (targets.length === 0) {
    return { exitCode: 0, output: "tools.lock has nothing to verify.\n" };
  }

  let output = "";
  let failed = false;
  for (const oldServer of targets) {
    let fresh: LockedServer;
    try {
      fresh = await captureServer({ id: oldServer.id, command: oldServer.command, args: oldServer.args });
    } catch (err) {
      failed = true;
      output += `${oldServer.id}: FAILED to capture — ${err instanceof Error ? err.message : String(err)}\n`;
      continue;
    }
    const findings = classifyServerDrift(oldServer, fresh);
    if (findings.length === 0) {
      output += `${oldServer.id}: OK, no drift\n`;
      continue;
    }
    output += formatFindings(oldServer.id, findings);
    if (hasFailingDrift(findings)) failed = true;
  }
  return { exitCode: failed ? 1 : 0, output };
}

/** Re-captures every (or the named) locked server, shows the diff against what's stored, then rewrites tools.lock to match — the explicit, human-invoked acceptance step (DECISIONS.md #6/#7: "diff shown, never silent, never auto-approved"). */
export async function runUpdate(ids: string[] | null, lockFilePath: string = DEFAULT_LOCK_FILE_PATH): Promise<RunResult> {
  let lockFile = readLockFile(lockFilePath);
  const { targets, missing } = selectTargets(lockFile, ids);
  if (missing.length > 0) {
    return { exitCode: 1, output: `Not in tools.lock: ${missing.join(", ")}. Run "toollock init" first.\n` };
  }
  if (targets.length === 0) {
    return { exitCode: 0, output: "tools.lock has nothing to update.\n" };
  }

  let output = "";
  for (const oldServer of targets) {
    const fresh = await captureServer({ id: oldServer.id, command: oldServer.command, args: oldServer.args });
    const findings = classifyServerDrift(oldServer, fresh);
    output += findings.length === 0 ? `${oldServer.id}: no changes\n` : formatFindings(oldServer.id, findings);
    lockFile = upsertServer(lockFile, fresh);
  }
  writeLockFile(lockFile, lockFilePath);
  return { exitCode: 0, output };
}
