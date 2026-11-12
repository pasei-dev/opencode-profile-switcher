# AGENTS.md — contributor notes

Working notes for anyone changing this plugin. The user-facing behaviour is in
[README.md](./README.md); this file is about the OpenCode **2.2.7** plugin
contract, where each behaviour lives, and how to verify a change against a
running server.

## Layout

```text
src/profiles.ts   pure/fs logic: JSONC reader, model refs, agent frontmatter,
                  permission rules, field classifier, profile discovery,
                  shared selection + policy state
src/types.ts      types shared by all three halves (no Node imports)
src/rpc.ts        the typed contract between the server and its clients
src/index.ts      server half — transforms, hooks, RPC, /profile, watcher
src/tui.tsx       terminal half — picker, footer badge, keymap, restart queue
src/gui.tsx       desktop entry: Plugin.define({ i18n, setup, main })
src/gui/          window UI, main-process restart Ipc, English copy
test/profiles.test.ts  bun tests over the pure layer (no server needed)
dist/gui-experimental.cjs  built GUI bundle — committed on purpose
install.sh        dev-only registration of this checkout via git+file://
vite.config.ts    builds the GUI bundle with @opencode/plugin/gui/vite
```

Keep new logic in `src/profiles.ts` and call it from whichever half needs it.
That file is the only one with meaningful test coverage, and it has no
dependency on a running server — behaviour that can be decided from the profile
alone belongs there. The desktop window must never import `profiles.ts`: it has
no filesystem access and reads the same data through RPC.

## The three halves

One package, one `plugins` entry in `opencode.json(c)` (2.2.7 loads every part
from the same entry):

- `.` — server, `@opencode/plugin`
- `./tui` — terminal, `@opencode/plugin/tui`
- `./gui-experimental` — desktop, `@opencode/plugin/gui` (built bundle)
- `./rpc` — the contract other parts and clients import

The desktop app reads only the global `opencode.json(c)`; the TUI now loads the
TUI parts of the plugins its server loads, so `cli.json` is no longer needed.
The TUI module must start with `/** @jsxImportSource @opentui/solid */` or the
host's JSX transform bails. The GUI bundle is built by Vite (`bun run build`) and
**committed** at `dist/gui-experimental.cjs`, because GitHub installs do not run
a build step.

The server is the only half that reads profile files. The TUI and the desktop
app call `src/rpc.ts`:

- `list` — active profile, layered profile, policy, per-profile warnings and
  restart verdict, `busy`
- `apply` — switch to a profile (or `null` for base), optionally migrating a
  session
- `setPolicy` — persist `ask` / `always` / `never`
- `busy` — whether a turn is running (the desktop restart waits for this)
- `changed` event — pushed after a switch, a policy change, or `/profile`

The handoff file, `<config>/.profile-switcher.json`, is the durable record
(`{ profile, at, sessionID, startup, policy }`). The server writes it; it still
watches the file so a manual edit applies. Clients read it only for the instant
first paint.

## Contract gotchas (each one bit us once)

- **2.2.7 renamed `ctx.catalog` to `ctx.model`.** The model editor is
  `ctx.model.transform((editor) => editor.default.set(providerID, modelID))`.
  There is no host/SDK skew guard any more: this release targets 2.2.7.
- **RPC is `ctx.rpc.register(definition, handlers)`.** The same definition is
  imported by the TUI (`context.client.rpc(Profiles)`) and the GUI
  (`ctx.client.rpc(Profiles)`). JSON Schema keeps `src/rpc.ts` free of Node and
  Effect imports; methods without arguments still need an input schema (`{}`),
  and the client then requires an argument, so call `list({})` / `busy({})`.
- **RPC output is validated.** An optional field must be *omitted*, not set to
  `undefined`: `...(value ? { key: value } : {})`. JSON Schema `type: "string"`
  rejects an explicit `undefined` with `rpc.invalid_output` (this bit
  `ProfileView.defaultAgent`).
- **Request overrides live on `event.options`.** There is no `event.generation`
  and no `event.providerOptions`. Typed keys are generation settings; any other
  key is forwarded to the selected protocol as a provider option.
- **Scope provider-specific options with the hook, not by hand:**
  `ctx.session.hook("context", cb, { providerID: "openai" })`.
- **Effect brands are not strings.** `Agent.Info.name`, `Model.Ref.id`,
  `Model.Ref.providerID`, `Provider.ID` and `Model.ID` are branded. Build refs
  with `Model.Ref.parse("provider/model#variant")` — it throws on garbage, so wrap
  it — and names with `Agent.Name.make(...)`. A plain `{ providerID, id }` literal
  does not typecheck.
