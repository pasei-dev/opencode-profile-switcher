/**
 * Profile discovery shared by the server, TUI and desktop halves.
 *
 * A profile is a directory under <config>/profiles/<name>/ containing an
 * opencode.jsonc. Agents are read from <profile>/agents/*.md so they can be
 * created live, since agent definitions are otherwise only discovered at
 * server startup from the launch directory.
 *
 * Everything here is pure or filesystem-only. The desktop window never imports
 * this module; it reads the same data through the server's RPC instead.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Model } from "@opencode/schema"
import { parse as parseYaml } from "yaml"

import type { RestartPolicy, StartupInfo, StartupKind } from "./types.ts"

export type { RestartPolicy, StartupInfo, StartupKind }

// --- paths -----------------------------------------------------------------

/** Global OpenCode config dir, honouring XDG_CONFIG_HOME (appends /opencode). */
export function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".config")
  return path.join(base, "opencode")
}

export function profilesRoot(): string {
  return path.join(globalConfigDir(), "profiles")
}

/**
 * Handoff file: the server writes the chosen profile and policy here, and
 * watches it so a manual edit (or an older client) still applies. The TUI and
 * the desktop app read it only for the instant first paint; RPC is the source
 * of truth once the server is reachable.
 */
export function stateFile(): string {
  return path.join(globalConfigDir(), ".profile-switcher.json")
}

export type SelectionState = {
  profile: string | null
  sessionID?: string
  startup?: StartupInfo
  policy?: RestartPolicy
  /** Automatic re-layer bookkeeping, shared by every client. */
  relayer?: RelayerState
}

/**
 * How many times the clients may restore a dropped layer on their own, how far
 * apart, and how long the layer must stay quiet before a new incident starts.
 * All three live in the handoff file, so two windows cannot bounce the service
 * at the same time — or keep bouncing it forever.
 *
 * The reset is deliberately *not* a layered boot: the host this guards against
 * restarts the service and then drops the layer again seconds later, so a boot
 * would hand out a fresh set of attempts every cycle.
 */
export const RELAYER_ATTEMPTS = 3
export const RELAYER_COOLDOWN_MS = 30_000
export const RELAYER_RESET_MS = 10 * 60_000

export type RelayerState = { profile: string; at: number; attempts: number }

function isPolicy(value: unknown): value is RestartPolicy {
  return value === "ask" || value === "always" || value === "never"
}

export function readSelectionState(): SelectionState {
  const parsed = readJsonc(stateFile())
  const startup = parsed?.startup
  const relayer = parsed?.relayer
  return {
    profile: typeof parsed?.profile === "string" ? parsed.profile : null,
    sessionID: typeof parsed?.sessionID === "string" ? parsed.sessionID : undefined,
    startup:
      startup && typeof startup === "object" && typeof startup.kind === "string"
        ? {
            kind: startup.kind as StartupKind,
            keys: Array.isArray(startup.keys) ? startup.keys.map(String) : [],
            command: typeof startup.command === "string" ? startup.command : undefined,
          }
        : undefined,
    policy: isPolicy(parsed?.policy) ? parsed.policy : undefined,
    relayer:
      relayer && typeof relayer === "object" && typeof relayer.profile === "string"
        ? {
            profile: relayer.profile,
            at: Number(relayer.at) || 0,
            attempts: Number(relayer.attempts) || 0,
          }
        : undefined,
  }
}

export function readSelection(): string | null {
  return readSelectionState().profile
}

function writeState(state: SelectionState): void {
  const file = stateFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body: Record<string, unknown> = { profile: state.profile, at: Date.now() }
  if (state.sessionID) body.sessionID = state.sessionID
  // The server's verdict on startup keys, echoed for clients to read.
  if (state.startup) body.startup = state.startup
  if (state.policy) body.policy = state.policy
  // Attempts belong to the profile they were made for; a switch starts fresh.
  if (state.relayer && state.relayer.profile === state.profile) body.relayer = state.relayer
  // Write-then-rename, so the watcher never reads a half-written file.
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(body), "utf8")
  fs.renameSync(temp, file)
}

/** Writes the selection without dropping the stored restart policy. */
export function writeSelection(name: string | null, sessionID?: string, startup?: StartupInfo): void {
  writeState({ ...readSelectionState(), profile: name, sessionID, startup })
}

/** Stores the restart policy shared by every client. */
export function writePolicy(policy: RestartPolicy): void {
  writeState({ ...readSelectionState(), policy })
}

/** The service's own config, where the CLI keeps the env it spawns a daemon with. */
export function serviceConfigFile(): string {
  return path.join(globalConfigDir(), "service.json")
}

/**
 * Keep the profile's layer in the service config's `env`. The CLI reads this
 * file whenever it spawns a daemon, so a cold start or a manual
 * `opencode service restart` layers the profile with no relay at all. The
 * desktop app starts its own server and ignores this file, so it still relies
 * on the boot relay.
 *
 * Other keys and other env vars are preserved; passing null removes only ours.
 */
export function writeServiceEnv(configFile: string | null): void {
  const file = serviceConfigFile()
  const exists = fs.existsSync(file)
  const current = readJsonc(file)
  if (exists && (!current || typeof current !== "object")) return
  const base: Record<string, unknown> = current ?? {}
  const env = { ...(base.env && typeof base.env === "object" ? (base.env as Record<string, unknown>) : {}) }
  if (configFile) env.OPENCODE_CONFIG = configFile
  else delete env.OPENCODE_CONFIG
  const next: Record<string, unknown> = { ...base }
  if (Object.keys(env).length > 0) next.env = env
  else delete next.env
  if (JSON.stringify(next) === JSON.stringify(base)) return
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
}

