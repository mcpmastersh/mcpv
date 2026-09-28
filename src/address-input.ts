// Everything that happens *before* an address reaches address.ts.
//
// address.ts owns the grammar: what an address may contain, and that it is
// compared verbatim. Its messages describe that grammar ("must be lowercase
// letters, digits, - or _"), which leaves a person holding a rule they have to
// translate into an action. This module turns it around: repair what is
// unambiguous — case, spaces, punctuation used as a separator, a missing
// scheme, a trailing slash, a whole address pasted into one field — and when
// something is genuinely missing, name that one piece and where it goes.
//
// It is shared by the CLI and the local web UI so both answer the same way.
// The repair mirrors the hosted product's slugifyAddressName() /
// normalizeSecretKey() on purpose: the grammar is shared with hosted
// mcpmaster, so the *normalizer* has to be shared too, or
// the same typing would store `dev-project` here and something else there.
//
// Nothing here loosens the grammar. Every function either produces a string
// address.ts would accept unchanged, or reports why it can't.

import { type Address, type EnvironmentAddress, AddressError } from "./address.ts";

export type Part = "workspace" | "project" | "environment" | "key";

/** Address order. `key` is optional; the first three are not. */
export const PARTS: readonly Part[] = ["workspace", "project", "environment", "key"];

export type Draft = { workspace?: string; project?: string; environment?: string; key?: string };

/** Longest name a segment may be — the same ceiling the hosted product enforces. */
export const MAX_NAME_LENGTH = 100;

/** The grammar's own pattern, restated here so a repair can be checked without parsing. */
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** How a missing piece reads in a sentence: "…is missing an environment". */
const ARTICLE: Record<Part, string> = { workspace: "a workspace", project: "a project", environment: "an environment", key: "a key" };

const SCHEME = /^mcpm:\/*/i;

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

/**
 * Any name a person might type → a slug the grammar accepts, or "" when there
 * is nothing left to salvage ("!!!"). Used for workspace, project, environment.
 */
export function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/[^a-z0-9]+$/, "");
}

/**
 * The same repair while a person is still typing into a field: a separator
 * they just produced is kept ("acme " → "acme-"), so typing "acme api" one
 * character at a time doesn't land the `a` on the end as `acmea`.
 */
export function slugifyWhileTyping(raw: string): string {
  const slug = slugify(raw);
  if (slug === "") return slug;
  const last = raw.toLowerCase().slice(-1);
  if (!/[a-z0-9]/.test(last)) return `${slug}${last === "_" ? "_" : "-"}`;
  return slug;
}

/** Why a repaired slug still isn't usable, or null if it is. */
export function slugProblem(slug: string): string | null {
  if (slug === "") return "needs at least one letter or number";
  if (slug.length > MAX_NAME_LENGTH) return `must be ${MAX_NAME_LENGTH} characters or fewer`;
  if (!SLUG.test(slug)) return 'can only contain lowercase letters, numbers, "-" and "_", and must start with one';
  return null;
}

/**
 * A key name → the same name with word separators collapsed to `_`. Case is
 * deliberately left alone: `stripe_key` and `STRIPE_KEY` are different .env
 * variables, and rewriting one into the other would silently rename the thing
 * a `.env` is already pointing at.
 */
export function normalizeKey(raw: string): string {
  const collapsed = raw
    .trim()
    .replace(/^[^A-Za-z0-9_]+/, "")
    .replace(/[^A-Za-z0-9_]+$/, "")
    .replace(/[^A-Za-z0-9_]+/g, "_");
  if (collapsed === "") return "";
  // A name can't start with a digit, and dropping the digit would silently
  // rename the key, so it is prefixed instead.
  return /^[0-9]/.test(collapsed) ? `_${collapsed}` : collapsed;
}

