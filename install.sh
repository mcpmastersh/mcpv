#!/bin/sh
# mcpv installer — offline secrets your agent can use but never see.
#
#   curl -fsSL https://raw.githubusercontent.com/mcpmastersh/mcpv/main/install.sh | sh
#
# Downloads the single-file mcpv build straight from the npm registry (no npm
# install, no dependencies to resolve, no npm cache in the way) and puts an
# `mcpv` command on your PATH. Running it again upgrades: it always fetches
# the newest published version and says what changed.
#
# Environment:
#   MCPV_VERSION       version to install (default: latest)
#   MCPV_INSTALL_DIR   where the command goes (default: ~/.local/bin)
#   MCPV_HOME          vault directory — never touched by an install (default: ~/.mcpv)
#   MCPV_SKILL=1       also save the agent skill to ~/.claude/skills/mcpv (Claude Code)

set -eu

say() { printf '  %s\n' "$*" >&2; }
fail() { printf '  x %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "mcpv needs Node.js 20 or later — install it from https://nodejs.org and run this again."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || fail "mcpv needs Node.js 20 or later (found $(node --version))."
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."

VERSION="${MCPV_VERSION:-latest}"
BIN_DIR="${MCPV_INSTALL_DIR:-$HOME/.local/bin}"
LIB_DIR="${MCPV_INSTALL_LIB:-$HOME/.local/share/mcpv}"
REGISTRY="${MCPV_REGISTRY:-https://registry.npmjs.org}"

PREVIOUS=""
if [ -x "$BIN_DIR/mcpv" ]; then PREVIOUS=$("$BIN_DIR/mcpv" --version 2>/dev/null || true); fi

say "Installing mcpv ($VERSION)…"

# The scoped name is one path segment on the registry, so the slash is %2f.
TARBALL=$(curl -fsSL "$REGISTRY/@mcpmastersh%2fmcpv/$VERSION" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);if(!m.dist||!m.dist.tarball)process.exit(1);process.stdout.write(m.dist.tarball)})') \
  || fail "Couldn't find mcpv $VERSION on the npm registry."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$TARBALL" -o "$TMP/pkg.tgz" || fail "Download failed — check your connection and try again."
tar -xzf "$TMP/pkg.tgz" -C "$TMP"
[ -f "$TMP/package/dist/mcpv.mjs" ] || fail "That package doesn't contain the mcpv build."

mkdir -p "$LIB_DIR" "$BIN_DIR"
cp "$TMP/package/dist/mcpv.mjs" "$LIB_DIR/mcpv.mjs"

# Replace the file, never write through it: an earlier `npm i -g` may have left
# a symlink here that points into npm's own package directory.
rm -f "$BIN_DIR/mcpv"
cat > "$BIN_DIR/mcpv" <<WRAPPER
#!/bin/sh
exec node "$LIB_DIR/mcpv.mjs" "\$@"
WRAPPER
chmod +x "$BIN_DIR/mcpv"

CURRENT=$("$BIN_DIR/mcpv" --version)
if [ -z "$PREVIOUS" ]; then
  say "+ Installed mcpv $CURRENT to $BIN_DIR/mcpv"
elif [ "$PREVIOUS" = "$CURRENT" ]; then
  say "+ mcpv $CURRENT is already the newest version"
else
  say "+ Upgraded mcpv $PREVIOUS -> $CURRENT (your vault is untouched)"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "! $BIN_DIR isn't on your PATH — add this to your shell profile:"
     say "    export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# Another mcpv earlier on the PATH (npm -g, pnpm, Homebrew) would keep answering.
FIRST=$(command -v mcpv 2>/dev/null || true)
if [ -n "$FIRST" ] && [ "$FIRST" != "$BIN_DIR/mcpv" ]; then
  say "! A different mcpv answers first: $FIRST"
  say "  Remove it, or run the one just installed: $BIN_DIR/mcpv"
fi

if [ "${MCPV_SKILL:-0}" = "1" ]; then
  if [ -f "$TMP/package/skills/mcpv/SKILL.md" ]; then
    mkdir -p "$HOME/.claude/skills/mcpv"
    cp "$TMP/package/skills/mcpv/SKILL.md" "$HOME/.claude/skills/mcpv/SKILL.md"
    say "+ Saved the agent skill to ~/.claude/skills/mcpv/SKILL.md"
  else
    say "! This version doesn't ship an agent skill."
  fi
fi

say ""
say "-> mcpv init     create the vault"
say "-> mcpv help     every command, with examples"
say "-> mcpv ui       browse and add secrets in your browser"
