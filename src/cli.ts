// `mcpv` — offline secrets for agents: use, never see.
//
// This file owns argument parsing, the command table, and the one place a
// failure becomes a rendered error and an exit code (0 ok / 1 failed / 2 the
// invocation was wrong). Storage lives in vault.ts, .env handling in
// dotenv.ts, the child process in run.ts, presentation in term.ts.
//
// Two rules every command here keeps:
//   - No command prints a secret value. There is no `get`/`reveal`; values go
//     into a child process (`run`) and nowhere else.
//   - No command takes a value as an argument. argv lands in shell history,
//     in `ps`, and in an agent's transcript; values come in over stdin.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { AddressError, parseEnvironmentAddress, parseKeyAddress } from "./address.ts";
import { DotEnvError, parseDotEnv, references, resolveDotEnv, rewriteAsReferences } from "./dotenv.ts";
import { KeyError, availableOsStore, envKey, type KeyStore } from "./keys.ts";
import { MIN_MASK_LENGTH } from "./mask.ts";
import { CommandNotFoundError, runWithEnv } from "./run.ts";
import { CliError, accent, action, bold, glyph, heading, muted, note, out, pad, row, say, setPlain } from "./term.ts";
import { Vault, VaultError, readVaultFile, vaultHome } from "./vault.ts";
import { VERSION } from "./version.ts";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

type Parsed = { positionals: string[]; rest: string[] | null; flags: Map<string, string[]> };

/** Flags that take a value; everything else is boolean. */
const VALUE_FLAGS = new Set(["env", "env-file", "into", "key-store", "only"]);

function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  let rest: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      rest = argv.slice(i + 1);
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const key = token.slice(2, eq === -1 ? undefined : eq);
      let value = eq === -1 ? undefined : token.slice(eq + 1);
      if (value === undefined && VALUE_FLAGS.has(key)) {
        value = argv[++i];
        if (value === undefined) throw new CliError(`--${key} needs a value`, ["mcpv help"], 2);
      }
      flags.set(key, [...(flags.get(key) ?? []), value ?? "true"]);
    } else if (token === "-h") {
      flags.set("help", ["true"]);
    } else if (token === "-y") {
      flags.set("yes", ["true"]);
    } else {
      positionals.push(token);
    }
  }
  return { positionals, rest, flags };
}

const flag = (p: Parsed, key: string) => p.flags.get(key)?.at(-1);
const flags = (p: Parsed, key: string) => p.flags.get(key) ?? [];
const has = (p: Parsed, key: string) => p.flags.has(key);

function usage(message: string, example: string): never {
  throw new CliError(message, [example], 2);
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Reads a value from a hidden TTY prompt, or all of piped stdin. Never argv. */
async function readValue(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    // One trailing newline is the `echo`/heredoc's, not the secret's.
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  process.stderr.write(`  ${prompt} ${muted("(hidden)")} `);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (data: Buffer) => {
      for (const char of data.toString("utf8")) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new CliError("Cancelled — nothing was stored", [], 1));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stderr.write(`  ${question} ${muted("[y/N]")} `);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolve(data.toString("utf8").trim().toLowerCase());
    });
  });
  return answer === "y" || answer === "yes";
}

