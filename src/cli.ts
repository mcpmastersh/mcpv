// `mcpv` — offline secrets for agents: use, never see.
//
// This file owns argument parsing, the command table, and the one place a
// failure becomes a rendered error and an exit code (0 ok / 1 failed / 2 the
// invocation was wrong). Storage lives in vault.ts, .env handling in
// dotenv.ts, the child process in run.ts, presentation in term.ts.
//
// Three rules every command here keeps:
//   - No command prints a secret value. There is no `get`/`reveal`; values go
//     into a child process (`run`) and nowhere else.
//   - No command takes a value as an argument. argv lands in shell history,
//     in `ps`, and in an agent's transcript; values come in over stdin.
//   - Every address a person types is read by address-input.ts before anything
//     does with it — repaired, and on a terminal completed by asking for the
//     piece that's missing. address.ts only ever sees the canonical grammar.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { AddressError, formatAddress } from "./address.ts";
import {
  PARTS,
  addressDraft,
  addressPreview,
  completeDraft,
  filterRows,
  inventoryRows,
  keyProblem,
  missingNote,
  normalizeKey,
  paginate,
  parseEnvironmentDraft,
  parseKeyDraft,
  readAddressInput,
  slugProblem,
  slugify,
  suggestionsFor,
  type AddressRead,
  type Draft,
  type Inventory,
  type Part,
  type SecretFilter,
  type SecretRow,
} from "./address-input.ts";
import { DotEnvError, isReferenceValue, parseDotEnv, references, resolveDotEnv, rewriteAsReferences } from "./dotenv.ts";
import { isTopic, showTopic } from "./help.ts";
import { KeyError, availableOsStore, envKey, type KeyStore } from "./keys.ts";
import { MIN_MASK_LENGTH } from "./mask.ts";
import { CommandNotFoundError, runWithEnv } from "./run.ts";
import { IDLE_MINUTES, startUi } from "./ui-server.ts";
import { CliError, accent, action, arrow, bold, glyph, heading, muted, note, out, pad, row, say, setPlain } from "./term.ts";
import { Vault, VaultError, readVaultFile, vaultHome } from "./vault.ts";
import { VERSION } from "./version.ts";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

type Parsed = { positionals: string[]; rest: string[] | null; flags: Map<string, string[]> };

/** Flags that take a value; everything else is boolean. */
const VALUE_FLAGS = new Set([
  "env",
  "env-file",
  "environment",
  "into",
  "key-store",
  "limit",
  "only",
  "page",
  "port",
  "project",
  "search",
  "workspace",
]);

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
// Addresses: read what was typed, ask for what's missing
// ---------------------------------------------------------------------------
//
// address-input.ts holds the shared contract — it repairs case, spaces, a
// missing scheme and a whole address pasted into one field, and when a piece is
// genuinely absent it names that one piece. What's left is completing it here:
// one question at a time, but only on a real terminal. Off one, a partial
// address is a usage error (exit 2) naming the missing piece and the command
// that would work, because a piped stdin must never turn into a prompt that
// nothing is there to answer.

const PART_LABEL: Record<Part, string> = { workspace: "Workspace", project: "Project", environment: "Environment", key: "Key name" };

/** How many environments `list` shows per page unless --limit says otherwise. */
const LIST_PAGE_SIZE = 20;

/** A real terminal, and not a machine contract: `--json` output stays parseable. */
function canAsk(p: Parsed): boolean {
  return Boolean(process.stdin.isTTY) && !has(p, "json");
}

/** The vault's existing names, for suggesting what already exists. Nothing at all when there's no vault yet. */
function inventoryOrEmpty(): Inventory {
  return readVaultFile() ? Vault.open().inventory() : [];
}

/** A key address in its canonical form: the reader repairs, address.ts formats. */
function canonicalKey(raw: string): string {
  return formatAddress(parseKeyDraft(raw));
}

function canonicalEnvironment(raw: string): string {
  return formatAddress(parseEnvironmentDraft(raw));
}

/** The copyable command a partial address was missing, e.g. `mcpv set mcpm://acme/api/dev/<KEY>`. */
function hintFor(prefix: string, parts: Draft, needKey: boolean): string {
  const wanted = needKey ? PARTS : PARTS.slice(0, 3);
  const filled = wanted.map((part) => parts[part] ?? `<${part === "key" ? "KEY" : part.toUpperCase()}>`);
  return `${prefix} mcpm://${filled.join("/")}`;
}

