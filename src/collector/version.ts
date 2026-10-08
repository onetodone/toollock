import { execFileSync } from "node:child_process";

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
export function resolveLatestVersion(packageName: string): string {
  const out = execFileSync("npm", ["view", packageName, "dist-tags.latest"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
  if (!out) throw new Error(`npm view ${packageName} returned no latest dist-tag`);
  return out;
}
