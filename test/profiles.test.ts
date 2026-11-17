import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  POLICY_VERSION,
  RELAYER_ATTEMPTS,
  RELAYER_COOLDOWN_MS,
  RELAYER_RESET_MS,
  agentMode,
  canonicalConfigPath,
  classifyConfig,
  cliBinary,
  configAgents,
  claimRelayer,
  clearRelayer,
  expectedLayered,
  layeredProfileName,
  loadProfiles,
  mcpServers,
  mergeAgent,
  modelDisplay,
  modelRefFromConfig,
  nextRestartPolicy,
  normalizeRestartPolicy,
  parseAgentMarkdown,
  parseModelRef,
  readAgents,
  readConfigJsonc,
  readSelectionState,
  referenceSources,
  restartCommand,
  restartEnv,
  resolveRestartPolicy,
  resolveEffect,
  serviceConfigFile,
  staleAgentNames,
  startupInfo,
  startupLabel,
  substituteConfigText,
  toPermissionRules,
  websearchSelection,
  writePolicy,
  writeSelection,
  writeServiceEnv,
} from "../src/profiles.ts"

describe("parseModelRef", () => {
  test("splits provider, model and variant", () => {
    // Fields are effect brands, so compare through String().
    const ref = parseModelRef("anthropic/claude-sonnet-4-5")
    expect(String(ref?.providerID)).toBe("anthropic")
    expect(String(ref?.id)).toBe("claude-sonnet-4-5")
    expect(ref?.variant).toBeUndefined()

    const withVariant = parseModelRef("openai/gpt-5.4#high")
    expect(String(withVariant?.id)).toBe("gpt-5.4")
    expect(String(withVariant?.variant)).toBe("high")
  })

  test("rejects refs without a provider", () => {
    expect(parseModelRef("gpt-5.4")).toBeUndefined()
    expect(parseModelRef("/gpt-5.4")).toBeUndefined()
    expect(parseModelRef("openai/")).toBeUndefined()
    expect(parseModelRef("")).toBeUndefined()
  })
})

describe("modelRefFromConfig", () => {
  test("reads both the string and the object form", () => {
    expect(String(modelRefFromConfig("anthropic/claude#high")?.id)).toBe("claude")
    const object = modelRefFromConfig({ providerID: "openai", model: "gpt-5.4", variant: "low" })
    expect(String(object?.providerID)).toBe("openai")
    expect(String(object?.id)).toBe("gpt-5.4")
    expect(String(object?.variant)).toBe("low")
    expect(modelRefFromConfig({ providerID: "openai", model: "gpt-5.4" })?.variant).toBeUndefined()
  })

  test("rejects malformed values instead of throwing", () => {
    expect(modelRefFromConfig(undefined)).toBeUndefined()
    expect(modelRefFromConfig({})).toBeUndefined()
    expect(modelRefFromConfig({ providerID: "", model: "x" })).toBeUndefined()
    expect(modelRefFromConfig({ providerID: "x", model: "" })).toBeUndefined()
    expect(modelRefFromConfig("nope")).toBeUndefined()
  })

  test("modelDisplay renders the canonical string", () => {
    expect(modelDisplay("anthropic/claude#high")).toBe("anthropic/claude#high")
    expect(modelDisplay({ providerID: "openai", model: "gpt-5.4", variant: "low" })).toBe("openai/gpt-5.4#low")
    expect(modelDisplay({ providerID: "openai", model: "gpt-5.4" })).toBe("openai/gpt-5.4")
    expect(modelDisplay("")).toBeUndefined()
    expect(modelDisplay({})).toBeUndefined()
  })
})

describe("toPermissionRules", () => {
  test("defaults a missing resource to every resource of the action", () => {
    expect(toPermissionRules([{ action: "edit", effect: "deny" }])).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
    ])
  })

  test("keeps order and drops malformed entries", () => {
    const rules = toPermissionRules([
      { action: "shell", resource: "git *", effect: "allow" },
      { action: "shell", resource: "git push *", effect: "ask" },
      { action: "read", resource: "*", effect: "maybe" },
      { resource: "*", effect: "deny" },
      "nope",
    ])
    expect(rules).toHaveLength(2)
    expect(rules[1]).toEqual({ action: "shell", resource: "git push *", effect: "ask" })
  })

  test("ignores non-arrays", () => {
    expect(toPermissionRules({ bash: "allow" })).toEqual([])
    expect(toPermissionRules(undefined)).toEqual([])
  })
})

