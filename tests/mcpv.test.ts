// mcpv (packages/mcpv) — offline secrets for agents.
//
// What this file protects, in priority order:
//   1. "Use, never see": no command prints a value; values never come in over
//      argv; vault.json holds no plaintext; `run` masks the child's output and
//      never hands the child the master key.
//   2. Integrity: a ciphertext moved to another key's slot, a tampered one, or
//      the wrong master key all fail loudly instead of decrypting to garbage.
//   3. mcpv ui: loopback-only, a per-run token, same-origin JSON writes, and
//      no route that returns a value.
//   4. Stream discipline: `run` leaves stdout to the child; every status line
//      goes to stderr; `--json` output is one object on stdout.
//
// The CLI is driven from source as a subprocess — only a separate process can
// prove which stream a byte landed on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatAddress, parseAddress, parseKeyAddress } from "../src/address.ts";
import {
  completeDraft,
  filterRows,
  inventoryRows,
  missingNote,
  normalizeKey,
  paginate,
  parseEnvironmentDraft,
  parseKeyDraft,
  readAddressInput,
  slugify,
  suggestionsFor,
} from "../src/address-input.ts";
import { open, seal } from "../src/crypto.ts";
import { parseDotEnv, rewriteAsReferences } from "../src/dotenv.ts";
import { MASK, Masker } from "../src/mask.ts";
import { startUi } from "../src/ui-server.ts";

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const SECRET = "sk_live_vault-test-9f8e7d6c5b4a";
const DB = "postgres://app:hunter2-long-password@db.internal/app";

