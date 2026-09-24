// The vault: one JSON file (vault.json, 0600) in the vault home
// (MCPV_HOME, default ~/.mcpv). No server, no account, no network.
//
//   {
//     "version": 1,
//     "keyStore": "keychain" | "secret-service" | "file",
//     "keyCheck": "<HMAC fingerprint of the master key>",
//     "environments": {
//       "<workspace>/<project>/<environment>": {
//         "<KEY>": { "value": "<AES-256-GCM, see crypto.ts>", "updatedAt": "…" }
//       }
//     }
//   }
//
// Key *names* are stored in the clear on purpose: listing what exists, or
// checking that every reference in a .env resolves, must work without
// unlocking anything — those are the questions an agent is allowed to ask.
// Values are only ever decrypted in memory, at the moment a process needs them.
//
// There is deliberately no "get" or "reveal" here. The vault hands values to a
// process (run.ts) or to library code (resolve*), never to a display.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  environmentPath,
  formatAddress,
  isKeyName,
  parseEnvironmentAddress,
  parseKeyAddress,
  type EnvironmentAddress,
} from "./address.ts";
import { open, seal } from "./crypto.ts";
import { ensurePrivateDir, writePrivate } from "./fs.ts";
import { createKey, keyCheck, loadKey, matchesCheck, type KeyStore } from "./keys.ts";

type Entry = { value: string; updatedAt: string };

export type VaultFile = {
  version: 1;
  keyStore: KeyStore;
  keyCheck: string;
  environments: Record<string, Record<string, Entry>>;
};

export class VaultError extends Error {
  readonly actions: string[];
  constructor(message: string, actions: string[] = []) {
    super(message);
    this.actions = actions;
  }
}

export function vaultHome(): string {
  return process.env.MCPV_HOME || join(homedir(), ".mcpv");
}

const vaultFile = (home: string) => join(home, "vault.json");

export function readVaultFile(home = vaultHome()): VaultFile | null {
  const path = vaultFile(home);
  if (!existsSync(path)) return null;
  let parsed: VaultFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new VaultError(`${path} isn't valid JSON`, ["mcpv doctor"]);
  }
  if (parsed?.version !== 1 || typeof parsed.environments !== "object" || !parsed.keyStore || !parsed.keyCheck) {
    throw new VaultError(`${path} isn't a vault this version understands`, ["mcpv doctor"]);
  }
  return parsed;
}

export class Vault {
  readonly home: string;
  private key: Buffer | null = null;

  private constructor(home: string) {
    this.home = home;
  }

  /** Creates the vault (and its master key) if it doesn't exist yet. */
  static init(home = vaultHome(), prefer?: KeyStore): { vault: Vault; created: boolean; keyStore: KeyStore } {
    const existing = readVaultFile(home);
    if (existing) return { vault: new Vault(home), created: false, keyStore: existing.keyStore };
    ensurePrivateDir(home);
    const { key, store } = createKey(home, prefer);
    const file: VaultFile = { version: 1, keyStore: store, keyCheck: keyCheck(key), environments: {} };
    writePrivate(vaultFile(home), `${JSON.stringify(file, null, 2)}\n`);
    const vault = new Vault(home);
    vault.key = key;
    return { vault, created: true, keyStore: store };
  }

  static open(home = vaultHome()): Vault {
    if (!readVaultFile(home)) {
      throw new VaultError(`No vault at ${home} yet`, ["mcpv init"]);
    }
    return new Vault(home);
  }

  private file(): VaultFile {
    const file = readVaultFile(this.home);
    if (!file) throw new VaultError(`The vault at ${this.home} disappeared`, ["mcpv init"]);
    return file;
  }

  private save(file: VaultFile): void {
    writePrivate(vaultFile(this.home), `${JSON.stringify(file, null, 2)}\n`);
  }

  private unlock(file: VaultFile): Buffer {
    if (this.key) return this.key;
    const key = loadKey(this.home, file.keyStore);
    if (!matchesCheck(key, file.keyCheck)) {
      throw new VaultError("That key doesn't unlock this vault", ["Check MCPV_KEY", "mcpv doctor"]);
    }
    this.key = key;
    return key;
  }

