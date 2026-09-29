# mcpv

**Offline, encrypted secrets for AI agents: they can use them, but never see them.**

AI coding agents like Claude Code are right not to handle raw secrets. A value pasted
into a prompt ends up in the transcript, in logs, and possibly in a commit. `mcpv`
keeps the values out of the agent's reach but still lets it run your app:

```bash
# .env: commit it, paste it, let an agent read it. It holds addresses, not values.
DATABASE_URL=mcpm://acme/api/dev/DATABASE_URL
STRIPE_KEY=mcpm://acme/api/dev/STRIPE_KEY
PORT=3000
```

```bash
mcpv run -- npm run dev
```

`run` decrypts the references in memory and passes the values to that one process
through its environment. It also scans everything the process prints and replaces
secret values with `[redacted]`. The agent sees the command, the key names and the
masked output. It never sees a value.

No server, no account, no network. One encrypted file on your machine.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/mcpmastersh/mcpv/main/install.sh | sh
```

This downloads one file, puts an `mcpv` command on your PATH and leaves your
vault alone. Needs Node.js 20+. Prefer npm? Use `npm i -g @mcpmastersh/mcpv`, or
skip the install with `npx @mcpmastersh/mcpv doctor`. No runtime dependencies.

## Connect your agent

Paste this into Claude Code, Codex, Cursor or any coding agent. It installs
`mcpv`, moves your `.env` into the vault, and saves a skill so every later
session knows how to use it:

```text
Set up mcpv, an offline secrets vault, so you can use my API keys without ever seeing them.

1. Install it (needs Node 20+; no sudo):
   curl -fsSL https://raw.githubusercontent.com/mcpmastersh/mcpv/main/install.sh | MCPV_SKILL=1 sh
   Then run `mcpv --version` and `mcpv init`.
2. Read the skill it saved (~/.claude/skills/mcpv/SKILL.md, or run `mcpv help`) before doing anything else.
3. If I have a .env, ask me first, then run:
   mcpv import .env --into mcpm://<workspace>/<project>/<environment> --rewrite
4. Check and run my app: `mcpv check`, then `mcpv run -- <my dev command>`.

Rules:
- Never print, log, commit or ask me for a secret value. Refer to secrets by their mcpm:// address.
- There is no command to reveal a value, on purpose. Do not look for a workaround.
- To add a key, tell me to run `mcpv set mcpm://<workspace>/<project>/<environment>/<KEY>` and type it at the hidden prompt.
- Do not guess flags. Run `mcpv help <command>` and use what it lists.
- If a step fails, quote what it printed and give me the next thing to try.
```

**Agent skill.** [`skills/mcpv/SKILL.md`](skills/mcpv/SKILL.md) is the standing
instruction sheet: what an agent can do, what deliberately doesn't exist, and
how to answer "show me my key". Claude Code loads it on demand from
`~/.claude/skills/mcpv/`. Save it with `MCPV_SKILL=1` on the installer, or copy
the file. For any other agent, append it to your project's `AGENTS.md`.

## Upgrade

Run the installer again. It fetches the newest version straight from the npm
registry, so a stale npm cache can't hold you back, and it tells you what
changed. Your vault and its key are never touched.

```bash
curl -fsSL https://raw.githubusercontent.com/mcpmastersh/mcpv/main/install.sh | sh
mcpv --version
```

Already installed? `mcpv update` does the same thing, and `mcpv update --check`
only says whether a newer version exists.

Installed with npm? `npm i -g @mcpmastersh/mcpv@latest --prefer-online`.
(`npm update -g` takes package names only; to pick a version use
`npm i -g @mcpmastersh/mcpv@0.3.0`.) Still the
old version afterwards? See [Troubleshooting](#troubleshooting): a second copy
earlier on your `PATH` is almost always the reason.

## Five commands you'll use

```bash
# Move an existing .env into the vault and swap its values for references
mcpv import .env --into mcpm://acme/api/dev --only DATABASE_URL,STRIPE_KEY --rewrite

# Add or replace one secret. Type it at a hidden prompt, or pipe it in.
mcpv set mcpm://acme/api/dev/OPENAI_API_KEY
pbpaste | mcpv set mcpm://acme/api/dev/OPENAI_API_KEY