describe("resolveEffect", () => {
  const rules = toPermissionRules([
    { action: "shell", resource: "git *", effect: "allow" },
    { action: "shell", resource: "git push *", effect: "ask" },
    { action: "edit", resource: "*", effect: "deny" },
  ])

  test("matches the resource, not just the action", () => {
    // The V1 -> V2 trap: { action: "shell", resource: "git push *" } must not
    // apply to every shell command.
    expect(resolveEffect(rules, "shell", ["rm -rf build"])).toBeUndefined()
    expect(resolveEffect(rules, "shell", ["git push origin main"])).toBe("ask")
    expect(resolveEffect(rules, "shell", ["git status"])).toBe("allow")
  })

  test("last matching rule wins, like OpenCode's ordered ruleset", () => {
    const ordered = toPermissionRules([
      { action: "shell", resource: "*", effect: "deny" },
      { action: "shell", resource: "git *", effect: "allow" },
    ])
    expect(resolveEffect(ordered, "shell", ["git push"])).toBe("allow")
    expect(resolveEffect(ordered, "shell", ["curl https://example.com"])).toBe("deny")

    const reversed = toPermissionRules([
      { action: "shell", resource: "git *", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
    ])
    expect(resolveEffect(reversed, "shell", ["git push"])).toBe("deny")
  })

  test("resource: '*' matches actions with no resources", () => {
    expect(resolveEffect(rules, "edit", [])).toBe("deny")
    expect(resolveEffect(rules, "read", [])).toBeUndefined()
  })

  test("a specific resource never matches an action with no resources", () => {
    expect(resolveEffect(rules, "shell", [])).toBeUndefined()
  })

  test("wildcards span path segments", () => {
    const scoped = toPermissionRules([{ action: "read", resource: "/tmp/**", effect: "allow" }])
    expect(resolveEffect(scoped, "read", ["/tmp/a/b/c.txt"])).toBe("allow")
    expect(resolveEffect(scoped, "read", ["/etc/passwd"])).toBeUndefined()
  })

  test("regex metacharacters in a pattern are literal", () => {
    const literal = toPermissionRules([{ action: "read", resource: "a+b.txt", effect: "deny" }])
    expect(resolveEffect(literal, "read", ["a+b.txt"])).toBe("deny")
    expect(resolveEffect(literal, "read", ["aab.txt"])).toBeUndefined()
  })
})

describe("classifyConfig", () => {
  test("separates what is applied live from what needs a relaunch", () => {
    const w = classifyConfig({
      $schema: "https://opencode.ai/config.json",
      agents: { coder: { model: "openai/gpt-5.4" } },
      default_agent: "coder",
      model: "anthropic/claude-sonnet-4-5",
      mcp: { servers: { docs: { type: "remote", url: "https://mcp.example.com" } } },
      permissions: [{ action: "edit", resource: "*", effect: "deny" }],
      compaction: { auto: false },
      providers: { acme: { package: "aisdk:@ai-sdk/openai", settings: { baseURL: "https://x/v1" } } },
      update: "auto",
      worktree: { directory: "../trees" },
      websearch: { provider: "random" },
      enterprise: { url: "https://x" },
    })
    expect(w.applied.sort()).toEqual([
      "agents",
      "default_agent",
      "mcp",
      "model",
      "permissions",
      "websearch",
    ])
    expect(w.relaunch.sort()).toEqual(["compaction", "enterprise", "providers", "update", "worktree"])
    expect(w.legacy).toEqual([])
    expect(w.unknown).toEqual([])
    expect(w.adapted).toEqual([])
  })

  test("reports V1 keys that are ignored, with the fix", () => {
    const w = classifyConfig({
      agent: { coder: { disable: true, prompt: "hi", variant: "high" } },
      plugin: ["x"],
      permission: { bash: "allow" },
      provider: { acme: { npm: "@ai-sdk/openai", api: "https://x/v1", options: {} } },
      tools: { websearch: false },
      autoshare: true,
      snapshot: false,
      attachment: { image: {} },
      command: { review: { template: "x" } },
      reference: { docs: "../docs" },
      subagent_depth: 2,
      logLevel: "DEBUG",
      server: { port: 1 },
      theme: { name: "system" },
    })
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining('agent — rename to "agents"')]))
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("subagent_depth")]))
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("theme")]))
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("provider.acme.npm")]))
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("provider.acme.api")]))
    expect(w.unknown).toEqual([])
  })

  test("V1 keys OpenCode still normalizes are reported as adapted, not ignored", () => {
    const w = classifyConfig({ autoupdate: true, small_model: "openai/gpt-5-nano" })
    expect(w.adapted).toHaveLength(2)
    expect(w.legacy).toEqual([])
    expect(w.relaunch).toEqual([])
  })

  test("lints nested experimental and compaction members", () => {
    const w = classifyConfig({
      experimental: { subagent_depth: 2, portable_shell_scanner: true, batch_tool: true, bogus: 1 },
      compaction: { auto: false, prune: false, preserve_recent_tokens: 8000 },
    })
    expect(w.relaunch).toContain("experimental")
    expect(w.relaunch).toContain("compaction")
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("experimental.batch_tool")]))
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("compaction.preserve_recent_tokens")]))
    expect(w.unknown).toEqual(["experimental.bogus"])
  })

  test("flags V1-shaped mcp and skills containers", () => {
    const w = classifyConfig({
      mcp: { docs: { type: "remote", url: "https://x", enabled: true } },
      skills: { paths: ["./team-skills"] },
    })
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining('mcp — nest servers under "mcp.servers"')]))
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("skills — combine")]))
  })

  test("mcp.timeout alone is native, not a V1 container", () => {
    const w = classifyConfig({ mcp: { timeout: { execution: 30_000 } } })
    expect(w.legacy).toEqual([])
    expect(w.unknown).toEqual([])
  })

  test("names malformed references and websearch entries", () => {
    const w = classifyConfig({
      references: { good: { path: "/x" }, bad: { description: "no source" } },
      websearch: "exa",
    })
    expect(w.applied).toEqual(expect.arrayContaining(["references", "websearch"]))
    expect(w.unknown).toEqual(expect.arrayContaining(['references.bad — needs "path" or "repository"']))
    expect(w.legacy).toEqual(expect.arrayContaining(['websearch — use { "provider": "<id>" } or false']))
  })

  test("an empty config produces no warnings", () => {
    expect(classifyConfig({})).toEqual({ applied: [], relaunch: [], adapted: [], legacy: [], unknown: [] })
    expect(classifyConfig(undefined).applied).toEqual([])
  })

  test("2.3.0 top-level keys are native, not unknown", () => {
    const w = classifyConfig({
      timezone: "Europe/Copenhagen",
      policies: [{ action: "provider.use", resource: "*", effect: "deny" }],
      skills: ["./team-skills"],
      instructions: ["AGENTS.md"],
      plugins: ["opencode-example"],
    })
    expect(w.relaunch.sort()).toEqual(["instructions", "plugins", "policies", "skills", "timezone"])
    expect(w.unknown).toEqual([])
    expect(w.legacy).toEqual([])
  })

  test("experimental.policies is reported as deprecated, not unknown", () => {
    const w = classifyConfig({ experimental: { policies: [], todo: true } })
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("experimental.policies")]))
    expect(w.unknown).toEqual([])
  })

  test("2.3.0 experimental flags are native", () => {
    const w = classifyConfig({
      experimental: { mcp_events: true, shell_timeout_background: true, codemode_vm: false },
    })
    expect(w.unknown).toEqual([])
    expect(w.legacy).toEqual([])
    expect(w.relaunch).toEqual(["experimental"])
  })

  test("flags V1-shaped policies, instructions and plugins containers", () => {
    const w = classifyConfig({
      policies: { deny: true },
      instructions: "AGENTS.md",
      plugins: { package: "x" },
    })
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("policies — must be an array")]))
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("instructions — must be an array")]))
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("plugins — must be an array")]))
  })
})