/** A partial address with nowhere to ask: what's missing, and the command that would have worked. */
function partialAddressError(raw: string, read: AddressRead, hint: string, needKey: boolean): CliError {
  const note = missingNote(read.missing, read.parts, needKey) ?? "Add the missing pieces";
  return new CliError(`"${raw.trim()}" isn't a full address yet. ${note}`, [hint], 2);
}

let buffered = "";

/**
 * One line of visible input from a terminal. The caller writes the prompt to
 * stderr; this only reads — and keeps whatever a paste delivered beyond the
 * first newline, so the next question isn't answered by accident. stdin is
 * paused on the way out so a finished command can't keep the process alive.
 */
async function readLine(): Promise<string> {
  process.stdin.resume();
  for (;;) {
    const end = buffered.indexOf("\n");
    if (end !== -1) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      process.stdin.pause();
      return line.replace(/\r$/, "");
    }
    const chunk = await new Promise<string | null>((resolve) => {
      const settle = (value: string | null) => {
        process.stdin.off("data", onData);
        process.stdin.off("end", onEnd);
        resolve(value);
      };
      const onData = (data: Buffer) => settle(data.toString("utf8"));
      const onEnd = () => settle(null);
      process.stdin.on("data", onData);
      process.stdin.on("end", onEnd);
    });
    if (chunk === null) {
      const rest = buffered;
      buffered = "";
      process.stdin.pause();
      return rest.replace(/\r$/, "");
    }
    buffered += chunk;
  }
}

/**
 * One question: the label, the vault's existing names as numbered picks, then a
 * prompt on stderr. Enter takes the first pick, a number takes that one, and
 * anything else is read as the name itself.
 */
async function askLine(label: string, suggestions: string[], hint: string): Promise<string> {
  say(row("info", label, hint));
  suggestions.forEach((suggestion, index) => say(`     ${muted(String(index + 1))}  ${accent(suggestion)}`));
  process.stderr.write(`  ${arrow()} `);
  return (await readLine()).trim();
}

function suggestionsForPart(part: Part, inventory: Inventory, draft: Draft): string[] {
  const options = suggestionsFor(inventory, draft);
  return { workspace: options.workspaces, project: options.projects, environment: options.environmentNames, key: options.keys }[part];
}

/** A `.env` path, asked for and validated by the same reader the flag path uses. */
async function askEnvFile(): Promise<string> {
  const suggestions = existsSync(".env") ? [".env"] : [];
  for (;;) {
    const answer = await askLine("File", suggestions, "a path to the .env holding plain values");
    const candidate = answer === "" ? suggestions[0] : answer;
    if (candidate === undefined || candidate === "") throw new CliError("Cancelled — nothing was imported", [], 1);
    try {
      readEnvFile(candidate);
      return candidate;
    } catch (error) {
      say(row("warn", "File", (error as Error).message));
    }
  }
}

/**
 * The missing pieces, in address order. Each answer is repaired exactly as an
 * address segment is, and a whole address pasted into any of them fills the
 * rest too — that is what somebody holding an address actually does with it.
 */
async function askMissing(command: string, draft: Draft, needKey: boolean): Promise<Draft> {
  const inventory = inventoryOrEmpty();
  const filled: Draft = { ...draft };
  const wanted = needKey ? PARTS : PARTS.slice(0, 3);
  say(heading(command, addressPreview(filled, needKey)));
  say();
  for (const part of wanted) {
    if (filled[part] !== undefined) continue;
    for (;;) {
      const label = PART_LABEL[part];
      const suggestions = suggestionsForPart(part, inventory, filled);
      const answer = await askLine(label, suggestions, suggestions.length > 0 ? `Enter for ${suggestions[0]}, or type a name` : "type a name");
      if (answer === "") {
        if (suggestions.length === 0) throw new CliError(`Cancelled — nothing was ${command === "import" ? "imported" : "stored"}`, [], 1);
        filled[part] = suggestions[0];
        break;
      }
      if (/^[0-9]+$/.test(answer)) {
        const pick = suggestions[Number(answer) - 1];
        if (pick !== undefined) {
          filled[part] = pick;
          break;
        }
        say(row("warn", label, suggestions.length > 0 ? `pick 1–${suggestions.length}, or type a name` : "type a name, not a number"));
        continue;
      }
      if (answer.includes("/") || /^mcpm:/i.test(answer)) {
        const pasted = completeDraft({ [part]: answer }, { needKey });
        if (pasted.unreadable.length > 0) {
          say(row("warn", label, pasted.unreadable[0].why));
          continue;
        }
        if (pasted.extra.length > 0) {
          say(row("warn", label, `"${answer}" is longer than an address`));
          continue;
        }
        for (const other of wanted) if (filled[other] === undefined && pasted.parts[other] !== undefined) filled[other] = pasted.parts[other];
        break;
      }
      // A single name, repaired the same way the reader repairs a segment. What
      // it was repaired to shows up in the final address, not as its own line.
      const repaired = part === "key" ? normalizeKey(answer) : slugify(answer);
      const why = part === "key" ? keyProblem(repaired) : slugProblem(repaired);
      if (why === null) {
        filled[part] = repaired;
        break;
      }
      say(row("warn", label, why));
    }
  }
  return filled;
}

