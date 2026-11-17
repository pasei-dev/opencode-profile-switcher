/**
 * profile-switcher — server half.
 *
 * Applies the selected profile from <config>/profiles/<name>/ as a live overlay
 * through plugin transforms. No config file is edited and nothing is rewritten
 * on disk.
 *
 * Live: default agent, per-agent models, hidden agents, profile agents (read
 * from the profile's agents/*.md), default model, MCP servers, permission effects.
 * Startup-only, so still needs a relaunch in that directory: plugins,
 * compaction, lsp, formatter, instructions, and friends (reported at switch time).
 *
 * The TUI and the desktop app never read profile files themselves: they call
 * the RPC in ./rpc.ts, so there is one implementation of discovery, linting and
 * application.
 *
 * Source of truth: https://opencode.ai/v2/docs/build/plugins/server (2.3.0)
 */

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"

import { Plugin } from "@opencode/plugin"
import { Agent } from "@opencode/schema"

import { Profiles, asPolicy } from "./rpc.ts"
import type { ProfileView, Snapshot } from "./types.ts"
import {
  agentMode,
  claimRelayer,
  clearRelayer,
  expectedLayered,
  globalConfigDir,
  layeredProfileName,
  loadProfiles,
  mcpServers,
  modelRefFromConfig,
  parseModelRef,
  profilesRoot,
  RELAYER_ATTEMPTS,
  readBaseConfig,
  readSelection,
  readSelectionState,
  referenceSources,
  resolveEffect,
  restartCommand,
  staleAgentNames,
  startupInfo,
  stateFile,
  websearchSelection,
  writePolicy,
  writeSelection,
  writeServiceEnv,
  type Profile,
} from "./profiles.ts"

/**
 * Restarts the background service with the profile layered. Detached, because the
 * service this runs in is the one being replaced.
 */
function restartDetached(configFile: string): void {
  try {
    const child = spawn(process.execPath, ["service", "restart"], {
      env: { ...process.env, OPENCODE_CONFIG: configFile },
      detached: true,
      stdio: "ignore",
    })
    child.unref()
  } catch (error) {
    console.warn("[profile-switcher] could not restart the service", error)
  }
}

/** Which registry a profile key feeds, so a switch reloads only what changed. */
const DOMAIN_KEYS: Record<string, string[]> = {
  agent: ["agents", "default_agent"],
  model: ["model"],
  mcp: ["mcp"],
  reference: ["references"],
  websearch: ["websearch"],
}

function domainsFor(profile: Profile | undefined): Set<string> {
  const out = new Set<string>()
  if (!profile) return out
  for (const [domain, keys] of Object.entries(DOMAIN_KEYS)) {
    if (keys.some((key) => profile.warnings.applied.includes(key))) out.add(domain)
  }
  // Agent .md files apply through the agent transform even without an `agents` key.
  if (profile.agents.length > 0) out.add("agent")
  return out
}

