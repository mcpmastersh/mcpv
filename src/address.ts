// `mcpm://` addresses — the same grammar the hosted mcpmaster Agent Secrets
// product uses, so a `.env` full of references works unchanged whether it is
// resolved from this local vault or from a hosted workspace:
//
//   mcpm://<workspace>/<project>/<environment>          a whole environment
//   mcpm://<workspace>/<project>/<environment>/<KEY>    one secret
//
// Workspace, project and environment are slugs; KEY is env-var shaped. Nothing
// an address can legally contain needs escaping, so an address is one
// readable, hand-typeable shell word and is compared verbatim. (The hosted
// product's personal `~me/…` branch has no meaning offline — there is only
// one person here — so it is rejected with a message instead of guessed at.)

const SCHEME = "mcpm://";
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type EnvironmentAddress = { workspace: string; project: string; environment: string };
export type Address = EnvironmentAddress & { key?: string };

export class AddressError extends Error {}

export function isAddress(value: string): boolean {
  return value.startsWith(SCHEME);
}

export function parseAddress(raw: string): Address {
  const text = raw.trim();
  if (!isAddress(text)) {
    throw new AddressError(`"${raw}" isn't an mcpm:// address`);
  }
  const segments = text.slice(SCHEME.length).split("/");
  if (segments.at(-1) === "") segments.pop();
  if (segments[1] === "~me") {
    throw new AddressError(`Personal (~me) addresses only exist in hosted mcpmaster — a local vault has one owner`);
  }
  if (segments.length < 3 || segments.length > 4) {
    throw new AddressError(`"${raw}" should look like mcpm://<workspace>/<project>/<environment>[/<KEY>]`);
  }
  const [workspace, project, environment, key] = segments;
  for (const [label, value] of [
    ["workspace", workspace],
    ["project", project],
    ["environment", environment],
  ] as const) {
    if (!SLUG.test(value)) {
      throw new AddressError(`The ${label} "${value}" must be lowercase letters, digits, "-" or "_"`);
    }
  }
  if (key !== undefined && !KEY.test(key)) {
    throw new AddressError(`The key "${key}" must look like an environment variable name (A-Z, 0-9, _)`);
  }
  return { workspace, project, environment, ...(key === undefined ? {} : { key }) };
}

export function parseKeyAddress(raw: string): Required<Address> {
  const address = parseAddress(raw);
  if (address.key === undefined) {
    throw new AddressError(`"${raw}" names a whole environment — add the key: ${raw.replace(/\/$/, "")}/<KEY>`);
  }
  return address as Required<Address>;
}

export function parseEnvironmentAddress(raw: string): EnvironmentAddress {
  const { key, ...environment } = parseAddress(raw);
  if (key !== undefined) {
    throw new AddressError(`"${raw}" names one key — drop "/${key}" to address its environment`);
  }
  return environment;
}

/** The vault's storage key for an environment: `workspace/project/environment`. */
export function environmentPath(address: EnvironmentAddress): string {
  return `${address.workspace}/${address.project}/${address.environment}`;
}

export function formatAddress(address: Address): string {
  return `${SCHEME}${environmentPath(address)}${address.key === undefined ? "" : `/${address.key}`}`;
}

export function isKeyName(value: string): boolean {
  return KEY.test(value);
}
