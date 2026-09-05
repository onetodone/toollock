import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readObservedVersion } from "./observedVersion.js";

function makeFakeCache(): string {
  return mkdtempSync(path.join(tmpdir(), "toollock-npm-cache-"));
}

function writePackageJson(cacheDir: string, hash: string, pkg: string, version: string, mtime: Date) {
  const dir = path.join(cacheDir, "_npx", hash, "node_modules", pkg);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "package.json");
  writeFileSync(file, JSON.stringify({ name: pkg, version }));
  utimesSync(file, mtime, mtime);
}

test("readObservedVersion: null when the _npx directory doesn't exist at all", () => {
  const cache = makeFakeCache();
  try {
    assert.equal(readObservedVersion("some-pkg", cache), null);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("readObservedVersion: null when no hash directory has this package", () => {
  const cache = makeFakeCache();
  try {
    writePackageJson(cache, "abc123", "other-pkg", "1.0.0", new Date());
    assert.equal(readObservedVersion("some-pkg", cache), null);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("readObservedVersion: reads the version from a single match, scoped package included", () => {
  const cache = makeFakeCache();
  try {
    writePackageJson(cache, "abc123", "@modelcontextprotocol/server-everything", "1.2.3", new Date());
    assert.equal(readObservedVersion("@modelcontextprotocol/server-everything", cache), "1.2.3");
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("readObservedVersion: with two matches (an old cached run and a fresh one), picks the most recently written", () => {
  const cache = makeFakeCache();
  try {
    writePackageJson(cache, "old-hash", "pkg", "1.0.0", new Date("2020-01-01"));
    writePackageJson(cache, "new-hash", "pkg", "2.0.0", new Date("2026-01-01"));
    assert.equal(readObservedVersion("pkg", cache), "2.0.0");
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});
