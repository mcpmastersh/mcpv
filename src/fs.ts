// Private, atomic writes: 0700 directories, 0600 files, written to a temp file
// and renamed into place, so a crash mid-write never leaves a half-written
// vault and nothing in the vault home is readable by another local user.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Not ours to change (e.g. a shared mount) — the files are still 0600.
  }
}

export function writePrivate(path: string, contents: string): void {
  ensurePrivateDir(dirname(path));
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, contents, { mode: 0o600 });
  renameSync(temp, path);
}
