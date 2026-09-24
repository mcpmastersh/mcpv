// Where the vault's master key lives. The key never sits next to the vault
// file when there is anywhere better to put it, because the point of
// encrypting at all is that `vault.json` on its own — copied into a backup,
// synced to a cloud drive, committed by accident, `cat`-ed by an agent — is
// ciphertext and key names, nothing more.
//
// First match wins:
//
//   1. MCPV_KEY — 64 hex chars (or base64 of 32 bytes). For CI and
//      containers, where the platform's own secret store holds the key.
//   2. The OS credential store — macOS Keychain (`security`) or the Secret
//      Service on Linux desktops (`secret-tool`). The default when present.
//   3. A key file (`master.key`, 0600) in the vault home. The fallback on a
//      headless machine. It protects the vault file from leaking on its own;
//      it cannot protect it from a process running as you, and `doctor` says so.
//
// Which store a vault uses is recorded in the vault file at `init`, so a
// missing keychain later is an error to fix, never a silent switch to a new key.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writePrivate } from "./fs.ts";

export type KeyStore = "keychain" | "secret-service" | "file";

const SERVICE = "mcpv";
const KEY_BYTES = 32;

export class KeyError extends Error {
  readonly actions: string[];
  constructor(message: string, actions: string[] = []) {
    super(message);
    this.actions = actions;
  }
}

/** One keychain entry per vault home, so two vaults on one machine never share a key. */
function account(home: string): string {
  return `master-key:${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 16)}`;
}

const keyFile = (home: string) => join(home, "master.key");

function has(command: string): boolean {
  const probe = spawnSync(command, ["--help"], { stdio: "ignore" });
  return !(probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT");
}

/** The OS credential store this machine offers, if any. */
export function availableOsStore(): Exclude<KeyStore, "file"> | null {
  if (process.env.MCPV_NO_KEYCHAIN === "1") return null;
  if (process.platform === "darwin" && has("security")) return "keychain";
  if (process.platform === "linux" && has("secret-tool")) return "secret-service";
  return null;
}

function decodeKey(raw: string): Buffer | null {
  const text = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  return key.length === KEY_BYTES ? key : null;
}

function osRead(store: Exclude<KeyStore, "file">, home: string): Buffer | null {
  const result =
    store === "keychain"
      ? spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", account(home), "-w"], { encoding: "utf8" })
      : spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", account(home)], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return null;
  return decodeKey(result.stdout);
}

function osWrite(store: Exclude<KeyStore, "file">, home: string, key: Buffer): boolean {
  const hex = key.toString("hex");
  // The key goes in over stdin, never argv — argv is readable by every local
  // process through `ps` for as long as the command runs.
  const result =
    store === "keychain"
      ? spawnSync("security", ["-i"], {
          input: `add-generic-password -U -s ${SERVICE} -a ${account(home)} -w ${hex}\n`,
          encoding: "utf8",
        })
      : spawnSync("secret-tool", ["store", "--label=mcpv master key", "service", SERVICE, "account", account(home)], {
          input: hex,
          encoding: "utf8",
        });
  return result.status === 0 && osRead(store, home)?.equals(key) === true;
}

/** Makes a fresh master key and stores it in the best place available. */
export function createKey(home: string, prefer?: KeyStore): { key: Buffer; store: KeyStore } {
  const key = randomBytes(KEY_BYTES);
  const os = availableOsStore();
  if (prefer !== "file" && os && osWrite(os, home, key)) return { key, store: os };
  if (prefer && prefer !== "file") {
    throw new KeyError(`Couldn't save a key in the ${prefer === "keychain" ? "macOS Keychain" : "Secret Service"}`, [
      "mcpv init --key-store file",
    ]);
  }
  writePrivate(keyFile(home), key.toString("hex"));
  return { key, store: "file" };
}

export function envKey(): Buffer | null {
  const raw = process.env.MCPV_KEY;
  if (raw === undefined || raw === "") return null;
  const key = decodeKey(raw);
  if (!key) throw new KeyError("MCPV_KEY must be 64 hex characters (32 bytes)");
  return key;
}

export function loadKey(home: string, store: KeyStore): Buffer {
  const fromEnv = envKey();
  if (fromEnv) return fromEnv;
  if (store === "file") {
    if (!existsSync(keyFile(home))) {
      throw new KeyError("This vault's key file is missing", ["Set MCPV_KEY to the vault's key", "mcpv doctor"]);
    }
    const key = decodeKey(readFileSync(keyFile(home), "utf8"));
    if (!key) throw new KeyError("This vault's key file is damaged", ["mcpv doctor"]);
    return key;
  }
  const key = osRead(store, home);
  if (!key) {
    const where = store === "keychain" ? "the macOS Keychain" : "the Secret Service (is your keyring unlocked?)";
    throw new KeyError(`Couldn't read this vault's key from ${where}`, ["Set MCPV_KEY to the vault's key", "mcpv doctor"]);
  }
  return key;
}

const CHECK_LABEL = "mcpv key check v1";

/** A fingerprint that proves a key is the vault's own without revealing anything about it. */
export function keyCheck(key: Buffer): string {
  return createHmac("sha256", key).update(CHECK_LABEL).digest("hex").slice(0, 32);
}

export function matchesCheck(key: Buffer, check: string): boolean {
  const expected = Buffer.from(keyCheck(key));
  const actual = Buffer.from(check);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
