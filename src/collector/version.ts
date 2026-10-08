import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The version the `latest` dist-tag points at right now, which the
 * collector then spawns exactly (`<pkg>@<version>`). A bare `npx -y <pkg>`
 * is not that: npm prefers the newest version whose `engines.node`
 * accepts the running Node, and a warm npx cache can serve an older
 * install outright — DECISIONS.md #21. Resolving first and pinning the
 * spawn makes the measured version a fact the collector chose, rather
 * than one read back from the npx cache afterwards (which is what
 * `src/lock/observedVersion.ts` does for `toollock init`, where the user's
 * own spec is spawned as given).
 */
export async function resolveLatestVersion(packageName: string): Promise<string> {
  const { stdout } = await execFileAsync("npm", ["view", packageName, "dist-tags.latest"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  const version = stdout.trim();
  if (!version) throw new Error(`npm view ${packageName} returned no latest dist-tag`);
  return version;
}
