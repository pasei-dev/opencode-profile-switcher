/**
 * profile-switcher — TUI half.
 *
 * Picker (`<leader>p`, palette) plus a footer badge showing the active profile.
 * Profiles that set startup-only keys are marked `⟳ needs restart` / `✓ startup
 * loaded`, and after applying one this half offers to bounce the shared service
 * with the profile layered in through OPENCODE_CONFIG.
 *
 * All profile state comes from the server's RPC (./rpc.ts): discovery, linting
 * and application live in one place, shared with the desktop app. The handoff
 * file is only read for the instant first paint.
 *
 * Source of truth:
 * - https://opencode.ai/v2/docs/build/plugins/cli (slots, keymap, storage, dialogs)
 * - https://opencode.ai/v2/docs/build/plugins/rpc
 */

/** @jsxImportSource @opentui/solid */

import { spawn } from "node:child_process"

import { Plugin } from "@opencode/plugin/tui"

import { Profiles, asClaim, asSnapshot } from "./rpc.ts"
import type { ProfileView, RestartPolicy, Snapshot } from "./types.ts"
import {
  POLICY_VERSION,
  cliBinary,
  nextRestartPolicy,
  readSelection,
  restartCommand,
  restartEnv,
  resolveRestartPolicy,
} from "./profiles.ts"

const POLICY_LABEL: Record<RestartPolicy, string> = {
  ask: "ask before restarting",
  always: "always restart to apply",
  never: "label only, never restart",
}