/**
 * Claim the right to restore a dropped layer. The handoff file is shared by
 * every client, so this is what stops two windows from bouncing the service at
 * the same time, and what stops any of them from doing it forever. A quiet
 * stretch longer than `RELAYER_RESET_MS` counts as a new incident.
 */
export function claimRelayer(profile: string, now = Date.now()): boolean {
  const state = readSelectionState()
  const previous = state.relayer?.profile === profile ? state.relayer : undefined
  const fresh = !previous || now - previous.at > RELAYER_RESET_MS
  const attempts = fresh ? 0 : previous.attempts
  if (attempts >= RELAYER_ATTEMPTS) return false
  if (!fresh && now - previous.at < RELAYER_COOLDOWN_MS) return false
  writeState({ ...state, relayer: { profile, at: now, attempts: attempts + 1 } })
  return true
}

/**
 * Forget the attempts once the layer has proved it stays. A layered boot alone
 * is not proof: the host that drops the layer restarts the service and drops it
 * again seconds later, so clearing on boot would hand out a fresh set of
 * attempts on every cycle. Callers clear after the layer has been live for a
 * while, which is what makes a later drop heal without a loop.
 */
export function clearRelayer(): void {
  const state = readSelectionState()
  if (!state.relayer) return
  writeState({ ...state, relayer: undefined })
}

/**
 * The profile the handoff record says should be layered. `apply` writes the
 * record before the restart, so it outlives a service that comes back without
 * the layer (the desktop app starts its own server with its own environment).
 * Clients use it to put the layer back, so ⟳ does not stay stuck.
 */
export function expectedLayered(state: SelectionState): string | null {
  return state.startup?.kind === "layered" ? state.profile : null
}

// --- JSONC -----------------------------------------------------------------