/** The same, while typing: "STRIPE " → "STRIPE_", without stacking underscores. */
export function normalizeKeyWhileTyping(raw: string): string {
  const key = normalizeKey(raw);
  if (key === "") return "";
  const last = raw.slice(-1);
  if (last !== "" && !/[A-Za-z0-9_]/.test(last) && !key.endsWith("_")) return `${key}_`;
  return key;
}

/** Why a normalized key still isn't usable, or null if it is. */
export function keyProblem(key: string): string | null {
  if (key === "") return "needs at least one letter, digit or _";
  if (!KEY.test(key)) return 'can only contain letters, numbers and "_", and can\'t start with a number';
  return null;
}

// ---------------------------------------------------------------------------
// Reading what someone typed
// ---------------------------------------------------------------------------

export type AddressRead = {
  /** The pieces the input supplied, repaired. Missing pieces are absent. */
  parts: Draft;
  /** Which of the wanted parts are still missing, in address order. */
  missing: Part[];
  /** Pieces that had to be repaired, so the caller can say what it changed. */
  repaired: { part: Part; from: string; to: string }[];
  /** Pieces that can't be repaired at all, with the reason. */
  unreadable: { part: Part; from: string; why: string }[];
  /** Segments past the key — an address has at most four. */
  extra: string[];
  /** True when the input already was the canonical address, byte for byte. */
  canonical: boolean;
  /** True when the input carried a name at all (so "" and "mcpm://" are distinguishable). */
  empty: boolean;
};

/**
 * Splits whatever a person pasted into address pieces, repairing each one.
 *
 * Deliberately total: it never throws, because its callers are a form field
 * and a prompt that need to say "you're three quarters of the way there, here
 * is the piece that's missing". A deliberately empty segment is a hole
 * ("acme//dev" is workspace+environment with the project still to come), which
 * is exactly what a form mid-completion looks like.
 */
export function readAddressInput(raw: string, opts: { needKey?: boolean } = {}): AddressRead {
  const text = raw.trim();
  const body = text.replace(SCHEME, "");
  const segments = body.split("/");
  // A trailing slash is punctuation, not a missing piece: "acme/api/dev/" is
  // the complete address, while "acme/api/" is a hole to fill in.
  while (segments.length > 1 && segments.at(-1) === "") segments.pop();
  if (segments.length === 1 && segments[0] === "") segments.pop();

  const parts: Draft = {};
  const repaired: AddressRead["repaired"] = [];
  const unreadable: AddressRead["unreadable"] = [];

  segments.slice(0, PARTS.length).forEach((segment, index) => {
    const part = PARTS[index];
    if (segment === "") return; // an intentional hole
    // The hosted product's personal branch has no meaning offline.
    if (index === 0 && segment === "~me") {
      unreadable.push({ part, from: segment, why: "personal (~me) addresses exist only in hosted mcpmaster — a local vault has one owner" });
      return;
    }
    const to = part === "key" ? normalizeKey(segment) : slugify(segment);
    const why = part === "key" ? keyProblem(to) : slugProblem(to);
    if (why !== null) {
      unreadable.push({ part, from: segment, why });
      return;
    }
    parts[part] = to;
    if (to !== segment) repaired.push({ part, from: segment, to });
  });

  const wanted = opts.needKey ? PARTS : PARTS.slice(0, 3);
  const missing = wanted.filter((part) => parts[part] === undefined);
  const built = addressDraft(parts, Boolean(opts.needKey));
  return {
    parts,
    missing,
    repaired,
    unreadable,
    extra: segments.slice(PARTS.length),
    canonical: missing.length === 0 && segments.length <= PARTS.length && (text === built || text === `${built}/`),
    empty: segments.length === 0 || segments.every((segment) => segment === ""),
  };
}

/** The canonical address for a complete draft: `mcpm://<w>/<p>/<e>[/<KEY>]`. */
export function addressDraft(parts: Draft, needKey = false): string {
  const wanted = needKey ? PARTS : PARTS.slice(0, 3);
  return `mcpm://${wanted.map((part) => parts[part] ?? "").join("/")}`;
}