# Run anything with ./.env resolved (or --env-file, or a whole --env environment)
mcpv run -- npm test
mcpv run --env mcpm://acme/api/prod -- ./migrate.sh

# Safe for agents: key names only, never values
mcpv check          # does every reference in ./.env resolve?
mcpv list           # environments and key names, or search across them:
mcpv list --search stripe --environment prod --limit 20 --page 2
```

## Addresses

```
mcpm://<workspace>/<project>/<environment>          a whole environment
mcpm://<workspace>/<project>/<environment>/<KEY>    one secret
```

Workspace, project and environment are lowercase slugs. `KEY` is an environment
variable name. This is the same format hosted [mcpmaster](https://mcpmaster.com)
Agent Secrets uses, so a `.env` of references works with either.

**You rarely have to type that.** Every command reads an address the way you'd
actually write one, and repairs what it can:

```bash
mcpv set Acme/API/Dev/STRIPE_KEY      # same address — case and the scheme are repaired
mcpv set acme/api/dev/STRIPE_KEY/     # a trailing slash is punctuation
mcpv list acme/api                    # a prefix lists everything under it
```

Stop early and it asks for the rest, one piece at a time, offering what already
exists in the vault to pick from. Paste a whole address into any one of the
prompts and it fills the rest. Off a terminal — in a script, or from an agent —
it never prompts: it exits `2` naming the piece that's missing and the command
that would have worked.

```bash
$ mcpv set acme/api/dev
✗  "acme/api/dev" isn't a full address yet. Add a key — mcpm://acme/api/dev/{key}
→  mcpv set mcpm://acme/api/dev/<KEY>
```

A `.env` reference is read the same way, so `mcpm://Acme/API/Dev/KEY` in a file
resolves against the same secret as `mcpm://acme/api/dev/KEY`. Anything that
doesn't start with `mcpm:` is left alone as a value — `LOG_PATH=var/log/app/err`
is a path, not an address.

## Web UI

```bash
mcpv ui
```

This opens a local page in your browser. From it you can browse environments and key
names, add or replace values, import a `.env`, delete secrets, and check that your
project's `.env` references all resolve. It never shows a value, the same as the CLI.

Search and filter by workspace, project, environment or key name, and page through
the result — the same matching rule `mcpv list` uses, so the page and the terminal
never disagree about what a search found.

**Import** takes either the `.env` beside where you started `mcpv ui`, any file you
choose in the browser, or text you paste. It tells you what it would store — how many
plain values, what it skips — before anything is written, and if the file already
holds `mcpm://` references it fills the environment in from them.

**Adding a secret** asks for the address as separate boxes — workspace, project,
environment, key — with a live readout of the address they add up to. What the vault
already has is offered as you go: pick an existing environment and the boxes fill
themselves, or paste a whole `mcpm://…` address into any one box and it splits across
them. A partial address says which piece is missing instead of refusing the lot, and
a name it repairs (`Acme API` → `acme-api`) says so.

It only runs while you use it. It listens on 127.0.0.1 with a new token each time, and
stops when you click Close, press Ctrl+C, or after 15 idle minutes. Nothing keeps
running in the background.

Also: `rm <address>` deletes a secret, `init` creates the vault, and `doctor` shows
where the vault and its key are and whether it unlocks. `--json` works on `list`,
`check` and `doctor`. The `mcpm` CLI in this project talks to a hosted workspace
instead; `mcpv` is the offline one.

## Using it with Claude Code (or any agent)