/** Strip // and block comments plus trailing commas, then parse. */
export function parseJsonc(text: string): any {
  let out = ""
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const n = text[i + 1]
    if (inLine) {
      if (c === "\n") {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (c === "\\") {
        out += n ?? ""
        i++
      } else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === "/" && n === "/") {
      inLine = true
      i++
      continue
    }
    if (c === "/" && n === "*") {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

export function readJsonc(file: string): any | undefined {
  try {
    return parseJsonc(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

/** Expand `~` and `$HOME` the way OpenCode expands config paths. */
export function expandHome(value: string): string {
  if (value === "~" || value === "$HOME") return os.homedir()
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
  if (value.startsWith("$HOME/")) return path.join(os.homedir(), value.slice(6))
  return value
}

/**
 * Core substitutes `{env:VAR}` and `{file:path}` in config text before parsing.
 * Mirror it here: a profile agent whose prompt is `{file:./prompts/lead.md}`
 * must reach the agent transform as text, not as a literal token.
 */
export function substituteConfigText(text: string, dir: string, escapeEnv = false): string {
  const withEnv = text.replace(/\{env:([^}]+)\}/g, (_, name: string) => {
    const value = process.env[name] ?? ""
    return escapeEnv ? JSON.stringify(value).slice(1, -1) : value
  })
  return withEnv.replace(/\{file:([^}]+)\}/g, (token, raw: string, offset: number, whole: string) => {
    // A reference in a line comment is documentation; leave it alone.
    const lineStart = whole.lastIndexOf("\n", offset - 1) + 1
    if (whole.slice(lineStart, offset).trimStart().startsWith("//")) return token
    const expanded = expandHome(raw)
    const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(dir, expanded)
    try {
      return JSON.stringify(fs.readFileSync(resolved, "utf8").trim()).slice(1, -1)
    } catch {
      // Like core: a missing reference substitutes empty instead of failing the
      // whole profile.
      return ""
    }
  })
}

/**
 * Read a config document with `{env:}` / `{file:}` substitution. Core first
 * substitutes raw values and retries with JSON-escaped ones only when the
 * result no longer parses, so configs that work today keep their meaning.
 */
export function readConfigJsonc(file: string): any | undefined {
  try {
    const text = fs.readFileSync(file, "utf8")
    const dir = path.dirname(file)
    try {
      return parseJsonc(substituteConfigText(text, dir))
    } catch {
      return parseJsonc(substituteConfigText(text, dir, true))
    }
  } catch {
    return undefined
  }
}

// --- model refs ------------------------------------------------------------

/**
 * "provider/model" or "provider/model#variant" -> a branded Model.Ref.
 * The contract's own parser is the only supported way to build one: ids and
 * providerIDs are effect brands, so a plain object of strings does not typecheck.
 * Returns undefined instead of throwing so a bad profile entry is skipped.
 */
export function parseModelRef(ref: string): Model.Ref | undefined {
  const i = ref.indexOf("/")
  if (i <= 0 || i === ref.length - 1) return undefined
  try {
    return Model.Ref.parse(ref)
  } catch {
    return undefined
  }
}

/**
 * V2 accepts both `"provider/model#variant"` and the object form
 * `{ providerID, model, variant }` for `model` and `agents.<name>.model`.
 */
export function modelRefFromConfig(value: unknown): Model.Ref | undefined {
  if (typeof value === "string") return parseModelRef(value)
  if (!value || typeof value !== "object") return undefined
  const { providerID, model, variant } = value as Record<string, unknown>
  if (typeof providerID !== "string" || providerID === "") return undefined
  if (typeof model !== "string" || model === "") return undefined
  const suffix = typeof variant === "string" && variant !== "" ? `#${variant}` : ""
  return parseModelRef(`${providerID}/${model}${suffix}`)
}

/** The display form of a config model value, or undefined when it is malformed. */
export function modelDisplay(value: unknown): string | undefined {
  if (typeof value === "string") return value !== "" ? value : undefined
  if (!value || typeof value !== "object") return undefined
  const { providerID, model, variant } = value as Record<string, unknown>
  if (typeof providerID !== "string" || providerID === "") return undefined
  if (typeof model !== "string" || model === "") return undefined
  const suffix = typeof variant === "string" && variant !== "" ? `#${variant}` : ""
  return `${providerID}/${model}${suffix}`
}

// --- agent markdown --------------------------------------------------------

export type AgentRequest = {
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

/**
 * One agent the profile wants live, whatever declared it: an `agents` entry in
 * opencode.jsonc or a markdown file. The fields mirror the native
 * ConfigAgent.Info / Agent.Info contract; the transform applies the ones that
 * exist.
 */
export type AgentDefinition = {
  name: string
  description?: string
  mode?: string
  model?: string
  system?: string
  hidden?: boolean
  color?: string
  steps?: number
  disabled?: boolean
  permissions?: PermissionRule[]
  request?: AgentRequest
  /** Per-agent generation tuning, applied at runtime via the context hook. */
  temperature?: number
  reasoningEffort?: string
  textVerbosity?: string
}

const AGENT_MODES = new Set(["subagent", "primary", "all"])
export type AgentMode = "subagent" | "primary" | "all"

/** The agent mode, or undefined when the frontmatter value is not a V2 mode. */
export function agentMode(value: string | undefined): AgentMode | undefined {
  return value && (AGENT_MODES as Set<string>).has(value) ? (value as AgentMode) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

/** `Agent.Info.steps` is a positive integer; anything else would be rejected. */
function asPositiveInt(value: unknown): number | undefined {
  const parsed = asNumber(value)
  return parsed !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function asRequest(value: unknown): AgentRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const { headers, body } = value as Record<string, unknown>
  const out: AgentRequest = {}
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    const entries = Object.entries(headers as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    )
    if (entries.length) out.headers = Object.fromEntries(entries)
  }
  if (body && typeof body === "object" && !Array.isArray(body)) out.body = body as Record<string, unknown>
  return out.headers || out.body ? out : undefined
}

/** Case-insensitive key lookup for frontmatter written in either V1 or V2 casing. */
function pick(data: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (data[name] !== undefined) return data[name]
  }
  const lower = new Map(Object.keys(data).map((key) => [key.toLowerCase(), key]))
  for (const name of names) {
    const key = lower.get(name.toLowerCase())
    if (key !== undefined) return data[key]
  }
  return undefined
}

/**
 * Map a native agent shape (config entry or markdown frontmatter) onto the
 * fields the overlay can apply. Unknown keys are ignored, exactly as core does.
 */
function agentFromData(name: string, data: Record<string, unknown>, primary = false): AgentDefinition {
  const definition: AgentDefinition = { name }

  const description = asString(data.description)
  if (description) definition.description = description

  const mode = primary ? "primary" : asString(pick(data, "mode", "permission_mode"))
  if (mode) definition.mode = mode

  let model = modelDisplay(data.model)
  const variant = asString(data.variant)
  if (model && !model.includes("#") && variant) model = `${model}#${variant}`
  if (model) definition.model = model

  // The markdown body is the prompt. A frontmatter `system` or the legacy
  // `prompt` is the fallback when the body is empty.
  const system = asString(data.system) ?? asString(data.prompt)
  if (system) definition.system = system

  if (typeof data.hidden === "boolean") definition.hidden = data.hidden
  const color = asString(data.color)
  if (color) definition.color = color
  const steps = asPositiveInt(data.steps)
  if (steps !== undefined) definition.steps = steps
  if (typeof data.disabled === "boolean") definition.disabled = data.disabled

  const permissions = toPermissionRules(data.permissions)
  if (permissions.length) definition.permissions = permissions

  const request = asRequest(data.request)
  if (request) definition.request = request

  const temperature = asNumber(pick(data, "temperature"))
  if (temperature !== undefined) definition.temperature = temperature
  const reasoningEffort = asString(pick(data, "reasoningEffort", "reasoning_effort"))
  if (reasoningEffort) definition.reasoningEffort = reasoningEffort
  const textVerbosity = asString(pick(data, "textVerbosity", "text_verbosity"))
  if (textVerbosity) definition.textVerbosity = textVerbosity

  return definition
}

/**
 * Read the YAML frontmatter the way core's `ConfigMarkdown` does: the body is
 * the prompt, and every native agent field is honoured. A malformed document
 * still yields its body, so one bad frontmatter cannot hide the agent.
 */
export function parseAgentMarkdown(name: string, text: string, options: { primary?: boolean } = {}): AgentDefinition {
  const normalized = text.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  if (lines[0]?.trim() !== "---") {
    return { name, system: normalized.trim() || undefined }
  }

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i
      break
    }
  }
  if (end === -1) return { name, system: normalized.trim() || undefined }

  const frontmatter = lines.slice(1, end).join("\n")
  const body = lines.slice(end + 1).join("\n").trim()
  let data: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(frontmatter)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
  } catch {
    // Fall back to the scalar reader so a frontmatter quirk (an unquoted colon,
    // a leading tag) still yields the fields it can read.
    data = parseFrontmatterScalars(frontmatter)
  }

  const definition = agentFromData(name, data, options.primary === true)
  if (body) definition.system = body
  return definition
}

/** Minimal top-level scalar reader used only when YAML parsing fails. */
function parseFrontmatterScalars(frontmatter: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const line of frontmatter.split("\n")) {
    if (line.length === 0 || /^\s/.test(line)) continue
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const value = match[2].trim()
    if (value === "" || value === "|" || value === ">" || value.startsWith("[")) continue
    out[match[1]] = value.replace(/^["']|["']$/g, "")
  }
  return out
}

/**
 * Every markdown file under `dir`, recursively. `seen` holds real paths, so a
 * symlink loop cannot recurse until the stack overflows — a profile that would
 * not load is worse than one missing an agent.
 */
function markdownFiles(dir: string, seen = new Set<string>()): string[] {
  let real: string
  try {
    real = fs.realpathSync.native(dir)
  } catch {
    real = dir
  }
  if (seen.has(real)) return []
  seen.add(real)

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    let directory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try {
        directory = fs.statSync(full).isDirectory()
      } catch {
        continue
      }
    }
    if (directory) out.push(...markdownFiles(full, seen))
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full)
  }
  return out
}