/**
 * The same address with the holes left visible, for a form that is still being
 * filled in: `mcpm://acme/{project}/dev`. Placeholders are wrapped in braces so
 * they can never be mistaken for a stored name.
 */
export function addressPreview(parts: Draft, needKey = false): string {
  const wanted = needKey ? PARTS : PARTS.slice(0, 3);
  return `mcpm://${wanted.map((part) => parts[part] ?? `{${part}}`).join("/")}`;
}

/** A one-line explanation of what's missing, or null when nothing is. */
export function missingNote(missing: Part[], parts: Draft, needKey = false): string | null {
  if (missing.length === 0) return null;
  const names = missing.map((part) => ARTICLE[part]);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Add ${list} — ${addressPreview(parts, needKey)}`;
}

function problems(read: AddressRead): string | null {
  if (read.unreadable.length > 0) {
    const { part, from, why } = read.unreadable[0];
    return `The ${part} "${from}" ${why}`;
  }
  if (read.extra.length > 0) {
    return `"${read.extra.join("/")}" is more than one key — an address is mcpm://<workspace>/<project>/<environment>[/<KEY>]`;
  }
  return null;
}

/** The first thing wrong with a draft, worded for a person, or null when nothing is. */
export function draftProblem(read: AddressRead): string | null {
  return problems(read);
}

// ---------------------------------------------------------------------------
// Turning a draft into an address — the one place CLI, UI and server agree
// ---------------------------------------------------------------------------

/**
 * A whole-environment address from anything in the accepted forms:
 * `mcpm://acme/api/dev`, `acme/api/dev`, `acme/api/dev/`, `Acme/API/Dev`.
 * Throws an AddressError that names the piece to fix.
 */
export function parseEnvironmentDraft(raw: string): EnvironmentAddress {
  const read = readAddressInput(raw);
  const problem = problems(read);
  if (problem !== null) throw new AddressError(problem);
  if (read.parts.key !== undefined) {
    throw new AddressError(`"${raw.trim()}" names one key — drop "/${read.parts.key}" to address its environment`);
  }
  if (read.empty) throw new AddressError(`Enter an environment address, like mcpm://acme/api/dev`);
  const note = missingNote(read.missing, read.parts);
  if (note !== null) throw new AddressError(`"${raw.trim()}" isn't a full environment yet. ${note}`);
  return { workspace: read.parts.workspace!, project: read.parts.project!, environment: read.parts.environment! };
}

/** A one-key address from anything in the accepted forms. */
export function parseKeyDraft(raw: string): Required<Address> {
  const read = readAddressInput(raw, { needKey: true });
  const problem = problems(read);
  if (problem !== null) throw new AddressError(problem);
  if (read.empty) throw new AddressError(`Enter an address, like mcpm://acme/api/dev/STRIPE_KEY`);
  const note = missingNote(read.missing, read.parts, true);
  if (note !== null) throw new AddressError(`"${raw.trim()}" isn't a full address yet. ${note}`);
  return { workspace: read.parts.workspace!, project: read.parts.project!, environment: read.parts.environment!, key: read.parts.key! };
}

/**
 * Fills in the pieces a partial address is missing from separate fields — what
 * a form with a workspace box, a project box and an environment box hands in.
 * Each field may itself hold a whole pasted address ("acme/api/dev" typed into
 * the workspace box), which is read as such rather than as a name.
 */
