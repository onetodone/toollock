import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

let cachedNpmCacheDir: string | null = null;

function getNpmCacheDir(): string {
  if (cachedNpmCacheDir === null) {
    cachedNpmCacheDir = execFileSync("npm", ["config", "get", "cache"], { encoding: "utf8" }).trim();
  }
  return cachedNpmCacheDir;
}

/**
 * The npm package version `npx -y <pkg>` actually resolved for the run
 * that just happened — read from the npx cache's own `package.json`
 * rather than a pre-spawn `npm view` query (Phase 0 spike 7: same
 * answer, zero extra network round-trip, and it reflects what actually
 * got spawned rather than a prediction). `npmCacheDir` is injectable so
 * tests can point this at a throwaway fixture directory instead of the
 * real global npm cache.
 *
 * `null` only when nothing matches at all — the package failed to
 * resolve/install, distinct from a server that installs fine but fails
 * at the MCP-protocol level (decision #6).
 */
export function readObservedVersion(packageName: string, npmCacheDir: string = getNpmCacheDir()): string | null {
  const npxDir = path.join(npmCacheDir, "_npx");
  if (!existsSync(npxDir)) return null;

  let latest: { file: string; mtimeMs: number } | null = null;
  for (const hash of readdirSync(npxDir)) {
    const pkgJsonPath = path.join(npxDir, hash, "node_modules", packageName, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    const mtimeMs = statSync(pkgJsonPath).mtimeMs;
    if (!latest || mtimeMs > latest.mtimeMs) {
      latest = { file: pkgJsonPath, mtimeMs };
    }
  }
  if (!latest) return null;

  const parsed = JSON.parse(readFileSync(latest.file, "utf8")) as { version?: string };
  return parsed.version ?? null;
}