/**
 * Agent markdown sources, in core's order: `agent/` and `agents/` are ordinary
 * agents, `mode/` and `modes/` force `mode: primary`. Files nest, and the name
 * is the path below the source directory (`agents/team/reviewer.md` is
 * `team/reviewer`). `.opencode/` is read too, so a profile can carry a
 * project-style tree.
 */
const AGENT_SOURCES = [
  { root: "agent", primary: false },
  { root: "agents", primary: false },
  { root: "mode", primary: true },
  { root: "modes", primary: true },
  { root: path.join(".opencode", "agent"), primary: false },
  { root: path.join(".opencode", "agents"), primary: false },
  { root: path.join(".opencode", "mode"), primary: true },
  { root: path.join(".opencode", "modes"), primary: true },
] as const

export function readAgents(directory: string): AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>()
  for (const source of AGENT_SOURCES) {
    const root = path.join(directory, source.root)
    for (const file of markdownFiles(root).sort()) {
      const name = path.relative(root, file).replaceAll("\\", "/").replace(/\.md$/, "")
      if (!name) continue
      try {
        byName.set(name, parseAgentMarkdown(name, fs.readFileSync(file, "utf8"), { primary: source.primary }))
      } catch {
        // Unreadable file: skip it, so one bad profile does not fail the rest.
      }
    }
  }
  return [...byName.values()]
}

/**
 * Agents declared as `agents` keys in the profile config. This is the other
 * native way to define an agent, and the only one that can carry a prompt
 * through `{file:...}` without a markdown file.
 */
export function configAgents(config: any): AgentDefinition[] {
  const agents = config?.agents
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return []
  const out: AgentDefinition[] = []
  for (const [name, value] of Object.entries(agents as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    out.push(agentFromData(name, value as Record<string, unknown>))
  }
  return out
}

/**
 * Merge a config definition over a file definition, keeping defined fields.
 * `permissions` and `request` accumulate instead of replacing: the file's rules
 * stay in force and the config entry's are appended, so under last-match-wins
 * the config entry still decides.
 */
export function mergeAgent(base: AgentDefinition | undefined, override: AgentDefinition): AgentDefinition {
  if (!base) return override
  const out: AgentDefinition = { ...base }
  for (const [key, value] of Object.entries(override) as Array<[keyof AgentDefinition, unknown]>) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value
  }
  if (base.permissions && override.permissions) {
    out.permissions = [...base.permissions, ...override.permissions]
  }
  if (base.request && override.request) {
    const headers = { ...base.request.headers, ...override.request.headers }
    const body = { ...base.request.body, ...override.request.body }
    out.request = {
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(Object.keys(body).length ? { body } : {}),
    }
  }
  return out
}

// --- permissions -----------------------------------------------------------

export type Effect = "allow" | "ask" | "deny"
export type PermissionRule = { action: string; resource: string; effect: Effect }

const EFFECTS = new Set<Effect>(["allow", "ask", "deny"])

/**
 * Read V2 permissions: an ordered array of {action, resource, effect}.
 * https://opencode.ai/v2/docs/config "Permissions"
 * A rule without a `resource` applies to every resource of its action.
 */
export function toPermissionRules(value: unknown): PermissionRule[] {
  const out: PermissionRule[] = []
  if (!Array.isArray(value)) return out
  for (const rule of value) {
    if (!rule || typeof rule !== "object") continue
    const { action, resource, effect } = rule as Record<string, unknown>
    if (typeof action !== "string") continue
    if (typeof effect !== "string" || !EFFECTS.has(effect as Effect)) continue
    out.push({
      action,
      resource: typeof resource === "string" && resource !== "" ? resource : "*",
      effect: effect as Effect,
    })
  }
  return out
}

/**
 * Compiled permission globs. `resolveEffect` runs on every tool decision, and a
 * profile's rule set is static between switches, so compiling the same pattern
 * once per decision is wasted work. The cache is bounded because patterns come
 * from user config: a pathological profile must not grow it without limit.
 */
const globCache = new Map<string, RegExp>()
const GLOB_CACHE_LIMIT = 256

function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern)
  if (cached) return cached
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  const compiled = new RegExp(`^${escaped}$`)
  if (globCache.size >= GLOB_CACHE_LIMIT) globCache.clear()
  globCache.set(pattern, compiled)
  return compiled
}

function matches(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value)
}

/**
 * Last matching rule wins, matching OpenCode's own ordered ruleset
 * (https://opencode.ai/v2/docs/permissions). A rule matches when its `action`
 * glob hits the evaluated action and its `resource` glob hits one of the
 * resources; an action with no resources is matched by `resource: "*"`.
 */