describe("mcpServers", () => {
  test("reads V2 servers and infers the type", () => {
    const servers = mcpServers({
      mcp: {
        servers: {
          tool: { command: ["bunx", "x"] },
          docs: { url: "https://mcp.example.com" },
        },
      },
    })
    expect(servers.tool?.type).toBe("local")
    expect(servers.docs?.type).toBe("remote")
  })

  test("folds the V1 enabled flag into the native disabled one", () => {
    const servers = mcpServers({
      mcp: { servers: { off: { type: "remote", url: "https://x", enabled: false } } },
    })
    expect(servers.off).toEqual({ type: "remote", url: "https://x", disabled: true })
  })

  test("drops structurally invalid servers and flat V1 containers", () => {
    const servers = mcpServers({
      mcp: {
        servers: {
          ok: { type: "local", command: ["x"] },
          noCommand: { type: "local" },
          noUrl: { type: "remote" },
          notAnObject: "x",
        },
      },
    })
    expect(Object.keys(servers)).toEqual(["ok"])
    expect(mcpServers({ mcp: { docs: { type: "remote", url: "https://x" } } })).toEqual({})
    expect(mcpServers({})).toEqual({})
  })
})

describe("referenceSources", () => {
  const root = "/home/you/.config/opencode/profiles/deep"

  test("infers local and git sources from the shorthand config shape", () => {
    const sources = referenceSources(
      {
        references: {
          docs: { path: "/workspace/product-docs", description: "Product behaviour" },
          spec: { repository: "acme/standards", branch: "main", hidden: true },
        },
      },
      root,
    )
    expect(sources.docs).toEqual({ type: "local", path: "/workspace/product-docs", description: "Product behaviour" })
    expect(sources.spec).toEqual({ type: "git", repository: "acme/standards", branch: "main", hidden: true })
  })

  test("resolves relative paths against the profile directory and expands ~", async () => {
    const os = await import("node:os")
    const nodePath = await import("node:path")
    const sources = referenceSources({ references: { shared: { path: "../docs" }, dot: { path: "~/notes" } } }, root)
    expect(sources.shared?.type === "local" && sources.shared.path).toBe(
      "/home/you/.config/opencode/profiles/docs",
    )
    expect(sources.dot?.type === "local" && sources.dot.path).toBe(
      nodePath.join(os.homedir(), "notes"),
    )
  })

  test("skips entries with neither path nor repository", () => {
    const sources = referenceSources(
      { references: { ok: { path: "/x" }, nope: { description: "nothing" }, str: "text", empty: { path: "" } } },
      root,
    )
    expect(Object.keys(sources)).toEqual(["ok"])
    expect(referenceSources({}, root)).toEqual({})
    expect(referenceSources({ references: ["x"] }, root)).toEqual({})
  })
})

