// `mcpv help <command>` — what each command is for, with examples to copy.
//
// The overview (`mcpv help`) lists every command in one line; this is the next
// level down, for the person who is looking at `set` and doesn't know that it
// asks questions, or at `import` and doesn't know what `--rewrite` changes.
// Each topic has the same four parts in the same order — what it does, how to
// call it, examples with a comment saying what each one is for, and what you
// should see — so once you have read one you know how to read them all.
//
// The examples are real commands: tests/mcpv.test.ts runs every topic's flags
// against the CLI's own flag table, so an example can't drift into advertising
// a flag that no longer exists.

import { CliError, accent, action, bold, heading, muted, note, say } from "./term.ts";

export type Topic = {
  /** One line: what it's for. */
  summary: string;
  /** How it's called; `[x]` optional, `<x>` required. */
  usage: string[];
  /** A command, and a comment saying when you'd use it. */
  examples: [command: string, why: string][];
  /** What you should see when it worked. */
  expect: string;
  /** Anything that isn't obvious from the examples. */
  notes?: string[];
  see?: string[];
};

export const TOPICS: Record<string, Topic> = {
  init: {
    summary: "Create the vault on this machine.",
    usage: ["mcpv init [--key-store keychain|secret-service|file]"],
    examples: [
      ["mcpv init", "the normal case — the master key goes in your OS keychain when there is one"],
      ["mcpv init --key-store file", "no keychain (a server, a container): the key sits beside the vault instead"],
    ],
    expect: "“Vault created”, and where the master key lives.",
    notes: ["Every other command creates the vault on first use, so you can skip this and just run `mcpv set`."],
    see: ["mcpv doctor", "mcpv set"],
  },
  set: {
    summary: "Store one secret, or replace it. The value is typed at a hidden prompt, never taken as an argument.",
    usage: ["mcpv set [<key-address>]"],
    examples: [
      ["mcpv set", "step by step: it asks for workspace, project, environment and key name, one at a time"],
      ["mcpv set mcpm://acme/api/dev/STRIPE_KEY", "you know the address: it goes straight to the hidden prompt"],
      ["mcpv set acme/api/dev/STRIPE_KEY", "the mcpm:// and the capital letters are optional — they are repaired"],
      ["pbpaste | mcpv set acme/api/dev/STRIPE_KEY", "pipe the value in (macOS; use xclip -o on Linux) so it never touches your history"],
    ],
    expect: "“Stored” (or “Replaced”) and the address. Nothing prints the value back.",
    notes: [
      "An address is workspace/project/environment/KEY, all lowercase slugs except KEY, which is an environment variable name.",
      "Off a terminal (a script, an agent) it never prompts: an incomplete address is an error naming the missing piece.",
    ],
    see: ["mcpv import", "mcpv check"],
  },
  import: {
    summary: "Move the values from an existing .env into the vault.",
    usage: ["mcpv import [<file>] --into <environment-address> [--only A,B] [--rewrite]"],
    examples: [
      ["mcpv import", "step by step: it asks which file and which environment"],
      ["mcpv import .env --into mcpm://acme/api/dev", "store every plain value in .env under acme/api/dev"],
      ["mcpv import .env --into acme/api/dev --only DATABASE_URL,STRIPE_KEY", "only those two keys"],
      ["mcpv import .env --into acme/api/dev --rewrite", "also replace each stored value in the file with its mcpm:// address"],
    ],
    expect: "A count of what was stored and what was skipped (empty values, lines that are already references).",
    notes: [
      "--rewrite is what makes the file safe to commit or show an agent. Without it the .env keeps its values.",
      "Run `mcpv check` afterwards to confirm every reference resolves.",
    ],
    see: ["mcpv check", "mcpv run"],
  },
  run: {
    summary: "Run a command with your secrets in its environment. Its output is masked.",
    usage: ["mcpv run [--env-file <file>] [--env <environment-address>] [--no-mask] [--quiet] -- <command>"],
    examples: [
      ["mcpv run -- npm run dev", "the everyday one: resolves the mcpm:// references in ./.env"],
      ["mcpv run --env-file .env.staging -- npm test", "a different file"],
      ["mcpv run --env mcpm://acme/api/prod -- ./migrate.sh", "inject a whole environment, no .env needed"],
      ["mcpv run --no-mask -- psql", "an interactive program (masking would garble a prompt)"],
    ],
    expect: "The command's own output, with any secret value shown as [redacted]. Status lines go to stderr, so piping still works.",
    notes: [
      "The two dashes matter: everything after them is your command, not mcpv's.",
      "Values reach that one process only. The child never receives the vault's master key.",
    ],
    see: ["mcpv check", "mcpv set"],
  },
  check: {
    summary: "Confirm every mcpm:// reference in a .env resolves. Prints names, never values.",
    usage: ["mcpv check [--env-file <file>] [--json]"],
    examples: [
      ["mcpv check", "check ./.env"],
      ["mcpv check --env-file .env.staging", "check another file"],
      ["mcpv check --json", "the same answer as one JSON object, for a script"],
    ],
    expect: "A tick per key that resolves, and a cross for each that's missing, with the `mcpv set` command that would fix it.",
    see: ["mcpv set", "mcpv run"],
  },
  list: {
    summary: "Show what's in the vault — environments and key names. Never values.",
    usage: ["mcpv list [<prefix>] [--search <text>] [--workspace <s>] [--project <s>] [--environment <s>] [--limit <n>] [--page <n>] [--json]"],
    examples: [
      ["mcpv list", "everything, 20 environments per page"],
      ["mcpv list acme/api", "only what's under that workspace and project"],
      ["mcpv list --search stripe", "any key or address containing “stripe”"],
      ["mcpv list --environment prod --limit 10 --page 2", "filter, then page through the result"],
    ],
    expect: "Environments as addresses, each with its key names.",
    notes: ["`mcpv ls` is the same command."],
    see: ["mcpv check", "mcpv ui"],
  },
  rm: {
    summary: "Delete one secret.",
    usage: ["mcpv rm <key-address> [--yes]"],
    examples: [
      ["mcpv rm acme/api/dev/OLD_KEY", "asks you to confirm first"],
      ["mcpv rm acme/api/dev/OLD_KEY --yes", "no question — for scripts"],
    ],
    expect: "“Deleted” and the address. It can't be undone; set it again to bring it back.",
    see: ["mcpv list"],
  },
  ui: {
    summary: "Open a local web page to browse, add, replace and import secrets. It never shows a value.",
    usage: ["mcpv ui [--port <n>] [--no-open]"],
    examples: [
      ["mcpv ui", "open it in your browser"],
      ["mcpv ui --no-open", "just print the link (over SSH, or to open it in another browser)"],
      ["mcpv ui --port 7438", "a fixed port"],
    ],
    expect: "A link containing a one-time token. The page stops on Close, on Ctrl+C, or after 15 idle minutes.",
    notes: ["It listens on 127.0.0.1 only. Nothing keeps running in the background."],
    see: ["mcpv list"],
  },
  doctor: {
    summary: "Check the setup: where the vault is, where its key lives, whether it unlocks.",
    usage: ["mcpv doctor [--json]"],
    examples: [
      ["mcpv doctor", "the first thing to run when something doesn't work"],
      ["mcpv doctor --json", "machine-readable"],
    ],
    expect: "A line each for the vault, the master key and the unlock test. Key names appear, values never do.",
    see: ["mcpv init"],
  },
  update: {
    summary: "Install the newest version of mcpv.",
    usage: ["mcpv update [--check]"],
    examples: [
      ["mcpv update", "fetch the newest version straight from the npm registry"],
      ["mcpv update --check", "only say whether a newer version exists"],
    ],
    expect: "“Updating vX -> vY”, then the installer's summary. Run `mcpv --version` to confirm.",
    notes: [
      "Your vault and its key are never touched.",
      "If `npm i -g` failed with EEXIST, the curl installer owns that path: use this instead of npm.",
    ],
    see: ["mcpv doctor"],
  },
};

