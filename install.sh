#!/bin/sh
# Local development install for opencode-profile-switcher (OpenCode 2.3.0+).
#
# 2.3.0 cannot install a local checkout through `opencode plugin add`:
#   - an absolute path is rejected (npm or Git spec only);
#   - a Git spec fails in dep preparation, because the installer runs its
#     bundled npm through the opencode binary ("Unrecognized flag: --force").
# So the dev install is one absolute path in the global config's `plugins`
# array. This script builds the GUI bundle and prints the exact entry.
#
# Requirements: bun (for the GUI build) and a global opencode.json(c).
set -e

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if command -v bun >/dev/null 2>&1; then
  echo "1) building the desktop GUI bundle..."
  (cd "$here" && bun run build)
else
  echo "1) bun not found — using the committed dist/gui-experimental.cjs"
fi

config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
config=""
for name in opencode.jsonc opencode.json; do
  if [ -f "$config_dir/$name" ]; then
    config="$config_dir/$name"
    break
  fi
done

if [ -z "$config" ]; then
  echo "2) no global config found under $config_dir"
  echo "   create opencode.jsonc with:"
  echo
  echo "     { \"plugins\": [\"$here\"] }"
  exit 0
fi

if grep -Fq "\"$here\"" "$config"; then
  echo "2) already registered in $config"
else
  echo "2) add this entry to the \"plugins\" array in $config:"
  echo
  echo "     \"$here\""
  echo
  echo "   (and remove any stale npm/Git spec for this plugin)"
fi

cat <<EOF

3) restart the service so the server picks up the plugin:

     opencode service restart

Then check it loaded:

     opencode plugin list        # profile-switcher, source $here
     opencode plugin check

Dev loop after editing src/:  bun run build  ->  opencode service restart
EOF
