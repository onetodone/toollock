/**
 * Spawns each given server package twice, independently, and confirms
 * schemaHash/promptHash agree across the two spawns for every tool and
 * prompt. `hash.test.ts`'s "determinism" test only proves the
 * canonicalizer is a pure function of an in-memory object — it says
 * nothing about whether two real process spawns of the same server
 * actually produce that same object. `verify` (Phase 3) depends on the
 * latter: if a real server embeds anything unstable across runs (a
 * timestamp, a generated id, a per-process value in a description),
 * `verify` would fail for every user on a server that hasn't changed at
 * all — the worst failure mode this tool can have. That's a real spawn
 * each time, so this stays out of `npm test` (Phase 2's suite is
 * deliberately network-free) — run by hand or before Phase 2.5.
 *
 * Usage: npx tsx scripts/check-hash-determinism.ts [pkg ...]
 * Defaults to server-everything (first-party) and context7-mcp
 * (third-party) when no packages are given.
 */
import type { Prompt, Tool } from "@modelcontextprotocol/sdk/types.js";
import { connect, killTransport, npxServerSpec } from "../src/mcp/connect.js";
import { capture } from "../src/mcp/capture.js";
import {
  computePromptCanonical,
  computePromptHashes,
  computeToolCanonical,
  computeToolHashes,
  type CanonicalStrings,
  type Hashes,
} from "../src/schema/hash.js";

interface SpawnResult {
  tools: Map<string, Hashes>;
  prompts: Map<string, Hashes>;
  toolsByName: Map<string, Tool>;
  promptsByName: Map<string, Prompt>;
}

async function spawnAndHash(pkg: string): Promise<SpawnResult> {
  const server = await connect(npxServerSpec(pkg));
  try {
    const result = await capture(server);
    return {
      tools: new Map(result.tools.map((t) => [t.name, computeToolHashes(t)])),
      prompts: new Map((result.prompts ?? []).map((p) => [p.name, computePromptHashes(p)])),
      toolsByName: new Map(result.tools.map((t) => [t.name, t])),
      promptsByName: new Map((result.prompts ?? []).map((p) => [p.name, p])),
    };
  } finally {
    killTransport(server.transport);
  }
}

function firstDiffIndex(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i;
  }
  return len;
}

function printCanonicalDiff(a: CanonicalStrings, b: CanonicalStrings): void {
  for (const field of ["schemaCanonical", "promptCanonical"] as const) {
    if (a[field] === b[field]) continue;
    const at = firstDiffIndex(a[field], b[field]);
    console.log(`    ${field} differs at byte ${at}:`);
    console.log(`      spawn 1: ...${a[field].slice(Math.max(0, at - 20), at + 40)}...`);
    console.log(`      spawn 2: ...${b[field].slice(Math.max(0, at - 20), at + 40)}...`);
  }
}

function compare(
  kind: "tool" | "prompt",
  first: SpawnResult,
  second: SpawnResult,
): string[] {
  const firstMap = kind === "tool" ? first.tools : first.prompts;
  const secondMap = kind === "tool" ? second.tools : second.prompts;
  const mismatches: string[] = [];

  for (const [name, hashA] of firstMap) {
    const hashB = secondMap.get(name);
    if (!hashB) {
      mismatches.push(`${kind} "${name}": present in spawn 1, missing in spawn 2`);
      continue;
    }
    if (hashA.schemaHash !== hashB.schemaHash || hashA.promptHash !== hashB.promptHash) {
      mismatches.push(
        `${kind} "${name}": ${hashA.schemaHash !== hashB.schemaHash ? "schemaHash" : ""}${
          hashA.schemaHash !== hashB.schemaHash && hashA.promptHash !== hashB.promptHash ? " and " : ""
        }${hashA.promptHash !== hashB.promptHash ? "promptHash" : ""} differ`,
      );
      const canonicalA =
        kind === "tool" ? computeToolCanonical(first.toolsByName.get(name)!) : computePromptCanonical(first.promptsByName.get(name)!);
      const canonicalB =
        kind === "tool" ? computeToolCanonical(second.toolsByName.get(name)!) : computePromptCanonical(second.promptsByName.get(name)!);
      printCanonicalDiff(canonicalA, canonicalB);
    }
  }
  for (const name of secondMap.keys()) {
    if (!firstMap.has(name)) {
      mismatches.push(`${kind} "${name}": present in spawn 2, missing in spawn 1`);
    }
  }
  return mismatches;
}

async function check(pkg: string): Promise<boolean> {
  console.log(`\n=== ${pkg} ===`);
  const first = await spawnAndHash(pkg);
  const second = await spawnAndHash(pkg);

  const mismatches = [...compare("tool", first, second), ...compare("prompt", first, second)];

  if (mismatches.length === 0) {
    console.log(`PASS — ${first.tools.size} tool(s), ${first.prompts.size} prompt(s), all hashes identical across two independent spawns.`);
    return true;
  }
  console.log(`FAIL — ${mismatches.length} mismatch(es):`);
  for (const m of mismatches) console.log(`  - ${m}`);
  return false;
}

async function main() {
  const argPkgs = process.argv.slice(2);
  const pkgs = argPkgs.length > 0 ? argPkgs : ["@modelcontextprotocol/server-everything", "@upstash/context7-mcp"];

  let allPass = true;
  for (const pkg of pkgs) {
    allPass = (await check(pkg)) && allPass;
  }
  process.exitCode = allPass ? 0 : 1;
}

main();