function cli(
  home: string,
  args: string[],
  opts: { input?: string; cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // FORCE_COLOR from the caller's shell would make Node warn on stderr that
    // it outranks NO_COLOR — noise the stream assertions would count.
    const { FORCE_COLOR: _forceColor, ...parentEnv } = process.env;
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: opts.cwd,
      env: { ...parentEnv, MCPV_HOME: home, MCPV_NO_KEYCHAIN: "1", NO_COLOR: "1", MCPV_KEY: "", ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(opts.input ?? "");
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function fresh(): { home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "mcpv-test-"));
  return { home: join(root, "home"), cwd: root };
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

test("addresses: the hosted grammar, verbatim", () => {
  assert.deepEqual(parseAddress("mcpm://acme/api/dev/STRIPE_KEY"), { workspace: "acme", project: "api", environment: "dev", key: "STRIPE_KEY" });
  assert.deepEqual(parseAddress("mcpm://acme/api/dev/"), { workspace: "acme", project: "api", environment: "dev" });
  assert.throws(() => parseAddress("mcpm://acme/~me/dev/KEY"), /Personal/);
  assert.throws(() => parseAddress("mcpm://Acme/api/dev"), /lowercase/);
  assert.throws(() => parseAddress("mcpm://acme/api"), /should look like/);
  assert.throws(() => parseKeyAddress("mcpm://acme/api/dev"), /whole environment/);
  assert.throws(() => parseAddress("mcpm://acme/api/dev/1BAD"), /environment variable/);
});

test("address input: every form a person types reaches the same address", () => {
  // The CLI, the UI and the UI's server all read addresses through this
  // module, so this is their shared contract: whatever arrives — no scheme, a
  // trailing slash, capitals, spaces used as separators — has to land on the
  // one canonical address the vault is keyed by. Getting this wrong doesn't
  // fail loudly; it quietly stores a secret somewhere nobody will look for it.
  assert.equal(formatAddress(parseEnvironmentDraft("mcpm://acme/api/dev")), "mcpm://acme/api/dev");
  assert.equal(formatAddress(parseEnvironmentDraft("acme/api/dev")), "mcpm://acme/api/dev");
  assert.equal(formatAddress(parseEnvironmentDraft("acme/api/dev/")), "mcpm://acme/api/dev");
  assert.equal(formatAddress(parseEnvironmentDraft("  Acme/API/Dev  ")), "mcpm://acme/api/dev");
  assert.equal(formatAddress(parseEnvironmentDraft("acme/My API/dev")), "mcpm://acme/my-api/dev");

  // A key keeps its case: `stripe_key` and `STRIPE_KEY` are different .env
  // variables, so rewriting one into the other would rename what a reference
  // already points at. Only the separators are repaired.
  assert.equal(formatAddress(parseKeyDraft("mcpm://acme/api/dev/STRIPE_KEY")), "mcpm://acme/api/dev/STRIPE_KEY");
  assert.equal(formatAddress(parseKeyDraft("acme/api/dev/stripe key")), "mcpm://acme/api/dev/stripe_key");
  assert.equal(normalizeKey("2fa"), "_2fa", "a name can't start with a digit, so it's prefixed rather than renamed");
  assert.equal(normalizeKey("stripe_key"), "stripe_key", "an underscore the user typed is not ours to rewrite");

  // Nothing here may produce an address the stored grammar would reject.
  for (const typed of ["acme/api/dev", "Acme/API/Dev", "acme/My API/dev", "My Workspace/My Project/My Env"]) {
    assert.deepEqual(Object.keys(parseAddress(formatAddress(parseEnvironmentDraft(typed)))).sort(), ["environment", "project", "workspace"]);
  }
});

test("address input: what's missing is named, in the user's own terms", () => {
  // The old failure mode was the grammar's own rule ("lowercase letters,
  // digits, - or _") handed to someone who had simply not finished typing.
  // A missing piece is a hole to fill, and the message says which one and
  // what the address will be.
  assert.deepEqual(readAddressInput("acme").missing, ["project", "environment"]);
  assert.deepEqual(readAddressInput("acme//dev").missing, ["project"], "an empty segment is a hole, not a name");
  assert.deepEqual(readAddressInput("mcpm://acme/api/dev").missing, []);
  assert.deepEqual(readAddressInput("mcpm://acme/api/dev", { needKey: true }).missing, ["key"]);
  assert.equal(missingNote(readAddressInput("acme/api").missing, readAddressInput("acme/api").parts), "Add an environment — mcpm://acme/api/{environment}");
  assert.equal(missingNote(readAddressInput("acme").missing, readAddressInput("acme").parts), "Add a project and an environment — mcpm://acme/{project}/{environment}");
  assert.equal(missingNote([], {}), null);

  assert.throws(() => parseEnvironmentDraft("acme/api"), /Add an environment — mcpm:\/\/acme\/api\/\{environment\}/);
  assert.throws(() => parseKeyDraft("mcpm://acme/api/dev"), /Add a key/);
  assert.throws(() => parseEnvironmentDraft(""), /isn't a full environment yet|Enter an environment/);
  assert.throws(() => parseEnvironmentDraft("mcpm://acme/api/dev/KEY"), /names one key/);
  assert.throws(() => parseAddress("mcpm://Acme/api/dev"), /lowercase/, "the stored grammar is unchanged by any of this");
});

test("address input: a name that can't be repaired is reported, never dropped", () => {
  const junk = readAddressInput("!!!/api/dev");
  assert.deepEqual(junk.parts, { project: "api", environment: "dev" });
  assert.deepEqual(junk.unreadable, [{ part: "workspace", from: "!!!", why: "needs at least one letter or number" }]);
  assert.throws(() => parseEnvironmentDraft("!!!/api/dev"), /The workspace "!!!" needs at least one letter/);
  // The hostile-looking one: dropping the bad segment would silently move
  // every key one slot left and store the secret in a different environment.
  assert.throws(() => parseEnvironmentDraft("mcpm://acme/api/dev/K/extra"), /more than one key/);
  assert.throws(() => parseEnvironmentDraft("mcpm://~me/dev/x"), /personal \(~me\) addresses exist only in hosted mcpmaster/);
  assert.equal(slugify("  "), "");
  assert.equal(slugify("Dev Project!"), "dev-project");
});

test("address input: one field can hold a whole pasted address", () => {
  // Pasting `mcpm://acme/api/dev/STRIPE_KEY` into the workspace box is the
  // commonest way to fill a three-box form, so it's read as an address, not
  // as a workspace named "mcpm:".
  const pasted = completeDraft({ workspace: "mcpm://acme/api/dev/STRIPE_KEY" }, { needKey: true });
  assert.deepEqual(pasted.parts, { workspace: "acme", project: "api", environment: "dev", key: "STRIPE_KEY" });
  assert.deepEqual(pasted.missing, []);
  // The ordinary case: three boxes, one piece each.
  const boxes = completeDraft({ workspace: "Acme", project: "API", environment: "dev" });
  assert.deepEqual(boxes.parts, { workspace: "acme", project: "api", environment: "dev" });
  assert.deepEqual(boxes.missing, []);
  assert.deepEqual(boxes.repaired.map((r) => r.to), ["acme", "api"]);
  // A hole in the middle of the pasted address survives as a missing piece.
  assert.deepEqual(completeDraft({ workspace: "acme//dev" }).missing, ["project"]);
  assert.equal(missingNote(completeDraft({ workspace: "acme" }).missing, completeDraft({ workspace: "acme" }).parts, false), "Add a project and an environment — mcpm://acme/{project}/{environment}");
});

function sampleInventory() {
  return [
    { address: "mcpm://acme/api/dev", keys: [{ name: "DB", updatedAt: "2024-01-01T00:00:00.000Z" }, { name: "STRIPE_KEY", updatedAt: "2024-01-02T00:00:00.000Z" }] },
    { address: "mcpm://acme/api/prod", keys: [{ name: "DB", updatedAt: "2024-01-03T00:00:00.000Z" }] },
    { address: "mcpm://other/web/dev", keys: [{ name: "TOKEN", updatedAt: "2024-01-04T00:00:00.000Z" }] },
  ];
}

test("address input: suggestions come from the vault, not from the user's memory", () => {
  const inventory = sampleInventory();
  const all = suggestionsFor(inventory, {});
  assert.deepEqual(all.workspaces, ["acme", "other"]);
  assert.deepEqual(all.projects, ["api", "web"]);
  assert.deepEqual(all.environments, ["mcpm://acme/api/dev", "mcpm://acme/api/prod", "mcpm://other/web/dev"]);

  // Once a workspace is chosen, only what exists under it is offered.
  const scoped = suggestionsFor(inventory, { workspace: "acme" });
  assert.deepEqual(scoped.projects, ["api"], "web belongs to another workspace");
  assert.deepEqual(scoped.environmentNames, ["dev", "prod"]);
  assert.deepEqual(scoped.keys, [], "no environment chosen yet, so no key names to offer");

  const chosen = suggestionsFor(inventory, { workspace: "acme", project: "api", environment: "dev" });
  assert.deepEqual(chosen.keys, ["DB", "STRIPE_KEY"], "reuse the spelling that's already stored");
  assert.deepEqual(suggestionsFor(inventory, { environment: "pro" }).environmentNames, ["prod"], "a partial name narrows the list");
  assert.deepEqual(suggestionsFor(inventory, { environment: "nope" }).environmentNames, ["dev", "prod"], "no match offers the real names instead of nothing");
});

test("address input: one definition of search, filters and paging for both surfaces", () => {
  const rows = inventoryRows(sampleInventory());
  assert.deepEqual(rows.map((row) => row.address), [
    "mcpm://acme/api/dev/DB",
    "mcpm://acme/api/dev/STRIPE_KEY",
    "mcpm://acme/api/prod/DB",
    "mcpm://other/web/dev/TOKEN",
  ]);
  // A term matches a key name or any part of its address; every term must match.
  assert.deepEqual(filterRows(rows, { search: "stripe" }).map((r) => r.key), ["STRIPE_KEY"]);
  assert.deepEqual(filterRows(rows, { search: "acme" }).map((r) => r.address), rows.slice(0, 3).map((r) => r.address), "an address match keeps every key in it");
  assert.deepEqual(filterRows(rows, { search: "acme db" }).map((r) => r.address), ["mcpm://acme/api/dev/DB", "mcpm://acme/api/prod/DB"]);
  assert.deepEqual(filterRows(rows, { environment: "prod" }).map((r) => r.address), ["mcpm://acme/api/prod/DB"]);
  assert.deepEqual(filterRows(rows, { workspace: "other", project: "web" }).map((r) => r.key), ["TOKEN"]);
  assert.equal(filterRows(rows, { search: "nothing here" }).length, 0);
  assert.equal(filterRows(rows).length, 4, "no filter is no filtering");

  const page = paginate(rows, 2, 3);
  assert.deepEqual([page.page, page.pages, page.from, page.to, page.total], [2, 2, 4, 4, 4]);
  assert.deepEqual(paginate(rows, 99, 3).items, rows.slice(3), "a page past the end clamps to the last one");
  assert.deepEqual(paginate(rows, 0, 3).page, 1);
  assert.deepEqual([paginate([], 1, 3).from, paginate([], 1, 3).to, paginate([], 1, 3).pages], [0, 0, 1]);
});

test("crypto: round-trips, and binds each value to its address", () => {
  const key = Buffer.alloc(32, 7);
  const sealed = seal(key, "mcpm://a/b/c/K", SECRET);
  assert.equal(open(key, "mcpm://a/b/c/K", sealed), SECRET);
  assert.notEqual(seal(key, "mcpm://a/b/c/K", SECRET), sealed, "fresh IV every time");
  assert.throws(() => open(key, "mcpm://a/b/c/OTHER", sealed), "moved to another address");
  assert.throws(() => open(Buffer.alloc(32, 8), "mcpm://a/b/c/K", sealed), "wrong key");
  const tampered = Buffer.from(sealed, "base64");
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => open(key, "mcpm://a/b/c/K", tampered.toString("base64")), "tampered");
});

test("masker: masks values split across chunks, without stalling ordinary output", () => {
  const masker = new Masker([SECRET, "abc"]);
  const out = [masker.push(Buffer.from(`token=${SECRET.slice(0, 10)}`)), masker.push(Buffer.from(`${SECRET.slice(10)} done\n`)), masker.flush()];
  assert.equal(Buffer.concat(out).toString(), `token=${MASK} done\n`);

  // A tail that can't start a secret is written immediately, not held back.
  assert.equal(new Masker([SECRET]).push(Buffer.from("Listening on :3000\n")).toString(), "Listening on :3000\n");
  // Values under the minimum length aren't masked (they'd shred the output).
  assert.equal(new Masker(["abc"]).push(Buffer.from("abcabc")).toString(), "abcabc");
  // Longest wins where values overlap.
  assert.equal(new Masker(["secret-value", "secret"]).push(Buffer.from("x secret-value y")).toString(), `x ${MASK} y`);
});

test("dotenv: parses the common subset and rewrites values to references in place", () => {
  const text = `# comment\nexport A="line\\nnext" # c\nB='lit # not comment'\nC=plain # comment\nD=mcpm://acme/api/dev/D\n`;
  assert.deepEqual(
    parseDotEnv(text).map((e) => [e.key, e.value]),
    [["A", "line\nnext"], ["B", "lit # not comment"], ["C", "plain"], ["D", "mcpm://acme/api/dev/D"]],
  );
  assert.throws(() => parseDotEnv('A="open\n'), /never closed/);
  assert.equal(
    rewriteAsReferences(text, "mcpm://acme/api/dev", new Set(["A", "C"])),
    `# comment\nexport A=mcpm://acme/api/dev/A\nB='lit # not comment'\nC=mcpm://acme/api/dev/C\nD=mcpm://acme/api/dev/D\n`,
  );
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test("set: value over stdin only, stored encrypted, 0600, never echoed", async () => {
  const { home } = fresh();
  const refused = await cli(home, ["set", "mcpm://acme/api/dev/STRIPE_KEY", SECRET]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /never taken as arguments/);
  assert.ok(!refused.stderr.includes(SECRET), "a refused value is not echoed back");

  const stored = await cli(home, ["set", "mcpm://acme/api/dev/STRIPE_KEY"], { input: `${SECRET}\n` });
  assert.equal(stored.code, 0, stored.stderr);
  assert.equal(stored.stdout, "");
  assert.ok(!stored.stderr.includes(SECRET));

  const raw = readFileSync(join(home, "vault.json"), "utf8");
  assert.ok(!raw.includes(SECRET), "no plaintext in vault.json");
  assert.match(raw, /"STRIPE_KEY"/, "names are stored in the clear");
  assert.equal(statSync(join(home, "vault.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, "master.key")).mode & 0o777, 0o600);
  assert.equal(statSync(home).mode & 0o777, 0o700);
});

test("run: resolves .env references in memory, masks output, withholds the master key", async () => {
  const { home, cwd } = fresh();
  await cli(home, ["set", "mcpm://acme/api/dev/STRIPE_KEY"], { input: SECRET });
  writeFileSync(join(cwd, ".env"), `STRIPE_KEY=mcpm://acme/api/dev/STRIPE_KEY\nPORT=3000\n`);

  const script = `process.stdout.write(JSON.stringify({ stripe: process.env.STRIPE_KEY, port: process.env.PORT, key: process.env.MCPV_KEY ?? null, len: process.env.STRIPE_KEY.length }))`;
  const run = await cli(home, ["run", "--", process.execPath, "-e", script], { cwd, env: { MCPV_KEY: readFileSync(join(home, "master.key"), "utf8") } });
  assert.equal(run.code, 0, run.stderr);
  const seen = JSON.parse(run.stdout);
  assert.equal(seen.stripe, MASK, "the value reached the child but not the output");
  assert.equal(seen.len, SECRET.length, "the child got the real value");
  assert.equal(seen.port, "3000", "non-references pass through");
  assert.equal(seen.key, null, "MCPV_KEY is never inherited");
  assert.match(run.stderr, /Injected 1 secret\s+STRIPE_KEY/);
  assert.ok(!run.stderr.includes(SECRET));

  const stderrLeak = await cli(home, ["run", "--", process.execPath, "-e", "console.error('boom', process.env.STRIPE_KEY)"], { cwd });
  assert.ok(!stderrLeak.stderr.includes(SECRET));
  assert.match(stderrLeak.stderr, /boom \[redacted\]/);
});

test("run: exit codes and whole-environment injection", async () => {
  const { home, cwd } = fresh();
  await cli(home, ["set", "mcpm://acme/api/prod/DATABASE_URL"], { input: DB });
  const failed = await cli(home, ["run", "--env", "mcpm://acme/api/prod", "--", process.execPath, "-e", "process.exit(process.env.DATABASE_URL.length === " + DB.length + " ? 7 : 1)"], { cwd });
  assert.equal(failed.code, 7);
  assert.match(failed.stderr, /exited with code 7/);

  assert.equal((await cli(home, ["run"], { cwd })).code, 2, "no command is a usage error");
  const missing = await cli(home, ["run", "--env", "mcpm://acme/api/nope", "--", "true"], { cwd });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no environment/);
});

test("import --rewrite, check and list: names only, everywhere", async () => {
  const { home, cwd } = fresh();
  writeFileSync(join(cwd, ".env"), `# app\nDATABASE_URL="${DB}"\nSTRIPE_KEY=${SECRET}\nPORT=3000\n`);
  const imported = await cli(home, ["import", ".env", "--into", "mcpm://acme/api/dev", "--only", "DATABASE_URL,STRIPE_KEY", "--rewrite"], { cwd });
  assert.equal(imported.code, 0, imported.stderr);
  assert.ok(!imported.stderr.includes(SECRET) && !imported.stderr.includes(DB));
  assert.equal(
    readFileSync(join(cwd, ".env"), "utf8"),
    `# app\nDATABASE_URL=mcpm://acme/api/dev/DATABASE_URL\nSTRIPE_KEY=mcpm://acme/api/dev/STRIPE_KEY\nPORT=3000\n`,
  );

  const check = await cli(home, ["check", "--json"], { cwd });
  assert.equal(check.code, 0);
  assert.equal(check.stderr, "");
  assert.equal(JSON.parse(check.stdout).ok, true);

  writeFileSync(join(cwd, ".env.bad"), "X=mcpm://acme/api/dev/NOT_THERE\n");
  const bad = await cli(home, ["check", "--env-file", ".env.bad"], { cwd });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /mcpv set mcpm:\/\/acme\/api\/dev\/NOT_THERE/);

  const list = await cli(home, ["list", "--json"]);
  assert.deepEqual(JSON.parse(list.stdout), {
    environments: [{ address: "mcpm://acme/api/dev", keys: ["DATABASE_URL", "STRIPE_KEY"] }],
    total: 1,
    page: 1,
    pageSize: 20,
    pages: 1,
    secrets: 2,
    filters: {},
  });
  assert.equal(list.stderr, "", "--json keeps stderr empty");
  assert.ok(!list.stdout.includes(SECRET) && !list.stdout.includes(DB));
});

test("integrity: moved ciphertexts and the wrong key fail loudly", async () => {
  const { home, cwd } = fresh();
  await cli(home, ["set", "mcpm://acme/api/dev/A"], { input: "value-of-a" });
  await cli(home, ["set", "mcpm://acme/api/dev/B"], { input: "value-of-b" });
  const path = join(home, "vault.json");
  const vault = JSON.parse(readFileSync(path, "utf8"));
  const env = vault.environments["acme/api/dev"];
  [env.A.value, env.B.value] = [env.B.value, env.A.value];
  writeFileSync(path, JSON.stringify(vault));

  const swapped = await cli(home, ["run", "--env", "mcpm://acme/api/dev", "--", "true"], { cwd });
  assert.equal(swapped.code, 1);
  assert.match(swapped.stderr, /integrity check/);

  const wrongKey = await cli(home, ["run", "--env", "mcpm://acme/api/dev", "--", "true"], { cwd, env: { MCPV_KEY: "00".repeat(32) } });
  assert.equal(wrongKey.code, 1);
  assert.match(wrongKey.stderr, /doesn't unlock this vault/);
});

// ---------------------------------------------------------------------------
// mcpv ui — the local server
// ---------------------------------------------------------------------------

function http(
  port: number,
  method: string,
  path: string,
  opts: { token?: string; host?: string; headers?: Record<string, string>; body?: unknown; contentType?: string } = {},
): Promise<{ status: number; headers: Record<string, unknown>; text: string }> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: opts.host ?? `127.0.0.1:${port}`,
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(body !== undefined ? { "content-type": opts.contentType ?? "application/json" } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("ui: loopback Host, per-run token, same-origin JSON writes, strict headers", async () => {
  const { home, cwd } = fresh();
  const ui = await startUi({ home, cwd });
  try {
    const page = await http(ui.port, "GET", "/");
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'.*frame-ancestors 'none'/);
    assert.equal(page.headers["cache-control"], "no-store");
    assert.match(ui.url, new RegExp(`^http://127\\.0\\.0\\.1:${ui.port}/#token=`), "the token rides in the fragment");

    assert.equal((await http(ui.port, "GET", "/", { host: `evil.example:${ui.port}` })).status, 403, "DNS rebinding");
    assert.equal((await http(ui.port, "GET", "/api/state")).status, 401, "no token");
    assert.equal((await http(ui.port, "GET", "/api/state", { token: "x".repeat(43) })).status, 401, "wrong token");
    assert.equal((await http(ui.port, "GET", "/api/state", { token: ui.token, headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await http(ui.port, "GET", "/api/state", { token: ui.token, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    const form = await http(ui.port, "POST", "/api/secrets", { token: ui.token, body: { address: "mcpm://a/b/c/K", value: SECRET }, contentType: "text/plain" });
    assert.equal(form.status, 415, "a cross-site form post can't be JSON");
    assert.equal((await http(ui.port, "GET", "/api/state", { token: ui.token })).status, 200);
  } finally {
    ui.close();
    await ui.closed;
  }
});

test("ui: values go in write-only and never come back out", async () => {
  const { home, cwd } = fresh();
  writeFileSync(join(cwd, ".env"), "STRIPE_KEY=mcpm://acme/api/dev/STRIPE_KEY\nDB=mcpm://acme/api/dev/DB\n");
  const ui = await startUi({ home, cwd });
  const seen: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await http(ui.port, method, path, { token: ui.token, body });
    seen.push(res.text);
    return { status: res.status, json: JSON.parse(res.text) };
  };
  try {
    const set = await call("POST", "/api/secrets", { address: "mcpm://acme/api/dev/STRIPE_KEY", value: SECRET });
    assert.deepEqual(set, { status: 200, json: { ok: true, address: "mcpm://acme/api/dev/STRIPE_KEY", created: true } });

    const imported = await call("POST", "/api/import", { environment: "mcpm://acme/api/dev", text: `DB="${DB}"\nPORT=3000\n`, only: ["DB"] });
    assert.deepEqual(imported.json.keys, ["DB"]);

    const state = await call("GET", "/api/state");
    assert.deepEqual(state.json.environments.map((e: { address: string; keys: { name: string }[] }) => [e.address, e.keys.map((k) => k.name)]), [["mcpm://acme/api/dev", ["DB", "STRIPE_KEY"]]]);
    const check = await call("GET", "/api/check");
    assert.deepEqual(check.json.references.map((r: { key: string; found: boolean }) => [r.key, r.found]), [["STRIPE_KEY", true], ["DB", true]]);

    // An environment address names no key, so there is nowhere to put a value:
    // it must be refused, and the message has to say which piece is missing
    // rather than restating the grammar at someone who simply stopped short.
    const bad = await call("POST", "/api/secrets", { address: "mcpm://acme/api/dev", value: SECRET });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /Add a key — mcpm:\/\/acme\/api\/dev\/\{key\}/);
    assert.equal((await call("GET", "/api/state")).json.environments[0].keys.length, 2, "nothing was stored under a half address");

    const removed = await call("POST", "/api/secrets/delete", { address: "mcpm://acme/api/dev/DB" });
    assert.equal(removed.status, 200);
    assert.equal((await call("POST", "/api/secrets/delete", { address: "mcpm://acme/api/dev/DB" })).status, 404);

    for (const text of seen) assert.ok(!text.includes(SECRET) && !text.includes(DB), `a response leaked a value: ${text}`);
    assert.ok(!readFileSync(join(home, "vault.json"), "utf8").includes(SECRET));

    // What the UI stored is what `run` injects.
    const run = await cli(home, ["run", "--env", "mcpm://acme/api/dev", "--", process.execPath, "-e", "process.exit(process.env.STRIPE_KEY === " + JSON.stringify(SECRET) + " ? 0 : 9)"], { cwd });
    assert.equal(run.code, 0, run.stderr);

    await call("POST", "/api/shutdown", {});
    await ui.closed;
  } finally {
    ui.close();
  }
});

// ---------------------------------------------------------------------------
// Addresses as people type them, and a partial one off a terminal
// ---------------------------------------------------------------------------

test("addresses: every form a person types is stored as the canonical address", async () => {
  const { home } = fresh();
  const forms = [
    "mcpm://acme/api/dev/STRIPE_KEY",
    "acme/api/dev/STRIPE_KEY",
    "Acme/API/Dev/STRIPE_KEY",
    "acme/api/dev/STRIPE_KEY/",
    "  acme/api/dev/STRIPE_KEY  ",
  ];
  for (const form of forms) {
    const stored = await cli(home, ["set", form], { input: SECRET });
    assert.equal(stored.code, 0, `${form}: ${stored.stderr}`);
    // Repaired, not stored verbatim: one address, one canonical spelling.
    // Stored the first time, Replaced after — never a separate spelling.
    assert.match(stored.stderr, /(Stored|Replaced)\s+mcpm:\/\/acme\/api\/dev\/STRIPE_KEY/);
  }
  const raw = readFileSync(join(home, "vault.json"), "utf8");
  assert.ok(raw.includes("acme/api/dev"), "one environment, however it was typed");
  assert.equal((raw.match(/"STRIPE_KEY"/g) ?? []).length, 1, "and one key, not five");

  // The same forms reach the same secret through `rm`, without a second copy.
  const removed = await cli(home, ["rm", "ACME/api/DEV/STRIPE_KEY/", "--yes"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stderr, /Deleted\s+mcpm:\/\/acme\/api\/dev\/STRIPE_KEY/);
});

test("addresses: a partial one off a TTY is exit 2, names the missing piece, and never prompts", async () => {
  const { home } = fresh();
  await cli(home, ["set", "mcpm://acme/api/dev/STRIPE_KEY"], { input: SECRET });

  // The regression this guards: piped stdin must not become an unanswered prompt.
  const missingKey = await cli(home, ["set", "acme/api/dev"], { input: "" });
  assert.equal(missingKey.code, 2);
  assert.match(missingKey.stderr, /isn't a full address yet/);
  assert.match(missingKey.stderr, /Add a key/);
  assert.match(missingKey.stderr, /mcpv set mcpm:\/\/acme\/api\/dev\/<KEY>/, "and offers the command that works");
  assert.doesNotMatch(missingKey.stderr, /Enter for|pick 1-/);

  const missingTwo = await cli(home, ["set", "acme/api"], { input: "" });
  assert.equal(missingTwo.code, 2);
  assert.match(missingTwo.stderr, /Add an environment and a key/);
  assert.match(missingTwo.stderr, /mcpv set mcpm:\/\/acme\/api\/<ENVIRONMENT>\/<KEY>/);

  const missingFromStart = await cli(home, ["rm", "mcpm://acme"], { input: "" });
  assert.equal(missingFromStart.code, 2);
  assert.match(missingFromStart.stderr, /Add a project, an environment and a key/);

  // A piece that can't be repaired is the reader's message, not the grammar's.
  const unrepairable = await cli(home, ["set", "mcpm://acme/api/!!!"], { input: "" });
  assert.equal(unrepairable.code, 2);
  assert.match(unrepairable.stderr, /needs at least one letter or number/);

  // Nothing stored behind any of it.
  const list = await cli(home, ["list"]);
  assert.equal(list.code, 0);
  assert.match(list.stderr, /1 environment · 1 secret/);
});

test("addresses: --json never prompts either", async () => {
  const { home } = fresh();
  const partial = await cli(home, ["set", "acme/api/dev", "--json"], { input: "" });
  assert.equal(partial.code, 2, "--json is a machine contract, so a question has no one to answer it");
  assert.match(partial.stderr, /Add a key/);
  assert.doesNotMatch(partial.stderr, /Enter for/);
});

// ---------------------------------------------------------------------------
// list: search, filters, paging and the prefix
// ---------------------------------------------------------------------------

/** Three environments, chosen so an address match and a key-name match differ. */
async function seedList(home: string): Promise<void> {
  for (const address of [
    "acme/api/dev/STRIPE_KEY",
    "acme/api/dev/DATABASE_URL",
    "acme/api/prod/STRIPE_KEY",
    "acme/web/dev/DB_URL",
    "beta/web/dev/DB_URL",
    "beta/web/prod/API_TOKEN",
  ]) {
    assert.equal((await cli(home, ["set", address], { input: `value-of-${address}` })).code, 0);
  }
}

test("list: the shared search rule, with an address match keeping its whole environment", async () => {
  const { home } = fresh();
  await seedList(home);

  // A key-name term shows just the keys it matched.
  const byKey = await cli(home, ["list", "--search", "DB_URL"]);
  assert.equal(byKey.code, 0);
  assert.match(byKey.stderr, /mcpm:\/\/acme\/web\/dev\s+1 key\n\s+DB_URL/);
  assert.match(byKey.stderr, /mcpm:\/\/beta\/web\/dev\s+1 key/);
  assert.doesNotMatch(byKey.stderr, /DATABASE_URL/, "an environment that didn't match keeps nothing");
  assert.match(byKey.stderr, /2 environments · 2 secrets/);

  // An address term matches every key inside it — the same rule the UI uses.
  const byAddress = await cli(home, ["list", "--search", "acme/api/dev"]);
  assert.match(byAddress.stderr, /mcpm:\/\/acme\/api\/dev\s+2 keys\n\s+DATABASE_URL\n\s+STRIPE_KEY/);
  assert.match(byAddress.stderr, /1 environment · 2 secrets/);

  // Every whitespace-separated term must appear, in a key name or in its address.
  const both = await cli(home, ["list", "--search", "acme STRIPE"]);
  assert.match(both.stderr, /mcpm:\/\/acme\/api\/dev\s+1 key\n\s+STRIPE_KEY/);
  assert.match(both.stderr, /mcpm:\/\/acme\/api\/prod\s+1 key/);
  assert.doesNotMatch(both.stderr, /DATABASE_URL/);
  assert.match(both.stderr, /2 environments · 2 secrets/);

  // A search that matches nothing says so and offers the unfiltered command.
  const none = await cli(home, ["list", "--search", "nothingmaches"]);
  assert.equal(none.code, 0, "an empty result isn't a failure");
  assert.match(none.stderr, /Nothing matches/);
  assert.match(none.stderr, /mcpv list\s+everything stored/);
});

test("list: exact slug filters, which are repaired like an address segment", async () => {
  const { home } = fresh();
  await seedList(home);

  const filtered = await cli(home, ["list", "--workspace", "acme", "--environment", "dev"]);
  assert.match(filtered.stderr, /mcpm:\/\/acme\/api\/dev/);
  assert.match(filtered.stderr, /mcpm:\/\/acme\/web\/dev/);
  assert.doesNotMatch(filtered.stderr, /beta/, "an exact filter, not a prefix one");
  assert.match(filtered.stderr, /2 environments · 3 secrets/);

  // Case is repaired, exactly as it is in an address.
  const repaired = await cli(home, ["list", "--workspace", "Acme", "--project", "API"]);
  assert.match(repaired.stderr, /mcpm:\/\/acme\/api\/dev/);
  assert.match(repaired.stderr, /2 environments · 3 secrets/);

  const bad = await cli(home, ["list", "--workspace", "!!!"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--workspace takes a name like "acme"/);
});

test("list: the positional is a prefix, so a partial address lists what's under it", async () => {
  const { home } = fresh();
  await seedList(home);

  const scheme = await cli(home, ["list", "mcpm://acme"]);
  assert.equal(scheme.code, 0, scheme.stderr);
  assert.match(scheme.stderr, /mcpm:\/\/acme\/api\/dev/);
  assert.match(scheme.stderr, /mcpm:\/\/acme\/web\/dev/);
  assert.doesNotMatch(scheme.stderr, /beta/);
  assert.match(scheme.stderr, /3 environments · 4 secrets/);

  // Without the scheme, and two segments deep.
  const bare = await cli(home, ["list", "acme/api"]);
  assert.match(bare.stderr, /mcpm:\/\/acme\/api\/dev/);
  assert.match(bare.stderr, /mcpm:\/\/acme\/api\/prod/);
  assert.doesNotMatch(bare.stderr, /acme\/web/, "api doesn't prefix-match web");
  assert.match(bare.stderr, /2 environments · 3 secrets/);

  // Case is repaired here too, and a prefix matching nothing is not an error.
  const repaired = await cli(home, ["list", "Acme/API/"]);
  assert.match(repaired.stderr, /2 environments · 3 secrets/);
  const empty = await cli(home, ["list", "acme/nope"]);
  assert.equal(empty.code, 0);
  assert.match(empty.stderr, /Nothing matches/);
});

test("list: paging over environments, with a copyable next page", async () => {
  const { home } = fresh();
  await seedList(home);

  const first = await cli(home, ["list", "--limit", "2"]);
  assert.equal(first.code, 0);
  assert.match(first.stderr, /5 environments · 6 secrets\s+showing 1–2 of 5/);
  assert.match(first.stderr, /mcpv list --limit 2 --page 2\s+\d+ more pages of environments/);
  const pageOneEnvs = (first.stderr.match(/^\s+mcpm:\/\//gm) ?? []).length;
  assert.equal(pageOneEnvs, 2, "two environments on a page of two");

  const second = await cli(home, ["list", "--limit", "2", "--page", "2"]);
  assert.match(second.stderr, /showing 3–4 of 5/);
  assert.match(second.stderr, /--limit 2 --page 3/);
  assert.doesNotMatch(second.stderr, /mcpm:\/\/acme\/api\/dev/, "a page doesn't repeat the last one");

  const last = await cli(home, ["list", "--limit", "2", "--page", "3"]);
  assert.match(last.stderr, /showing 5–5 of 5/);
  assert.doesNotMatch(last.stderr, /--page/, "no next page is offered at the end");

  // Out of range clamps to the last page rather than erroring or going blank.
  const clamped = await cli(home, ["list", "--limit", "2", "--page", "99"]);
  assert.equal(clamped.code, 0);
  assert.match(clamped.stderr, /showing 5–5 of 5/);

  for (const bad of [["--limit", "0"], ["--limit", "two"], ["--page", "-1"]]) {
    const check = await cli(home, ["list", ...bad]);
    assert.equal(check.code, 2, `${bad.join(" ")} is a usage error`);
  }
});

test("list --json: one object on stdout, and the filter it answered is echoed back", async () => {
  const { home } = fresh();
  await seedList(home);

  const filtered = await cli(home, ["list", "--json", "--search", "acme STRIPE", "--workspace", "acme"]);
  assert.equal(filtered.code, 0);
  assert.equal(filtered.stderr, "", "--json keeps stderr empty");
  assert.deepEqual(JSON.parse(filtered.stdout), {
    environments: [
      { address: "mcpm://acme/api/dev", keys: ["STRIPE_KEY"] },
      { address: "mcpm://acme/api/prod", keys: ["STRIPE_KEY"] },
    ],
    total: 2,
    page: 1,
    pageSize: 20,
    pages: 1,
    secrets: 2,
    filters: { search: "acme STRIPE", workspace: "acme" },
  });

  const paged = await cli(home, ["list", "--json", "--limit", "2", "--page", "2"]);
  assert.equal(paged.stderr, "");
  const parsed = JSON.parse(paged.stdout);
  assert.equal(parsed.total, 5, "total counts environments, which is what paging moves over");
  assert.equal(parsed.secrets, 6, "secrets counts every matched key, not just this page's");
  assert.equal(parsed.page, 2);
  assert.equal(parsed.pageSize, 2);
  assert.equal(parsed.pages, 3);
  assert.equal(parsed.environments.length, 2);
  assert.equal(parsed.environments[0].address, "mcpm://acme/web/dev");

  const prefix = await cli(home, ["list", "--json", "mcpm://acme/api"]);
  assert.equal(JSON.parse(prefix.stdout).filters.prefix, "acme/api");

  const empty = await cli(home, ["list", "--json", "--search", "nothingmaches"]);
  assert.equal(empty.code, 0, "no match is not a failure");
  assert.equal(empty.stderr, "");
  assert.deepEqual(JSON.parse(empty.stdout).environments, []);

  for (const text of [filtered.stdout, paged.stdout, prefix.stdout]) assert.ok(!text.includes("value-of-acme"));
});

test("run: the per-piece flags are refused, not silently ignored", async () => {
  const { home, cwd } = fresh();
  await cli(home, ["set", "mcpm://acme/api/dev/STRIPE_KEY"], { input: SECRET });

  // The bug this prevents: unknown flags are swallowed, so this used to inject
  // nothing and still exit 0.
  for (const name of ["workspace", "project", "environment"]) {
    const refused = await cli(home, ["run", `--${name}`, "dev", "--", process.execPath, "-e", "process.exit(3)"], { cwd });
    assert.equal(refused.code, 2, `--${name} is refused`);
    assert.match(refused.stderr, new RegExp(`run doesn't take --${name}`));
    assert.match(refused.stderr, /mcpv run --env mcpm:\/\/acme\/api\/dev -- <command>/);
    assert.match(refused.stderr, new RegExp(`mcpv list --${name} dev`));
  }

  // And --env still works, still resolving what it always did.
  const ran = await cli(home, ["run", "--env", "mcpm://acme/api/dev", "--", process.execPath, "-e", "process.exit(process.env.STRIPE_KEY.length === " + SECRET.length + " ? 0 : 9)"], { cwd });
  assert.equal(ran.code, 0, ran.stderr);
});

test("run and check: a reference is resolved the way the address was typed", async () => {
  const { home, cwd } = fresh();
  await cli(home, ["set", "mcpm://acme/api/dev/STRIPE_KEY"], { input: SECRET });
  // A trailing slash on a reference, and a .env that already holds it.
  writeFileSync(join(cwd, ".env"), `STRIPE_KEY=mcpm://acme/api/dev/STRIPE_KEY/\n`);
  const check = await cli(home, ["check", "--json"], { cwd });
  assert.equal(check.code, 0, check.stderr);
  assert.equal(check.stderr, "");
  const parsed = JSON.parse(check.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.references[0].address, "mcpm://acme/api/dev/STRIPE_KEY", "printed canonical");

  const run = await cli(home, ["run", "--", process.execPath, "-e", "process.exit(process.env.STRIPE_KEY.length === " + SECRET.length + " ? 0 : 9)"], { cwd });
  assert.equal(run.code, 0, run.stderr);

  // And a partial `--env` off a TTY is the same exit 2, naming the piece.
  const partial = await cli(home, ["run", "--env", "acme/api", "--", "true"], { cwd });
  assert.equal(partial.code, 2);
  assert.match(partial.stderr, /Add an environment/);
  assert.match(partial.stderr, /mcpv run --env mcpm:\/\/acme\/api\/<ENVIRONMENT>/);
});

test("plain output: MCPV_PLAIN=1 list carries no escape bytes and no prompts", async () => {
  const { home } = fresh();
  await seedList(home);
  const plain = await cli(home, ["list"], { env: { MCPV_PLAIN: "1" } });
  assert.equal(plain.code, 0);
  assert.equal(plain.stdout, "", "stdout stays data — and list has no data to put there");
  assert.ok(!plain.stderr.includes("\x1b"), "not one escape byte");
  assert.match(plain.stderr, /mcpm:\/\/acme\/api\/dev/);
  assert.match(plain.stderr, /-\s+5 environments · 6 secrets/, "ASCII glyph, same layout");

  const plainHelp = await cli(home, ["help"], { env: { MCPV_PLAIN: "1" } });
  assert.ok(!plainHelp.stderr.includes("\x1b"));
  assert.match(plainHelp.stderr, /--search text/);
  assert.match(plainHelp.stderr, /completed for you, piece by piece, on a terminal/);
});

// ---------------------------------------------------------------------------
// mcpv ui — the address form, the filtered page, and the import preview
//
// The page does no address reasoning of its own: it posts its boxes to
// /api/address/preview and renders the answer. These tests cover that answer
// and the rest of what the page's buttons actually call, so the two surfaces
// can't answer differently about where a secret lives.
// ---------------------------------------------------------------------------

function uiCall(port: number, token: string) {
  return async (method: string, path: string, body?: unknown) => {
    const res = await http(port, method, path, { token, body });
    return { status: res.status, json: res.text ? JSON.parse(res.text) : null };
  };
}

test("ui: the address form is told what's missing, and what was repaired", async () => {
  const { home, cwd } = fresh();
  await cli(home, ["set", "mcpm://acme/api/dev/STRIPE_KEY"], { input: SECRET });
  const ui = await startUi({ home, cwd });
  const call = uiCall(ui.port, ui.token);
  try {
    // An empty form: the shape of the address, and everything the vault could fill.
    const blank = await call("POST", "/api/address/preview", { fields: {}, needKey: true });
    assert.equal(blank.json.valid, false);
    assert.deepEqual(blank.json.missing, ["workspace", "project", "environment", "key"]);
    assert.equal(blank.json.address, "mcpm://{workspace}/{project}/{environment}/{key}");
    assert.deepEqual(blank.json.suggestions.workspaces, ["acme"], "the form offers what exists instead of a blank box");

    // Three quarters of the way: name that one piece, don't restate the rule.
    const partial = await call("POST", "/api/address/preview", { fields: { workspace: "acme", project: "api" }, needKey: false });
    assert.deepEqual(partial.json.missing, ["environment"]);
    assert.equal(partial.json.note, "Add an environment — mcpm://acme/api/{environment}");

    // What a person typed vs what it becomes: reported, never silent.
    const repaired = await call("POST", "/api/address/preview", { fields: { workspace: "Acme API", project: "dev" }, needKey: false });
    assert.deepEqual(repaired.json.repaired, [{ part: "workspace", from: "Acme API", to: "acme-api" }]);
    assert.equal(repaired.json.parts.workspace, "acme-api");

    // A whole address pasted into one box fills the others, key included.
    const pasted = await call("POST", "/api/address/preview", { fields: { workspace: "mcpm://acme/api/dev/STRIPE_KEY" }, needKey: true });
    assert.deepEqual(pasted.json.parts, { workspace: "acme", project: "api", environment: "dev", key: "STRIPE_KEY" });
    assert.equal(pasted.json.valid, true);
    assert.equal(pasted.json.address, "mcpm://acme/api/dev/STRIPE_KEY");
    assert.deepEqual(pasted.json.suggestions.keys, ["STRIPE_KEY"], "reuse the spelling the vault already has");

    // A name that can't be repaired is reported with the reason, not dropped —
    // dropping it would silently move every key one slot to the left.
    const junk = await call("POST", "/api/address/preview", { fields: { workspace: "!!!", project: "api", environment: "dev" }, needKey: false });
    assert.equal(junk.json.valid, false);
    assert.match(junk.json.problem, /The workspace "!!!" needs at least one letter or number/);
  } finally {
    ui.close();
    await ui.closed;
  }
});

test("ui: the list is one page of what the CLI would print", async () => {
  const { home, cwd } = fresh();
  for (const address of ["mcpm://acme/api/dev/DB", "mcpm://acme/api/dev/STRIPE_KEY", "mcpm://acme/api/prod/DB", "mcpm://other/web/dev/TOKEN"]) {
    await cli(home, ["set", address], { input: `${SECRET}-${address}` });
  }
  const ui = await startUi({ home, cwd });
  const call = uiCall(ui.port, ui.token);
  try {
    const all = await call("GET", "/api/secrets?limit=2&page=1");
    assert.equal(all.json.total, 4);
    assert.equal(all.json.pages, 2);
    assert.equal(all.json.pageSize, 2);
    assert.deepEqual([all.json.from, all.json.to], [1, 2], "the page says which slice of the whole it is");
    assert.deepEqual(all.json.items.map((row: { address: string }) => row.address), ["mcpm://acme/api/dev/DB", "mcpm://acme/api/dev/STRIPE_KEY"]);
    assert.deepEqual(all.json.environments, ["mcpm://acme/api/dev", "mcpm://acme/api/prod", "mcpm://other/web/dev"], "every environment the filter matched, so the page can offer them as scopes");

    // The shared rule: a term matches a key name or anywhere in its address,
    // every term must match, and an address match keeps all of its keys.
    assert.equal((await call("GET", "/api/secrets?search=token")).json.total, 1);
    assert.equal((await call("GET", "/api/secrets?search=acme")).json.total, 3);
    assert.equal((await call("GET", "/api/secrets?search=acme%20db")).json.total, 2);
    assert.equal((await call("GET", "/api/secrets?search=nothing")).json.total, 0);
    assert.deepEqual((await call("GET", "/api/secrets?environment=prod")).json.items.map((r: { key: string }) => r.key), ["DB"]);
    assert.deepEqual((await call("GET", "/api/secrets?workspace=other&project=web")).json.items.map((r: { key: string }) => r.key), ["TOKEN"]);

    // A page past the end clamps rather than showing nothing, and a nonsense
    // page size can't be used to ask for the whole vault at once.
    const clamped = await call("GET", "/api/secrets?limit=2&page=99");
    assert.deepEqual([clamped.json.page, clamped.json.from, clamped.json.to], [2, 3, 4]);
    assert.equal((await call("GET", "/api/secrets?limit=99999")).json.pageSize, 200, "the ceiling holds");

    const rows = await call("GET", "/api/secrets");
    for (const row of rows.json.items) {
      assert.deepEqual(Object.keys(row).sort(), ["address", "environment", "key", "path", "project", "updatedAt", "workspace"], "a row carries names and times, nothing else");
    }
  } finally {
    ui.close();
    await ui.closed;
  }
});

test("ui: an import is planned before anything is stored, and values never come back", async () => {
  const { home, cwd } = fresh();
  writeFileSync(join(cwd, ".env"), `DATABASE_URL="${DB}"\nSTRIPE_KEY=${SECRET}\nPORT=3000\nEMPTY=\nREFERENCE=mcpm://acme/api/dev/REFERENCE\n`);
  const ui = await startUi({ home, cwd });
  const call = uiCall(ui.port, ui.token);
  const seen: string[] = [];
  const watch = async (method: string, path: string, body?: unknown) => {
    const res = await uiCall(ui.port, ui.token)(method, path, body);
    seen.push(JSON.stringify(res.json));
    return res;
  };
  try {
    // This folder's .env is read by mcpv itself: the answer names keys and
    // counts, and the file's own reference tells the form which environment it
    // belongs to, so nothing has to be typed twice.
    const folder = await watch("POST", "/api/import/preview", { source: "project" });
    assert.equal(folder.json.file, join(cwd, ".env"));
    assert.deepEqual(folder.json.plain, ["DATABASE_URL", "STRIPE_KEY", "PORT"]);
    assert.deepEqual(folder.json.references, ["REFERENCE"]);
    assert.deepEqual(folder.json.skipped, ["EMPTY"]);
    assert.equal(folder.json.environment, "mcpm://acme/api/dev");

    // A pasted .env is planned the same way, from the request body.
    const pasted = await watch("POST", "/api/import/preview", { text: "A=1\nB=\nC=mcpm://acme/api/prod/C\n" });
    assert.deepEqual([pasted.json.plain, pasted.json.skipped, pasted.json.references], [["A"], ["B"], ["C"]]);
    assert.equal(pasted.json.environment, "mcpm://acme/api/prod");
    assert.equal((await watch("POST", "/api/import/preview", { text: "not a line\n" })).json.error, "Line 1 isn't KEY=value");

    // `source` names one of two ways in — it is never a path, so a request
    // can't turn this route into a file reader.
    for (const source of ["/etc/passwd", "../../secrets", "file"]) {
      const refused = await watch("POST", "/api/import/preview", { source });
      assert.equal(refused.status, 400, `source ${source}`);
      assert.match(refused.json.error, /source must be "project" or "text"/);
    }
    const outside = await watch("POST", "/api/import", { source: "proj/.env", fields: { workspace: "a", project: "b", environment: "c" } });
    assert.equal(outside.status, 400);

    // Importing that folder's .env needs only the environment boxes; the
    // values never travel over the socket at all for this source.
    const imported = await call("POST", "/api/import", { source: "project", fields: { workspace: "acme", project: "api", environment: "dev" }, only: ["DATABASE_URL", "STRIPE_KEY"] });
    assert.equal(imported.status, 200);
    assert.deepEqual(imported.json.keys, ["DATABASE_URL", "STRIPE_KEY"]);
    assert.deepEqual((await call("GET", "/api/state")).json.environments.map((e: { keys: { name: string }[] }) => e.keys.map((k) => k.name)), [["DATABASE_URL", "STRIPE_KEY"]], "the reference and the empty value were skipped");

    for (const response of seen) assert.ok(!response.includes(SECRET) && !response.includes(DB), `a preview leaked a value: ${response}`);
  } finally {
    ui.close();
    await ui.closed;
  }
});

test("ui: every endpoint the page calls is one the server answers", async () => {
  // The page and the server are two files with no compiler between them, so a
  // renamed route would show up as a broken button and nothing else. This is
  // the cheapest check that they still agree.
  const app = readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
  const routes = new Set<string>();
  for (const match of app.matchAll(/api\("(GET|POST)", *[`"](\/api\/[^?`"$]*)/g)) routes.add(`${match[1]} ${match[2]}`);
  assert.ok(routes.size >= 6, `found only ${routes.size} calls — the scan is broken, not the page`);

  const { home, cwd } = fresh();
  const ui = await startUi({ home, cwd });
  const call = uiCall(ui.port, ui.token);
  const bodies: Record<string, unknown> = {
    "POST /api/secrets": { fields: {}, value: "x" },
    "POST /api/secrets/delete": { address: "mcpm://a/b/c/K" },
    "POST /api/import": { fields: {} },
    "POST /api/import/preview": { text: "" },
    "POST /api/address/preview": { fields: {} },
  };
  // /api/shutdown is left out on purpose: answering it stops the server, so it
  // is asserted below, last, rather than in the middle of the sweep.
  try {
    for (const route of routes) {
      const [method, path] = route.split(" ");
      const res = await call(method, path, bodies[route]);
      assert.ok(!(res.status === 404 && res.json?.error === "Not found"), `${route} isn't routed`);
      assert.ok(!(res.status === 405), `${route} answers the wrong method`);
    }
    const off = await call("POST", "/api/shutdown", {});
    assert.equal(off.status, 200);
  } finally {
    ui.close();
    await ui.closed;
  }
});

test("dotenv: a reference is read the way it was written", async () => {
  const { home, cwd } = fresh();
  await cli(home, ["set", "mcpm://acme/api/dev/STRIPE_KEY"], { input: SECRET });

  // Capitals and a trailing slash are the same address, and `run` has to
  // resolve them rather than passing the text through as the value.
  writeFileSync(join(cwd, ".env"), "STRIPE_KEY=mcpm://Acme/API/Dev/STRIPE_KEY/\n");
  const run = await cli(home, ["run", "--", process.execPath, "-e", "process.exit(process.env.STRIPE_KEY === " + JSON.stringify(SECRET) + " ? 0 : 9)"], { cwd });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /Injected 1 secret/);

  const check = await cli(home, ["check", "--json"], { cwd });
  assert.equal(JSON.parse(check.stdout).ok, true);
  assert.equal(JSON.parse(check.stdout).references[0].address, "mcpm://acme/api/dev/STRIPE_KEY", "reported canonically");

  // One slash is unambiguous, so it is repaired like any other typo.
  writeFileSync(join(cwd, ".env.slash"), "STRIPE_KEY=mcpm:/acme/api/dev/STRIPE_KEY\n");
  assert.equal((await cli(home, ["check", "--env-file", ".env.slash"], { cwd })).code, 0);

  // A value that says it's an address but can't be completed is reported — the
  // one outcome that must never happen is injecting the text as the value.
  writeFileSync(join(cwd, ".env.bad"), "STRIPE_KEY=mcpm://acme/api/dev\nOTHER=mcpm:nonsense\n");
  // Exit 2, not 1: the .env itself is wrong, which is the invocation being
  // wrong — a reference that is well formed but missing is the check failing (1).
  const bad = await cli(home, ["check", "--env-file", ".env.bad"], { cwd });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /Line 1 \(STRIPE_KEY\): .*Add a key/);
  const badRun = await cli(home, ["run", "--env-file", ".env.bad", "--", "true"], { cwd });
  assert.equal(badRun.code, 2);
  assert.equal(badRun.stdout, "", "the child never ran, so the address text was never injected as its value");

  // Anything that doesn't claim to be an address stays a value — a slashed
  // path in a .env is a path, not a reference.
  writeFileSync(join(cwd, ".env.plain"), "LOG_PATH=var/log/app/err\nPORT=3000\n");
  assert.deepEqual(JSON.parse((await cli(home, ["check", "--env-file", ".env.plain", "--json"], { cwd })).stdout).references, []);
  const imported = await cli(home, ["import", ".env.plain", "--into", "acme/api/dev"], { cwd });
  assert.equal(imported.code, 0, imported.stderr);
  assert.deepEqual(JSON.parse((await cli(home, ["list", "--json"])).stdout).environments[0].keys, ["LOG_PATH", "PORT", "STRIPE_KEY"]);
});

test("cli: a flag no command reads is a wrong invocation, not a silent no-op", async () => {
  const { home, cwd } = fresh();
  await cli(home, ["set", "mcpm://acme/api/dev/STRIPE_KEY"], { input: SECRET });

  // The confusing ones: a machine-ish flag on the wrong command, and a typo
  // that used to print everything as though the filter had matched.
  const typo = await cli(home, ["list", "--seach", "stripe"], { cwd });
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /list doesn't take --seach/);
  assert.match(typo.stderr, /mcpv help/);

  const elsewhere = await cli(home, ["set", "mcpm://acme/api/dev/KEY2", "--into", "acme/api/dev"], { cwd });
  assert.equal(elsewhere.code, 2);
  assert.match(elsewhere.stderr, /set doesn't take --into \(it's a import flag\)/);

  const runTypo = await cli(home, ["run", "--quiet", "--seach", "x", "--", "true"], { cwd });
  assert.equal(runTypo.code, 2);
  assert.match(runTypo.stderr, /run doesn't take --seach/);

  // The flags each command does read still work, `--json` included (it is the
  // promise that nothing will be asked, on every command).
  assert.equal((await cli(home, ["list", "--json"])).code, 0);
  assert.equal((await cli(home, ["check", "--json"], { cwd: fresh().cwd })).code, 2, "no .env here is still a usage error");
  assert.equal((await cli(home, ["doctor", "--json"])).code, 0);
  assert.equal((await cli(home, ["rm", "mcpm://acme/api/dev/STRIPE_KEY", "--yes"])).code, 0);
});

test("ui: the file picker can select any file, because .env is not a file type", async () => {
  // This is a regression pin, not a style preference. The first version hid a
  // file input behind a styled button and put `accept=".env,.env.*,…"` on it.
  // A dotfile has no MIME type and `.env.production` matches no extension
  // token, so the native dialog opened with the file a person needed greyed
  // out and unselectable — the button looked fine and did nothing. Both halves
  // of that are asserted here so neither comes back:
  //   * no accept filter — refusing nothing is the only filter that always works;
  //   * no .click() on a file input — a dialog for a control the browser was
  //     told not to render is the part that has no guaranteed behaviour.
  const app = readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");

  const input = /h\("input", \{ type: "file"[^}]*\}/.exec(app);
  assert.ok(input, "the import dialog still has a file input");
  assert.ok(!input[0].includes("accept"), `the file input must not filter what can be chosen: ${input[0]}`);
  assert.ok(!/h\("input", \{ type: "file"[^}]*class: "(?:visually-hidden|sr-only)"/.test(app), "the input is a real control, not a hidden one behind a button");
  assert.ok(!/(?:picker|file)\.click\(\)/.test(app), "nothing calls .click() on a file input");

  // And it is served that way, with a handler that reads what was chosen.
  const { home, cwd } = fresh();
  const ui = await startUi({ home, cwd });
  try {
    const served = await http(ui.port, "GET", "/app.js", { token: ui.token });
    assert.equal(served.status, 200);
    assert.match(served.text, /type: "file"/);
    assert.match(served.text, /picker\.addEventListener\("change"/);
    assert.ok(!/picker\.click\(\)/.test(served.text));
  } finally {
    ui.close();
    await ui.closed;
  }
});