describe("websearchSelection", () => {
  test("reads the provider id, false to disable, and nothing else", () => {
    expect(websearchSelection({ websearch: { provider: "random" } })).toBe("random")
    expect(websearchSelection({ websearch: false })).toBe(false)
    expect(websearchSelection({ websearch: { provider: "" } })).toBeUndefined()
    expect(websearchSelection({ websearch: "exa" })).toBeUndefined()
    expect(websearchSelection({})).toBeUndefined()
  })
})

describe("startupInfo", () => {
  const config = "/home/you/.config/opencode/profiles/deep/opencode.jsonc"

  test("a profile with no startup-only keys needs nothing", () => {
    expect(startupInfo(config, [])).toEqual({ kind: "none", keys: [] })
  })

  test("pending startup keys carry the exact restart command", () => {
    const info = startupInfo(config, ["plugins", "compaction"])
    expect(info.kind).toBe("pending")
    expect(info.keys).toEqual(["plugins", "compaction"])
    expect(info.command).toBe(`OPENCODE_CONFIG="${config}" opencode service restart`)
  })

  test("layered when the server was started with this profile", () => {
    expect(startupInfo(config, ["plugins"], config).kind).toBe("layered")
    // same file, spelled differently
    expect(startupInfo(config, ["plugins"], "/home/you/.config/opencode/profiles/deep/../deep/opencode.jsonc").kind).toBe(
      "layered",
    )
  })

  test("another profile layered in still counts as pending", () => {
    const info = startupInfo(config, ["plugins"], "/home/you/.config/opencode/profiles/fast/opencode.jsonc")
    expect(info.kind).toBe("pending")
  })

  test("an empty env value is not a layered profile", () => {
    expect(startupInfo(config, ["plugins"], "").kind).toBe("pending")
  })

  test("expectedLayered reports the profile the handoff says should be layered", () => {
    expect(expectedLayered({ profile: "deep", startup: { kind: "layered", keys: ["plugins"] } })).toBe("deep")
    expect(expectedLayered({ profile: "deep", startup: { kind: "pending", keys: ["plugins"] } })).toBeNull()
    expect(expectedLayered({ profile: "deep" })).toBeNull()
    expect(expectedLayered({ profile: null })).toBeNull()
  })

  test("startupLabel renders the badge text", () => {
    expect(startupLabel(startupInfo(config, ["plugins", "lsp"]))).toBe("⟳ needs restart (2)")
    expect(startupLabel(startupInfo(config, ["plugins"], config))).toBe("✓ startup loaded")
    expect(startupLabel(startupInfo(config, []))).toBe("")
  })

  test("layeredProfileName answers even when the profile has no startup keys", () => {
    const profiles = [
      { name: "deep", configFile: "/p/deep/opencode.jsonc" },
      { name: "fast", configFile: "/p/fast/opencode.jsonc" },
    ]
    expect(layeredProfileName(profiles, "/p/deep/opencode.jsonc")).toBe("deep")
    expect(layeredProfileName(profiles, "/p/deep/../deep/opencode.jsonc")).toBe("deep")
    expect(layeredProfileName(profiles, "/p/other/opencode.jsonc")).toBeNull()
    expect(layeredProfileName(profiles, undefined)).toBeNull()
    expect(layeredProfileName(profiles, "")).toBeNull()
  })
})

