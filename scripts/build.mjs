// Bundles mcpv into dependency-free files: dist/mcpv.mjs (the CLI, with the
// web UI inlined) and dist/index.mjs (the library). There are no runtime dependencies to
// resolve — only node:crypto, node:fs and node:child_process.

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const WEB_FILES = { "/": "index.html", "/app.js": "app.js", "/app.css": "app.css", "/logo.svg": "logo.svg" };

// Replaces src/web-assets.ts (which reads from disk) with the same files inlined.
const inlineWebAssets = {
  name: "inline-web-assets",
  setup(b) {
    b.onLoad({ filter: /[\\/]web-assets\.ts$/ }, () => {
      const files = Object.fromEntries(
        Object.entries(WEB_FILES).map(([path, file]) => [path, readFileSync(join(root, "src", "web", file), "utf8")]),
      );
      return {
        loader: "ts",
        contents: `const FILES = ${JSON.stringify(files)};\nexport function webAsset(path) { return Object.hasOwn(FILES, path) ? FILES[path] : null; }\n`,
      };
    });
  },
};

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  legalComments: "eof",
  define: { __MCPV_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "warning",
  plugins: [inlineWebAssets],
};

await build({
  ...common,
  entryPoints: [join(root, "src", "bin.ts")],
  outfile: join(root, "dist", "mcpv.mjs"),
  minify: true,
  banner: { js: "#!/usr/bin/env node" },
});

await build({
  ...common,
  entryPoints: [join(root, "src", "index.ts")],
  outfile: join(root, "dist", "index.mjs"),
});
