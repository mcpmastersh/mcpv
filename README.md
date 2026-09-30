<p align="center">
  <img src="docs/mcpv-logo.svg" width="56" height="56" alt="mcpv">
</p>

<h1 align="center">mcpv</h1>

<p align="center">
  <b>Your agent uses the keys. It never sees them.</b><br>
  Offline, encrypted secrets for AI agents. No server, no account, no network.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mcpmastersh/mcpv"><img alt="npm" src="https://img.shields.io/npm/v/@mcpmastersh/mcpv?color=8b7bff&label=npm"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-8b7bff"></a>
  <img alt="Node.js 20+" src="https://img.shields.io/badge/node-%E2%89%A520-8b7bff">
  <a href="https://mcpmaster.sh/"><img alt="Cloud: mcpmaster.sh" src="https://img.shields.io/badge/cloud-mcpmaster.sh-121216"></a>
</p>

---

Your `.env` holds addresses, not values. `mcpv run` hands the real values to one
process and masks them in everything it prints.

```bash
# .env: safe to commit. Addresses, not values. Paste it, commit it, let an agent read it.
DATABASE_URL=mcpm://acme/api/dev/DATABASE_URL
STRIPE_KEY=mcpm://acme/api/dev/STRIPE_KEY
OPENAI_API_KEY=mcpm://acme/api/dev/OPENAI_API_KEY
PORT=3000
```

```console
$ mcpv check
✓ 3 references resolve in mcpm://acme/api/dev

$ mcpv run -- npm run dev
> acme-api@1.4.0 dev
> node server.js
db    postgres://app:[redacted]@db:5432
stripe key=[redacted] mode=test
✓ listening on :3000
```

- ✅ The agent sees the command, the key names and the masked output.
- ❌ The agent never sees a value.

AI coding agents like Claude Code are right not to handle raw secrets. A value
pasted into a prompt ends up in the transcript, in logs, and possibly in a
commit. `mcpv` keeps the values out of the agent's reach but still lets it run
your app. One encrypted file on your machine.

**Works with any coding agent that runs a shell:** Claude Code · Codex · Cursor ·
Windsurf · OpenCode · VS Code · CI

## Contents