describe("shared selection state", () => {
  const withConfig = (fn: (dir: string) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-switcher-"))
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = dir
    try {
      fn(dir)
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  test("writeSelection preserves the policy and writePolicy preserves the profile", () => {
    withConfig(() => {
      writePolicy("never")
      writeSelection("deep", "session-1", { kind: "pending", keys: ["plugins"], command: "restart" })

      const state = readSelectionState()
      expect(state.profile).toBe("deep")
      expect(state.sessionID).toBe("session-1")
      expect(state.policy).toBe("never")
      expect(state.startup).toEqual({ kind: "pending", keys: ["plugins"], command: "restart" })

      writePolicy("ask")
      const after = readSelectionState()
      expect(after.profile).toBe("deep")
      expect(after.sessionID).toBe("session-1")
      expect(after.policy).toBe("ask")
    })
  })

  test("switching to base keeps the policy", () => {
    withConfig(() => {
      writePolicy("always")
      writeSelection(null)
      const state = readSelectionState()
      expect(state.profile).toBeNull()
      expect(state.policy).toBe("always")
    })
  })

  test("claimRelayer hands out one attempt at a time and stops after three", () => {
    withConfig(() => {
      writeSelection("deep", undefined, { kind: "layered", keys: ["plugins"] })

      expect(claimRelayer("deep", 1_000)).toBe(true)
      // Two clients on the same snapshot: only the first gets the token.
      expect(claimRelayer("deep", 1_001)).toBe(false)
      // The cooldown expires.
      expect(claimRelayer("deep", 1_000 + RELAYER_COOLDOWN_MS)).toBe(true)
      expect(claimRelayer("deep", 1_000 + RELAYER_COOLDOWN_MS * 2)).toBe(true)
      // Three attempts is the cap, however long the client waits.
      expect(claimRelayer("deep", 1_000 + RELAYER_COOLDOWN_MS * 10)).toBe(false)
      expect(readSelectionState().relayer).toMatchObject({ profile: "deep", attempts: RELAYER_ATTEMPTS })
    })
  })

  test("writeServiceEnv keeps the layer in the service config and preserves the rest", () => {
    withConfig(() => {
      const file = serviceConfigFile()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ password: "secret", remote: { route: "abc" } }))

      writeServiceEnv("/profiles/deep/opencode.jsonc")
      const written = JSON.parse(fs.readFileSync(file, "utf8"))
      expect(written.password).toBe("secret")
      expect(written.remote).toEqual({ route: "abc" })
      expect(written.env.OPENCODE_CONFIG).toBe("/profiles/deep/opencode.jsonc")

      // A second call with the same value is a no-op, not a rewrite.
      const before = fs.statSync(file).mtimeMs
      writeServiceEnv("/profiles/deep/opencode.jsonc")
      expect(fs.statSync(file).mtimeMs).toBe(before)

      writeServiceEnv(null)
      const cleared = JSON.parse(fs.readFileSync(file, "utf8"))
      expect(cleared.env).toBeUndefined()
      expect(cleared.password).toBe("secret")
    })
  })

  test("writeServiceEnv leaves a malformed service config alone", () => {
    withConfig(() => {
      const file = serviceConfigFile()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, "{ not json")
      writeServiceEnv("/profiles/deep/opencode.jsonc")
      expect(fs.readFileSync(file, "utf8")).toBe("{ not json")
    })
  })

  test("clearRelayer gives the attempts back once the layer has stayed up", () => {
    withConfig(() => {
      writeSelection("deep", undefined, { kind: "layered", keys: ["plugins"] })
      claimRelayer("deep", 1_000)
      claimRelayer("deep", 1_000 + RELAYER_COOLDOWN_MS)
      expect(readSelectionState().relayer?.attempts).toBe(2)

      clearRelayer()
      expect(readSelectionState().relayer).toBeUndefined()
      // A fresh incident starts from zero again.
      expect(claimRelayer("deep", 1_000 + RELAYER_COOLDOWN_MS * 2)).toBe(true)
      expect(readSelectionState().relayer?.attempts).toBe(1)
    })
  })

  test("a switch starts the attempts over", () => {
    withConfig(() => {
      writeSelection("deep", undefined, { kind: "layered", keys: ["plugins"] })
      claimRelayer("deep", 1_000)
      expect(readSelectionState().relayer?.attempts).toBe(1)

      writeSelection("fast", undefined, { kind: "layered", keys: ["plugins"] })
      expect(readSelectionState().relayer).toBeUndefined()
      expect(claimRelayer("fast", 1_001)).toBe(true)
    })
  })

  test("a quiet stretch starts a new incident", () => {
    withConfig(() => {
      writeSelection("deep", undefined, { kind: "layered", keys: ["plugins"] })
      const first = 1_000
      for (let i = 0; i < RELAYER_ATTEMPTS; i++) claimRelayer("deep", first + i * RELAYER_COOLDOWN_MS)
      const last = first + (RELAYER_ATTEMPTS - 1) * RELAYER_COOLDOWN_MS
      expect(claimRelayer("deep", last + RELAYER_COOLDOWN_MS)).toBe(false)
      // The layer stayed up long enough that the next drop is a new incident.
      expect(claimRelayer("deep", last + RELAYER_RESET_MS + 1)).toBe(true)
      expect(readSelectionState().relayer?.attempts).toBe(1)
    })
  })

  test("loadProfiles reads the object model form", () => {
    withConfig((dir) => {
      const profileDir = path.join(dir, "opencode", "profiles", "deep")
      fs.mkdirSync(profileDir, { recursive: true })
      fs.writeFileSync(
        path.join(profileDir, "opencode.jsonc"),
        JSON.stringify({
          model: { providerID: "anthropic", model: "claude", variant: "high" },
          agents: { reviewer: { model: { providerID: "openai", model: "gpt-5.4", variant: "low" } } },
        }),
      )

      const profiles = loadProfiles()
      expect(profiles).toHaveLength(1)
      expect(profiles[0].defaultModel).toBe("anthropic/claude#high")
      expect(profiles[0].agentModels).toEqual([{ agent: "reviewer", model: "openai/gpt-5.4#low" }])
    })
  })

  test("loadProfiles merges config agents with markdown agents", () => {
    withConfig((dir) => {
      const profileDir = path.join(dir, "opencode", "profiles", "ocO")
      fs.mkdirSync(path.join(profileDir, "agents"), { recursive: true })
      fs.writeFileSync(
        path.join(profileDir, "agents", "explore.md"),
        "---\nmode: subagent\n---\nexplore prompt",
      )
      fs.writeFileSync(
        path.join(profileDir, "opencode.jsonc"),
        JSON.stringify({
          default_agent: "lead",
          agents: {
            lead: { system: "lead prompt", mode: "primary", model: "a/b", color: "#fff" },
            explore: { model: "c/d", hidden: true },
            plan: { disabled: true },
          },
        }),
      )

      const [profile] = loadProfiles()
      expect(profile.agents.find((agent) => agent.name === "lead")).toMatchObject({
        system: "lead prompt",
        mode: "primary",
        model: "a/b",
        color: "#fff",
      })
      // The config model and hidden flag win; the markdown body stays the prompt.
      expect(profile.agents.find((agent) => agent.name === "explore")).toMatchObject({
        system: "explore prompt",
        model: "c/d",
        hidden: true,
      })
      expect(profile.disabledAgents).toEqual(["plan"])
      expect(profile.declaredAgents.sort()).toEqual(["explore", "lead", "plan"])
    })
  })
})

