import type { Prompt, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectedServer } from "./connect.js";
import { withListTimeout } from "./connect.js";

export interface WireTools {
  /** Each tool's raw JSON, original wire key order, exactly as the server sent it. `null` when the cross-check below fails. */
  raw: unknown[] | null;
  crossCheckOk: boolean;
  reason: string | null;
}

export interface CaptureResult {
  serverInfo: ConnectedServer["serverInfo"];
  capabilities: ConnectedServer["capabilities"];
  tools: Tool[];
  /** `null` when the server didn't declare the `prompts` capability — distinct from an empty list. */
  prompts: Prompt[] | null;
  wireTools: WireTools;
}

/**
 * Captures tools/list (paginated) and, if declared, prompts/list
 * (paginated), plus the raw wire-order bytes of the tools/list response
 * needed for `wireTokens` (Phase 2, DECISIONS.md #5).
 *
 * The raw bytes come from an independent tee of the child process's own
 * stdout, run in parallel with (not instead of) the normal `Client`
 * calls below — Node streams allow multiple `'data'` listeners on the
 * same stream, so this doesn't disturb the SDK's own parsing.
 * `Client.listTools()`'s return value cannot be used for this: every
 * incoming message is Zod-validated before the Client sees it, and
 * Zod's `.parse()` rebuilds the object in the SDK's own schema field
 * order, not the server's original order (Phase 0 spike 5).
 */
export async function capture(server: ConnectedServer): Promise<CaptureResult> {
  const { client, process, capabilities } = server;

  // Always non-null in practice: connect.ts always spawns with
  // stdio: ['pipe', 'pipe', ...] (the SDK's own StdioClientTransport
  // default). Asserted explicitly rather than silently trusting it.
  const stdout = process.stdout;
  if (!stdout) {
    throw new Error("child process has no stdout stream — was it spawned without 'pipe'?");
  }

  const rawToolsLines: string[] = [];
  let stdoutBuffer = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    let newlineIndex: number;
    while ((newlineIndex = stdoutBuffer.indexOf(0x0a)) !== -1) {
      const line = stdoutBuffer.subarray(0, newlineIndex).toString("utf8").replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.subarray(newlineIndex + 1);
      try {
        const message = JSON.parse(line) as { result?: { tools?: unknown } };
        if (message?.result && Array.isArray(message.result.tools)) {
          rawToolsLines.push(line);
        }
      } catch {
        // Not a tools/list response (or stdout noise) — the cross-check
        // below is what actually catches noise, not this catch block.
      }
    }
  };
  stdout.on("data", onData);

  const tools = await paginatedListTools(client);

  let prompts: Prompt[] | null = null;
  if (capabilities.prompts) {
    prompts = await paginatedListPrompts(client);
  }

  // The tee runs off the same stdout chunks as the SDK's own parser but
  // slightly behind it (listTools()'s promise resolves as soon as the
  // Client's own parse completes); give it a moment to catch up before
  // reading what it collected.
  await new Promise((resolve) => setTimeout(resolve, 200));
  stdout.off("data", onData);

  return {
    serverInfo: server.serverInfo,
    capabilities,
    tools,
    prompts,
    wireTools: crossCheckWireTools(rawToolsLines, tools),
  };
}

async function paginatedListTools(client: ConnectedServer["client"]): Promise<Tool[]> {
  const all: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await withListTimeout(client.listTools(cursor ? { cursor } : undefined), "listTools");
    all.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

async function paginatedListPrompts(client: ConnectedServer["client"]): Promise<Prompt[]> {
  const all: Prompt[] = [];
  let cursor: string | undefined;
  do {
    const page = await withListTimeout(client.listPrompts(cursor ? { cursor } : undefined), "listPrompts");
    all.push(...page.prompts);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/**
 * A server that logs non-JSON-RPC noise to stdout would corrupt the
 * tee's line-splitting while the SDK's own `Client` fails loudly on the
 * same response (Phase 0 spike 1 sampled 5 clean servers; a larger seed
 * list will find one that isn't). So the raw tee is only trusted once
 * it's confirmed to describe the same tool set the `Client` returned —
 * same names, same count. On any mismatch, `wireTokens`'s eventual
 * source (`raw`) is `null` with a reason: a missing measurement is
 * recoverable, a wrong one in a published dataset is not.
 */
function crossCheckWireTools(rawLines: string[], clientTools: Tool[]): WireTools {
  if (rawLines.length === 0) {
    return { raw: null, crossCheckOk: false, reason: "no raw tools/list line captured on the stdout tee" };
  }

  let rawTools: unknown[];
  try {
    rawTools = rawLines.flatMap((line) => (JSON.parse(line) as { result: { tools: unknown[] } }).result.tools);
  } catch (err) {
    return { raw: null, crossCheckOk: false, reason: `raw tee line(s) failed to parse: ${String(err)}` };
  }

  const rawNames = rawTools.map((t) => (t as { name?: unknown }).name);
  const clientNames = clientTools.map((t) => t.name);
  const sameSet =
    rawNames.length === clientNames.length &&
    new Set(rawNames).size === new Set(clientNames).size &&
    rawNames.every((n) => clientNames.includes(n as string));

  if (!sameSet) {
    return {
      raw: null,
      crossCheckOk: false,
      reason: `tee/Client tool-set mismatch: tee saw ${rawNames.length} tool(s) (${rawNames.join(", ")}), Client saw ${clientNames.length} (${clientNames.join(", ")})`,
    };
  }

  return { raw: rawTools, crossCheckOk: true, reason: null };
}
