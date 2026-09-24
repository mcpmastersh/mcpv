// Bundles mcpv into dependency-free files: dist/mcpv.mjs (the CLI)
// and dist/index.mjs (the library). There are no runtime dependencies to
// resolve — only node:crypto, node:fs and node:child_process.

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  legalComments: "eof",
  define: { __MCPV_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "warning",
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
