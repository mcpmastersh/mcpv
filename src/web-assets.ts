// The web UI's static files. Run from source, they're read from src/web/ on
// disk; in the published bundle, scripts/build.mjs replaces this module with
// one that has the same files inlined, so `mcpv` ships as one file.

import { readFileSync } from "node:fs";

const FILES: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/app.css": "app.css",
  "/logo.svg": "logo.svg",
};

export function webAsset(path: string): string | null {
  const file = FILES[path];
  if (!file) return null;
  return readFileSync(new URL(`./web/${file}`, import.meta.url), "utf8");
}
