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
import { parseAddress, parseKeyAddress } from "../src/address.ts";
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
  assert.deepEqual(JSON.parse(list.stdout), { environments: [{ address: "mcpm://acme/api/dev", keys: ["DATABASE_URL", "STRIPE_KEY"] }] });
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

    const bad = await call("POST", "/api/secrets", { address: "mcpm://acme/api/dev", value: SECRET });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /whole environment/);

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