export function resolveEffect(
  rules: PermissionRule[],
  action: string,
  resources: readonly string[],
): Effect | undefined {
  let effect: Effect | undefined
  for (const rule of rules) {
    if (!matches(rule.action, action)) continue
    if (rule.resource !== "*") {
      if (resources.length === 0) continue
      if (!resources.some((resource) => matches(rule.resource, resource))) continue
    }
    effect = rule.effect
  }
  return effect
}

// --- mcp -------------------------------------------------------------------

/**
 * V2 nests servers under mcp.servers. Entries are passed through with the V1
 * `enabled` flag folded into the native `disabled` so a profile written in the
 * old shape still applies, and structurally invalid servers are skipped.
 */
export function mcpServers(config: any): Record<string, any> {
  const servers = config?.mcp?.servers
  if (!servers || typeof servers !== "object") return {}
  const out: Record<string, any> = {}
  for (const [name, value] of Object.entries(servers as Record<string, any>)) {
    if (!value || typeof value !== "object") continue
    const { enabled, ...rest } = value
    const server = enabled === false ? { ...rest, disabled: true } : rest
    const type =
      server.type ?? (Array.isArray(server.command) ? "local" : typeof server.url === "string" ? "remote" : undefined)
    if (type !== "local" && type !== "remote") continue
    if (type === "local" && !Array.isArray(server.command)) continue
    if (type === "remote" && typeof server.url !== "string") continue
    out[name] = { ...server, type }
  }
  return out
}

// --- references ------------------------------------------------------------

export type ReferenceSource =
  | { type: "local"; path: string; description?: string; hidden?: boolean }
  | { type: "git"; repository: string; branch?: string; description?: string; hidden?: boolean }

/**
 * V2 `references` entries declare a local path or a git repository without a
 * `type`; the source shape the editor wants adds one. Relative paths are
 * resolved against the *profile directory*, because that is the file that
 * declares them — a profile moved between machines keeps working, and `~` is
 * expanded the way config paths usually are.
 */
export function referenceSources(config: any, directory: string): Record<string, ReferenceSource> {
  const entries = config?.references
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return {}
  const out: Record<string, ReferenceSource> = {}
  for (const [name, value] of Object.entries(entries as Record<string, any>)) {
    if (!value || typeof value !== "object") continue
    const description = typeof value.description === "string" ? value.description : undefined
    const hidden = value.hidden === true ? true : undefined
    if (typeof value.repository === "string" && value.repository !== "") {
      out[name] = {
        type: "git",
        repository: value.repository,
        ...(typeof value.branch === "string" && value.branch !== "" ? { branch: value.branch } : {}),
        ...(description ? { description } : {}),
        ...(hidden ? { hidden } : {}),
      }
      continue
    }
    if (typeof value.path === "string" && value.path !== "") {
      const raw = value.path.startsWith("~/") ? path.join(os.homedir(), value.path.slice(2)) : value.path
      out[name] = {
        type: "local",
        path: path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(directory, raw),
        ...(description ? { description } : {}),
        ...(hidden ? { hidden } : {}),
      }
    }
  }
  return out
}

// --- websearch -------------------------------------------------------------

/** V2 accepts `false` (off) or `{ provider }`; anything else is not applied. */
export function websearchSelection(config: any): string | false | undefined {
  const value = config?.websearch
  if (value === false) return false
  if (value && typeof value === "object" && typeof value.provider === "string" && value.provider !== "")
    return value.provider
  return undefined
}

// --- field classification --------------------------------------------------
//
// The switcher only reads V2 shapes. At switch time it lints the profile config
// so nothing is silently applied or silently dropped.
//
// Source of truth: the Config contract the server itself serves
// (`opencode api get /openapi.json` -> Config.Info, 29 keys + $schema in 2.3.0)
// plus https://opencode.ai/v2/docs/config and /v2/docs/migrate-v1.

/** Native V2 top-level keys. */
const V2_TOP = new Set([
  "shell",
  "model",
  "default_agent",
  "update",
  "share",
  "enterprise",
  "username",
  "timezone",
  "permissions",
  "policies",
  "agents",
  "snapshots",
  "watcher",
  "formatter",
  "lsp",
  "media",
  "tool_output",
  "mcp",
  "compaction",
  "skills",
  "commands",
  "instructions",
  "references",
  "websearch",
  "plugins",
  "worktree",
  "warming",
  "providers",
  "experimental",
])

/** Keys the switcher applies live through plugin transforms. */
const APPLIED_LIVE = new Set(["agents", "default_agent", "model", "mcp", "permissions", "references", "websearch"])

/** V1 keys that have a native V2 name, and still work while unconverted. */
const ADAPTED_TOP: Record<string, string> = {
  autoupdate: 'native form: "update": "disable" | "notify" | "auto"',
  small_model: 'native form: "agents": { "title": { "model": … } }',
  enabled_providers: "native form: permissions rules",
  disabled_providers: "native form: permissions rules",
}

/** V1/unsupported keys V2 ignores, with the fix. */
const LEGACY_TOP: Record<string, string> = {
  agent: 'rename to "agents"',
  mode: 'rename to "agents" (entries become primary agents)',
  plugin: 'rename to "plugins"',
  permission: 'rename to "permissions" (array of { action, resource, effect })',
  tools: 'express through "permissions" (e.g. { action: "websearch", resource: "*", effect: "deny" })',
  provider: 'rename to "providers"; npm -> package "aisdk:<pkg>", api/options -> settings',
  command: 'rename to "commands"',
  reference: 'rename to "references"',
  autoshare: 'use "share": "auto"',
  snapshot: 'rename to "snapshots"',
  attachment: 'rename to "media"',
  subagent_depth: 'use "experimental": { "subagent_depth": n }',
  logLevel: "no config field — set OPENCODE_LOG_LEVEL when starting OpenCode",
  server: "no V2 equivalent — use the service and explicit server options",
  theme: "terminal-only — move to cli.json",
  keybinds: "terminal-only — move to cli.json",
}

