#!/usr/bin/env node
import { connect, killTransport, npxServerSpec } from "./mcp/connect.js";
import { capture } from "./mcp/capture.js";

async function main(argv: string[]): Promise<void> {
  const [command, pkg, ...rest] = argv;

  if (command !== "capture" || !pkg) {
    process.stderr.write("Usage: toollock capture <npm-package> [-- <extra npx args>]\n");
    process.exitCode = 1;
    return;
  }

  const extraArgs = rest[0] === "--" ? rest.slice(1) : rest;
  const server = await connect(npxServerSpec(pkg, extraArgs));
  try {
    const result = await capture(server);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    killTransport(server.transport);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