describe("cliBinary", () => {
  test("OPENCODE_BIN wins", () => {
    expect(cliBinary({ OPENCODE_BIN: "/wrappers/oc" }, "/usr/local/bin/opencode")).toBe("/wrappers/oc")
    expect(cliBinary({ OPENCODE_BIN: "   " }, "/usr/local/bin/opencode")).toBe("/usr/local/bin/opencode")
  })

  test("uses the running binary when it is the opencode CLI, else PATH", () => {
    expect(cliBinary({}, "/Users/you/.local/bin/opencode")).toBe("/Users/you/.local/bin/opencode")
    expect(cliBinary({}, "/opt/opencode/opencode.exe")).toBe("/opt/opencode/opencode.exe")
    expect(cliBinary({}, "/usr/local/bin/bun")).toBe("opencode")
    expect(cliBinary({}, "/usr/local/bin/node")).toBe("opencode")
  })
})

describe("staleAgentNames", () => {
  const fast = { declaredAgents: ["scout", "coder"] }
  const deep = { declaredAgents: ["architect", "explorer"] }

  test("lists names the active profile does not define", () => {
    expect(staleAgentNames([fast, deep], deep)).toEqual(["scout", "coder"])
  })

  test("with no active profile every declared name is a candidate", () => {
    expect(staleAgentNames([fast, deep])).toEqual(["scout", "coder", "architect", "explorer"])
  })

  test("deduplicates across profiles", () => {
    expect(staleAgentNames([fast, { declaredAgents: ["coder", "scribe"] }], fast)).toEqual(["scribe"])
  })

  test("an empty active profile leaves everything", () => {
    expect(staleAgentNames([fast], { declaredAgents: [] })).toEqual(["scout", "coder"])
  })
})

describe("restart policy", () => {
  test("normalizes the pre-1.4 boolean preference", () => {
    expect(normalizeRestartPolicy({})).toBe("ask")
    expect(normalizeRestartPolicy(undefined)).toBe("ask")
    expect(normalizeRestartPolicy({ askRestart: false })).toBe("never")
    expect(normalizeRestartPolicy({ askRestart: true })).toBe("ask")
    expect(normalizeRestartPolicy({ askRestart: false, restartPolicy: "always" })).toBe("always")
    expect(normalizeRestartPolicy({ restartPolicy: "bogus", askRestart: false })).toBe("never")
  })

  test("cycles ask -> always -> never", () => {
    expect(nextRestartPolicy("ask")).toBe("always")
    expect(nextRestartPolicy("always")).toBe("never")
    expect(nextRestartPolicy("never")).toBe("ask")
  })

  test("1.5 defaults to always when the stored value is an older default", () => {
    expect(resolveRestartPolicy(undefined)).toBe("always")
    expect(resolveRestartPolicy({})).toBe("always")
    // pre-1.5 wrote "ask" as the default, which is not a choice
    expect(resolveRestartPolicy({ restartPolicy: "ask" })).toBe("always")
    expect(resolveRestartPolicy({ policyVersion: 1, restartPolicy: "ask" })).toBe("always")
  })

  test("an explicit choice survives the default change", () => {
    expect(resolveRestartPolicy({ askRestart: false })).toBe("never")
    expect(resolveRestartPolicy({ restartPolicy: "never" })).toBe("never")
    expect(resolveRestartPolicy({ restartPolicy: "always" })).toBe("always")
  })

  test("versioned preferences are authoritative", () => {
    expect(resolveRestartPolicy({ policyVersion: POLICY_VERSION, restartPolicy: "ask" })).toBe("ask")
    expect(resolveRestartPolicy({ policyVersion: POLICY_VERSION, restartPolicy: "never" })).toBe("never")
    expect(resolveRestartPolicy({ policyVersion: POLICY_VERSION })).toBe("ask")
  })

  test("restartCommand covers both directions", () => {
    expect(restartCommand("/p/deep/opencode.jsonc")).toBe(
      'OPENCODE_CONFIG="/p/deep/opencode.jsonc" opencode service restart',
    )
    // no file means the layer has to go, and the bare command does exactly that
    expect(restartCommand(null)).toBe("opencode service restart")
  })

  test("reverting to base must not inherit the layered file", () => {
    const base = { PATH: "/usr/bin", OPENCODE_CONFIG: "/old/profile/opencode.jsonc" }
    const layered = restartEnv("/new/profile/opencode.jsonc", base)
    expect(layered.OPENCODE_CONFIG).toBe("/new/profile/opencode.jsonc")
    expect(layered.PATH).toBe("/usr/bin")

    const cleared = restartEnv(null, base)
    expect("OPENCODE_CONFIG" in cleared).toBe(false)
    // the caller's env object is never mutated
    expect(base.OPENCODE_CONFIG).toBe("/old/profile/opencode.jsonc")
  })
})

