// Injected by scripts/build.mjs from package.json; "dev" when run from source.
declare const __MCPV_VERSION__: string | undefined;

export const VERSION: string = typeof __MCPV_VERSION__ === "string" ? __MCPV_VERSION__ : "0.0.0-dev";
