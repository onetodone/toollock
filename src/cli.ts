#!/usr/bin/env node
import { capture } from "./mcp/capture.js";
import { connect, killTransport, npxServerSpec } from "./mcp/connect.js";
import { runInit, runUpdate, runVerify, type ServerTarget } from "./lock/commands.js";

const USAGE = `Usage:
  toollock capture <npm-package> [-- <extra npx args>]
  toollock init <npm-package> [-- <extra npx args>]
  toollock verify [npm-package ...]
  toollock update [npm-package ...]
`;

function splitExtraArgs(rest: string[]): string[] {
  return rest[0] === "--" ? rest.slice(1) : rest;
}

async function runCapture(argv: string[]): Promise<number> {
  const [pkg, ...rest] = argv;
  if (!pkg) {
    process.stderr.write(USAGE);
    return 1;
  }
  const server = await connect(npxServerSpec(pkg, splitExtraArgs(rest)));
  try {
    const result = await capture(server);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } finally {
    killTransport(server.transport);
  }
}

async function runInitCommand(argv: string[]): Promise<number> {
  const [pkg, ...rest] = argv;
  if (!pkg) {
    process.stderr.write(USAGE);
    return 1;
  }
  const target: ServerTarget = { id: pkg, command: "npx", args: ["-y", pkg, ...splitExtraArgs(rest)] };
  const result = await runInit(target);
  process.stdout.write(result.output);
  return result.exitCode;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "capture":
      return runCapture(rest);
    case "init":
      return runInitCommand(rest);
    case "verify": {
      const result = await runVerify(rest.length > 0 ? rest : null);
      process.stdout.write(result.output);
      return result.exitCode;
    }
    case "update": {
      const result = await runUpdate(rest.length > 0 ? rest : null);
      process.stdout.write(result.output);
      return result.exitCode;
    }
    default:
      process.stderr.write(USAGE);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
