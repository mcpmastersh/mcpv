// `mcpv ui` — a local web UI for the vault, running only while you use it.
//
// It manages secrets without ever showing one: the API returns environment
// addresses, key names and timestamps, and accepts values write-only (set,
// replace, import). No route returns, echoes or logs a value.
//
// Threat model. This runs on a developer's machine, where the realistic
// attacker is a web page open in their browser, or another local process:
//   - Bound to 127.0.0.1 only, on a random port unless --port says otherwise.
//   - The Host header must be a loopback name for our port, which defeats DNS
//     rebinding (evil.example resolving to 127.0.0.1 still sends its own Host).
//   - Every /api/* call needs this run's token as a Bearer header, compared in
//     constant time. The token is random per run, lives only in this process
//     and the URL fragment it prints (a fragment is never sent to a server),
//     and dies with the process, so there's nothing on disk to steal.
//   - A request carrying an Origin must be same-origin, a Sec-Fetch-Site other
//     than same-origin/none is refused, and writes must be application/json.
//   - Strict CSP, no framing, no referrer, no caching.
//   - It shuts itself down after IDLE_MINUTES without an API call, and on the
//     UI's Close button, so it never lingers as a background service.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AddressError, formatAddress, parseEnvironmentAddress, parseKeyAddress } from "./address.ts";
import { DotEnvError, parseDotEnv, references } from "./dotenv.ts";
import { KeyError } from "./keys.ts";
import { Vault, VaultError, readVaultFile, vaultHome } from "./vault.ts";
import { webAsset } from "./web-assets.ts";
import { VERSION } from "./version.ts";

export const IDLE_MINUTES = 15;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_VALUE_BYTES = 64 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

const CONTENT_TYPES: Record<string, string> = {
  "/": "text/html; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/app.css": "text/css; charset=utf-8",
  "/logo.svg": "image/svg+xml",
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: string | Buffer, contentType: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": contentType });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "That's too large to send in one go");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "Expected a JSON object");
}

function text(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, `Missing ${field}`);
  return value;
}

// ---------------------------------------------------------------------------
// Views — names, addresses and timestamps. Never a value.
// ---------------------------------------------------------------------------

function state(home: string) {
  const file = readVaultFile(home);
  if (!file) return { version: VERSION, home, keyStore: null, environments: [] };
  return { version: VERSION, home, keyStore: file.keyStore, environments: Vault.open(home).inventory() };
}

/** The .env in the folder `mcpv ui` was started from: which references resolve. */
function projectCheck(home: string, cwd: string) {
  const path = join(cwd, ".env");
  if (!existsSync(path)) return { file: null, references: [] };
  const vault = readVaultFile(home) ? Vault.open(home) : null;
  try {
    const refs = references(parseDotEnv(readFileSync(path, "utf8")));
    return {
      file: path,
      references: refs.map((ref) => ({ key: ref.key, address: ref.address, found: vault?.has(ref.address) ?? false })),
    };
  } catch (error) {
    if (error instanceof DotEnvError) return { file: path, references: [], error: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export type UiServer = { url: string; port: number; token: string; closed: Promise<void>; close(): void };

export function startUi(options: { port?: number; home?: string; cwd?: string } = {}): Promise<UiServer> {
  const home = options.home ?? vaultHome();
  const cwd = options.cwd ?? process.cwd();
  const token = randomBytes(32).toString("base64url");
  let port = 0;
  let idle: NodeJS.Timeout | undefined;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.end();
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      // Vault, address and .env errors are written for people and never carry
      // a value; anything else is unexpected and stays generic.
      if (error instanceof VaultError || error instanceof KeyError || error instanceof AddressError || error instanceof DotEnvError) {
        return sendJson(res, 400, { error: error.message });
      }
      sendJson(res, 500, { error: "Something went wrong. Please try again." });
    });
  });

  const close = () => {
    clearTimeout(idle);
    server.close(() => resolveClosed());
    server.closeAllConnections();
  };
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(close, IDLE_MINUTES * 60_000);
    idle.unref();
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const host = req.headers.host ?? "";
    if (!allowedHosts.has(host)) throw new HttpError(403, "Forbidden");
    const url = new URL(req.url ?? "/", `http://${host}`);

    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
      const asset = webAsset(url.pathname);
      if (asset === null) throw new HttpError(404, "Not found");
      return send(res, 200, asset, CONTENT_TYPES[url.pathname]);
    }

    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) throw new HttpError(403, "Forbidden");
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") throw new HttpError(403, "Forbidden");
    if (!tokenMatches(req.headers.authorization, token)) throw new HttpError(401, "This session has ended — run mcpv ui again");
    touch();

    const route = `${req.method} ${url.pathname}`;
    if (req.method === "POST" && !(req.headers["content-type"] ?? "").startsWith("application/json")) {
      throw new HttpError(415, "Expected application/json");
    }

    switch (route) {
      case "GET /api/state":
        return sendJson(res, 200, state(home));

      case "GET /api/check":
        return sendJson(res, 200, projectCheck(home, cwd));

      case "POST /api/secrets": {
        const body = await readJson(req);
        const address = formatAddress(parseKeyAddress(text(body, "address")));
        const value = body.value;
        if (typeof value !== "string" || value === "") throw new HttpError(400, "Enter a value");
        if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new HttpError(413, "That value is over 64 KB");
        const { created } = Vault.init(home).vault.set(address, value);
        return sendJson(res, 200, { ok: true, address, created });
      }

      case "POST /api/secrets/delete": {
        const body = await readJson(req);
        const address = formatAddress(parseKeyAddress(text(body, "address")));
        if (!readVaultFile(home) || !Vault.open(home).remove(address)) throw new HttpError(404, `Nothing is stored at ${address}`);
        return sendJson(res, 200, { ok: true, address });
      }

      case "POST /api/import": {
        const body = await readJson(req);
        const environment = formatAddress(parseEnvironmentAddress(text(body, "environment")));
        const only = Array.isArray(body.only) ? new Set(body.only.filter((k): k is string => typeof k === "string")) : null;
        const entries = parseDotEnv(text(body, "text")).filter(
          (entry) => entry.value !== "" && !entry.value.startsWith("mcpm://") && (!only || only.has(entry.key)),
        );
        if (entries.length === 0) throw new HttpError(400, "No plain values to import — references and empty values are skipped");
        const result = Vault.init(home).vault.setMany(environment, Object.fromEntries(entries.map((e) => [e.key, e.value])));
        return sendJson(res, 200, { ok: true, environment, keys: entries.map((e) => e.key), ...result });
      }

      case "POST /api/shutdown":
        sendJson(res, 200, { ok: true });
        setImmediate(close);
        return;

      default:
        throw new HttpError(404, "Not found");
    }
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      touch();
      resolve({ url: `http://127.0.0.1:${port}/#token=${token}`, port, token, closed, close });
    });
  });
}