- **`model` accepts two shapes.** `"provider/model#variant"` and
  `{ providerID, model, variant }`. `modelRefFromConfig` and `modelDisplay` in
  `profiles.ts` handle both; use them instead of reading `config.model` directly.
- **`Agent.Info` has no `native` field.** Real fields: `id`, `name`, `model?`,
  `request{settings,headers,body}`, `description?`, `mode`, `hidden`, `color?`,
  `steps?`, `permissions[]`. Guarding on a field that never existed silently
  disables the guard.
- **`registration.dispose()` may return `void`**, so `dispose().catch()` is a type
  error; await it in a try/catch in the cleanup function.
- **`keymap.layer()` must be called from a component body**, not from `setup()`.
  It resolves the Keymap provider through the current Solid owner tree, and
  `setup()` runs after an `await` in the loader, so calling it there throws
  `Keymap.Provider is missing`. Same reason `usePlugin()` is not used in the slot
  render: the host provides no `PluginContextProvider` there.
- **`draft.update(id, …)` in `agent.transform` creates the agent** when the id is
  unknown. That is what makes live agent loading possible — and why an unknown
  name is never passed to it: it would produce a prompt-less stub.
- **Hide, never remove — and never remember having hidden.** Disabling an agent
  sets `hidden = true`; removal orphans sessions bound to it
  (`Session.AgentNotFoundError`), and a hidden agent stays resolvable but drops
  out of selection (`selectable = mode !== "subagent" && !hidden` in core).
  Visibility must be *derived* in every replay, not tracked in a set: `reload()`
  rebuilds from a fresh base, so a hide applied from stale state persists one
  replay too many.