/** An environment address from anything typed or asked for. Canonical on the way out. */
async function readEnvironment(p: Parsed, raw: string, command: string): Promise<string> {
  const read = readAddressInput(raw);
  // Complete already, or wrong in a way the reader words better than we can
  // (a stray segment, a personal ~me branch, a piece that can't be repaired):
  // its own message names the offending piece, so let it throw.
  if (read.unreadable.length > 0 || read.extra.length > 0 || read.missing.length === 0) return canonicalEnvironment(raw);
  const hint = hintFor(`mcpv ${command}`, read.parts, false);
  if (!canAsk(p)) throw partialAddressError(raw, read, hint, false);
  return canonicalEnvironment(addressDraft(await askMissing(command, read.parts, false), false));
}

/** A one-key address the same way. Canonical on the way out. */
async function readKey(p: Parsed, raw: string, command: string): Promise<string> {
  const read = readAddressInput(raw, { needKey: true });
  if (read.unreadable.length > 0 || read.extra.length > 0 || read.missing.length === 0) return canonicalKey(raw);
  const hint = hintFor(`mcpv ${command}`, read.parts, true);
  if (!canAsk(p)) throw partialAddressError(raw, read, hint, true);
  return canonicalKey(addressDraft(await askMissing(command, read.parts, true), true));
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
  if (address !== undefined && extra.length) {
    throw new CliError(
      "Values are never taken as arguments — they'd land in shell history, `ps` and agent transcripts",
      [`mcpv set ${address}   # then paste at the hidden prompt`, `pbpaste | mcpv set ${address}`],
      2,
    );
  }
  if (address === undefined && !canAsk(p)) usage("Which address?", "mcpv set mcpm://acme/api/dev/STRIPE_KEY");
  // No address at all on a terminal is the guided flow: every piece, in order.
  const canonical =
    address === undefined
      ? canonicalKey(addressDraft(await askMissing("set", {}, true), true))
      : await readKey(p, address, "set");
  const { vault } = Vault.init();
  const value = await readValue(`Value for ${accent(canonical)}`);
  if (value === "") throw new CliError("Empty value — nothing was stored", [], 1);
  const { created } = vault.set(canonical, value);
  say(row("ok", created ? "Stored" : "Replaced", canonical));
}

async function cmdImport(p: Parsed): Promise<void> {
  const [file, ...extra] = p.positionals;
  if (extra.length) usage("Import takes one file", "mcpv import .env --into mcpm://acme/api/dev --rewrite");
  const into = flag(p, "into");
  if ((file === undefined || into === undefined) && !canAsk(p)) {
    usage("Import needs a file and --into", "mcpv import .env --into mcpm://acme/api/dev --rewrite");
  }
  // The file first, then the environment it goes into.
  const path = file ?? (await askEnvFile());
  const text = readEnvFile(path);
  const target =
    into === undefined
      ? canonicalEnvironment(addressDraft(await askMissing("import", {}, false), false))
      : await readEnvironment(p, into, `import ${path} --into`);
  const only = flag(p, "only")?.split(",").map((key) => key.trim()).filter(Boolean);
  const entries = parseDotEnv(text).filter(
    (entry) => entry.value !== "" && !isReferenceValue(entry.value) && (!only || only.includes(entry.key)),
  );
  if (entries.length === 0) {
    say(row("info", `No plain values in ${path} to import`));
    return;
  }
  const { vault } = Vault.init();
  const { created, updated } = vault.setMany(target, Object.fromEntries(entries.map((e) => [e.key, e.value])));
  say(heading("import", target));
  say();
  say(row("ok", `Imported ${plural(entries.length, "secret")}`, `${created} new, ${updated} replaced`));
  say(`     ${muted(entries.map((e) => e.key).join("  "))}`);
  if (has(p, "rewrite")) {
    const mode = statSync(path).mode & 0o777;
    writeFileSync(path, rewriteAsReferences(text, target, new Set(entries.map((e) => e.key))), { mode });
    say(row("ok", `Rewrote ${path}`, "values replaced by mcpm:// references"));
    say();
    say(action(`mcpv run -- <your command>`, `reads ${path} and injects the values`));
  } else {
    say();
    say(note(`${path} still holds the plain values. --rewrite swaps them for references.`));
  }
}