describe("agent markdown", () => {
  test("reads scalars from frontmatter and uses the body as the system prompt", () => {
    const agent = parseAgentMarkdown(
      "coder",
      [
        "---",
        "description: Ships changes",
        "mode: subagent",
        "model: openai/gpt-5.4#high",
        "temperature: 0.2",
        "reasoningEffort: low",
        "permissions:",
        "  edit: deny",
        "---",
        "Body instructions.",
      ].join("\n"),
    )
    expect(agent.description).toBe("Ships changes")
    expect(agent.mode).toBe("subagent")
    expect(agent.model).toBe("openai/gpt-5.4#high")
    expect(agent.temperature).toBe(0.2)
    expect(agent.reasoningEffort).toBe("low")
    expect(agent.system).toContain("Body instructions")
  })

  test("treats a file without frontmatter as a plain prompt", () => {
    expect(parseAgentMarkdown("plain", "Just instructions").system).toBe("Just instructions")
    expect(parseAgentMarkdown("plain", "Just instructions").name).toBe("plain")
  })

  test("ignores a non-numeric temperature", () => {
    expect(parseAgentMarkdown("x", "---\ntemperature: warm\n---\nbody").temperature).toBeUndefined()
  })

  test("agentMode only accepts V2 modes", () => {
    expect(agentMode("primary")).toBe("primary")
    expect(agentMode("subagent")).toBe("subagent")
    expect(agentMode("all")).toBe("all")
    expect(agentMode("orchestrator")).toBeUndefined()
    expect(agentMode(undefined)).toBeUndefined()
  })
})