function readEnvFile(path: string): string {
  if (!existsSync(path)) throw new CliError(`${path} doesn't exist`, ["mcpv run --env-file <path> -- <command>"]);
  return readFileSync(path, "utf8");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const STORE_LABEL: Record<KeyStore, string> = {
  keychain: "macOS Keychain",
  "secret-service": "Secret Service (keyring)",
  file: "key file (master.key, 0600)",
};

function cmdInit(p: Parsed): void {
  const prefer = flag(p, "key-store");
  if (prefer !== undefined && !["keychain", "secret-service", "file"].includes(prefer)) {
    usage("--key-store is keychain, secret-service or file", "mcpv init --key-store file");
  }
  const { created, keyStore } = Vault.init(vaultHome(), prefer as KeyStore | undefined);
  say(heading("init", vaultHome()));
  say();
  say(row("ok", created ? "Vault created" : "Vault already exists", vaultHome(), 12));
  say(row("info", "Master key", STORE_LABEL[keyStore], 12));
  if (keyStore === "file") {
    say(note("No OS keychain here, so the key sits beside the vault. vault.json alone is still"));
    say(note("useless to whoever copies it; a process running as you can read both."));
  }
  say();
  say(action("mcpv set mcpm://<workspace>/<project>/<env>/<KEY>", "store a secret"));
  say(action("mcpv import .env --into mcpm://<workspace>/<project>/<env> --rewrite", "move an existing .env in"));
}

async function cmdSet(p: Parsed): Promise<void> {
  const [address, ...extra] = p.positionals;
  if (!address) usage("Which address?", "mcpv set mcpm://acme/api/dev/STRIPE_KEY");
  if (extra.length) {
    throw new CliError(
      "Values are never taken as arguments — they'd land in shell history, `ps` and agent transcripts",
      [`mcpv set ${address}   # then paste at the hidden prompt`, `pbpaste | mcpv set ${address}`],
      2,
    );
  }
  parseKeyAddress(address);
  const { vault } = Vault.init();
  const value = await readValue(`Value for ${accent(address)}`);
  if (value === "") throw new CliError("Empty value — nothing was stored", [], 1);
  const { created } = vault.set(address, value);
  say(row("ok", created ? "Stored" : "Replaced", address));
}

function cmdImport(p: Parsed): void {
  const [file] = p.positionals;
  const into = flag(p, "into");
  if (!file || !into) usage("Import needs a file and --into", "mcpv import .env --into mcpm://acme/api/dev --rewrite");
  parseEnvironmentAddress(into);
  const text = readEnvFile(file);
  const only = flag(p, "only")?.split(",").map((key) => key.trim()).filter(Boolean);
  const entries = parseDotEnv(text).filter(
    (entry) => entry.value !== "" && !entry.value.startsWith("mcpm://") && (!only || only.includes(entry.key)),
  );
  if (entries.length === 0) {
    say(row("info", `No plain values in ${file} to import`));
    return;
  }
  const { vault } = Vault.init();
  const { created, updated } = vault.setMany(into, Object.fromEntries(entries.map((e) => [e.key, e.value])));
  say(heading("import", into));
  say();
  say(row("ok", `Imported ${plural(entries.length, "secret")}`, `${created} new, ${updated} replaced`));
  say(`     ${muted(entries.map((e) => e.key).join("  "))}`);
  if (has(p, "rewrite")) {
    const mode = statSync(file).mode & 0o777;
    writeFileSync(file, rewriteAsReferences(text, into, new Set(entries.map((e) => e.key))), { mode });
    say(row("ok", `Rewrote ${file}`, "values replaced by mcpm:// references"));
    say();
    say(action(`mcpv run -- <your command>`, `reads ${file} and injects the values`));
  } else {
    say();
    say(note(`${file} still holds the plain values. --rewrite swaps them for references.`));
  }
}

function cmdList(p: Parsed): void {
  const [address] = p.positionals;
  const vault = Vault.open();
  const envs = address
    ? [{ address: address.replace(/\/$/, ""), keys: vault.keys(address) ?? [] }]
    : vault.environments();
  if (has(p, "json")) {
    out(JSON.stringify({ environments: envs }));
    return;
  }
  say(heading("list", address));
  say();
  if (envs.length === 0 || envs.every((env) => env.keys.length === 0)) {
    say(row("info", "Nothing stored yet"));
    say();
    say(action("mcpv set mcpm://<workspace>/<project>/<env>/<KEY>"));
    return;
  }
  for (const env of envs) {
    say(`  ${accent(env.address)}  ${muted(plural(env.keys.length, "key"))}`);
    for (const key of env.keys) say(`     ${key}`);
  }
}

function envFiles(p: Parsed): string[] {
  const explicit = flags(p, "env-file");
  if (explicit.length || flags(p, "env").length) return explicit;
  return existsSync(".env") ? [".env"] : [];
}

function cmdCheck(p: Parsed): void {
  const files = envFiles(p);
  if (files.length === 0) usage("No .env here to check", "mcpv check --env-file .env.local");
  const vault = Vault.open();
  const results = files.flatMap((file) =>
    references(parseDotEnv(readEnvFile(file))).map((ref) => ({ file, key: ref.key, address: ref.address, found: vault.has(ref.address) })),
  );
  const missing = results.filter((r) => !r.found);
  if (has(p, "json")) {
    out(JSON.stringify({ ok: missing.length === 0, references: results }));
  } else {
    say(heading("check", files.join(" ")));
    say();
    const width = Math.max(0, ...results.map((r) => r.key.length));
    for (const r of results) say(row(r.found ? "ok" : "fail", pad(r.key, width), r.address));
    if (results.length === 0) say(row("info", "No mcpm:// references found"));
    say();
    say(row(missing.length ? "fail" : "ok", missing.length ? `${plural(missing.length, "reference")} missing` : "Every reference resolves"));
    for (const r of missing) say(action(`mcpv set ${r.address}`));
  }
  if (missing.length) process.exitCode = 1;
}

async function cmdRun(p: Parsed): Promise<void> {
  const command = p.rest;
  if (!command || command.length === 0) usage("Nothing to run — put the command after --", "mcpv run -- npm run dev");
  const vault = Vault.open();
  const env: Record<string, string> = {};
  const secretKeys = new Set<string>();

  // Order is precedence: whole environments first, then .env files in the
  // order given — a later source overrides an earlier one.
  for (const address of flags(p, "env")) {
    for (const [key, value] of Object.entries(vault.resolveEnvironment(address))) {
      env[key] = value;
      secretKeys.add(key);
    }
  }
  const files = envFiles(p);
  for (const file of files) {
    const resolved = resolveDotEnv(vault, parseDotEnv(readEnvFile(file)));
    for (const [key, value] of Object.entries(resolved.env)) {
      env[key] = value;
      if (resolved.secretKeys.includes(key)) secretKeys.add(key);
      else secretKeys.delete(key);
    }
  }
  if (secretKeys.size === 0 && files.length === 0) {
    usage("Nothing to inject — no .env here and no --env", "mcpv run --env mcpm://acme/api/dev -- npm run dev");
  }

  const secretValues = [...secretKeys].map((key) => env[key]);
  const mask = !has(p, "no-mask");
  const unmaskable = [...secretKeys].filter((key) => env[key].length < MIN_MASK_LENGTH);

  // Names only, never values — on stderr, so the child owns stdout.
  if (!has(p, "quiet")) {
    say(row("ok", `Injected ${plural(secretKeys.size, "secret")}`, [...secretKeys].join(" ")));
    if (!mask) say(row("warn", "Output masking is off", "--no-mask"));
    else if (unmaskable.length) say(row("warn", `Too short to mask: ${unmaskable.join(" ")}`, `under ${MIN_MASK_LENGTH} chars`));
  }
  const result = await runWithEnv(command, env, { mask, secretValues });
  if (result.exitCode !== 0 && !has(p, "quiet")) {
    say(row("fail", result.signal ? `${command[0]} was killed by ${result.signal}` : `${command[0]} exited with code ${result.exitCode}`));
  }
  process.exitCode = result.exitCode;
}

async function cmdRemove(p: Parsed): Promise<void> {
  const [address] = p.positionals;
  if (!address) usage("Which address?", "mcpv rm mcpm://acme/api/dev/STRIPE_KEY");
  const vault = Vault.open();
  if (!vault.has(address)) throw new CliError(`Nothing is stored at ${address}`, ["mcpv list"]);
  if (!has(p, "yes") && !(await confirm(`Delete ${address}? This can't be undone.`))) {
    throw new CliError(`Not deleted`, [`mcpv rm ${address} --yes`], process.stdin.isTTY ? 1 : 2);
  }
  vault.remove(address);
  say(row("ok", "Deleted", address));
}

function cmdDoctor(p: Parsed): void {
  const home = vaultHome();
  const checks: { kind: "ok" | "fail" | "warn" | "info"; label: string; detail: string }[] = [];
  const file = readVaultFile(home);
  checks.push({ kind: file ? "ok" : "fail", label: "Vault", detail: file ? `${home}/vault.json` : `none at ${home}` });
  if (file) {
    const mode = statSync(`${home}/vault.json`).mode & 0o777;
    checks.push({
      kind: mode & 0o077 ? "warn" : "ok",
      label: "Permissions",
      detail: mode & 0o077 ? `vault.json is ${mode.toString(8)} — chmod 600 it` : "private (0600)",
    });
    const fromEnv = (() => {
      try {
        return envKey() !== null;
      } catch {
        return true;
      }
    })();
    checks.push({
      kind: file.keyStore === "file" && !fromEnv ? "warn" : "ok",
      label: "Master key",
      detail: fromEnv ? "MCPV_KEY (overrides the vault's own store)" : STORE_LABEL[file.keyStore],
    });
    try {
      const vault = Vault.open(home);
      const envs = vault.environments();
      // Unlocking is proven by one real decrypt; the value is dropped unread.
      const first = envs.find((env) => env.keys.length);
      if (first) vault.resolveKey(`${first.address}/${first.keys[0]}`);
      checks.push({ kind: "ok", label: "Unlock", detail: first ? "key opens the vault" : "nothing stored yet" });
      checks.push({
        kind: "info",
        label: "Contents",
        detail: `${plural(envs.length, "environment")}, ${plural(envs.reduce((n, e) => n + e.keys.length, 0), "secret")}`,
      });
    } catch (error) {
      checks.push({ kind: "fail", label: "Unlock", detail: (error as Error).message });
    }
  }
  const os = availableOsStore();
  checks.push({ kind: "info", label: "OS key store", detail: os ? STORE_LABEL[os] : "none available" });

  if (has(p, "json")) {
    out(JSON.stringify({ ok: !checks.some((c) => c.kind === "fail"), checks }));
  } else {
    say(heading("doctor"));
    say();
    for (const check of checks) say(row(check.kind, check.label, check.detail, 12));
    if (file?.keyStore === "file") {
      say();
      say(note("A key file protects vault.json from leaking on its own (backups, sync, a stray"));
      say(note("commit). It can't protect it from a process running as you — nothing local can."));
    }
    if (!file) {
      say();
      say(action("mcpv init"));
    }
  }
  if (checks.some((c) => c.kind === "fail")) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function help(): void {
  const cmd = (name: string, text: string) => say(`  ${pad(accent(name), 38)}${text}`);
  say(`  ${bold("mcpv")} ${muted(VERSION)}  Offline secrets for agents — use, never see.`);
  say();
  say(`  ${bold("Usage")}`);
  cmd("run [--env-file f] -- <cmd>", "Run <cmd> with .env references resolved (default ./.env)");
  cmd("run --env <env-address> -- <cmd>", "Run <cmd> with a whole environment injected");
  cmd("set <key-address>", "Store a secret (hidden prompt, or piped stdin)");
  cmd("import <file> --into <env-address>", "Store a .env's plain values (--only A,B); --rewrite it to references");
  cmd("check [--env-file f]", "Confirm every reference in a .env resolves (names only)");
  cmd("list [env-address]", "List environments and key names — never values");
  cmd("rm <key-address>", "Delete a secret");
  cmd("init [--key-store s]", "Create the vault (keychain, secret-service or file)");
  cmd("doctor", "Where the vault and its key live, and whether it unlocks");
  say();
  say(`  ${bold("Addresses")}   ${muted("mcpm://<workspace>/<project>/<environment>[/<KEY>]")}`);
  say(`  ${bold("In a .env")}   ${muted("STRIPE_KEY=mcpm://acme/api/dev/STRIPE_KEY")}`);
  say();
  say(`  ${bold("Flags")}       ${muted("--json (list, check, doctor)  --no-mask --quiet (run)  --only --rewrite (import)  --yes (rm)")}`);
  say(`  ${bold("Env")}         ${muted("MCPV_HOME  MCPV_KEY  MCPV_PLAIN  MCPV_ASCII  NO_COLOR")}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const COMMANDS: Record<string, (p: Parsed) => void | Promise<void>> = {
  init: cmdInit,
  set: cmdSet,
  import: cmdImport,
  list: cmdList,
  ls: cmdList,
  check: cmdCheck,
  run: cmdRun,
  rm: cmdRemove,
  doctor: cmdDoctor,
};

export async function main(argv: string[]): Promise<void> {
  try {
    const [name, ...rest] = argv;
    const p = parseArgs(rest);
    if (has(p, "plain") || has(p, "json")) setPlain();
    if (!name || name === "help" || name === "--help" || name === "-h") return help();
    if (name === "version" || name === "--version" || name === "-v") return out(VERSION);
    const command = COMMANDS[name];
    if (!command) throw new CliError(`Unknown command: ${name}`, ["mcpv help"], 2);
    if (has(p, "help")) return help();
    await command(p);
  } catch (error) {
    report(error);
  }
}

function report(error: unknown): void {
  let message: string;
  let actions: string[] = [];
  let exitCode = 1;
  if (error instanceof CliError) {
    ({ message, actions, exitCode } = error);
  } else if (error instanceof AddressError || error instanceof DotEnvError) {
    message = error.message;
    exitCode = 2;
  } else if (error instanceof VaultError || error instanceof KeyError) {
    ({ message, actions } = error);
  } else if (error instanceof CommandNotFoundError) {
    message = error.message;
    actions = [`command -v ${error.command}`];
  } else {
    // Unexpected: say so plainly, and keep the internals behind MCPV_DEBUG.
    message = "Something went wrong";
    if (process.env.MCPV_DEBUG === "1") console.error(error);
    else actions = ["MCPV_DEBUG=1 mcpv …  for details"];
  }
  say(`  ${glyph("fail")}  ${message}`);
  for (const next of actions) say(action(next));
  process.exitCode = exitCode;
}