/** V2 keeps this key but only accepts these members (/v2/docs/config). */
const V2_EXPERIMENTAL = new Set([
  "portable_shell_scanner",
  "all_flags",
  "part_rows",
  "image_generate",
  "subagent_depth",
  "location_idle_timeout",
  "artifacts",
  "background_compaction",
  "codemode_vm",
  "console_watches",
  "mcp_events",
  "media_blob",
  "schedules",
  "shell_timeout_background",
  "todo",
])
const LEGACY_EXPERIMENTAL: Record<string, string> = {
  policies: 'deprecated — use top-level "policies"',
  batch_tool: "no V2 equivalent — ignored",
  disable_paste_summary: "no V2 equivalent — ignored",
  continue_loop_on_deny: "no V2 equivalent — ignored",
  openTelemetry: "no V2 equivalent — ignored",
  primary_tools: "no V2 equivalent — ignored",
  mcp_timeout: 'use "mcp": { "timeout": { catalog, execution } }',
}

const LEGACY_COMPACTION: Record<string, string> = {
  prune: "no V2 equivalent — ignored",
  tail_turns: "no V2 equivalent — V2 keeps a token budget",
  preserve_recent_tokens: 'use "keep": { "tokens": n }',
  reserved: 'use "buffer": n',
}

const LEGACY_PROVIDER: Record<string, string> = {
  npm: 'use "package": "aisdk:<pkg>"',
  api: 'use "settings": { "baseURL": … }',
  options: 'split into "settings" / "headers" / "body"',
  id: "no V2 equivalent — ignored",
  whitelist: "no V2 equivalent — ignored",
  blacklist: "no V2 equivalent — ignored",
}

/** Legacy per-agent keys (opencode.ai/v2/docs/agents, /v2/docs/migrate-v1). */
const LEGACY_AGENT: Record<string, string> = {
  disable: 'use "disabled: true"',
  prompt: 'use "system"',
  permission: 'use "permissions" (array)',
  maxSteps: 'use "steps"',
  variant: 'fold into model: "provider/model#variant"',
  temperature: "put it in the agent's .md frontmatter (applied at runtime)",
  top_p: "use request.body, or the model/provider default",
  topP: "use request.body, or the model/provider default",
  reasoningEffort: "put it in the agent's .md frontmatter (applied at runtime)",
  textVerbosity: "put it in the agent's .md frontmatter (applied at runtime)",
  options: "use request.body / settings",
  tools: "not a V2 agent field",
  name: "not a V2 agent field — the map key is the id",
}

export type ProfileWarnings = {
  /** Applied live through plugin transforms. */
  applied: string[]
  /** Valid V2, but only take effect on a relaunch in that directory. */
  relaunch: string[]
  /** V1 keys OpenCode still normalizes, so they work but are not native. */
  adapted: string[]
  /** V1/legacy fields V2 ignores, each with the fix. */
  legacy: string[]
  /** Keys that match no known V2 field. */
  unknown: string[]
}

function lintNested(
  config: any,
  warnings: ProfileWarnings,
  path: string,
  allowed: Set<string>,
  legacy: Record<string, string>,
) {
  const value = config?.[path]
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  for (const field of Object.keys(value)) {
    if (legacy[field]) warnings.legacy.push(`${path}.${field} — ${legacy[field]}`)
    else if (!allowed.has(field)) warnings.unknown.push(`${path}.${field}`)
  }
}

export function classifyConfig(config: any): ProfileWarnings {
  const warnings: ProfileWarnings = { applied: [], relaunch: [], adapted: [], legacy: [], unknown: [] }
  if (!config || typeof config !== "object") return warnings

  for (const key of Object.keys(config)) {
    if (key === "$schema") continue
    if (APPLIED_LIVE.has(key)) {
      warnings.applied.push(key)
      continue
    }
    if (V2_TOP.has(key)) {
      warnings.relaunch.push(key)
      continue
    }
    if (ADAPTED_TOP[key]) {
      warnings.adapted.push(`${key} — ${ADAPTED_TOP[key]}`)
      continue
    }
    if (LEGACY_TOP[key]) {
      warnings.legacy.push(`${key} — ${LEGACY_TOP[key]}`)
      continue
    }
    warnings.unknown.push(key)
  }

  // Shape checks on keys that are valid but easy to write in the V1 shape.
  if (config.permissions !== undefined && !Array.isArray(config.permissions))
    warnings.legacy.push("permissions — must be an array of { action, resource, effect }")
  if (config.policies !== undefined && !Array.isArray(config.policies))
    warnings.legacy.push("policies — must be an array of { action, resource, effect }")
  if (config.skills !== undefined && !Array.isArray(config.skills))
    warnings.legacy.push('skills — combine "paths" and "urls" into one array')
  if (config.instructions !== undefined && !Array.isArray(config.instructions))
    warnings.legacy.push("instructions — must be an array of paths, globs or URLs")
  if (config.plugins !== undefined && !Array.isArray(config.plugins))
    warnings.legacy.push('plugins — must be an array of package names or { "package", "options" }')
  if (
    config.mcp &&
    typeof config.mcp === "object" &&
    !("servers" in config.mcp) &&
    Object.keys(config.mcp).some((key) => key !== "timeout")
  )
    warnings.legacy.push('mcp — nest servers under "mcp.servers"')

  lintNested(config, warnings, "experimental", V2_EXPERIMENTAL, LEGACY_EXPERIMENTAL)
  lintNested(config, warnings, "compaction", new Set(["auto", "keep", "buffer", "tokens"]), LEGACY_COMPACTION)

  // references / websearch are applied live, so a malformed entry is worth naming.
  for (const [name, value] of Object.entries((config.references ?? {}) as Record<string, any>)) {
    if (!value || typeof value !== "object" || (typeof value.path !== "string" && typeof value.repository !== "string"))
      warnings.unknown.push(`references.${name} — needs "path" or "repository"`)
  }
  if (config.websearch !== undefined && config.websearch !== false) {
    const provider = (config.websearch as Record<string, unknown>)?.provider
    if (typeof provider !== "string" || provider === "")
      warnings.legacy.push('websearch — use { "provider": "<id>" } or false')
  }

  // Provider entries keep the V1 shape easily; lint both container names.
  for (const key of ["providers", "provider"] as const) {
    for (const [id, provider] of Object.entries((config[key] ?? {}) as Record<string, any>)) {
      if (!provider || typeof provider !== "object") continue
      for (const field of Object.keys(provider)) {
        if (LEGACY_PROVIDER[field])
          warnings.legacy.push(`${key}.${id}.${field} — ${LEGACY_PROVIDER[field]}`)
      }
    }
  }

  // Legacy per-agent fields anywhere in the agents map.
  const seen = new Set<string>()
  for (const agent of Object.values((config.agents ?? {}) as Record<string, unknown>)) {
    if (!agent || typeof agent !== "object") continue
    for (const field of Object.keys(agent as Record<string, unknown>)) {
      if (LEGACY_AGENT[field] && !seen.has(field)) {
        seen.add(field)
        warnings.legacy.push(`agents.*.${field} — ${LEGACY_AGENT[field]}`)
      }
    }
  }

  return warnings
}