/** Names that mean the same command as another. */
const ALIASES: Record<string, string> = { ls: "list", upgrade: "update" };

export function isTopic(name: string): boolean {
  return Object.hasOwn(TOPICS, ALIASES[name] ?? name);
}

export function showTopic(name: string): void {
  const key = ALIASES[name] ?? name;
  if (!Object.hasOwn(TOPICS, key)) {
    throw new CliError(`There's no command called “${name}”`, ["mcpv help"], 2);
  }
  const topic = TOPICS[key];
  say(heading(key, "help"));
  say();
  say(`  ${topic.summary}`);
  say();
  say(`  ${bold("Usage")}`);
  for (const line of topic.usage) say(`    ${accent(line)}`);
  say();
  say(`  ${bold("Examples")}`);
  // Comment above, command below: a long command never has to share a line,
  // and on a narrow terminal nothing wraps mid-command.
  topic.examples.forEach(([command, why], index) => {
    if (index > 0) say();
    say(`    ${muted("# " + why)}`);
    say(`    ${accent(command)}`);
  });
  say();
  say(`  ${bold("What you should see")}`);
  say(`    ${topic.expect}`);
  if (topic.notes?.length) {
    say();
    for (const line of topic.notes) say(note(line));
  }
  if (topic.see?.length) {
    say();
    say(`  ${muted("Next")}`);
    for (const command of topic.see) say(action(command));
  }
}