The [skill above](#connect-your-agent) covers this. To do it by hand, tell the agent how to run things, for example in the project instructions file Claude Code reads at startup:

```markdown
Secrets are in mcpv. `.env` holds mcpm:// references, not values.
Start anything that needs them with `mcpv run -- <command>`.
Never ask for secret values. `mcpv check` shows what's missing.
If a key is missing, ask me to run `mcpv set <address>`.
```

Setting a secret needs you: values are only accepted from a hidden prompt or from
stdin, never as command arguments, which end up in shell history, in `ps` and in
agent transcripts.

## Security model

**What is protected, and how**

- **Encryption at rest.** Each value is encrypted with AES-256-GCM using a fresh IV.
  Its own address is bound in as additional authenticated data. If a ciphertext is
  moved to another key's slot, edited, or opened with the wrong key, it fails loudly.
  It never decrypts to the wrong value.
- **The key lives somewhere else.** The master key is stored in the macOS Keychain
  or the Linux Secret Service (`secret-tool`) when available. Otherwise it goes in a
  `0600` key file. In CI, set `MCPV_KEY` (64 hex characters). On its own,
  `vault.json` is only ciphertext plus key names, whether it's in a backup, a synced
  folder, or a stray commit.
- **No display surface.** No command prints a value, and no page of `mcpv ui` shows
  one. There is no `get` and no `reveal`. Values only go into a child process's
  environment.
- **A locked-down local UI.** `mcpv ui` listens on 127.0.0.1 only, checks the Host
  header (which blocks DNS rebinding), and requires a per-run token that is never
  written to disk. It refuses cross-origin requests and non-JSON writes, sends a
  strict Content-Security-Policy, and shuts itself down when idle.
- **Output masking.** `run` masks resolved values in the child's stdout and stderr,
  even when a value is split across two writes. Use `--no-mask` for fully interactive
  programs.
- **No key inheritance.** The child process never receives `MCPV_KEY`.
- **Private files.** The vault directory is `0700`. Its files are `0600` and are
  written atomically.

**What it can't do.** Any process running as your user, an agent's shell included,
can run `mcpv run -- printenv` with `--no-mask`, or read the key file, or ask
the keychain for the key. Masking catches accidents, not a process that sets out to
leak a value (it could base64-encode it first). Values shorter than 4 characters
aren't masked, because masking them would shred the output. `run` warns when that
happens. For a hard boundary, run the agent as a different OS user or in a container
that has no access to the vault. This tool can't enforce that for you.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `MCPV_HOME` | Vault directory (default `~/.mcpv`) |
| `MCPV_KEY` | Master key, 64 hex chars. Overrides the vault's own key store (for CI) |
| `MCPV_PLAIN` / `MCPV_ASCII` / `NO_COLOR` | Terminal output: no decoration / ASCII glyphs / no color |
| `MCPV_DEBUG=1` | Show stack traces for unexpected errors |

## As a library

```ts
import { Vault, parseDotEnv, resolveDotEnv } from "@mcpmastersh/mcpv";

const vault = Vault.open();
const token = vault.resolveKey("mcpm://acme/api/dev/GITHUB_TOKEN"); // in memory, for your code to use
```

## Troubleshooting

### 1. Cached Registry Metadata

npm caches registry responses. If `0.2.0` was published recently, your local cache
might still believe `0.1.0` is the only version. Force an uncached install:

```bash
npm i -g @mcpmastersh/mcpv@0.2.0 --prefer-online
```

Or clear the cache entirely:

```bash
npm cache clean --force
npm i -g @mcpmastersh/mcpv@0.2.0
```

### 2. `npm i -g` fails with `EEXIST: file already exists`

The one-line installer already put an `mcpv` command at that path (for example
`~/.local/bin/mcpv`), and npm won't overwrite a file it didn't create. You don't
need npm: run `mcpv update`. To switch to the npm copy instead, remove the
installer's file first, then install:

```bash
rm ~/.local/bin/mcpv
npm i -g @mcpmastersh/mcpv@latest --prefer-online
```

`--force` also works but overwrites without asking. Your vault and its key are
not touched either way.

### 3. An older copy answers first

The new version can be installed and still not be the one that runs. `npm i -g`
writes into whichever Node is active, and a second global copy can sit earlier on
your `PATH` — another version manager's prefix, a `pnpm`/`yarn`/`bun` global, or
Homebrew.

```bash
which -a mcpv           # every copy that would answer, in order
mcpv --version          # the one that actually runs
npm ls -g --depth=0     # what npm's global prefix holds
```

Install into the prefix that is actually first, or remove the stale copy. `npx`
also keeps its own cache of everything it has run, so an occasional
`npx @mcpmastersh/mcpv` can serve an old version:

```bash
npx --yes @mcpmastersh/mcpv@latest --version   # force the newest
rm -rf ~/.npm/_npx                             # or drop npx's cache
```

The same two steps apply to any package installed globally, these ones included.

## License

Apache-2.0
