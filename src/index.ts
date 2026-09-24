// The library surface, for tools that want to resolve `mcpm://` references
// themselves — e.g. a local MCP runtime handing a vault secret straight to an
// outbound request header, so the value never passes through the agent.
// Same rule as the CLI: values go to the code that uses them, never to a display.

export { AddressError, formatAddress, isAddress, parseAddress, parseEnvironmentAddress, parseKeyAddress } from "./address.ts";
export type { Address, EnvironmentAddress } from "./address.ts";
export { DotEnvError, parseDotEnv, references, resolveDotEnv, rewriteAsReferences } from "./dotenv.ts";
export type { DotEnvEntry } from "./dotenv.ts";
export { KeyError } from "./keys.ts";
export type { KeyStore } from "./keys.ts";
export { MASK, Masker } from "./mask.ts";
export { CommandNotFoundError, runWithEnv } from "./run.ts";
export { Vault, VaultError, vaultHome } from "./vault.ts";
