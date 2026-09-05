import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ServerCapabilities, Implementation } from "@modelcontextprotocol/sdk/types.js";

export interface ServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ConnectedServer {
  client: Client;
  transport: StdioClientTransport;
  process: ChildProcess;
  capabilities: ServerCapabilities;
  serverInfo: Implementation | undefined;
}

// Sized for a cold `npx -y` install with no local npm cache — the actual
// condition on an ephemeral CI runner, not a warm-cache dev machine.
export const CONNECT_TIMEOUT_MS = 30_000;
export const LIST_TIMEOUT_MS = 15_000;

export function npxServerSpec(pkg: string, extraArgs: string[] = []): ServerSpec {
  return { command: "npx", args: ["-y", pkg, ...extraArgs] };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function withListTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return withTimeout(promise, LIST_TIMEOUT_MS, label);
}

/**
 * The SDK doesn't expose the spawned child process publicly, but
 * capture.ts needs it to tee raw stdout (DECISIONS.md #5 — wireTokens
 * cannot be sourced from Client.listTools()'s Zod-reconstructed return
 * value). Reached via the transport's private field, stable across the
 * exact SDK version this package pins (DECISIONS.md #15).
 */
function getChildProcess(transport: StdioClientTransport): ChildProcess {
  const proc = (transport as unknown as { _process?: ChildProcess })._process;
  if (!proc) {
    throw new Error("StdioClientTransport has no child process — was connect() called?");
  }
  return proc;
}

/**
 * Spawn + capability-checked connect. The Client is constructed with
 * `enforceStrictCapabilities: true` explicitly (Phase 0 spike 2): by
 * default the SDK does *not* guard capability-gated calls locally, and a
 * call like `listPrompts()` on a server without that capability just
 * round-trips over the wire and relays whatever the server happens to
 * return — never a guaranteed contract to rely on.
 */
export async function connect(spec: ServerSpec): Promise<ConnectedServer> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: spec.env,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "toollock", version: "0.0.0" },
    { capabilities: {}, enforceStrictCapabilities: true },
  );

  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "connect");
  } catch (err) {
    killTransport(transport);
    throw err;
  }

  return {
    client,
    transport,
    process: getChildProcess(transport),
    capabilities: client.getServerCapabilities() ?? {},
    serverInfo: client.getServerVersion(),
  };
}

/** Close the transport and, if the child process didn't exit on its own, SIGKILL it. Never leaves a spawned server running. */
export function killTransport(transport: StdioClientTransport): void {
  try {
    transport.close();
  } catch {
    // already closed
  }
  let proc: ChildProcess;
  try {
    proc = getChildProcess(transport);
  } catch {
    return;
  }
  if (proc.exitCode === null && !proc.killed) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}