/** A whole number flag, defaulted. */
function wholeNumber(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) usage(`--${name} takes a whole number of 1 or more`, `mcpv list --${name} ${fallback}`);
  return value;
}

/** An exact slug filter, repaired the way an address segment is. */
function slugFilter(p: Parsed, name: "workspace" | "project" | "environment"): string | undefined {
  const raw = flag(p, name);
  if (raw === undefined) return undefined;
  const slug = slugify(raw);
  if (slug === "" || slugProblem(slug) !== null) usage(`--${name} takes a name like "acme"`, `mcpv list --${name} acme`);
  return slug;
}

/**
 * The positional is a prefix, so `mcpv list mcpm://acme` and `mcpv list acme/api`
 * mean everything under that path rather than one full environment. A prefix
 * that already names a key filters within the environment instead.
 */
function listPrefix(raw: string): { text: string; hasKey: boolean } {
  const read = readAddressInput(raw);
  if (read.unreadable.length > 0 || read.extra.length > 0) {
    // Not address-shaped at all: the reader's own message names the piece.
    parseEnvironmentDraft(raw);
  }
  const filled = PARTS.filter((part) => read.parts[part] !== undefined);
  if (filled.length === 0) throw new CliError(`"${raw}" isn't an address or the start of one`, ["mcpv list"], 2);
  return { text: filled.map((part) => read.parts[part]).join("/"), hasKey: read.parts.key !== undefined };
}

const matchesPrefix = (row: SecretRow, prefix: { text: string; hasKey: boolean }) =>
  prefix.hasKey ? `${row.path}/${row.key}`.startsWith(prefix.text) : `${row.path}/${row.key}`.startsWith(`${prefix.text}/`);

/** The grouped shape `list` has always printed: one entry per environment, names only. */
function groupEnvironments(rows: SecretRow[]): { address: string; keys: string[] }[] {
  const grouped = new Map<string, { address: string; keys: string[] }>();
  for (const row of rows) {
    const entry = grouped.get(row.path) ?? { address: `mcpm://${row.path}`, keys: [] };
    entry.keys.push(row.key);
    grouped.set(row.path, entry);
  }
  return [...grouped.values()];
}

/** A phrase for what a view was narrowed to, for the heading and the empty state. */
function describeView(prefix: { text: string } | undefined, filter: SecretFilter): string {
  const bits: string[] = [];
  if (prefix) bits.push(`mcpm://${prefix.text}`);
  if (filter.search) bits.push(`"${filter.search}"`);
  if (filter.workspace) bits.push(`workspace ${filter.workspace}`);
  if (filter.project) bits.push(`project ${filter.project}`);
  if (filter.environment) bits.push(`environment ${filter.environment}`);
  return bits.join(", ");
}