describe("agent definitions", () => {
  test("config agents carry every native field", () => {
    const [lead] = configAgents({
      agents: {
        lead: {
          description: "d",
          system: "prompt",
          mode: "primary",
          model: { providerID: "anthropic", model: "claude", variant: "high" },
          hidden: true,
          color: "#fff",
          steps: 12,
          disabled: true,
          permissions: [{ action: "edit", resource: "**", effect: "deny" }],
          request: { headers: { "x-y": "z" }, body: { temperature: 0.2 } },
        },
      },
    })
    expect(lead).toEqual({
      name: "lead",
      description: "d",
      system: "prompt",
      mode: "primary",
      model: "anthropic/claude#high",
      hidden: true,
      color: "#fff",
      steps: 12,
      disabled: true,
      permissions: [{ action: "edit", resource: "**", effect: "deny" }],
      request: { headers: { "x-y": "z" }, body: { temperature: 0.2 } },
    })
  })

  test("markdown frontmatter is parsed as YAML, body wins as the prompt", () => {
    const agent = parseAgentMarkdown(
      "reviewer",
      [
        "---",
        "description: Reviews diffs",
        "mode: subagent",
        "model: openai/gpt-5.4#high",
        "hidden: true",
        "color: '#ff0000'",
        "steps: 7",
        "permissions:",
        "  - action: edit",
        "    resource: '**'",
        "    effect: deny",
        "request:",
        "  headers:",
        "    x-test: '1'",
        "  body:",
        "    temperature: 0.3",
        "---",
        "Body prompt.",
      ].join("\n"),
    )
    expect(agent.description).toBe("Reviews diffs")
    expect(agent.mode).toBe("subagent")
    expect(agent.model).toBe("openai/gpt-5.4#high")
    expect(agent.hidden).toBe(true)
    expect(agent.color).toBe("#ff0000")
    expect(agent.steps).toBe(7)
    expect(agent.permissions).toEqual([{ action: "edit", resource: "**", effect: "deny" }])
    expect(agent.request).toEqual({ headers: { "x-test": "1" }, body: { temperature: 0.3 } })
    expect(agent.system).toBe("Body prompt.")
  })

  test("mode/ files force a primary agent", () => {
    expect(parseAgentMarkdown("planner", "---\nmode: subagent\n---\nbody", { primary: true }).mode).toBe("primary")
  })

  test("mergeAgent keeps defined config fields over the file definition", () => {
    const merged = mergeAgent(
      { name: "lead", system: "file prompt", model: "a/b", color: "#111" },
      { name: "lead", model: "c/d", hidden: true },
    )
    expect(merged).toEqual({ name: "lead", system: "file prompt", model: "c/d", color: "#111", hidden: true })
  })

  test("mergeAgent accumulates permissions and request settings", () => {
    const merged = mergeAgent(
      {
        name: "lead",
        permissions: [{ action: "read", resource: "*", effect: "allow" }],
        request: { headers: { a: "1" }, body: { temperature: 0.2 } },
      },
      {
        name: "lead",
        permissions: [{ action: "edit", resource: "**", effect: "deny" }],
        request: { headers: { b: "2" } },
      },
    )
    // File rules first, config rules appended: last match wins, so the config
    // entry still decides.
    expect(merged.permissions).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "edit", resource: "**", effect: "deny" },
    ])
    expect(merged.request).toEqual({ headers: { a: "1", b: "2" }, body: { temperature: 0.2 } })
  })

  test("steps must be a positive integer", () => {
    const steps = (value: string) => parseAgentMarkdown("x", `---\nsteps: ${value}\n---\nbody`).steps
    expect(steps("25")).toBe(25)
    expect(steps("0")).toBeUndefined()
    expect(steps("-3")).toBeUndefined()
    expect(steps("2.5")).toBeUndefined()
    expect(steps("many")).toBeUndefined()
  })

  test("readAgents survives a symlink loop", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-agents-"))
    try {
      fs.mkdirSync(path.join(dir, "agents", "team"), { recursive: true })
      fs.writeFileSync(path.join(dir, "agents", "team", "reviewer.md"), "---\nmode: subagent\n---\nreview")
      fs.symlinkSync(path.join(dir, "agents"), path.join(dir, "agents", "team", "loop"))
      expect(readAgents(dir).map((agent) => agent.name)).toEqual(["team/reviewer"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("readAgents discovers agent/, agents/, mode/ and nested files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-agents-"))
    try {
      fs.mkdirSync(path.join(dir, "agent"), { recursive: true })
      fs.mkdirSync(path.join(dir, "agents", "team"), { recursive: true })
      fs.mkdirSync(path.join(dir, "modes"), { recursive: true })
      fs.writeFileSync(path.join(dir, "agent", "solo.md"), "---\nmode: subagent\n---\nsolo")
      fs.writeFileSync(path.join(dir, "agents", "team", "reviewer.md"), "---\nmode: subagent\n---\nreview")
      fs.writeFileSync(path.join(dir, "modes", "planner.md"), "---\nmode: subagent\n---\nplan")
      const agents = readAgents(dir)
      expect(agents.map((agent) => agent.name).sort()).toEqual(["planner", "solo", "team/reviewer"])
      expect(agents.find((agent) => agent.name === "planner")?.mode).toBe("primary")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("config substitution", () => {
  test("resolves {file:} relative to the config and {env:}", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-config-"))
    try {
      fs.writeFileSync(path.join(dir, "prompt.md"), "  Hello  \n")
      process.env.PROFILE_SWITCHER_TEST = "from-env"
      const text = '{"system":"{file:prompt.md}","env":"{env:PROFILE_SWITCHER_TEST}"}'
      expect(JSON.parse(substituteConfigText(text, dir))).toEqual({ system: "Hello", env: "from-env" })
    } finally {
      delete process.env.PROFILE_SWITCHER_TEST
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("readConfigJsonc parses a config with a file prompt", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-config-"))
    try {
      fs.writeFileSync(path.join(dir, "prompt.md"), "Prompt body")
      fs.writeFileSync(
        path.join(dir, "opencode.jsonc"),
        '{ "agents": { "lead": { "system": "{file:prompt.md}" } } }',
      )
      expect(readConfigJsonc(path.join(dir, "opencode.jsonc"))?.agents.lead.system).toBe("Prompt body")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("canonical config paths", () => {
  test("expands ~ and resolves symlinks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-path-"))
    try {
      const real = path.join(dir, "real.jsonc")
      const link = path.join(dir, "link.jsonc")
      fs.writeFileSync(real, "{}")
      fs.symlinkSync(real, link)
      expect(canonicalConfigPath(link)).toBe(canonicalConfigPath(real))
      expect(canonicalConfigPath("~/x")).toBe(path.join(os.homedir(), "x"))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("startupInfo treats a symlinked path as layered", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-path-"))
    try {
      const real = path.join(dir, "opencode.jsonc")
      const link = path.join(dir, "link.jsonc")
      fs.writeFileSync(real, "{}")
      fs.symlinkSync(real, link)
      expect(startupInfo(real, ["plugins"], link).kind).toBe("layered")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
