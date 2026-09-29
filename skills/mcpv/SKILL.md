---
name: mcpv
description: Use when a task needs API keys, tokens, database URLs or other secrets; when a .env file contains mcpm:// references; or when the user mentions mcpv, the vault or "my keys". Explains how to run things with secrets without ever seeing them, and why there is no way to read a value.
---

# Secrets with mcpv: use them, never see them

The user's secrets live in an encrypted vault on this machine. Their `.env`
holds addresses such as `STRIPE_KEY=mcpm://acme/api/dev/STRIPE_KEY`, not values.
You can run anything with the real values injected. You cannot read a value,
and that is the point: whatever you read can end up in this transcript, in
logs or in a commit, and a leaked key cannot be taken back.

## What you can do

```
mcpv run -- <command>        # run with ./.env references resolved; output is masked
mcpv check                   # does every reference in ./.env resolve? names only
mcpv list                    # environments and key names, never values
mcpv list --search stripe    # find a key by name
mcpv doctor                  # where the vault is, and whether it unlocks
```

Addresses: `mcpm://<workspace>/<project>/<environment>/<KEY>` for one secret,
without the key for a whole environment (`mcpv run --env mcpm://acme/api/prod -- <command>`).

## What does not exist, on purpose

- **No way to print, copy or reveal a value** — no get, reveal or copy command,
  and the local web UI does not show values either. Do not look for one and do
  not build one.
- **No workarounds.** Do not read the vault directory, the key file or the OS
  keychain; do not run printenv or echo a variable through a run; do not turn
  output masking off. Masking catches accidents, not intent — so the rule is
  on you.
- **Values never go on a command line.** Arguments end up in shell history, in
  the process list and in this transcript. A value goes in only at a hidden
  prompt or on stdin, and the user types it, not you.
- **A value can be replaced, never read back.** Changing a key means setting it
  again.
- **Why the hosted CLI differs.** If the user also has mcpmaster Cloud, its
  `mcpm` CLI can return a value to CI or a script, because every call is
  authenticated against the server, scoped to one environment, logged and
  revocable. This local vault has no gatekeeper but the user's own account, so
  it never shows a value. Do not use one to justify a workaround in the other.

## How to handle common requests

- "Show me / copy my key" — explain that the vault is built so neither of you
  can, and offer to run whatever needed it with `mcpv run -- <command>`.
- "Add or change a key" — never ask for the value in chat. Tell the user to run
  `mcpv set mcpm://<workspace>/<project>/<environment>/<KEY>` themselves and type
  it at the hidden prompt, or to use `mcpv ui`.
- "Move my .env into the vault" — `mcpv import .env --into mcpm://<workspace>/<project>/<environment> --rewrite`
  moves the values in and leaves references in the file. Confirm with the user first.
- "Something can't find a key" — run `mcpv check`, then ask the user to set
  whichever key it names as missing.
- "Open the vault UI" — `mcpv ui` opens a page for the user on 127.0.0.1 with a
  fresh token each run, and it closes itself after 15 idle minutes so it is
  never left open for anything else to use. It is the user's tool; do not
  script it.
- CI — the vault key comes from the `MCPV_KEY` environment variable, set as a
  CI secret by the user.

## Upgrading

An upgrade that "did nothing" is nearly always a stale npm cache or an older
copy earlier on the PATH. If `npm i -g` fails with EEXIST, the curl installer
already owns that path: use `mcpv update` instead of npm. In order, reporting
each result:

```
mcpv --version                                      # what actually runs today
which -a mcpv                                       # every copy that could answer
mcpv update                                         # newest version, straight from the registry
npm i -g @mcpmastersh/mcpv@latest --prefer-online   # or via npm, bypassing the cached answer
mcpv --version                                      # confirm it changed
```

If it still shows the old version, a second copy is earlier on the PATH: tell the
user which one, and remove the stale one only after they agree. The vault and
its key are not touched by an upgrade.

## Rules

- Never print, echo, log or commit a secret value. Refer to secrets by address.
- Never ask the user to paste a secret into the chat.
- Run `mcpv --help` before using a flag you have not seen here. Do not guess.