export function completeDraft(fields: Draft, opts: { needKey?: boolean } = {}): AddressRead {
  const merged: Draft = {};
  const repaired: AddressRead["repaired"] = [];
  const unreadable: AddressRead["unreadable"] = [];
  const extra: string[] = [];
  let pastedAny = false;

  for (const part of PARTS) {
    const field = fields[part];
    if (field === undefined || field.trim() === "") continue;
    // A field holds one name — or a whole address someone pasted into the
    // wrong box (`mcpm://acme/api/dev/STRIPE_KEY` into the workspace field),
    // which is the commonest way to fill a multi-box form. Only a separator
    // decides which: reading every single word as an address would make the
    // project box's "api" land as a workspace named "api".
    const whole = field.includes("/") || SCHEME.test(field.trim());
    if (!whole) {
      const to = part === "key" ? normalizeKey(field) : slugify(field);
      const why = part === "key" ? keyProblem(to) : slugProblem(to);
      if (why !== null) {
        unreadable.push({ part, from: field, why });
        continue;
      }
      merged[part] = to;
      if (to !== field) repaired.push({ part, from: field, to });
      continue;
    }

    pastedAny = true;
    const read = readAddressInput(field, part === "key" ? { needKey: true } : {});
    // The pasted pieces fill whatever is still empty; what the other boxes
    // already said is never overwritten by them.
    for (const other of PARTS) {
      if (read.parts[other] === undefined || merged[other] !== undefined) continue;
      merged[other] = read.parts[other];
      const fix = read.repaired.find((entry) => entry.part === other);
      if (fix) repaired.push(fix);
    }
    unreadable.push(...read.unreadable);
    extra.push(...read.extra);
  }

  const wanted = opts.needKey ? PARTS : PARTS.slice(0, 3);
  return {
    parts: merged,
    missing: wanted.filter((part) => merged[part] === undefined),
    repaired,
    unreadable,
    extra,
    // Nothing had to be touched, and nothing was pasted: what the boxes said
    // is exactly what was stored, so there is nothing to announce.
    canonical: repaired.length === 0 && unreadable.length === 0 && extra.length === 0 && !pastedAny,
    empty: PARTS.every((part) => (fields[part] ?? "").trim() === ""),
  };
}

/** `completeDraft` plus the same failure messages, for a form submitting all its fields at once. */
export function parseDraftFields(fields: Draft, opts: { needKey?: boolean } = {}): Required<Address> | EnvironmentAddress {
  const read = completeDraft(fields, opts);
  const problem = problems(read);
  if (problem !== null) throw new AddressError(problem);
  if (read.empty) throw new AddressError(opts.needKey ? `Enter an address, like mcpm://acme/api/dev/STRIPE_KEY` : `Enter an environment, like mcpm://acme/api/dev`);
  const note = missingNote(read.missing, read.parts, Boolean(opts.needKey));
  if (note !== null) throw new AddressError(`Not a full address yet. ${note}`);
  return opts.needKey
    ? { workspace: read.parts.workspace!, project: read.parts.project!, environment: read.parts.environment!, key: read.parts.key! }
    : { workspace: read.parts.workspace!, project: read.parts.project!, environment: read.parts.environment! };
}

// ---------------------------------------------------------------------------
// The vault's own contents: suggestions, filtering, paging
// ---------------------------------------------------------------------------

/** The shape Vault.inventory() returns, and what the UI's /api/state serves. */
export type Inventory = { address: string; keys: { name: string; updatedAt?: string }[] }[];

/** One stored secret, with its address already split up. */
export type SecretRow = {
  address: string;
  key: string;
  updatedAt: string;
  workspace: string;
  project: string;
  environment: string;
  /** `workspace/project/environment` — the address without its scheme or key. */
  path: string;
};

export function inventoryRows(inventory: Inventory): SecretRow[] {
  const rows: SecretRow[] = [];
  for (const env of inventory) {
    const segments = env.address.replace(SCHEME, "").replace(/\/$/, "").split("/");
    if (segments.length !== 3) continue; // not an address this version wrote
    const [workspace, project, environment] = segments;
    for (const entry of env.keys) {
      rows.push({
        address: `${env.address.replace(/\/$/, "")}/${entry.name}`,
        key: entry.name,
        updatedAt: entry.updatedAt ?? "",
        workspace,
        project,
        environment,
        path: `${workspace}/${project}/${environment}`,
      });
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path) || a.key.localeCompare(b.key));
}