- [Install](#install)
- [Set it up with your agent](#set-it-up-with-your-agent)
- [Data path: one secret, start to finish](#data-path-one-secret-start-to-finish)
- [How it works: five commands](#how-it-works-five-commands)
- [Addresses](#addresses)
- [Web UI](#web-ui)
- [Security model](#security-model)
- [Environment variables](#environment-variables)
- [As a library](#as-a-library)
- [Upgrade](#upgrade)
- [Troubleshooting](#troubleshooting)
- [Pairs with mcpmaster](#pairs-with-mcpmaster)
- [mcpmaster Cloud](#mcpmaster-cloud)
- [FAQ](#faq)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/mcpmastersh/mcpv/main/install.sh | sh
```

This downloads one file, puts an `mcpv` command on your PATH and leaves your
vault alone. Needs Node.js 20+. No runtime dependencies.

Prefer npm, or no install at all?

```bash
npm i -g @mcpmastersh/mcpv     # npm
npx @mcpmastersh/mcpv doctor   # no install
```

## Set it up with your agent

**One prompt. Your agent does the rest.** Paste this into Claude Code, Codex,
Cursor or any coding agent. It installs `mcpv`, moves your `.env` into the
vault and saves a skill so later sessions know the rules.

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

**Install + skill only:**

```bash
curl -fsSL https://raw.githubusercontent.com/mcpmastersh/mcpv/main/install.sh | MCPV_SKILL=1 sh
```

**Agent skill.** [`skills/mcpv/SKILL.md`](skills/mcpv/SKILL.md) is the standing
instruction sheet: what an agent can do, what deliberately doesn't exist, and
how to answer "show me my key". Claude Code loads it on demand from
`~/.claude/skills/mcpv/`. Save it with `MCPV_SKILL=1` on the installer, or copy
the file. For any other agent, append it to your project's `AGENTS.md`.

**By hand**, in the project instructions file your agent reads at startup
(`CLAUDE.md`, `AGENTS.md`, …):

```markdown
Secrets are in mcpv. `.env` holds mcpm:// references, not values.
Start anything that needs them with `mcpv run -- <command>`.
Never ask for secret values. `mcpv check` shows what's missing.
If a key is missing, ask me to run `mcpv set <address>`.
```

**In CI**, give the job the master key and run as usual:

```bash
MCPV_KEY=<64 hex chars> mcpv run -- npm test
```

Setting a secret needs you: values are only accepted from a hidden prompt or
from stdin, never as command arguments, which end up in shell history, in `ps`
and in agent transcripts.

## Data path: one secret, start to finish

Your agent reads addresses on the way in and redactions on the way out. The
real value only exists inside one process, in memory.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/mcpv-data-path-dark.svg">
  <img alt="How mcpv moves a secret: .env holds mcpm:// addresses → the AES-256-GCM vault decrypts in memory → one child process gets the values → a mask turns every secret in stdout and stderr into [redacted] → the agent only ever sees [redacted]." src="docs/mcpv-data-path-light.svg" width="100%">
</picture>

## How it works: five commands

**None of them reveal a value.** There is no `get` and no `reveal`. On purpose.
Values only ever go into a child process's environment.

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

### 01 · Import: move your existing `.env` into the vault

mcpv stores each value, then rewrites the file so it holds `mcpm://`
references instead. It shows what it would store before anything is written.
`--only` picks which keys to move; plain config like `PORT` stays as-is.

```console
$ mcpv import .env --into mcpm://acme/api/dev \
    --only DATABASE_URL,STRIPE_KEY --rewrite
✓ stored 2 secrets in mcpm://acme/api/dev
✓ rewrote .env · 2 references, 1 plain value
```

### 02 · Set: add a key at a hidden prompt, never as an argument

Arguments end up in shell history, in `ps` and in agent transcripts. mcpv only
accepts values from a hidden prompt or stdin, so setting a secret needs you.
Pipe from your clipboard with `pbpaste | mcpv set …`. Off a terminal it never
prompts; it exits `2` with the fix.

```console
$ mcpv set mcpm://acme/api/dev/OPENAI_API_KEY
Value (hidden): ••••••••••••••••••••
✓ saved OPENAI_API_KEY

$ mcpv set acme/api/dev
✗  "acme/api/dev" isn't a full address yet.
→  mcpv set mcpm://acme/api/dev/<KEY>
```

### 03 · Run: decrypt in memory, pass to one process, mask the output

`run` resolves references and injects values into that one child's
environment. It scans stdout and stderr and replaces every secret with
`[redacted]`, even when a value is split across two writes. It uses `./.env`,
`--env-file` or a whole `--env` environment. The child never receives the
master key.

```console
$ mcpv run -- npm test
$ mcpv run --env mcpm://acme/api/prod -- ./migrate.sh
  migrating postgres://app:[redacted]@prod-db
✓ 4 migrations applied
```

### 04 · Check & list: key names only, never values

An agent can see what's missing and ask you to add it. It can search across
every environment without touching a single value. `--json` works on `list`,
`check` and `doctor`.

```console
$ mcpv list --search stripe --environment prod
  mcpm://acme/api/prod/STRIPE_KEY
  mcpm://acme/billing/prod/STRIPE_WEBHOOK_SECRET

$ mcpv check
✗ 1 missing: mcpm://acme/api/dev/SENTRY_DSN
→ ask the user to run: mcpv set mcpm://acme/api/dev/SENTRY_DSN
```

Also: `rm <address>` deletes a secret, `init` creates the vault, and `doctor`
shows where the vault and its key are and whether it unlocks.

## Addresses

**Every secret has an address.** Same format as mcpmaster Cloud Agent Secrets,
so a `.env` of references works with either one.

```
mcpm://<workspace>/<project>/<environment>          a whole environment
mcpm://<workspace>/<project>/<environment>/<KEY>    one secret
```

| Scheme | Workspace | Project | Environment | Key |
| --- | --- | --- | --- | --- |
| `mcpm://` | `acme` | `api` | `dev` | `STRIPE_KEY` |

Workspace, project and environment are lowercase slugs. `KEY` is an environment
variable name.

**You rarely have to type that.** Every command reads an address the way you'd
actually write one, and repairs what it can:

- **Forgiving by design.** Case and the scheme are repaired. A trailing slash is just punctuation.
- **Prefixes list everything.** Stop at any level to list what lives under it.
- **Asks for the rest.** In a terminal, it prompts for missing pieces and offers what already exists.

```bash
mcpv set Acme/API/Dev/STRIPE_KEY      # same address: case and the scheme are repaired
mcpv set acme/api/dev/STRIPE_KEY/     # a trailing slash is punctuation
mcpv list acme/api                    # a prefix lists everything under it
```

Stop early and it asks for the rest, one piece at a time, offering what already
exists in the vault to pick from. Paste a whole address into any one of the
prompts and it fills the rest. Off a terminal (in a script, or from an agent)
it never prompts: it exits `2` naming the piece that's missing and the command
that would have worked.

A `.env` reference is read the same way, so `mcpm://Acme/API/Dev/KEY` in a file
resolves against the same secret as `mcpm://acme/api/dev/KEY`. Anything that
doesn't start with `mcpm:` is left alone as a value: `LOG_PATH=var/log/app/err`
is a path, not an address.

## Web UI

**A browser page that never shows a value, either.**

```bash
mcpv ui
```

This opens a local page in your browser. From it you can browse environments
and key names, add or replace values, import a `.env`, delete secrets, and
check that your project's `.env` references all resolve. It never shows a
value, the same as the CLI.

- **127.0.0.1 only**, with a new token each run that is never written to disk.
- **Paste a whole `mcpm://` address** into any box and it splits across them.
- **Stops** when you click Close, press Ctrl+C, or after 15 idle minutes. Nothing keeps running in the background.

Search and filter by workspace, project, environment or key name, and page
through the result. It uses the same matching rule as `mcpv list`, so the page
and the terminal never disagree about what a search found.

**Import** takes either the `.env` beside where you started `mcpv ui`, any file
you choose in the browser, or text you paste. It tells you what it would store
(how many plain values, what it skips) before anything is written, and if the
file already holds `mcpm://` references it fills the environment in from them.

**Adding a secret** asks for the address as separate boxes (workspace, project,
environment, key) with a live readout of the address they add up to. What the
vault already has is offered as you go: pick an existing environment and the
boxes fill themselves. A partial address says which piece is missing instead of
refusing the lot, and a name it repairs (`Acme API` → `acme-api`) says so. The
value box is write-only.

The `mcpm` CLI in this project talks to a hosted workspace instead; `mcpv` is
the offline one.

## Security model

**What's protected, and how.** One encrypted file on your machine. On its own,
`vault.json` is only ciphertext plus key names, whether it's in a backup, a
synced folder or a stray commit.

| | Protection | How |
| --- | --- | --- |
| 🔐 | **AES-256-GCM at rest** | Each value is encrypted with a fresh IV, with its own address bound in as additional authenticated data. If a ciphertext is moved to another key's slot, edited, or opened with the wrong key, it fails loudly. It never decrypts to the wrong value. |
| 🗝️ | **The key lives elsewhere** | The master key is stored in the macOS Keychain or the Linux Secret Service (`secret-tool`) when available, otherwise in a `0600` key file. In CI, set `MCPV_KEY` (64 hex characters). |
| 🙈 | **No display surface** | No command prints a value, and no page of `mcpv ui` shows one. There is no `get` and no `reveal`. Values only go into a child process's environment. |
| 🧱 | **Locked-down local UI** | `mcpv ui` listens on 127.0.0.1 only, checks the Host header (which blocks DNS rebinding), and requires a per-run token that is never written to disk. It refuses cross-origin requests and non-JSON writes, sends a strict Content-Security-Policy, and shuts itself down when idle. |
| ▓ | **Output masking** | `run` masks resolved values in the child's stdout and stderr, even when a value is split across two writes. Use `--no-mask` for fully interactive programs. |
| 📁 | **Private files, no key inheritance** | The vault directory is `0700`; its files are `0600` and written atomically. The child process never receives `MCPV_KEY`. |

> [!WARNING]
> **What it can't do.** Any process running as your user, an agent's shell
> included, can run `mcpv run --no-mask -- printenv`, read the key file, or ask
> the keychain for the key. Masking catches accidents, not a process that sets
> out to leak a value (it could base64-encode it first). Values shorter than 4
> characters aren't masked, because masking them would shred the output; `run`
> warns when that happens. For a hard boundary, run the agent as a different OS
> user or in a container that has no access to the vault. This tool can't
> enforce that for you, and says so plainly instead of pretending otherwise.

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
`npm i -g @mcpmastersh/mcpv@0.3.0`.) Still the old version afterwards? See
[Troubleshooting](#troubleshooting): a second copy earlier on your `PATH` is
almost always the reason.

## Troubleshooting

<details>
<summary><b>1. Cached registry metadata</b></summary>

npm caches registry responses. If `0.2.0` was published recently, your local
cache might still believe `0.1.0` is the only version. Force an uncached
install:

```bash
npm i -g @mcpmastersh/mcpv@0.2.0 --prefer-online
```

Or clear the cache entirely:

```bash
npm cache clean --force
npm i -g @mcpmastersh/mcpv@0.2.0
```

</details>

<details>
<summary><b>2. <code>npm i -g</code> fails with <code>EEXIST: file already exists</code></b></summary>

The one-line installer already put an `mcpv` command at that path (for example
`~/.local/bin/mcpv`), and npm won't overwrite a file it didn't create. You
don't need npm: run `mcpv update`. To switch to the npm copy instead, remove
the installer's file first, then install:

```bash
rm ~/.local/bin/mcpv
npm i -g @mcpmastersh/mcpv@latest --prefer-online
```

`--force` also works but overwrites without asking. Your vault and its key are
not touched either way.

</details>

<details>
<summary><b>3. An older copy answers first</b></summary>

The new version can be installed and still not be the one that runs. `npm i -g`
writes into whichever Node is active, and a second global copy can sit earlier
on your `PATH`: another version manager's prefix, a `pnpm`/`yarn`/`bun`
global, or Homebrew.

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

The same two steps apply to any package installed globally, these ones
included.

</details>

## Pairs with mcpmaster

**Now give that agent every tool.** [mcpmaster](https://github.com/mcpmastersh/mcpmaster)
is one local MCP endpoint for every API and MCP server you use. Agents see one
`execute` tool instead of a thousand schemas, and credentials stay out of their
context.

```console
$ mcpmaster add https://api.github.com/openapi.json \
    --bearer --token-env GITHUB_TOKEN
✓ github · openapi · 1,081 tools
$ mcpmaster connect claude-code | sh
✓ Claude Code now sees 1 tool: execute
```

## mcpmaster Cloud

**Share secrets with your team. Still never in the chat.** mcpv is the offline
one. Cloud Agent Secrets uses the same `mcpm://` addresses, so the same `.env`
works with both, plus workspaces, roles and an audit trail.

| **mcpv, self-hosted** | **Cloud Agent Secrets** |
| --- | --- |
| Free, Apache-2.0. One encrypted file on your machine. | 14-day trial. Hosted at [mcpmaster.sh](https://mcpmaster.sh/). Nothing to install. |
| ✅ Encrypted vault, no network | ✅ Same `mcpm://` format, same `.env` |
| ✅ Output masking, local web UI | ✅ Workspaces and team roles |
| ✅ Agent skill, CLI and TypeScript library | ✅ Audit trail of every access |
| — Shared team workspaces | ✅ Instant access revocation |
| — Audit trail and instant revocation | ✅ Plus a hosted mcpmaster endpoint for every tool |

<p>
  <a href="#install"><b>Install mcpv for free</b></a> ·
  <a href="https://mcpmaster.sh/"><b>Try mcpmaster Cloud →</b></a>
</p>

## FAQ

<details>
<summary><b>Why can't I read a secret back?</b></summary>

Because anything printed can land in a transcript, a log or a commit. mcpv has
no `get` and no `reveal`. If you need a value, it's wherever you got it from.
Your app gets it through `mcpv run`.

</details>

<details>
<summary><b>Does it need a server or an account?</b></summary>

No. No server, no account, no network. One encrypted file in `~/.mcpv` and a
master key in your OS keychain.

</details>

<details>
<summary><b>How do I use it in CI?</b></summary>

Set `MCPV_KEY` to the 64-hex-character master key. It overrides the vault's
key store, and the child process never receives it.

</details>

<details>
<summary><b>Can I use it from code?</b></summary>

Yes. `import { Vault } from "@mcpmastersh/mcpv"`, then
`Vault.open().resolveKey("mcpm://…")` resolves a value in memory for your own
code. See [As a library](#as-a-library).

</details>

<details>
<summary><b>How is this different from mcpmaster Cloud?</b></summary>

mcpv is offline and personal. Cloud Agent Secrets is hosted and shared with
your team, with roles, audit and revocation. Both read the same `mcpm://`
addresses.

</details>

Anything else? [Open an issue](https://github.com/mcpmastersh/mcpv/issues).

## License

[Apache-2.0](LICENSE)

<p align="center"><sub>Let agents run your app. Keep every key.</sub></p>
