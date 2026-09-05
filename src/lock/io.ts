import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { emptyLockFile, sortedStringify, type LockFile } from "./schema.js";

export const DEFAULT_LOCK_FILE_PATH = "tools.lock";

export function readLockFile(filePath: string = DEFAULT_LOCK_FILE_PATH): LockFile {
  if (!existsSync(filePath)) {
    return emptyLockFile();
  }
  return JSON.parse(readFileSync(filePath, "utf8")) as LockFile;
}

export function writeLockFile(lockFile: LockFile, filePath: string = DEFAULT_LOCK_FILE_PATH): void {
  writeFileSync(filePath, sortedStringify(lockFile));
}
