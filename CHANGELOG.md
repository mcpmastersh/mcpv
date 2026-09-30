# Changelog

All notable changes to `@mcpmastersh/mcpv` are listed here, newest first. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [semantic versioning](https://semver.org/).

## [Unreleased]

## [0.3.4] - 2026-09-30

### Changed

- New logo: `[v]`, the brackets from `[redacted]` around a v. It replaces
  the old mark in the web UI (favicon and sidebar) and in the README.
  The tile is light in light mode and dark in dark mode.

## [0.3.3] - 2026-09-29

### Changed

- The command cheat sheet starts collapsed; opening it is remembered.
  A Show/Hide button on the right of its header opens and closes it.

## [0.3.2] - 2026-09-29

### Changed

- The command cheat sheet covers every command, including `rm`, `init`,
  `update`, `run --env` and `list --search`.
- The web UI shows the command cheat sheet at the top, open by default, and adds
  a top-bar shortcut nav (Commands, .env check, Secrets).

### Added

- `mcpv update` upgrades an install in place, with troubleshooting for
  `EEXIST` errors.
- Per-command help with examples: `mcpv help <command>` and
  `mcpv <command> --help`.
- A curl installer (`install.sh`), an agent setup prompt and an agent skill.
- `mcpv ui` can copy a key's address on its own, and has a labelled `.env` copy.
- The local UI has a numbered first-run guide with samples and a command cheat
  sheet.

## [0.3.0] - 2026-09-28

### Added

- Addresses are read and completed the way people type them, in the CLI and in
  `mcpv ui` (build an address, filter the list, browse the `.env`).

### Fixed

- A `.env` reference is read the way it was written.
- A flag no command reads is now reported as a wrong invocation.
- The import file picker in `mcpv ui` works.

## [0.2.0] - 2026-09-24

### Added

- `mcpv ui`: a local web UI that never shows a value.

## [0.1.0] - 2026-09-24

### Added

- Offline, encrypted secrets for agents: `.env` files of `mcpm://` references
  that `mcpv run` resolves in memory and masks in the process's output.

### Changed

- Published as `@mcpmastersh/mcpv`; the command is still `mcpv`.