  get keyStore(): KeyStore {
    return this.file().keyStore;
  }

  /** Every environment in the vault with its key names. Needs no key. */
  environments(): { address: string; keys: string[] }[] {
    return Object.entries(this.file().environments)
      .map(([path, entries]) => ({ address: `mcpm://${path}`, keys: Object.keys(entries).sort() }))
      .sort((a, b) => a.address.localeCompare(b.address));
  }

  /** Key names in one environment, or null if it doesn't exist. Needs no key. */
  keys(address: string | EnvironmentAddress): string[] | null {
    const env = typeof address === "string" ? parseEnvironmentAddress(address) : address;
    const entries = this.file().environments[environmentPath(env)];
    return entries ? Object.keys(entries).sort() : null;
  }

  has(address: string): boolean {
    const parsed = parseKeyAddress(address);
    return Boolean(this.file().environments[environmentPath(parsed)]?.[parsed.key]);
  }

  set(address: string, value: string): { created: boolean } {
    const parsed = parseKeyAddress(address);
    const file = this.file();
    const key = this.unlock(file);
    const path = environmentPath(parsed);
    const env = (file.environments[path] ??= {});
    const created = !env[parsed.key];
    env[parsed.key] = { value: seal(key, formatAddress(parsed), value), updatedAt: new Date().toISOString() };
    this.save(file);
    return { created };
  }

  /** Sets many keys in one environment with a single write. */
  setMany(environment: string, values: Record<string, string>): { created: number; updated: number } {
    const env = parseEnvironmentAddress(environment);
    const file = this.file();
    const key = this.unlock(file);
    const entries = (file.environments[environmentPath(env)] ??= {});
    let created = 0;
    for (const [name, value] of Object.entries(values)) {
      if (!isKeyName(name)) throw new VaultError(`"${name}" isn't a valid key name (A-Z, 0-9, _)`);
      const address = formatAddress({ ...env, key: name });
      if (!entries[name]) created++;
      entries[name] = { value: seal(key, address, value), updatedAt: new Date().toISOString() };
    }
    this.save(file);
    return { created, updated: Object.keys(values).length - created };
  }

  remove(address: string): boolean {
    const parsed = parseKeyAddress(address);
    const file = this.file();
    const path = environmentPath(parsed);
    const env = file.environments[path];
    if (!env?.[parsed.key]) return false;
    delete env[parsed.key];
    if (Object.keys(env).length === 0) delete file.environments[path];
    this.save(file);
    return true;
  }

  /** Decrypts one secret, in memory. */
  resolveKey(address: string): string {
    const parsed = parseKeyAddress(address);
    const file = this.file();
    const entry = file.environments[environmentPath(parsed)]?.[parsed.key];
    if (!entry) {
      throw new VaultError(`Nothing is stored at ${formatAddress(parsed)}`, [
        `mcpv set ${formatAddress(parsed)}`,
        `mcpv list mcpm://${environmentPath(parsed)}`,
      ]);
    }
    return this.decrypt(file, formatAddress(parsed), entry);
  }

  /** Decrypts every secret in one environment, in memory. */
  resolveEnvironment(address: string): Record<string, string> {
    const env = parseEnvironmentAddress(address);
    const file = this.file();
    const entries = file.environments[environmentPath(env)];
    if (!entries) {
      throw new VaultError(`There's no environment at ${formatAddress(env)}`, ["mcpv list"]);
    }
    return Object.fromEntries(
      Object.entries(entries).map(([name, entry]) => [name, this.decrypt(file, formatAddress({ ...env, key: name }), entry)]),
    );
  }

  private decrypt(file: VaultFile, address: string, entry: Entry): string {
    const key = this.unlock(file);
    try {
      return open(key, address, entry.value);
    } catch {
      // Never echo the ciphertext or the crypto library's message — only
      // that this one entry can't be trusted.
      throw new VaultError(`${address} failed its integrity check — it was edited or moved by hand`, [`mcpv set ${address}`]);
    }
  }
}
