/**
 * Main-process half of the desktop GUI.
 *
 * A window cannot spawn processes, and the server cannot restart itself without
 * racing its own reply. Main is outside both: it runs `opencode service restart`
 * with the profile layered in through OPENCODE_CONFIG, exactly like the TUI does.
 */

import { spawn } from "node:child_process"

import type { Plugin } from "@opencode/plugin/gui"

import { Restart } from "./contract.ts"

export const main: Plugin.MainSetup = (ctx) => {
  ctx.provide(Restart, {
    run: async (input) => {
      const [bin, ...args] = ctx.cli.command
      if (!bin) return { ok: false, error: "the desktop app did not report a CLI command" }

      // restartEnv(null) removes the layer: that is how switching back to base
      // takes a profile's plugins and providers away again.
      const env = { ...process.env }
      if (input.configFile) env.OPENCODE_CONFIG = input.configFile
      else delete env.OPENCODE_CONFIG

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