export type SecretFilter = { search?: string; workspace?: string; project?: string; environment?: string };

/**
 * The one definition of "matches", shared by `mcpv list` and the UI's search
 * box: every whitespace-separated term must appear in the key name or
 * somewhere in its address, and each dropdown filter is an exact slug. A term
 * matching an address therefore keeps every key in it, which is what someone
 * narrowing to an environment means.
 */
export function filterRows(rows: SecretRow[], filter: SecretFilter = {}): SecretRow[] {
  const terms = (filter.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const exact = (value: string | undefined, wanted: string | undefined) => wanted === undefined || wanted === "" || value === wanted;
  return rows.filter((row) => {
    if (!exact(row.workspace, filter.workspace) || !exact(row.project, filter.project) || !exact(row.environment, filter.environment)) return false;
    if (terms.length === 0) return true;
    const haystack = `${row.key} ${row.path}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export type Page<T> = {
  items: T[];
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  /** 1-based index of the first item shown, and of the last — 0 when there are none. */
  from: number;
  to: number;
};

/** A page of anything, clamped so no caller has to think about bounds. */
export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
  const size = Math.max(1, Math.floor(pageSize));
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (current - 1) * size;
  const slice = items.slice(start, start + size);
  return { items: slice, page: current, pages, total, pageSize: size, from: total === 0 ? 0 : start + 1, to: start + slice.length };
}

export type Suggestions = {
  /** Whole environments consistent with the draft — pick one and the form is done. */
  environments: string[];
  workspaces: string[];
  /** Projects that exist under the chosen workspace. */
  projects: string[];
  /** Environment slugs that exist under the chosen workspace and project. */
  environmentNames: string[];
  /** Key names already stored in the fully chosen environment, to reuse spelling. */
  keys: string[];
};

/**
 * What could go in each empty field, taken from the vault itself — so naming an
 * environment is picking from what exists rather than inventing a path and
 * hoping. A partially typed value narrows the list; when nothing matches it,
 * the full list comes back rather than nothing, since that is usually a typo
 * the user wants to notice against real names.
 */
export function suggestionsFor(inventory: Inventory, draft: Draft, limit = 8): Suggestions {
  const rows = inventoryRows(inventory);
  const narrow = (candidates: string[], typed: string | undefined) => {
    const unique = [...new Set(candidates)];
    const prefix = typed === undefined || typed === "" ? [] : unique.filter((value) => value.startsWith(typed));
    return (prefix.length > 0 ? prefix : unique).sort().slice(0, limit);
  };
  const within = (row: SecretRow) =>
    (draft.workspace === undefined || row.workspace === draft.workspace) && (draft.project === undefined || row.project === draft.project);

  const environments = rows
    .filter((row) => draft.workspace === undefined || row.workspace === draft.workspace)
    .filter((row) => draft.project === undefined || row.project === draft.project)
    .filter((row) => draft.environment === undefined || row.environment === draft.environment)
    .map((row) => row.path);

  const exact = draft.workspace !== undefined && draft.project !== undefined && draft.environment !== undefined
    ? rows.find((row) => row.path === `${draft.workspace}/${draft.project}/${draft.environment}`)
    : undefined;

  return {
    environments: narrow(environments.map((path) => `mcpm://${path}`), undefined),
    workspaces: narrow(rows.map((row) => row.workspace), draft.workspace),
    projects: narrow(rows.filter((row) => draft.workspace === undefined || row.workspace === draft.workspace).map((row) => row.project), draft.project),
    environmentNames: narrow(
      rows.filter(within).map((row) => row.environment),
      draft.environment,
    ),
    keys: exact ? narrow(inventory.find((env) => env.address.replace(SCHEME, "").replace(/\/$/, "") === exact.path)?.keys.map((entry) => entry.name) ?? [], undefined) : [],
  };
}