- **Retiring another profile's agents uses hidden stubs.** `staleAgentNames(
  profiles, active)` lists names declared by some profile but not the active one;
  the transform registers each as a hidden `subagent` **only when nothing else
  defines it** (`draft.get(name)` empty).
- **Reference paths resolve against the profile directory, on purpose.** V2 core
  resolves a project's relative `references` against the project; here they are
  rewritten to absolute against `<config>/profiles/<name>/` because that is the
  file that declares them, and `~` is expanded.
- **Registry reads reflect every registration made so far**, including during
  setup; `reload()` replays transforms onto a fresh value, so transforms must be
  cheap, pure, and re-runnable — read external state *before* the callback.
- **Reload only the domains a switch touched.** `domainsFor()` maps applied keys
  to `agent` / `model` / `mcp` / `reference` / `websearch`; `apply()` reloads the
  union of the previous and next profiles. An empty set means no reload.
- **Permission hook ordering.** `evaluate` runs after the configured ruleset and
  is never invoked for an explicit configured `deny`, so a profile can tighten but
  not loosen. There is no ruleset transform.
- **`Session.Info` carries `agent`, `model` and `location.directory`.**
  `migrateSession` compares the session's directory with `ctx.location.directory`
  because the handoff file is global: without that check one switch migrates the
  same session once per loaded location.
- **`session.status` events are the only server-side busy signal.** The server
  tracks `{ sessionID, status.type }` (`idle` clears, `retry`/`busy` sets) and
  prunes `session.deleted`, then reports `busy` over RPC. The desktop restart
  polls it before bouncing the service.
- **The desktop window has no `fs` and no `child_process`.** The GUI bundle is
  evaluated in both processes; Node built-ins are inert placeholders in the
  window. Restarting the service is an `Ipc` provided by `src/gui/main.ts` and
  called with `ctx.main(Restart).run(...)`.

## The field classifier

`classifyConfig` in `src/profiles.ts` buckets profile keys into `applied`,
`relaunch`, `adapted`, `legacy`, `unknown`. `applied` must match what the
transforms in `src/index.ts` really do — currently `agents`, `default_agent`,
`model`, `mcp`, `permissions`, `references`, `websearch`.

Two keys have plugin transforms but are deliberately *not* applied live:
`commands` (slash-command template rendering is core's) and `providers` (the
integration's connection lifecycle is not re-run from a model transform). Both
land correctly through the restart flow. Keep them in `relaunch`.

The native key set tracks the **contract the server serves**, not the published
schema:

```sh
opencode api get /openapi.json   # components.schemas.Config.Info (30 props in 2.2.7)
```

2.2.7 added `timezone` and top-level `policies`; `experimental.policies` is
deprecated (still accepted, reported as legacy). `skills`, `instructions` and
`plugins` are arrays. `compaction` gained `tokens`. The
[config docs](https://opencode.ai/v2/docs/config) are the source for the
`legacy` and `adapted` tables.

When you add a key: put it in the right `Set`, add a nested lint via `lintNested`
if it has a closed member set, and extend `test/profiles.test.ts`.

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

## The desktop bundle

```sh
bun run build            # vite build -> dist/gui-experimental.cjs
node -e '...'            # smoke-test the bundle (see below)
```

The Vite preset (`@opencode/plugin/gui/vite`) compiles Solid JSX, emits one
CommonJS file, and keeps `solid-js`, `effect`, `@opencode/plugin/gui`,
`@opencode/plugin/rpc` and Node built-ins external. The app provides them.

Smoke-test the bundle without the app: evaluate it with a `require` that maps the
shared modules to the installed package files, then check
`Object.keys(defaultExport)` contains `setup` and `main`. The bundle must not
`require` anything else.

The GUI declares no id: it takes the server part's `profile-switcher`. Its
commands are published as `profile-switcher.<id>`; stored keys are
`plugin.profile-switcher.<key>`. The window setup runs in every window; `main`
runs once. `ctx.add` with a function is reactive; a fixed object is not.

The desktop app's background server **is** the shared service
(`opencode serve --service`, recorded in `~/.local/state/opencode/service.json`),
so `opencode service restart` bounces it and the app reconnects. The GUI's main
process runs that command with `ctx.cli.command` (the exact argv the app uses)
and `OPENCODE_CONFIG` from the profile. If the app itself restarts the server
later (an update, a crash), it does so with its own environment and the layer is
lost; the profile's live keys stay applied.

## Startup layering (the restart flow)

V2 has no "apply config at runtime" API, but the server reads one extra config
document at startup from `OPENCODE_CONFIG`. Verified on 2.2.7: with
`OPENCODE_CONFIG=<profile>/opencode.jsonc` the profile appears in `/api/config`
as the **last** document, above `<config>/opencode.jsonc` and the directory
sources, so its keys win and its `plugins` / `providers` / `compaction` are real.

The server reports the verdict over RPC (`restart: "none" | "pending" |
"layered"` and `layered: <name> | null`), because only the server process knows
its own environment. `layeredProfileName()` answers even for a profile with no
startup-only keys; `startupInfo()` carries the keys and the exact command.

- restart policy is `"ask" | "always" | "never"`, stored in the handoff file and
  shared by the TUI and the desktop app. The default is `always`. The TUI
  migrates a pre-2.0 local preference once (`policyStored: false`).
- the TUI queues a restart while a turn is running (`busy()`), and flushes on
  `session.idle` / `session.execution.{succeeded,failed,interrupted}`.
- the desktop app polls the RPC `busy` method instead, and restarts from the main
  process.
- `restartEnv(null)` **deletes** `OPENCODE_CONFIG` — that is how switching back
  to base takes a profile's `plugins` / `providers` away again. Never mutate the
  caller's env object: `restartEnv` copies.
- `cliBinary()` prefers `process.execPath` when its basename starts with
  `opencode`, else falls back to `opencode` on `PATH`; `OPENCODE_BIN` overrides
  for wrappers. The desktop main process uses `ctx.cli.command` instead.

**Never test the restart from inside the service you are running in** — it
terminates your own session. Verify with a private server instead, which does not
touch the managed service:

```sh
OPENCODE_CONFIG=$HOME/.config/opencode/profiles/deep/opencode.jsonc \
  opencode serve --port 40098 --print-logs > /tmp/serve.log 2>&1 &
sleep 6                       # then take "server password …" from /tmp/serve.log
curl -s -u "opencode:$PASS" http://127.0.0.1:40098/api/config \
  | jq -r '.[] | select(.type=="document") | .path'
```

The profile path must be listed, and last. Kill that process when you are done.

## House rules

- 2-space indent, no semicolons, `snake_case` config keys quoted as-is from V2.
- Never write user paths, account names, or real profile names into examples —
  this repo is public and history is squashed on purpose.
- `bun.lock`, `node_modules/`, `package-lock.json` stay gitignored.
- `dist/gui-experimental.cjs` **is committed**: the desktop app needs a prebuilt
  CommonJS bundle and GitHub installs do not build. Run `bun run build` before
  committing a GUI change; the bundle must match `src/gui`.
- `tsconfig.json` runs strict + `"types": ["node", "bun"]`; the default
  `jsxImportSource` is `solid-js` (the TUI file overrides it with
  `@opentui/solid`). `allowImportingTsExtensions` is on because imports use
  `./profiles.ts` explicitly and nothing is emitted.
- Typecheck, tests and the GUI build must pass before pushing:
  `bun run check` (`typecheck && test && build`).

## Release

```sh
# package.json version bump first; run bun run build and commit dist/
git commit -am "release: vX.Y.Z" && git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main && git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."
```

Unpinned `github:` installs track the default branch, so a fix on `main` is
reachable with `opencode plugin update` before it is ever tagged.
