# Verifying against a live server

Recipes for checking a change without touching your own session. `AGENTS.md`
holds the short version and the commands you will use most.

## Verifying against a live server

```sh
opencode plugin check                                   # server + TUI target/current
opencode api get /api/plugin | jq '.data[] | select(.source.type!="builtin")'
opencode debug config                                   # documents actually loaded
opencode api get /api/provider                          # resolved provider settings
```

The plugin list must show `features: { server: true, tui: true, rpc: true, gui: true }`
for this package. A missing `gui` means the installed copy has no
`./gui-experimental` export or no built bundle.

RPC is a plain HTTP endpoint, so a private server can be checked without the
running service:

```sh
DIR=$(mktemp -d)
XDG_CONFIG_HOME=$DIR/config XDG_DATA_HOME=$DIR/data \
  opencode serve --port 40098 --print-logs > $DIR/serve.log 2>&1 &
sleep 8
PASS=$(grep -o 'server password .*' $DIR/serve.log | awk '{print $3}')
curl -s -u "opencode:$PASS" -X POST \
  "http://127.0.0.1:40098/api/rpc/profile-switcher/list" \
  -H 'content-type: application/json' -d '{"input":{}}' | jq .output
```

The config at `$DIR/config/opencode/opencode.jsonc` should list this checkout as
an absolute path (`"plugins": ["/abs/path/profile-switcher"]`); a profile goes
under `$DIR/config/opencode/profiles/<name>/opencode.jsonc`.

End-to-end for `/profile` without spending tokens — create a scratch session in
a throwaway location, run the command, read the synthetic reply, delete it:

```sh
S=$(opencode api post /api/session \
     --data "{\"title\":\"e2e\",\"location\":{\"directory\":\"$DIR\"}}" \
   | jq -r '.data.id // .id')
opencode api post "/api/session/$S/command" --data '{"name":"profile","text":"status"}'
sleep 2
opencode api get "/api/session/$S/message" | jq -r '.data[] | select(.type=="synthetic") | .text'
opencode api delete "/api/session/$S"
```

**Do not run `/profile <name>` against a scratch session to test a switch** — the
overlay is global, so it applies to every loaded location, including the one your
own session runs in. Check switching through `bun test` on the classifier plus
manual testing in a spare terminal.

Log: `~/.local/share/opencode/log/opencode.log`, filter `role=server`; a plugin
that fails to load logs `failed to load plugin` with the module error.