/** The same view one page further on, quoted so it can be pasted as-is. */
function nextPage(p: Parsed, address: string | undefined, page: number): string {
  const args = ["mcpv", "list"];
  if (address !== undefined) args.push(address);
  for (const name of ["search", "workspace", "project", "environment"] as const) {
    const value = flag(p, name);
    if (value !== undefined) args.push(`--${name}`, /[\s"'$]/.test(value) ? JSON.stringify(value) : value);
  }
  const limit = flag(p, "limit");
  if (limit !== undefined) args.push("--limit", limit);
  args.push("--page", String(page + 1));
  return args.join(" ");
}

function cmdList(p: Parsed): void {
  const [address, ...extra] = p.positionals;
  if (extra.length) usage("List takes one address or prefix", "mcpv list mcpm://acme");
  const prefix = address === undefined ? undefined : listPrefix(address);
  const filter: SecretFilter = {
    ...(flag(p, "search") === undefined ? {} : { search: flag(p, "search") }),
    workspace: slugFilter(p, "workspace"),
    project: slugFilter(p, "project"),
    environment: slugFilter(p, "environment"),
  };
  const pageNumber = wholeNumber(flag(p, "page"), "page", 1);
  const pageSize = wholeNumber(flag(p, "limit"), "limit", LIST_PAGE_SIZE);

  const vault = Vault.open();
  const everything = inventoryRows(vault.inventory());
  const matched = filterRows(everything, filter).filter((row) => prefix === undefined || matchesPrefix(row, prefix));
  // One row per key, so an environment whose *address* matched keeps all of its
  // keys while one that matched on a key name keeps just those — the shared
  // filter already decided that per row, and grouping keeps the decision.
  const environments = groupEnvironments(matched);
  const secrets = environments.reduce((count, env) => count + env.keys.length, 0);
  // Paging is over environments: a page is a few environments with all their keys.
  const shown = paginate(environments, pageNumber, pageSize);
  const subject = describeView(prefix, filter);

  if (has(p, "json")) {
    out(
      JSON.stringify({
        environments: shown.items,
        total: shown.total,
        page: shown.page,
        pageSize: shown.pageSize,
        pages: shown.pages,
        secrets,
        filters: {
          ...(prefix === undefined ? {} : { prefix: prefix.text }),
          ...(filter.search === undefined ? {} : { search: filter.search }),
          ...(filter.workspace === undefined ? {} : { workspace: filter.workspace }),
          ...(filter.project === undefined ? {} : { project: filter.project }),
          ...(filter.environment === undefined ? {} : { environment: filter.environment }),
        },
      }),
    );
    return;
  }

  say(heading("list", subject === "" ? undefined : subject));
  say();
  if (shown.total === 0) {
    if (everything.length === 0) {
      say(row("info", "Nothing stored yet"));
      say();
      say(action("mcpv set mcpm://<workspace>/<project>/<env>/<KEY>"));
    } else {
      say(row("info", "Nothing matches", subject));
      say();
      say(action("mcpv list", "everything stored"));
    }
    return;
  }
  for (const env of shown.items) {
    say(`  ${accent(env.address)}  ${muted(plural(env.keys.length, "key"))}`);
    for (const key of env.keys) say(`     ${key}`);
  }
  say();
  say(row("info", `${plural(shown.total, "environment")} · ${plural(secrets, "secret")}`, shown.pages > 1 ? `showing ${shown.from}–${shown.to} of ${shown.total}` : ""));
  if (shown.page < shown.pages) {
    say();
    say(action(nextPage(p, address, shown.page), `${plural(shown.pages - shown.page, "more page")} of environments`));
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
    // references() already returns the canonical form, so a .env whose
    // address was typed with capitals is compared against the same vault entry
    // as one written exactly.
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
  // `run` injects a whole environment; the per-piece flags belong to `list`.
  // Unknown flags are otherwise swallowed, so without this
  // `run --environment dev -- npm test` would inject nothing and say nothing.
  for (const name of ["workspace", "project", "environment"] as const) {
    if (has(p, name)) {
      throw new CliError(
        `run doesn't take --${name} — a whole environment is injected with --env`,
        [`mcpv run --env mcpm://acme/api/dev -- <command>`, `mcpv list --${name} ${flag(p, name)}`],
        2,
      );
    }
  }
  const command = p.rest;
  if (!command || command.length === 0) usage("Nothing to run — put the command after --", "mcpv run -- npm run dev");
  const vault = Vault.open();
  const env: Record<string, string> = {};
  const secretKeys = new Set<string>();

  // Order is precedence: whole environments first, then .env files in the
  // order given — a later source overrides an earlier one.
  for (const address of flags(p, "env")) {
    const target = await readEnvironment(p, address, "run --env");
    for (const [key, value] of Object.entries(vault.resolveEnvironment(target))) {
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
  const [address, ...extra] = p.positionals;
  if (extra.length) usage("Remove takes one address", "mcpv rm mcpm://acme/api/dev/STRIPE_KEY");
  if (!address) usage("Which address?", "mcpv rm mcpm://acme/api/dev/STRIPE_KEY");
  const canonical = await readKey(p, address, "rm");
  const vault = Vault.open();
  if (!vault.has(canonical)) throw new CliError(`Nothing is stored at ${canonical}`, ["mcpv list"]);
  if (!has(p, "yes") && !(await confirm(`Delete ${canonical}? This can't be undone.`))) {
    throw new CliError("Not deleted", [`mcpv rm ${canonical} --yes`], process.stdin.isTTY ? 1 : 2);
  }
  vault.remove(canonical);
  say(row("ok", "Deleted", canonical));
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

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // No browser here — the URL is printed anyway.
  }
}

async function cmdUi(p: Parsed): Promise<void> {
  const raw = flag(p, "port");
  const port = raw === undefined ? 0 : Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) usage("--port must be 1–65535", "mcpv ui --port 7438");
  let ui;
  try {
    ui = await startUi({ port });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new CliError(`Port ${port} is already in use`, ["mcpv ui", `mcpv ui --port ${port + 1}`]);
    }
    throw error;
  }
  // The URL carries this run's token, so it goes to the terminal only. It
  // grants set/replace/delete, never a read of a value.
  say(heading("ui", `http://127.0.0.1:${ui.port}`));
  say();
  say(row("ok", "Running", "127.0.0.1 only, until you close it", 10));
  say(row("info", "Open", ui.url, 10));
  say();
  say(note(`Stops on the page's Close button, Ctrl+C, or after ${IDLE_MINUTES} idle minutes.`));
  if (!has(p, "no-open") && process.stdout.isTTY) openBrowser(ui.url);
  const stop = () => ui.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await ui.closed;
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  say(row("ok", "Stopped"));
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
  cmd("set [key-address]", "Store a secret (hidden prompt, or piped stdin)");
  cmd("import [file] --into <env>", "Store a .env's plain values (--only A,B); --rewrite it to references");
  cmd("check [--env-file f]", "Confirm every reference in a .env resolves (names only)");
  cmd("list [prefix]", "List environments and key names — never values");
  cmd("list --search t --page n", "Search every key name and address; page the environments");
  cmd("rm <key-address>", "Delete a secret");
  cmd("init [--key-store s]", "Create the vault (keychain, secret-service or file)");
  cmd("ui [--port n] [--no-open]", "Open a local web UI: browse, add, replace, import. Never shows a value");
  cmd("doctor", "Where the vault and its key live, and whether it unlocks");
  cmd("update [--check]", "Install the newest version (bypasses the npm cache)");
  say();
  say(`  ${bold("Stuck on a command?")}  ${accent("mcpv help <command>")}  ${muted("shows what it does, examples to copy and what you should see:")}`);
  say(`                        ${muted("mcpv help set    mcpv help import    mcpv help run")}`);
  say();
  say(`  ${bold("Addresses")}   ${muted("mcpm://<workspace>/<project>/<environment>[/<KEY>]")}`);
  say(`              ${muted("acme/api/dev/STRIPE_KEY and Acme/API/Dev/STRIPE_KEY work too — case,")}`);
  say(`              ${muted("a missing mcpm:// and a trailing / are repaired, never guessed at.")}`);
  say(`              ${muted("A partial one is completed for you, piece by piece, on a terminal;")}`);
  say(`              ${muted("off one it's an error naming the piece that's missing.")}`);
  say(`  ${bold("In a .env")}   ${muted("STRIPE_KEY=mcpm://acme/api/dev/STRIPE_KEY")}`);
  say();
  say(`  ${bold("Filters")}     ${muted("list [prefix]  --workspace s  --project s  --environment s  --search text")}`);
  say(`              ${muted("--limit n (environments per page, default " + LIST_PAGE_SIZE + ")  --page n")}`);
  say(`  ${bold("Flags")}       ${muted("--json (list, check, doctor)  --no-mask --quiet (run)  --only --rewrite (import)  --yes (rm)")}`);
  say(`  ${bold("Env")}         ${muted("MCPV_HOME  MCPV_KEY  MCPV_PLAIN  MCPV_ASCII  NO_COLOR")}`);
}

const INSTALLER_URL = "https://raw.githubusercontent.com/mcpmastersh/mcpv/main/install.sh";

async function cmdUpdate(p: Parsed): Promise<void> {
  let latest = "";
  try {
    const res = await fetch("https://registry.npmjs.org/@mcpmastersh/mcpv/latest", {
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(8000),
    });
    latest = ((await res.json()) as { version?: string }).version ?? "";
  } catch {
    // Offline or blocked: the installer reports its own error.
  }
  if (has(p, "check")) {
    if (!latest) throw new CliError("Couldn't reach the npm registry", ["mcpv update"]);
    if (latest === VERSION) say(row("ok", `Up to date  v${VERSION}`));
    else {
      say(row("info", `v${latest} is available`, `you have v${VERSION}`));
      say(action("mcpv update"));
    }
    return;
  }
  if (latest && latest === VERSION) {
    say(row("ok", `Already the newest version  v${VERSION}`));
    return;
  }
  say(row("info", latest ? `Updating v${VERSION} -> v${latest}` : "Updating to the newest version"));
  // The installer reads the registry directly, so a stale npm cache can't hold it back.
  // Your vault and its key are not touched.
  const code: number = await new Promise((resolve) => {
    const child = spawn("sh", ["-c", `curl -fsSL ${INSTALLER_URL} | sh`], { stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", (c) => resolve(c ?? 1));
  });
  if (code !== 0) throw new CliError("The update didn't finish", [`curl -fsSL ${INSTALLER_URL} | sh`]);
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
  ui: cmdUi,
  update: cmdUpdate,
  upgrade: cmdUpdate,
};

/**
 * The flags each command actually reads.
 *
 * Anything else used to be swallowed silently, which is how `mcpv run
 * --environment dev -- npm test` injected nothing and still exited 0, and how a
 * mistyped `mcpv list --seach x` printed every secret as though the search had
 * matched. "The invocation was wrong" is what exit 2 is for, so an unknown flag
 * is now one — and where the flag does belong somewhere, the message says so.
 *
 * `run` lists the three per-piece flags even though it refuses them, so its own
 * message (the one naming `--env`) is what gets printed instead of this table's
 * generic line.
 */
export const COMMAND_FLAGS: Record<string, string[]> = {
  init: ["key-store"],
  set: [],
  import: ["into", "only", "rewrite"],
  list: ["search", "workspace", "project", "environment", "limit", "page"],
  ls: ["search", "workspace", "project", "environment", "limit", "page"],
  check: ["env-file"],
  run: ["env", "env-file", "no-mask", "quiet", "workspace", "project", "environment"],
  rm: ["yes"],
  doctor: [],
  update: ["check"],
  upgrade: ["check"],
  ui: ["port", "no-open"],
};

/**
 * `--help`, `--plain` and `--json` belong to every command, not to one: `main`
 * reads them before it dispatches, and `--json` is the promise that output is
 * parseable and no question is ever asked — including on a command that has no
 * JSON shape of its own yet. Each remaining flag does belong to one command.
 */
const GLOBAL_FLAGS = ["help", "plain", "json"];

function rejectUnknownFlags(name: string, p: Parsed): void {
  const allowed = new Set([...(COMMAND_FLAGS[name] ?? []), ...GLOBAL_FLAGS]);
  for (const key of p.flags.keys()) {
    if (allowed.has(key)) continue;
    const owner = Object.entries(COMMAND_FLAGS).find(([command, list]) => command !== name && list.includes(key));
    throw new CliError(
      `${name} doesn't take --${key}${owner ? ` (it's a ${owner[0]} flag)` : ""}`,
      [`mcpv ${name} --help`, "mcpv help"],
      2,
    );
  }
}

export async function main(argv: string[]): Promise<void> {
  try {
    const [name, ...rest] = argv;
    const p = parseArgs(rest);
    if (has(p, "plain") || has(p, "json")) setPlain();
    if (name === "help") {
      // `mcpv help set` — one command, in detail.
      if (p.positionals[0]) return showTopic(p.positionals[0]);
      return help();
    }
    if (!name || name === "--help" || name === "-h") return help();
    if (name === "version" || name === "--version" || name === "-v") return out(VERSION);
    const command = COMMANDS[name];
    if (!command) throw new CliError(`Unknown command: ${name}`, ["mcpv help"], 2);
    // `mcpv set --help` is the same question as `mcpv help set`.
    if (has(p, "help")) return isTopic(name) ? showTopic(name) : help();
    rejectUnknownFlags(name, p);
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
