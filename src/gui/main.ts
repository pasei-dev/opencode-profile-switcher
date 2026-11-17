/**
 * Main-process half of the desktop GUI.
 *
 * A window cannot spawn processes, and the server cannot restart itself without
 * racing its own reply. Main is outside both: it runs `opencode service restart`
 * with the profile layered in through OPENCODE_CONFIG, exactly like the TUI does.
 */

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Plugin } from "@opencode/plugin/gui"

import { Restart } from "./contract.ts"

/**
 * The desktop app spawns the background service from this process, so this
 * process's env is the env the service inherits. Put the selected profile's
 * layer here: the app's own reconnects then spawn a layered server, instead of
 * racing the boot relay with an unlayered contender.
 *
 * The first spawn of an app launch still happens before this runs, so the relay
 * stays; this makes every spawn after it deterministic.
 */
function adoptLayer(): void {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".config")
  const config = path.join(base, "opencode")
  let state: { profile?: unknown } | undefined
  try {
    state = JSON.parse(fs.readFileSync(path.join(config, ".profile-switcher.json"), "utf8"))
  } catch {
    return
  }
  if (typeof state?.profile !== "string") {
    delete process.env.OPENCODE_CONFIG
    return
  }
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const file = path.join(config, "profiles", state.profile, name)
    if (fs.existsSync(file)) {
      process.env.OPENCODE_CONFIG = file
      return
    }
  }
}

export const main: Plugin.MainSetup = (ctx) => {
  adoptLayer()
  ctx.provide(Restart, {
    run: async (input) => {
      const [bin, ...args] = ctx.cli.command
      if (!bin) return { ok: false, error: "the desktop app did not report a CLI command" }

      // restartEnv(null) removes the layer: that is how switching back to base
      // takes a profile's plugins and providers away again.
      const env = { ...process.env }
      if (input.configFile) env.OPENCODE_CONFIG = input.configFile
      else delete env.OPENCODE_CONFIG
      // Keep the app's own env in step, so a reconnect it spawns later carries
      // the same layer as this restart.
      if (input.configFile) process.env.OPENCODE_CONFIG = input.configFile
      else delete process.env.OPENCODE_CONFIG

      try {
        const child = spawn(bin, [...args, "service", "restart"], {
          env,
          detached: true,
          stdio: "ignore",
        })
        // Wait for the OS to start it, so a missing binary is reported to the
        // window instead of becoming an unhandled 'error' event.
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", () => resolve())
          child.once("error", (error) => reject(error))
        })
        child.unref()
        ctx.log.write("info", "profile-switcher: restarting the background service", {
          profile: input.profile,
          layered: input.configFile !== null,
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