export default Plugin.define({
  id: "profile-switcher",

  async setup(ctx) {
    // Transforms and the permission hook close over these, so reload() replays
    // them against whatever is current.
    let active: Profile | undefined
    let profiles: Profile[] = []
    let previous: string | null = null
    /**
     * Lookups rebuilt whenever the active profile changes. The context hook runs
     * on every request, so it must not scan the profile's arrays each time.
     */
    let agentByName = new Map<string, Profile["agents"][number]>()
    let agentModelByName = new Map<string, string>()
    /** Every registration, disposed on unload so hot-reloads do not stack. */
    const registrations: Array<{ dispose(): Promise<void> | void }> = []
    /** Sessions with a running turn, tracked from `session.status` events. */
    const running = new Set<string>()
    /** Set once the RPC is registered; apply() and the watcher emit through it. */
    let emitChanged: (() => void) | undefined
    /** Asks a connected TUI to open its profile picker. */
    let emitPick: (() => void) | undefined

    const refresh = async () => {
      profiles = loadProfiles()
    }

    const select = (name: string | null) => {
      active = name ? profiles.find((profile) => profile.name === name) : undefined
      agentByName = new Map((active?.agents ?? []).map((definition) => [definition.name, definition]))
      agentModelByName = new Map((active?.agentModels ?? []).map((entry) => [entry.agent, entry.model]))
    }

    const policy = () => readSelectionState().policy ?? "always"

    const reloadDomains = async (domains: Set<string>) => {
      const reloaders: Array<Promise<void>> = []
      if (domains.has("agent")) reloaders.push(ctx.agent.reload())
      if (domains.has("model")) reloaders.push(ctx.model.reload())
      if (domains.has("mcp")) reloaders.push(ctx.mcp.reload())
      if (domains.has("reference")) reloaders.push(ctx.reference.reload())
      if (domains.has("websearch")) reloaders.push(ctx.websearch.reload())
      await Promise.all(reloaders)
    }

    // The model the switched session should run on: the profile's default agent's
    // model if it has one, otherwise the profile's default model. Mirrors the
    // agent transform, where a config `agents.<name>.model` override wins over the
    // agent definition's own model.
    const sessionModel = () => {
      if (!active) return undefined
      const agentName = active.defaultAgent
      if (agentName) {
        const override = agentModelByName.get(agentName)
        const definition = agentByName.get(agentName)?.model
        const agentRef = parseModelRef(override ?? "") ?? parseModelRef(definition ?? "")
        if (agentRef) return agentRef
      }
      return parseModelRef(active.defaultModel ?? "")
    }

    // Switching back to base: use the base config's own agent/model if it defines
    // them (default_agent, that agent's model, or the top-level model), otherwise
    // fall back to the built-in `build` agent and force no model.
    const baseTarget = () => {
      const config = readBaseConfig()
      const agent =
        typeof config?.default_agent === "string" && config.default_agent ? config.default_agent : "build"
      const agentsMap = (config?.agents ?? config?.agent ?? {}) as Record<string, any>
      const agentModel = modelRefFromConfig(agentsMap?.[agent]?.model)
      const raw = agentModel ?? modelRefFromConfig(config?.model)
      return { agent, model: raw }
    }

    // Move the requesting session onto the profile's default agent and model.
    // Disabled agents are only hidden, so this never strands a session; it just
    // points the session at the agent/model the profile intends.
    const migrateSession = async (sessionID?: string) => {
      if (!sessionID) return
      const target = active ? { agent: active.defaultAgent, model: sessionModel() } : baseTarget()

      // This plugin loads once per location but the handoff file is global, so
      // one switch wakes every instance. Only the instance owning the session's
      // location migrates it — otherwise a single switch emits one "Switched
      // agent" message per loaded location. Redundant switches are skipped too:
      // switchAgent/switchModel announce even when nothing changes.
      let currentAgent: unknown
      let currentModel: { providerID?: unknown; id?: unknown } | undefined
      try {
        const info = await ctx.session.get({ sessionID })
        const sessionDir = info?.location?.directory
        const ownDir = ctx.location.directory
        if (typeof sessionDir === "string" && typeof ownDir === "string" && sessionDir !== ownDir) return
        currentAgent = info?.agent
        currentModel = info?.model
      } catch (error) {
        console.warn("[profile-switcher] could not read session, migrating anyway", error)
      }

      if (target.agent && target.agent !== currentAgent) {
        try {
          await ctx.session.switchAgent({ sessionID, agent: target.agent })
        } catch (error) {
          console.warn("[profile-switcher] could not move session to profile agent", error)
        }
      }
      if (
        target.model &&
        (target.model.providerID !== currentModel?.providerID || target.model.id !== currentModel?.id)
      ) {
        try {
          await ctx.session.switchModel({ sessionID, model: target.model })
        } catch (error) {
          console.warn("[profile-switcher] could not switch session model", error)
        }
      }
    }

    const apply = async (name: string | null, sessionID?: string) => {
      const before = active
      previous = active?.name ?? previous
      await refresh()
      select(name)
      writeSelection(
        name,
        sessionID,
        active ? startupInfo(active.configFile, active.warnings.relaunch, process.env.OPENCODE_CONFIG) : undefined,
      )
      // Persist the layer where the CLI reads it at spawn time, so the next
      // cold start or manual restart needs no relay. `none` removes it, or the
      // next restart would put the old profile back.
      writeServiceEnv(active?.configFile ?? null)
      await reloadDomains(new Set([...domainsFor(before), ...domainsFor(active)]))
      await migrateSession(sessionID)
      emitChanged?.()
    }

    const profileView = (profile: Profile): ProfileView => ({
      name: profile.name,
      label: profile.label,
      description: profile.description,
      directory: profile.directory,
      configFile: profile.configFile,
      ...(profile.defaultAgent ? { defaultAgent: profile.defaultAgent } : {}),
      ...(profile.defaultModel ? { defaultModel: profile.defaultModel } : {}),
      agents: profile.agents.filter((definition) => !definition.disabled).map((definition) => definition.name),
      applied: profile.warnings.applied,
      relaunch: profile.warnings.relaunch,
      adapted: profile.warnings.adapted,
      legacy: profile.warnings.legacy,
      unknown: profile.warnings.unknown,
      restart: startupInfo(profile.configFile, profile.warnings.relaunch, process.env.OPENCODE_CONFIG).kind,
      hidden: profile.hidden,
      command: restartCommand(profile.configFile),
    })

    const snapshot = (): Snapshot => {
      const state = readSelectionState()
      return {
        active: active?.name ?? null,
        layered: layeredProfileName(profiles, process.env.OPENCODE_CONFIG),
        expected: expectedLayered(state),
        policy: state.policy ?? "always",
        policyStored: state.policy !== undefined,
        profilesRoot: profilesRoot(),
        busy: running.size > 0,
        profiles: profiles.map(profileView),
      }
    }

    await refresh()
    select(readSelection())

    // `apply` writes the handoff before the restart, so it records the
    // pre-restart verdict ("pending"). Once the layered server is up, correct
    // the record: clients read it for their first paint, and a stale "pending"
    // is what makes the marker survive a successful restart.
    const bootLayered = layeredProfileName(profiles, process.env.OPENCODE_CONFIG)
    if (active && bootLayered === active.name) {
      const stored = readSelectionState()
      const startup = startupInfo(active.configFile, active.warnings.relaunch, process.env.OPENCODE_CONFIG)
      if (stored.profile !== active.name || stored.startup?.kind !== startup.kind) {
        writeSelection(active.name, stored.sessionID, startup)
      }
      // The layer stuck. Give back the relay attempts once it has stayed up a
      // while, so a later drop can heal again. Waiting avoids resetting on the
      // very boot the host is about to undo.
      setTimeout(clearRelayer, 60_000).unref?.()
      // Record the layer where the CLI reads it, so the next start needs no
      // relay. Idempotent: a boot that already matches writes nothing.
      writeServiceEnv(active.configFile)
    }

    // A manual restart, or the desktop app starting its own server, drops the
    // OPENCODE_CONFIG layer: the profile comes back with its live keys applied and
    // its startup keys silently missing. Put the layer back once, guarded by the
    // shared relayer token so several locations cannot bounce the service.
    //
    // A "pending" record is the same failure seen from the other side: the switch
    // asked for a restart and this boot is the one that came back without the
    // layer. Clients only relay a "layered" record (a pending one may still be
    // mid-restart), but at boot the restart is over.
    const boot = readSelectionState()
    const expected = expectedLayered(boot) ?? (boot.startup?.kind === "pending" ? boot.profile : null)
    if (expected && bootLayered === null && expected === active?.name) {
      const profile = profiles.find((item) => item.name === expected)
      if (profile && claimRelayer(expected)) {
        console.warn(
          `[profile-switcher] the ${expected} layer is missing; restarting the service with ${profile.configFile}`,
        )
        // Let this server finish booting before the restart replaces it.
        setTimeout(() => restartDetached(profile.configFile), 2_000)
      } else if (profile) {
        // Another location may have claimed the relay a moment ago; only speak
        // when the attempts are spent and nobody will fix it.
        const relayer = readSelectionState().relayer
        if (relayer?.profile === expected && relayer.attempts >= RELAYER_ATTEMPTS) {
          console.warn(
            `[profile-switcher] the ${expected} layer is still missing; run: ${restartCommand(profile.configFile)}`,
          )
        }
      }
    }

    // --- agents ------------------------------------------------------------

    registrations.push(
      await ctx.agent.transform((draft) => {
        // Transforms replay onto a fresh registry, so nothing a previous profile
        // changed can survive into this one: base agents come back exactly as
        // configured. That is what makes `/profile none` restore `build` — the
        // `created` bookkeeping this replaces *hid* those agents instead, and
        // nothing ever un-hid them, so reverting could not switch back to them.
        if (active) {
          // `active.agents` is the merge of both native sources: `agents` keys
          // in opencode.jsonc and markdown files under agent/agents/mode/modes.
          // A config-only agent is created here, exactly as core does, so a
          // profile does not need an agents/ directory to be usable live.
          for (const definition of active.agents) {
            const name = definition.name

            // Hide disabled agents instead of removing them: a session already
            // bound to one would otherwise die with Session.AgentNotFoundError
            // on its next turn. Hidden agents stay resolvable but drop out of
            // the picker (core: selectable = mode !== "subagent" && !hidden).
            if (definition.disabled) {
              if (draft.get(name)) draft.update(name, (agent) => { agent.hidden = true })
              continue
            }

            // A config entry that only retunes an agent (a model, a colour) is
            // not a definition: creating it would add a prompt-less primary
            // agent with core's default `*: allow` rules to the picker. So it
            // may only update an agent that already exists.
            const defines =
              definition.system !== undefined ||
              agentMode(definition.mode) !== undefined ||
              definition.description !== undefined
            if (!defines && !draft.get(name)) continue

            draft.update(name, (agent) => {
              agent.name = Agent.Name.make(name)
              if (definition.description !== undefined) agent.description = definition.description
              const mode = agentMode(definition.mode)
              if (mode) agent.mode = mode
              if (definition.system !== undefined) agent.system = definition.system
              const ref = parseModelRef(definition.model ?? "")
              if (ref) agent.model = ref
              if (definition.hidden !== undefined) agent.hidden = definition.hidden
              if (definition.color !== undefined) agent.color = definition.color
              if (definition.steps !== undefined) agent.steps = definition.steps
              if (definition.permissions?.length) agent.permissions.push(...definition.permissions)
              if (definition.request?.headers) Object.assign(agent.request.headers, definition.request.headers)
              if (definition.request?.body) Object.assign(agent.request.body, definition.request.body)
            })
          }

          if (active.defaultAgent) draft.default(active.defaultAgent)
        }

        // A session may still be bound to another profile's agent, and those
        // names exist nowhere else — keep one resolvable as a hidden stub so the
        // session survives, while selection and the picker ignore it.
        for (const name of staleAgentNames(profiles, active)) {
          if (draft.get(name)) continue
          draft.update(name, (agent) => {
            agent.name = Agent.Name.make(name)
            agent.mode = "subagent"
            agent.hidden = true
          })
        }
      }),
    )

    // --- models and MCP ----------------------------------------------------

    registrations.push(
      await ctx.model.transform((editor) => {
        const ref = modelRefFromConfig(active?.defaultModel)
        if (ref) editor.default.set(ref.providerID, ref.id)
      }),
    )

    registrations.push(
      await ctx.mcp.transform((draft) => {
        if (!active) return
        for (const [name, server] of Object.entries(mcpServers(active.config))) draft.set(name, server)
      }),
    )

    // Named references: replayed onto a fresh registry, so the previous
    // profile's entries disappear without any bookkeeping here.
    registrations.push(
      await ctx.reference.transform((draft) => {
        if (!active) return
        for (const [name, source] of Object.entries(referenceSources(active.config, active.directory)))
          draft.add(name, source)
      }),
    )

    // websearch is selection only: an id, or false to turn it off.
    registrations.push(
      await ctx.websearch.transform((draft) => {
        const selection = active ? websearchSelection(active.config) : undefined
        if (selection !== undefined) draft.default.set(selection)
      }),
    )

    // --- permissions -------------------------------------------------------
    // There is no ruleset transform, so the profile's permissions are enforced
    // per decision through the evaluate hook, which runs after the configured
    // rules. Two consequences: an explicit configured `deny` is final and never
    // reaches the hook, so a profile cannot widen what config already blocks;
    // and the profile's ordered { action, resource, effect } rules are replayed
    // here with the same last-match-wins precedence OpenCode uses.

    registrations.push(
      await ctx.permission.hook("evaluate", (event) => {
        if (!active?.permissions.length) return
        const effect = resolveEffect(active.permissions, event.action, event.resources)
        if (!effect) return
        event.effect = effect
        if (effect !== "allow") event.message = `profile '${active.name}': ${event.action} -> ${effect}`
      }),
    )

    // --- per-agent generation tuning ---------------------------------------
    // V2 has no agent-level temperature/reasoningEffort/textVerbosity fields
    // (opencode.ai/v2/docs/agents). The runtime equivalent is the context hook's
    // `options`: typed keys are generation settings, any other key is passed to
    // the selected protocol as a provider option.

    registrations.push(
      await ctx.session.hook("context", (event) => {
        if (!active) return
        const agent = agentByName.get(event.agent)
        if (agent?.temperature !== undefined) event.options.temperature = agent.temperature
      }),
    )

    // reasoningEffort / textVerbosity are OpenAI request options, so scope that
    // hook to the provider instead of handing other providers unknown fields.
    registrations.push(
      await ctx.session.hook(
        "context",
        (event) => {
          if (!active) return
          const agent = agentByName.get(event.agent)
          if (!agent) return
          if (agent.reasoningEffort) event.options.reasoningEffort = agent.reasoningEffort
          if (agent.textVerbosity) event.options.textVerbosity = agent.textVerbosity
        },
        { providerID: "openai" },
      ),
    )

    // --- busy tracking ------------------------------------------------------
    // A desktop restart must not interrupt a running turn. The server is the
    // only process that sees every session's status, so it tracks them here and
    // reports `busy` over RPC.

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.status", "session.deleted"],
          signal: controller.signal,
        })) {
          if (event.type === "session.deleted") {
            running.delete(event.data.sessionID)
            continue
          }
          const { sessionID, status } = event.data
          if (status.type === "idle") running.delete(sessionID)
          else running.add(sessionID)
        }
      } catch (error) {
        if (!controller.signal.aborted) console.warn("[profile-switcher] session status stream ended", error)
      }
    })()

    // --- RPC ----------------------------------------------------------------

    const rpc = await ctx.rpc.register(Profiles, {
      list: async () => snapshot(),
      apply: async (input) => {
        const { name, sessionID } = input as { name: string | null; sessionID?: string }
        await apply(name, sessionID)
        return snapshot()
      },
      setPolicy: async (input) => {
        writePolicy(asPolicy((input as { policy: unknown }).policy))
        emitChanged?.()
        return snapshot()
      },
      busy: async () => ({ busy: running.size > 0 }),
      // One client at a time may restore a dropped layer, and only a few times:
      // the token lives in the shared handoff file, not in each client. The
      // server enforces the same invariant the clients check, so a stray call
      // cannot spend an attempt while the layer is live.
      claimRestart: async (input) => {
        const { profile } = input as { profile: string }
        const live = layeredProfileName(profiles, process.env.OPENCODE_CONFIG)
        const allowed = live === null && profile === (active?.name ?? null) && claimRelayer(profile)
        return { allowed }
      },
    })
    registrations.push(rpc)
    emitChanged = () => {
      void rpc.events
        .emit("changed", { profile: active?.name ?? null, policy: policy(), busy: running.size > 0 })
        .catch(() => {
          // No subscribers or the server is shutting down; nothing to report.
        })
    }
    emitPick = () => {
      void rpc.events.emit("pick", {}).catch(() => {
        // No TUI attached; the command's text answer still says what happened.
      })
    }

    // --- /profile ----------------------------------------------------------

    const report = (profile: Profile) => {
      const w = profile.warnings
      const lines = [`**${profile.label}** — \`${profile.directory}\``]
      if (profile.defaultAgent) lines.push(`- default agent: \`${profile.defaultAgent}\``)
      if (profile.defaultModel) lines.push(`- default model: \`${profile.defaultModel}\``)
      const agentNames = profile.agents.filter((agent) => !agent.disabled).map((agent) => agent.name)
      if (agentNames.length) lines.push(`- agents: ${agentNames.join(", ")}`)
      if (w.applied.length) lines.push(`- applied live: ${w.applied.join(", ")}`)
      const startup = startupInfo(profile.configFile, w.relaunch, process.env.OPENCODE_CONFIG)
      if (startup.kind === "layered") lines.push(`- startup keys loaded: ${startup.keys.join(", ")}`)
      if (startup.kind === "pending")
        lines.push(
          `- ⟳ needs a restart — ${startup.keys.join(", ")} are read when the server starts:\n    ${startup.command}\n    (the TUI picker and the desktop app can run this for you, or use /profile restart)`,
        )
      if (w.adapted.length) lines.push(`- V1 but normalized by V2:\n${w.adapted.map((l) => `    - ${l}`).join("\n")}`)
      if (w.legacy.length) lines.push(`- legacy fields (ignored by V2):\n${w.legacy.map((l) => `    - ${l}`).join("\n")}`)
      if (w.unknown.length) lines.push(`- unrecognized fields (ignored): ${w.unknown.join(", ")}`)
      return lines.join("\n")
    }

    const profilesHint = () => path.join(globalConfigDir(), "profiles")

    const listing = () => {
      const rows = profiles
        .filter((profile) => !profile.hidden)
        .map((profile) => `- ${profile.name === active?.name ? "active" : "      "} ${profile.name} — ${profile.description}`)
      return rows.length ? `Available:\n${rows.join("\n")}` : `No profiles in ${profilesHint()}`
    }

    const respond = (sessionID: string, text: string) => ctx.session.synthetic({ sessionID, text })

    const handle = async (sessionID: string, argument: string) => {
      const name = argument.trim().toLowerCase()

      // Bare `/profile` is the picker: the TUI opens its popup on the event, and
      // the text answer is the fallback for a client that has none.
      if (name === "") {
        emitPick?.()
        return respond(sessionID, "Opening the profile picker — or run `/profile list` for the text form.")
      }

      if (name === "list" || name === "status") {
        if (!active) return respond(sessionID, `No profile applied — base config only.\n\n${listing()}`)
        return respond(sessionID, `Active profile: ${active.name}\n\n${report(active)}\n\n${listing()}`)
      }

      if (name === "restart") {
        if (!active) return respond(sessionID, "No profile applied — nothing to layer in.")
        const startup = startupInfo(active.configFile, active.warnings.relaunch, process.env.OPENCODE_CONFIG)
        if (startup.kind === "layered")
          return respond(sessionID, `Startup keys for **${active.name}** are already loaded (${startup.keys.join(", ")}).`)
        if (startup.kind === "none")
          return respond(sessionID, `**${active.name}** needs no restart — everything it sets applies live.`)
        return respond(
          sessionID,
          `Restart the service with this profile layered in:\n\n    ${startup.command}\n\nThe TUI picker and the desktop app can run this for you. Sessions keep their history; the running turn is interrupted.`,
        )
      }

      if (name === "policy" || name.startsWith("policy ")) {
        const wanted = name.slice("policy".length).trim()
        if (wanted === "ask" || wanted === "always" || wanted === "never") {
          writePolicy(wanted)
          emitChanged?.()
          return respond(sessionID, `Restart policy: **${wanted}**.`)
        }
        return respond(sessionID, `Restart policy: **${policy()}** (use /profile policy ask|always|never).`)
      }

      if (name === "none" || name === "clear" || name === "off") {
        await apply(null, sessionID)
        return respond(sessionID, "Profile removed — back to base config.")
      }

      if (name === "prev" || name === "back") {
        await apply(previous, sessionID)
        return respond(sessionID, active ? `Active profile: ${active.name}` : "Profile removed — back to base config.")
      }

      const target = profiles.find(
        (profile) => profile.name.toLowerCase() === name || profile.label.toLowerCase() === name,
      )
      if (!target) return respond(sessionID, `No profile named \`${name}\`. ${listing()}`)

      await apply(target.name, sessionID)
      return respond(sessionID, `Active profile: ${target.name}\n\n${report(target)}`)
    }

    registrations.push(
      await ctx.command.transform((draft) => {
        draft.add({
          name: "profile",
          description: "Open the profile picker (or: list, <name>, none, prev, policy, restart)",
          execute: async ({ sessionID, prompt }) => {
            await handle(sessionID, String(prompt?.text ?? ""))
          },
        })
      }),
    )

    // --- selection watcher --------------------------------------------------
    // The handoff file is the durable record. RPC writes it, and the watcher
    // still applies a manual edit (or a write from an older client) so the
    // overlay never depends on which process made the change.

    const file = stateFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const base = path.basename(file)
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastPolicy = policy()

    const watcher = fs.watch(path.dirname(file), (_event, changed) => {
      if (changed && changed !== base) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        void (async () => {
          const state = readSelectionState()
          const wanted = state.profile
          if (wanted !== (active?.name ?? null)) {
            await apply(wanted, state.sessionID)
            lastPolicy = policy()
            return
          }
          const next = state.policy ?? "always"
          if (next !== lastPolicy) {
            lastPolicy = next
            emitChanged?.()
          }
        })().catch((error) => console.warn("[profile-switcher] could not apply selection", error))
      }, 80)
    })

    return async () => {
      clearTimeout(timer)
      watcher.close()
      controller.abort()
      for (const registration of registrations) {
        try {
          await registration.dispose()
        } catch {
          // Already torn down by the host; nothing left to undo.
        }
      }
    }
  },
})