// --- profiles --------------------------------------------------------------

export type Profile = {
  name: string
  label: string
  description: string
  hidden: boolean
  directory: string
  /** The config file this profile was read from — what OPENCODE_CONFIG points at. */
  configFile: string
  config: any
  agents: AgentDefinition[]
  /** Agent names this profile declares: `.md` files plus `agents` config keys. */
  declaredAgents: string[]
  disabledAgents: string[]
  agentModels: Array<{ agent: string; model: string }>
  defaultAgent?: string
  defaultModel?: string
  permissions: PermissionRule[]
  mcpCount: number
  pluginCount: number
  /** Field classification surfaced as warnings at switch time. */
  warnings: ProfileWarnings
  /** Valid V2 keys that only take effect on a relaunch (warnings.relaunch). */
  restartNeeded: string[]
}

// --- startup layering ------------------------------------------------------

/**
 * Keys that need a restart are read once when a server starts. A profile
 * directory is not a launch target (`opencode <dir>` opens a *project*), but the
 * server does read one extra config document from `OPENCODE_CONFIG`, merged
 * above the global and project config — verified against a running 2.3.0 server.
 * So restarting the service with `OPENCODE_CONFIG=<profile>/opencode.jsonc`
 * applies the whole profile, including `plugins` and `providers`.
 *
 * Only the server knows its own environment, so it reports this verdict over
 * RPC (and echoes it into the handoff file for older clients).
 */

/** The command a manual restart needs, layered or un-layered. */
export function restartCommand(configFile: string | null): string {
  return configFile
    ? `OPENCODE_CONFIG=${JSON.stringify(configFile)} opencode service restart`
    : "opencode service restart"
}

/**
 * Canonical form of a config path for comparison. A service can be started with
 * a symlinked, relative or `~`-spelled path; comparing raw strings leaves the
 * restart marker stuck even though the layer is live.
 */
