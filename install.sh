#!/bin/sh
# Local development install for opencode-profile-switcher (OpenCode 2.2.7+).
# Use this when you are editing the plugin; install from GitHub otherwise:
#   opencode plugin add github:Nejrup/opencode-profile-switcher
#
# One entry loads every part in 2.2.7: the server part from `.`, the TUI part
# from `./tui`, the desktop GUI from `./gui-experimental`, and the RPC contract
# from `./rpc`. You no longer need to add the package to cli.json.
#
# The desktop app loads only the GUI bundle, which is committed at
# dist/gui-experimental.cjs. This script rebuilds it before committing, so a
# local install always matches src/.
#
# Requirements: the plugin folder must be a git repo (git+file installs a
# clone of HEAD), and `opencode` must be on PATH.
set -e

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
spec="git+file://$here"

if command -v bun >/dev/null 2>&1; then
  echo "1) building the desktop GUI bundle..."
  (cd "$here" && bun run build)
else
  echo "1) bun not found — using the committed dist/gui-experimental.cjs"
fi

echo "2) committing working tree (git+file installs a clone of HEAD)..."
git -C "$here" add -A
git -C "$here" diff --cached --quiet || git -C "$here" commit -q -m "chore: install/update snapshot"
echo "   HEAD: $(git -C "$here" rev-parse --short HEAD)"

if ! opencode plugin list 2>/dev/null | grep -q "profile-switcher"; then
  echo "3) registering the plugin with the service (opencode.jsonc)..."
  opencode plugin add "$spec"
else
  echo "3) already registered — refresh with \`opencode plugin update\`"
fi

cat <<EOF

Done. Restart the service once so the server picks up the new config:

  opencode service restart

Dev loop after editing src/:  git commit  →  opencode plugin update
(or remove + add) and reopen the TUI / desktop window.
EOF