export default Plugin.define({
  id: "profile-switcher-tui",

  setup(context) {
    // Reactive snapshot from the server. A memory store: the durable record is
    // the handoff file, and the server owns it.
    const [state, setState] = context.storage.memory<Snapshot>("snapshot", {
      initial: {
        active: readSelection(),
        layered: null,
        expected: null,
        policy: "always",
        policyStored: false,
        profilesRoot: "",
        busy: false,
        profiles: [],
      },
    })

    // Pre-2.0 restart policy, migrated into the shared handoff file once.
    const [prefs] = context.storage.store<{
      policyVersion?: number
      askRestart?: boolean
      restartPolicy?: RestartPolicy
    }>("preferences", { initial: {} })

    const rpc = () => context.client.rpc(Profiles)

    const applySnapshot = (snap: Snapshot) => {
      setState((draft) => {
        draft.active = snap.active
        draft.layered = snap.layered
        draft.policy = snap.policy
        draft.policyStored = snap.policyStored
        draft.profilesRoot = snap.profilesRoot
        draft.busy = snap.busy
        draft.profiles = snap.profiles
      })
    }

    const activeProfile = (): ProfileView | undefined =>
      state.profiles.find((profile) => profile.name === state.active)

    // The TUI keeps its own per-location cache of agents / models / mcp servers.
    // After the server applies a profile we must invalidate + re-sync those, or
    // the switch only becomes visible after a relaunch.
    const locationOf = () => {
      try {
        return context.location ?? context.data.location.default()
      } catch {
        return undefined
      }
    }

    const reflect = () => {
      try {
        const location = locationOf()
        if (!location) return
        const loc = context.data.location
        for (const store of [loc.agent, loc.model, loc.provider]) {
          store.invalidate(location)
          void store.sync(location).catch(() => {})
        }
        loc.mcp.server.invalidate(location)
        void loc.mcp.server.sync(location).catch(() => {})
      } catch (error) {
        console.warn("[profile-switcher] could not refresh location data", error)
      }
    }

    let migrated = false
    const refresh = async () => {
      try {
        let snap = asSnapshot(await rpc().list({}))
        applySnapshot(snap)

        // A pre-2.0 TUI stored the policy locally. Import an explicit choice
        // once; the shared file is authoritative from then on.
        if (!snap.policyStored && !migrated) {
          migrated = true
          const explicit =
            prefs.policyVersion === POLICY_VERSION ||
            prefs.askRestart === false ||
            prefs.restartPolicy === "always" ||
            prefs.restartPolicy === "never"
          if (explicit) {
            const policy = resolveRestartPolicy({
              policyVersion: prefs.policyVersion,
              askRestart: prefs.askRestart,
              restartPolicy: prefs.restartPolicy,
            })
            snap = asSnapshot(await rpc().setPolicy({ policy }))
            applySnapshot(snap)
          }
        }

        // After the policy is settled, so a migrated `never` is honoured.
        await maybeRelayer(snap)
      } catch (error) {
        console.warn("[profile-switcher] could not read profiles from the server", error)
      }
    }

    /** Deferred cache refreshes after a switch; cleared on unload. */
    const deferred = new Set<ReturnType<typeof setTimeout>>()
    const later = (fn: () => void, ms: number) => {
      const timer = setTimeout(() => {
        deferred.delete(timer)
        fn()
      }, ms)
      deferred.add(timer)
    }

    // Latest session seen by the footer slot (slot input carries sessionID).
    // Falls back to the router when the picker runs outside a session render.
    let lastSessionID: string | undefined
    const currentSessionID = (): string | undefined => {
      try {
        const route = context.ui.router.current()
        if (route.type === "session" && typeof route.sessionID === "string") return route.sessionID
      } catch {
        // Router unavailable — fall through to the last slot input.
      }
      return lastSessionID
    }

    // --- restart with the profile layered in -------------------------------

    /**
     * Bounce the service with `file` layered in (null = un-layer). Takes the name
     * and path rather than a Profile, because a queued restart may outlive the
     * profile it was scheduled for.
     */
    const doRestart = (name: string | null, file: string | null) => {
      try {
        const child = spawn(cliBinary(), ["service", "restart"], {
          env: restartEnv(file),
          detached: true,
          stdio: "ignore",
        })
        child.on("error", (error) => {
          console.warn("[profile-switcher] restart failed", error)
          context.ui.toast.show({
            title: "Profile",
            message: `could not restart the service — run: ${restartCommand(file)}`,
            variant: "error",
            duration: 8000,
          })
        })
        child.unref()
        setState((draft) => {
          draft.active = name
          draft.layered = name
        })
        context.ui.toast.show({
          title: "Profile",
          message: name
            ? `restarting with ${name} layered in — relaunch opencode if the terminal does not reconnect`
            : "restarting with no profile layered in — the previous profile's plugins and providers go away",
          variant: "info",
          duration: 6000,
        })
      } catch (error) {
        console.warn("[profile-switcher] restart failed", error)
        context.ui.toast.show({
          title: "Profile",
          message: `could not restart the service — run: ${restartCommand(file)}`,
          variant: "error",
          duration: 8000,
        })
      }
    }

    // --- deferred restart --------------------------------------------------
    // A restart stops whatever the service is doing, so it never fires while a
    // turn is running: it is queued and flushed when the session goes idle.

    const [queue, setQueue] = context.storage.memory<{
      pending: boolean
      profile: string | null
      file: string | null
    }>("restart-queue", { initial: { pending: false, profile: null, file: null } })

    const busy = (): boolean => {
      try {
        return context.data.session.list().some((session) => {
          try {
            return context.data.session.status(session.id) === "running"
          } catch {
            return false
          }
        })
      } catch {
        return false
      }
    }

    const clearQueue = () =>
      setQueue((draft) => {
        draft.pending = false
        draft.profile = null
        draft.file = null
      })

    const flushQueue = async () => {
      if (!queue.pending || busy()) return
      const { profile, file } = queue
      clearQueue()
      // The queued file is authoritative: a profile deleted between switch and
      // idle still has to be layered in, or un-layered if it is gone. But a
      // switch made in the meantime wins — restarting with the profile the user
      // already left would layer the wrong config.
      try {
        if (asSnapshot(await rpc().list({})).active !== profile) return
      } catch {
        // The server may be unreachable while it restarts; the next refresh
        // shows the marker, and the user can restart from the picker.
        return
      }
      doRestart(profile, file)
    }

    const requestRestart = (profile: ProfileView | null) => {
      if (!busy()) {
        doRestart(profile?.name ?? null, profile?.configFile ?? null)
        return
      }
      setQueue((draft) => {
        draft.pending = true
        draft.profile = profile?.name ?? null
        draft.file = profile?.configFile ?? null
      })
      context.ui.toast.show({
        title: "Profile",
        message: profile
          ? `will restart with ${profile.name} layered in when this turn finishes`
          : "will restart with no profile layered in when this turn finishes",
        variant: "info",
        duration: 5000,
      })
    }

    /**
     * Put the layer back if the service lost it. The desktop app starts its own
     * background server with its own environment, which drops OPENCODE_CONFIG;
     * under the default `always` policy the marker should not be a dead end.
     *
     * The decision uses the server's handoff record, never this client's
     * memory: another client may have switched since, and racing its restart
     * would bounce the service twice. The server also hands out a single claim
     * at a time, so two windows cannot both restart.
     */
    async function maybeRelayer(snap: Snapshot) {
      if (snap.layered !== null) return
      if (!snap.active || snap.expected !== snap.active) return
      if (snap.policy !== "always" || snap.busy) return
      const target = snap.profiles.find((profile) => profile.name === snap.active)
      if (!target || target.restart !== "pending") return
      try {
        if (!asClaim(await rpc().claimRestart({ profile: snap.active })).allowed) return
      } catch (error) {
        console.warn("[profile-switcher] could not claim the layer restart", error)
        return
      }
      requestRestart(target)
    }

    /**
     * What happens after a switch, per the shared restart policy:
     * `always` bounces the service (including back to base, which is the only way
     * to drop plugins the previous profile layered in), `ask` confirms first,
     * `never` only leaves the marker and the command.
     */
    const offerRestart = async (snap: Snapshot, name: string | null) => {
      const profile = name ? snap.profiles.find((entry) => entry.name === name) : undefined
      const pending = name ? profile?.restart === "pending" : snap.layered !== null
      if (!pending) return

      if (snap.policy === "always") {
        requestRestart(profile ?? null)
        return
      }

      if (snap.policy === "never") {
        const command = profile?.command ?? restartCommand(null)
        context.ui.toast.show({
          title: "Profile",
          message: `⟳ ${profile?.relaunch.join(", ") || "startup keys"} need a restart — ${command}`,
          variant: "warning",
          duration: 7000,
        })
        return
      }

      let confirmed = false
      try {
        confirmed =
          (await context.ui.dialog.confirm({
            title: "Restart the service?",
            message:
              (profile
                ? `${profile.name} sets ${profile.relaunch.join(", ")} — those keys are read when the server starts, so they are not applied yet.`
                : "Switching back to base config removes the profile's plugins and providers, which only a restart can do.") +
              "\n\nRestart with this profile layered in?\n" +
              `${profile?.command ?? restartCommand(null)}\n\n` +
              "Sessions keep their history. If a turn is running, the restart waits until it finishes instead of interrupting it.",
            label: { confirm: "Restart service", cancel: "Not now" },
          })) === true
      } catch (error) {
        console.warn("[profile-switcher] could not show the restart dialog", error)
        return
      }

      if (confirmed) {
        requestRestart(profile ?? null)
        return
      }
      context.ui.toast.show({
        title: "Profile",
        message: `not now — run \`${profile?.command ?? restartCommand(null)}\`, or use "Restart service" in the palette`,
        variant: "info",
        duration: 6000,
      })
    }

    const notify = (name: string | null, snap: Snapshot) => {
      const target = name ? snap.profiles.find((profile) => profile.name === name) : undefined
      const dropped = target ? target.legacy.length + target.unknown.length : 0
      const pending = target?.restart === "pending"
      try {
        context.ui.toast.show({
          title: "Profile",
          message: target
            ? dropped
              ? `${target.name} applied — ⚠ ${dropped} field${dropped === 1 ? "" : "s"} ignored`
              : pending
                ? `${target.name} applied — ⟳ ${target.relaunch.length} keys need a restart`
                : `${target.name} applied`
            : "profile removed",
          variant: dropped || pending ? "warning" : "success",
          duration: 3000,
        })
      } catch (error) {
        console.warn("[profile-switcher] could not show toast", error)
      }
    }

    const switchTo = async (name: string | null) => {
      if (state.active === name) return
      const sessionID = currentSessionID()
      try {
        const snap = asSnapshot(await rpc().apply(sessionID ? { name, sessionID } : { name }))
        applySnapshot(snap)
        // Give the server a beat to apply, then refresh the TUI's per-location
        // caches so the switch is visible without a relaunch.
        later(reflect, 300)
        later(reflect, 1500)
        // The server moves this session onto the profile's default agent; re-sync
        // it so the composer/agent badge updates without a relaunch.
        if (sessionID) {
          const resync = () => {
            try {
              context.data.session.invalidate(sessionID)
              void context.data.session.sync(sessionID).catch(() => {})
            } catch (error) {
              console.warn("[profile-switcher] could not refresh session", error)
            }
          }
          later(resync, 600)
          later(resync, 2000)
        }
        notify(name, snap)
        void offerRestart(snap, name)
      } catch (error) {
        console.warn("[profile-switcher] could not apply profile", error)
        context.ui.toast.show({
          title: "Profile",
          message: `could not apply ${name ?? "base config"} — is the server running?`,
          variant: "error",
          duration: 6000,
        })
      }
    }

    const setPolicy = async (policy: RestartPolicy) => {
      try {
        applySnapshot(asSnapshot(await rpc().setPolicy({ policy })))
        context.ui.toast.show({
          title: "Profile",
          message:
            policy === "always"
              ? "every switch restarts the service once nothing is running, so plugins and providers swap both ways"
              : policy === "ask"
                ? "will ask before restarting the service"
                : "will only mark profiles that need a restart — restart from the palette",
          variant: policy === "always" ? "warning" : "info",
          duration: 5000,
        })
      } catch (error) {
        console.warn("[profile-switcher] could not save the restart policy", error)
      }
    }

    const detail = (profile: ProfileView) => {
      const notes: string[] = []
      if (profile.legacy.length)
        notes.push(`⚠ ${profile.legacy.length} legacy field${profile.legacy.length === 1 ? "" : "s"} ignored`)
      if (profile.unknown.length) notes.push(`⚠ ${profile.unknown.length} unrecognized`)
      if (profile.adapted.length)
        notes.push(`${profile.adapted.length} V1 key${profile.adapted.length === 1 ? "" : "s"} normalized`)
      if (profile.agents.length) notes.push(`${profile.agents.length} agents`)
      if (profile.restart === "pending") notes.push(`⟳ restart for: ${profile.relaunch.join(", ")}`)
      if (profile.restart === "layered") notes.push(`✓ startup loaded: ${profile.relaunch.join(", ")}`)
      return notes.length ? `${profile.description} · ${notes.join(" · ")}` : profile.description
    }

    const openPicker = async () => {
      await refresh()
      const items = state.profiles
      const current = state.active
      const options = items.map((profile) => {
        // The ⚠ lives in the title because descriptions are muted/truncated in
        // narrow terminals; the title is always rendered.
        const dropped = profile.legacy.length + profile.unknown.length
        const flag = dropped ? "⚠ " : profile.restart === "layered" ? "✓ " : ""
        return {
          title: profile.name === current ? `active  ${flag}${profile.label}` : `        ${flag}${profile.label}`,
          value: profile.name,
          description: detail(profile),
        }
      })

      options.unshift({
        title: current === null ? "active  base config" : "        base config",
        value: "",
        description: "No profile overlay",
      })

      if (items.length === 0) {
        await context.ui.dialog.alert({
          title: "Profile",
          message: `No profiles found.\n\nAdd one at ${state.profilesRoot || "<config>/profiles"}/<name>/opencode.jsonc`,
        })
        return
      }

      const pick = await context.ui.dialog.select({
        title: "Profile",
        current: current ?? "",
        options,
      })
      if (pick === undefined) return
      await switchTo(pick === "" ? null : pick)
    }

    // --- badge + keymap ---------------------------------------------------
    // keymap.layer() is registered from a component body rather than from
    // `setup()` (see AGENTS.md): it resolves the Keymap provider through the
    // current Solid owner tree, which only exists during a component render.
    // NOTE: usePlugin() is NOT used here — the host does not wrap slot renders
    // in a PluginContextProvider ("PluginContextProvider is missing").

    function Badge() {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "profile-switcher.pick",
            title: "Switch profile",
            description: "Apply a profile from the profiles directory",
            group: "Profile",
            bind: "<leader>p",
            palette: true,
            suggested: true,
            run: () => void openPicker(),
          },
          {
            id: "profile-switcher.restart",
            title: "Restart service with profile",
            description: "Bounce the shared server with this profile layered in (OPENCODE_CONFIG)",
            group: "Profile",
            bind: false,
            palette: true,
            enabled: () => {
              const target = activeProfile()
              return target ? target.restart === "pending" : state.layered !== null
            },
            run: () => {
              const target = activeProfile()
              if (target) requestRestart(target)
              else if (state.layered !== null) requestRestart(null)
            },
          },
          {
            id: "profile-switcher.policy",
            title: `Profile restart policy: ${POLICY_LABEL[state.policy]}`,
            description: "Cycle: always restart to apply the whole profile, ask before restarting, or label only",
            group: "Profile",
            bind: false,
            palette: true,
            run: () => void setPolicy(nextRestartPolicy(state.policy)),
          },
        ],
        bindings: ["profile-switcher.pick", "profile-switcher.restart", "profile-switcher.policy"],
      }))
      // Reactive store reads — re-renders when refresh()/doRestart() change it.
      const target = activeProfile()
      const mark = state.active
        ? target?.restart === "pending"
          ? " ⟳"
          : target?.restart === "layered"
            ? " ✓"
            : ""
        : state.layered
          ? " ⟳"
          : ""
      return <text>{`${state.active ?? ""}${mark}`}</text>
    }

    const removeSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        // Track the latest session for switchTo()'s fallback path. The primary
        // source is ui.router.current() read live at switch time.
        if (input.sessionID) lastSessionID = input.sessionID
        return <Badge />
      },
    })

    // Keep the badge correct when /profile or the desktop app switches, and
    // refresh the location caches so server-side switches are visible too.
    const offChanged = rpc().events.on("changed", () => {
      void refresh()
      later(reflect, 300)
    })

    // Bare `/profile` runs on the server, which cannot open a popup itself; it
    // asks the TUI to do it.
    const offPick = rpc().events.on("pick", () => void openPicker())

    // A missed event (server restart, a reconnect) must not leave the badge
    // stale forever.
    const poll = setInterval(() => void refresh(), 20_000)

    void refresh()

    // A queued restart fires the moment nothing is running. Execution end events
    // are covered too, so a failed or interrupted turn cannot leave it stranded.
    const unsubscribe = (
      [
        "session.idle",
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted",
      ] as const
    ).map((type) => context.data.on(type, () => void flushQueue()))

    return () => {
      clearInterval(poll)
      for (const timer of deferred) clearTimeout(timer)
      deferred.clear()
      offChanged()
      offPick()
      for (const off of unsubscribe) off()
      removeSlot()
    }
  },
})
