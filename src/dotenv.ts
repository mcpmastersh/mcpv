// .env files whose secret values are *references*:
//
//   DATABASE_URL=mcpm://acme/api/dev/DATABASE_URL
//   STRIPE_KEY=mcpm://acme/api/dev/STRIPE_KEY
//   PORT=3000
//
// A file like that is safe to commit, safe to paste into an issue, and safe
// for an agent to read — it holds addresses, not values. `run` resolves the
// references in memory and passes everything else through untouched.
//
// The parser covers the dotenv subset people actually write: comments, blank
// lines, an optional `export `, unquoted values (with ` #` comments),
// 'single-quoted' literals and "double-quoted" values with \n, \t, \" and \\.
// Multi-line quoted values are rejected rather than half-parsed.

import { isAddress, parseKeyAddress } from "./address.ts";
import type { Vault } from "./vault.ts";

export type DotEnvEntry = { key: string; value: string; line: number };

export class DotEnvError extends Error {}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function parseValue(raw: string, lineNumber: number): string {
  const text = raw.trim();
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1);
    if (end === -1) throw new DotEnvError(`Line ${lineNumber}: the ' quote is never closed (multi-line values aren't supported)`);
    return text.slice(1, end);
  }
  if (text.startsWith('"')) {
    let value = "";
    for (let i = 1; i < text.length; i++) {
      const char = text[i];
      if (char === '"') return value;
      if (char === "\\" && i + 1 < text.length) {
        const next = text[++i];
        value += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
      } else {
        value += char;
      }
    }
    throw new DotEnvError(`Line ${lineNumber}: the " quote is never closed (multi-line values aren't supported)`);
  }
  const comment = text.search(/\s#/);
  return (comment === -1 ? text : text.slice(0, comment)).trim();
}

export function parseDotEnv(text: string): DotEnvEntry[] {
  const entries: DotEnvEntry[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const match = line.match(LINE);
    if (!match) throw new DotEnvError(`Line ${index + 1} isn't KEY=value`);
    entries.push({ key: match[1], value: parseValue(match[2], index + 1), line: index + 1 });
  });
  return entries;
}

/** The `mcpm://` references in a .env, validated. Never touches a value. */
export function references(entries: DotEnvEntry[]): { key: string; address: string; line: number }[] {
  return entries
    .filter((entry) => isAddress(entry.value))
    .map((entry) => {
      try {
        parseKeyAddress(entry.value);
      } catch (error) {
        throw new DotEnvError(`Line ${entry.line} (${entry.key}): ${(error as Error).message}`);
      }
      return { key: entry.key, address: entry.value, line: entry.line };
    });
}

/**
 * Resolves a parsed .env against the vault: references become their values
 * (in memory), everything else passes through. `secretKeys` names which
 * variables came from the vault, so the caller knows what to mask.
 */
export function resolveDotEnv(vault: Vault, entries: DotEnvEntry[]): { env: Record<string, string>; secretKeys: string[] } {
  const refs = new Map(references(entries).map((ref) => [ref.line, ref]));
  const env: Record<string, string> = {};
  const secretKeys: string[] = [];
  for (const entry of entries) {
    const ref = refs.get(entry.line);
    if (ref) {
      env[entry.key] = vault.resolveKey(ref.address);
      secretKeys.push(entry.key);
    } else {
      env[entry.key] = entry.value;
    }
  }
  return { env, secretKeys };
}

/**
 * Rewrites a .env so the given keys hold references instead of values —
 * every other line (comments, ordering, untouched keys) is kept byte for byte.
 */
export function rewriteAsReferences(text: string, environment: string, keys: Set<string>): string {
  const base = environment.replace(/\/$/, "");
  return text
    .split(/(\r?\n)/)
    .map((part) => {
      const match = part.match(LINE);
      if (!match || !keys.has(match[1])) return part;
      const prefix = part.slice(0, part.indexOf("=") + 1);
      return `${prefix}${base}/${match[1]}`;
    })
    .join("");
}
