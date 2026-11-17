# AGENTS.md — contributor notes

Working notes for anyone changing this plugin. The user-facing behaviour is in
[README.md](./README.md); this file is about the OpenCode **2.3.0** plugin
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

One package, one `plugins` entry in `opencode.json(c)` (2.3.0 loads every part
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

## Contract

The server half is where the bugs are. Five rules cover most of them:

- Optional RPC fields are omitted, never set to `undefined`.
- `keymap.layer()` runs from a component body, so call it there.
- Disabling an agent sets `hidden`; removal orphans sessions.
- Transforms must be pure and re-runnable. Read external state before the callback.
- The desktop window has no `fs` and no `child_process`.

Read [docs/contract.md](./docs/contract.md) before changing `src/index.ts`,
`src/profiles.ts` or `src/rpc.ts`. It has the full gotcha list, the field
classifier, the two agent sources, the desktop bundle and the startup layering.

## Installing this checkout

2.3.0's `opencode plugin add` accepts only npm and Git specs: an absolute path is
rejected with "Plugin target must be an npm registry package or Git package
specifier". A Git spec (`github:…`, `git+file://…`) still fails during dep
preparation because the installer runs its bundled npm through the `opencode`
binary (`Unrecognized flag: --force in command opencode`). Both were reproduced
on 2.3.0.

So a dev install is a hand-written absolute path in the global config:

```jsonc
{ "plugins": ["/absolute/path/to/profile-switcher"] }
```

The server resolves it directly (`source.type: "local"` in `/api/plugin`), and
the TUI and desktop app pick up their halves from the same entry. `install.sh`
builds the GUI and prints the entry; it does not call `opencode plugin add`.
`cli.json` must not list the plugin — 2.3.0 loads the TUI part from the server's
plugin list, and a stale entry there fails independently.

## Verify

```sh
bun run check          # typecheck + tests + GUI build
opencode plugin check  # server + TUI target/current
```

The plugin list must show `features: { server: true, tui: true, rpc: true, gui: true }`.
Never test a restart from inside the service you are running in; it terminates
your session. Use a private server on another port.

Read [docs/verify.md](./docs/verify.md) for the RPC, `/profile` and layering
recipes.

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
