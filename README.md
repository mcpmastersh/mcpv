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
npm i -g mcpv        # or: npx mcpv …
```

Needs Node 20 or newer. No runtime dependencies.

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
mcpv list           # environments and key names
```

Also: `rm <address>` deletes a secret, `init` creates the vault, and `doctor` shows
where the vault and its key are and whether it unlocks. `--json` works on `list`,
`check` and `doctor`.

## Addresses

```
mcpm://<workspace>/<project>/<environment>          a whole environment
mcpm://<workspace>/<project>/<environment>/<KEY>    one secret
```

Workspace, project and environment are lowercase slugs. `KEY` is an environment
variable name. This is the same format hosted [mcpmaster](https://mcpmaster.com)
Agent Secrets uses, so a `.env` of references works with either.

## Using it with Claude Code (or any agent)

Tell the agent how to run things, for example in the project instructions file Claude Code reads at startup:

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
- **No display surface.** No command prints a value. There is no `get` and no
  `reveal`. Values only go into a child process's environment.
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
import { Vault, parseDotEnv, resolveDotEnv } from "mcpv";

const vault = Vault.open();
const token = vault.resolveKey("mcpm://acme/api/dev/GITHUB_TOKEN"); // in memory, for your code to use
```

## License

Apache-2.0