export function canonicalConfigPath(value: string): string {
  const expanded = expandHome(value.trim())
  const absolute = path.resolve(expanded)
  try {
    return fs.realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

function sameConfigPath(a: string, b: string): boolean {
  return canonicalConfigPath(a) === canonicalConfigPath(b)
}

export function startupInfo(configFile: string, relaunch: string[], env?: string): StartupInfo {
  if (relaunch.length === 0) return { kind: "none", keys: [] }
  if (env !== undefined && env.trim() !== "" && sameConfigPath(env, configFile))
    return { kind: "layered", keys: relaunch }
  return { kind: "pending", keys: relaunch, command: restartCommand(configFile) }
}

/**
 * The profile whose config file the server was started with, if any. Unlike
 * `startupInfo`, this answers even for a profile with no startup-only keys.
 */
export function layeredProfileName(
  profiles: ReadonlyArray<{ name: string; configFile: string }>,
  env?: string,
): string | null {
  if (!env || env.trim() === "") return null
  return profiles.find((profile) => sameConfigPath(profile.configFile, env))?.name ?? null
}

/**
 * Agent names that other profiles declare but the active one does not. Sessions
 * can still be bound to them, and a transform that simply stops registering an
 * agent makes it disappear, so the server keeps a hidden stub alive for each.
 * Names the base config already defines are excluded by the caller: those agents
 * have to come back untouched when a profile is removed.
 */
export function staleAgentNames(
  profiles: Array<{ declaredAgents: string[] }>,
  active?: { declaredAgents: string[] },
): string[] {
  const seen = new Set(active?.declaredAgents ?? [])
  const out: string[] = []
  for (const profile of profiles) {
    for (const name of profile.declaredAgents) {
      if (seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

// --- restart policy --------------------------------------------------------

/** Reads the durable preference, including the pre-1.4 boolean `askRestart`. */
export function normalizeRestartPolicy(stored: Record<string, unknown> | undefined): RestartPolicy {
  const value = stored?.restartPolicy
  if (value === "ask" || value === "always" || value === "never") return value
  if (stored?.askRestart === false) return "never"
  if (stored?.askRestart === true) return "ask"
  return "ask"
}

/**
 * Effective policy, including the 1.5 change of default to `always`.
 *
 * Before 1.5 the stored default was `ask`, so a stored `ask` from an older
 * install is indistinguishable from never having chosen anything: only an
 * explicit `always` / `never` (or the old `askRestart: false`) survives the
 * upgrade. Writing `policyVersion` on the first explicit choice pins it.
 */
export const POLICY_VERSION = 2

export function resolveRestartPolicy(stored: Record<string, unknown> | undefined): RestartPolicy {
  if (stored?.policyVersion === POLICY_VERSION) return normalizeRestartPolicy(stored)
  if (stored?.askRestart === false) return "never"
  const explicit = stored?.restartPolicy
  if (explicit === "always" || explicit === "never") return explicit
  return "always"
}

export function nextRestartPolicy(current: RestartPolicy): RestartPolicy {
  return current === "ask" ? "always" : current === "always" ? "never" : "ask"
}

/**
 * Environment for `opencode service restart`: the profile file layered in, or no
 * layering at all when returning to base config — which is the only way to
 * *remove* plugins, providers and friends a previous profile added.
 */
export function restartEnv(
  configFile: string | null,
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const next = { ...env }
  if (configFile) next.OPENCODE_CONFIG = configFile
  else delete next.OPENCODE_CONFIG
  return next
}

/** One-line label for a profile whose startup keys are not loaded yet. */
export function startupLabel(info: StartupInfo): string {
  if (info.kind === "layered") return "✓ startup loaded"
  if (info.kind === "pending") return `⟳ needs restart (${info.keys.length})`
  return ""
}

/**
 * The CLI used to bounce the shared background service. The TUI process *is* the
 * opencode binary in normal use, so prefer it; `OPENCODE_BIN` overrides for
 * wrappers that run the CLI through something else (bun, node, a shim).
 */
export function cliBinary(
  env: Record<string, string | undefined> = process.env,
  execPath: string = process.execPath,
): string {
  const configured = env.OPENCODE_BIN
  if (configured && configured.trim() !== "") return configured
  return path.basename(execPath).startsWith("opencode") ? execPath : "opencode"
}

const CONFIG_NAMES = ["opencode.jsonc", "opencode.json"]

/**
 * The global base config (opencode.jsonc / opencode.json). Read when switching
 * back to base so the session can be moved onto whatever agent/model the base
 * config itself defines (default_agent, agents.<name>.model, or top-level model).
 * OpenCode merges both files when present and .jsonc wins, so read in that order.
 */
export function readBaseConfig(): any | undefined {
  for (const name of CONFIG_NAMES) {
    const parsed = readConfigJsonc(path.join(globalConfigDir(), name))
    if (parsed && typeof parsed === "object") return parsed
  }
  return undefined
}

function summarize(config: any): string {
  const bits: string[] = []
  if (config.default_agent) bits.push(`agent ${config.default_agent}`)
  const model = modelDisplay(config.model)
  if (model) bits.push(`model ${model}`)
  return bits.join(" · ") || "config overlay"
}

export function loadProfiles(options: { includeHidden?: boolean } = {}): Profile[] {
  const root = profilesRoot()
  if (!fs.existsSync(root)) return []

  const found: Profile[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = path.join(root, entry.name)
    const file = CONFIG_NAMES.map((name) => path.join(directory, name)).find((name) => fs.existsSync(name))
    if (!file) continue

    // `{env:}` / `{file:}` substitution matches core, so an agent prompt can
    // live in prompts/<name>.md and still reach the transform as text.
    const config = readConfigJsonc(file)
    if (!config || typeof config !== "object") continue

    // Optional picker metadata; remove it to fall back to the derived summary.
    const meta = readJsonc(path.join(directory, "profile.jsonc")) ?? {}

    // V2 shapes only (opencode.ai/v2/docs/agents, /v2/docs/config). Anything in
    // a V1 shape is not read here; classifyConfig reports it instead.
    const warnings = classifyConfig(config)
    // Both native sources: markdown files and `agents` keys in the config. A
    // config entry wins per field, so a profile can ship the prompt as a file
    // and override just its model in opencode.jsonc.
    const merged = new Map<string, AgentDefinition>()
    for (const definition of readAgents(directory)) merged.set(definition.name, definition)
    for (const definition of configAgents(config)) {
      merged.set(definition.name, mergeAgent(merged.get(definition.name), definition))
    }
    const agents = [...merged.values()]
    const declaredAgents = agents.map((definition) => definition.name)

    found.push({
      name: entry.name,
      label: String(meta.label ?? entry.name),
      description: String(meta.description ?? summarize(config)),
      hidden: meta.hidden === true,
      directory,
      configFile: file,
      config,
      agents,
      declaredAgents,
      disabledAgents: agents.filter((definition) => definition.disabled).map((definition) => definition.name),
      agentModels: agents
        .filter((definition) => definition.model !== undefined)
        .map((definition) => ({ agent: definition.name, model: definition.model as string })),
      defaultAgent: typeof config.default_agent === "string" ? config.default_agent : undefined,
      defaultModel: modelDisplay(config.model),
      permissions: toPermissionRules(config.permissions),
      mcpCount: Object.keys(mcpServers(config)).length,
      pluginCount: Array.isArray(config.plugins) ? config.plugins.length : 0,
      warnings,
      restartNeeded: warnings.relaunch,
    })
  }

  const visible = options.includeHidden ? found : found.filter((profile) => !profile.hidden)
  return visible.sort((a, b) => a.label.localeCompare(b.label))
}
