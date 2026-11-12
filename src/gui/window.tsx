/**
 * Desktop window half: a picker, a titlebar pill, a project-menu submenu and a
 * Settings › Profiles page.
 *
 * The window has no filesystem access. Everything it renders comes from the
 * server's RPC (`list`), and every switch goes back through `apply`, so the
 * desktop app and the TUI share one implementation.
 */

import {
  Command,
  Plugin,
  SettingsPage,
  Slot,
  TitlebarItem,
} from "@opencode/plugin/gui"
import { For, Show, createSignal } from "solid-js"

import { Profiles, asBusy, asSnapshot } from "../rpc.ts"
import type { ProfileView, RestartPolicy, Snapshot } from "../types.ts"
import { Restart } from "./contract.ts"

export const setup: Plugin.Setup = (ctx) => {
  const [snapshot, setSnapshot] = createSignal<Snapshot | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  const timers = new Set<number>()
  let sequence = 0

  const rpc = () => ctx.client.rpc(Profiles)

  const refresh = async () => {
    const mine = ++sequence
    try {
      const snap = asSnapshot(await rpc().list({}))
      if (mine !== sequence || ctx.signal.aborted) return
      setSnapshot(snap)
      setError(undefined)
    } catch (cause) {
      if (mine !== sequence || ctx.signal.aborted) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const describe = (profile: ProfileView) => {
    const bits = [profile.description]
    if (profile.restart === "pending")
      bits.push(ctx.t("profile.pending", { keys: profile.relaunch.join(", ") }))
    if (profile.restart === "layered") bits.push(ctx.t("profile.layered"))
    if (profile.agents.length) bits.push(ctx.t("profile.agents", { count: profile.agents.length }))
    const dropped = profile.legacy.length + profile.unknown.length
    if (dropped) bits.push(ctx.t("picker.warnings", { count: dropped }))
    return bits.filter(Boolean).join(" · ")
  }

  const restartDescription = (snap: Snapshot, name: string | null) => {
    const profile = name ? snap.profiles.find((entry) => entry.name === name) : undefined
    if (!profile) return ctx.t("restart.base.description")
    return ctx.t("restart.description", {
      profile: profile.name,
      keys: profile.relaunch.join(", ") || "startup keys",
    })
  }

  const doRestart = async (name: string | null, file: string | null) => {
    try {
      const result = await ctx.main(Restart).run({ profile: name, configFile: file })
      if (!result.ok) {
        ctx.toast.show({
          title: ctx.t("toast.restartTitle"),
          description: ctx.t("restart.failed", { error: result.error ?? "unknown error" }),
          variant: "error",
          duration: 8000,
        })
        return
      }
      ctx.toast.show({
        title: ctx.t("toast.restartTitle"),
        description: name ? ctx.t("restart.done", { profile: name }) : ctx.t("restart.doneBase"),
        variant: "success",
        duration: 6000,
      })
      // The server comes back on a new endpoint; give the app a moment, then
      // re-read through the new client.
      timers.add(window.setTimeout(() => void refresh(), 5000))
    } catch (cause) {
      ctx.toast.show({
        title: ctx.t("toast.restartTitle"),
        description: ctx.t("restart.failed", {
          error: cause instanceof Error ? cause.message : String(cause),
        }),
        variant: "error",
        duration: 8000,
      })
    }
  }

  const restartWhenIdle = async (snap: Snapshot, name: string | null) => {
    const profile = name ? snap.profiles.find((entry) => entry.name === name) : undefined
    const file = profile?.configFile ?? null

    const busy = async () => {
      try {
        return asBusy(await rpc().busy({})).busy
      } catch {
        // The server may already be restarting; do not queue forever.
        return false
      }
    }

    if (!(await busy())) {
      await doRestart(name, file)
      return
    }

    const toast = ctx.toast.show({
      title: ctx.t("toast.restartTitle"),
      description: ctx.t("restart.queued"),
      variant: "loading",
      persistent: true,
    })
    const timer = window.setInterval(async () => {
      if (await busy()) return
      window.clearInterval(timer)
      timers.delete(timer)
      toast.dismiss()
      await doRestart(name, file)
    }, 2000)
    timers.add(timer)
  }

  const maybeRestart = async (snap: Snapshot, name: string | null) => {
    const profile = name ? snap.profiles.find((entry) => entry.name === name) : undefined
    const pending = name ? profile?.restart === "pending" : snap.layered !== null
    if (!pending) return

    if (snap.policy === "never") {
      ctx.toast.show({
        title: ctx.t("toast.restartTitle"),
        description: profile?.command ?? restartDescription(snap, name),
        variant: "default",
        duration: 8000,
        actions: [{ label: ctx.t("restart.now"), run: () => void restartWhenIdle(snap, name) }],
      })
      return
    }

    if (snap.policy === "ask") {
      const confirmed = await ctx.dialogs.confirm({
        title: ctx.t("restart.title"),
        description: restartDescription(snap, name),
        confirm: ctx.t("restart.confirm"),
        cancel: ctx.t("restart.cancel"),
      })
      if (!confirmed) return
    }

    await restartWhenIdle(snap, name)
  }

  const apply = async (name: string | null) => {
    try {
      const session = ctx.sessions.current()
      // The RPC belongs to the app's own server; a session on another server
      // has no id there, so do not ask it to migrate one.
      const sessionID = session?.server.builtin ? session.id : undefined
      const snap = asSnapshot(await rpc().apply(sessionID ? { name, sessionID } : { name }))
      setSnapshot(snap)
      ctx.toast.show({
        title: ctx.t("command.group"),
        description: name ? ctx.t("toast.applied", { profile: name }) : ctx.t("toast.removed"),
        variant: "success",
        duration: 3000,
      })
      await maybeRestart(snap, name)
    } catch (cause) {
      ctx.toast.show({
        title: ctx.t("command.group"),
        description: ctx.t("toast.failed", {
          error: cause instanceof Error ? cause.message : String(cause),
        }),
        variant: "error",
        duration: 8000,
      })
    }
  }

  const setPolicy = async (policy: RestartPolicy) => {
    try {
      setSnapshot(asSnapshot(await rpc().setPolicy({ policy })))
    } catch (cause) {
      ctx.toast.show({
        title: ctx.t("settings.policy"),
        description: cause instanceof Error ? cause.message : String(cause),
        variant: "error",
        duration: 6000,
      })
    }
  }

  const pick = async () => {
    await refresh()
    const snap = snapshot()
    if (!snap) {
      await ctx.dialogs.alert({
        title: ctx.t("picker.title"),
        description: error() ?? ctx.t("picker.unavailable"),
      })
      return
    }

    const options = [
      { title: ctx.t("picker.base"), value: "", description: ctx.t("picker.base.description") },
      ...snap.profiles.map((profile) => ({
        title: profile.label,
        value: profile.name,
        description: describe(profile),
      })),
    ]
    const picked = await ctx.dialogs.select({
      title: ctx.t("picker.title"),
      placeholder: ctx.t("picker.search"),
      options,
      current: snap.active ?? "",
    })
    if (picked === undefined) return
    await apply(picked === "" ? null : picked)
  }

  const restartNow = async () => {
    await refresh()
    const snap = snapshot()
    if (snap) await restartWhenIdle(snap, snap.active)
  }

  // --- contributions ------------------------------------------------------

  ctx.add(
    Command,
    (): Command => ({
      id: "pick",
      title: ctx.t("command.pick"),
      description: ctx.t("command.pick.description"),
      keywords: "profile config switch",
      group: ctx.t("command.group"),
      section: "general",
      bind: "mod+alt+p",
      run: () => void pick(),
    }),
  )

  ctx.add(
    TitlebarItem,
    (): TitlebarItem | undefined => {
      const snap = snapshot()
      if (!snap) return undefined
      const active = snap.profiles.find((profile) => profile.name === snap.active)
      const pending = active?.restart === "pending" || (!snap.active && snap.layered !== null)
      return {
        id: "profile",
        label: snap.active ?? ctx.t("base"),
        title: active ? active.label : ctx.t("base.description"),
        icon: pending ? "warning" : "status",
        run: () => void pick(),
      }
    },
  )

  ctx.add(Slot, {
    at: "session.location.menu",
    render: (input) => (
      <Show when={input.shown}>
        <ctx.ui.MenuSub label={ctx.t("menu.title")} icon="status">
          <For each={snapshot()?.profiles ?? []}>
            {(profile) => (
              <ctx.ui.MenuItem
                label={profile.name === snapshot()?.active ? `✓ ${profile.label}` : profile.label}
                onSelect={() => void apply(profile.name)}
              />
            )}
          </For>
          <ctx.ui.MenuSeparator />
          <ctx.ui.MenuItem label={ctx.t("menu.base")} onSelect={() => void apply(null)} />
        </ctx.ui.MenuSub>
      </Show>
    ),
  })

  ctx.add(SettingsPage, {
    id: "profile-switcher",
    icon: "sliders",
    get title() {
      return ctx.t("settings.title")
    },
    get entries() {
      return [
        { id: "active", title: ctx.t("settings.active"), keywords: "profile switch config" },
        { id: "policy", title: ctx.t("settings.policy"), keywords: "restart policy" },
        { id: "restart", title: ctx.t("settings.restart") },
        { id: "folder", title: ctx.t("settings.folder"), keywords: "profiles directory" },
      ]
    },
    render: () => {
      return (
        <ctx.ui.SettingsLayout title={ctx.t("settings.title")} description={ctx.t("settings.description")}>
          <Show
            when={snapshot()}
            fallback={
              <ctx.ui.SettingsSection title={ctx.t("settings.title")}>
                <ctx.ui.SettingsRow
                  title={ctx.t("picker.title")}
                  description={error() ?? ctx.t("picker.unavailable")}
                />
              </ctx.ui.SettingsSection>
            }
          >
            {(value) => (
              <>
                <ctx.ui.SettingsSection title={ctx.t("settings.active.section")}>
                  <ctx.ui.SettingsRow
                    id="active"
                    title={ctx.t("settings.active")}
                    description={ctx.t("settings.active.description")}
                  >
                    <ctx.ui.Select
                      label={ctx.t("settings.active")}
                      options={[
                        { value: "", label: ctx.t("base") },
                        ...value().profiles.map((profile) => ({ value: profile.name, label: profile.label })),
                      ]}
                      value={value().active ?? ""}
                      onChange={(next) => void apply(next === "" ? null : next)}
                    />
                  </ctx.ui.SettingsRow>
                  <ctx.ui.SettingsRow
                    id="policy"
                    title={ctx.t("settings.policy")}
                    description={ctx.t("settings.policy.description")}
                  >
                    <ctx.ui.Select
                      label={ctx.t("settings.policy")}
                      options={[
                        { value: "always", label: ctx.t("policy.always") },
                        { value: "ask", label: ctx.t("policy.ask") },
                        { value: "never", label: ctx.t("policy.never") },
                      ]}
                      value={value().policy}
                      onChange={(next) => void setPolicy(next as RestartPolicy)}
                    />
                  </ctx.ui.SettingsRow>
                  <ctx.ui.SettingsRow
                    id="restart"
                    title={ctx.t("settings.restart")}
                    description={ctx.t("settings.restart.description")}
                  >
                    <ctx.ui.Button onClick={() => void restartNow()}>
                      {ctx.t("settings.restart.action")}
                    </ctx.ui.Button>
                  </ctx.ui.SettingsRow>
                  <ctx.ui.SettingsRow
                    id="folder"
                    title={ctx.t("settings.folder")}
                    description={value().profilesRoot}
                  >
                    <ctx.ui.Button
                      disabled={!ctx.desktop}
                      onClick={() => void ctx.desktop?.reveal(value().profilesRoot)}
                    >
                      {ctx.t("settings.folder.action")}
                    </ctx.ui.Button>
                  </ctx.ui.SettingsRow>
                </ctx.ui.SettingsSection>
                <ctx.ui.SettingsSection title={ctx.t("settings.profiles")}>
                  <For each={value().profiles}>
                    {(profile) => (
                      <ctx.ui.SettingsRow
                        id={`profile-${profile.name}`}
                        title={profile.label}
                        description={describe(profile)}
                      >
                        <ctx.ui.Button
                          variant={profile.name === value().active ? "contrast" : "neutral"}
                          disabled={profile.name === value().active}
                          onClick={() => void apply(profile.name)}
                        >
                          {profile.name === value().active
                            ? ctx.t("settings.applied")
                            : ctx.t("settings.apply")}
                        </ctx.ui.Button>
                      </ctx.ui.SettingsRow>
                    )}
                  </For>
                </ctx.ui.SettingsSection>
              </>
            )}
          </Show>
        </ctx.ui.SettingsLayout>
      )
    },
  })

  // --- lifecycle ----------------------------------------------------------

  void refresh()

  // The server pushes a change when /profile, the TUI or another window
  // switches. The poll covers a server restart, where the client is replaced.
  const offChanged = rpc().events.on("changed", () => void refresh())
  const poll = window.setInterval(() => void refresh(), 15_000)

  return () => {
    offChanged()
    window.clearInterval(poll)
    for (const timer of timers) {
      window.clearTimeout(timer)
      window.clearInterval(timer)
    }
    timers.clear()
  }
}
