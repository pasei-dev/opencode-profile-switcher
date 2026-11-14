import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * The desktop app evaluates ./gui-experimental as a CommonJS module whose
 * default export is a Plugin.define. This is the closest check without the app:
 * evaluate the built bundle with the modules the app provides.
 */
describe("desktop GUI bundle", () => {
  test("evaluates to a Plugin.define with setup and main", async () => {
    const file = path.join(import.meta.dir, "..", "dist", "gui-experimental.cjs")
    expect(fs.existsSync(file)).toBe(true)
    const code = fs.readFileSync(file, "utf8")

    const shared: Record<string, unknown> = {
      "@opencode/plugin/gui": await import("@opencode/plugin/gui"),
      "@opencode/plugin/rpc": await import("@opencode/plugin/rpc"),
      effect: await import("effect"),
      "solid-js": await import("solid-js"),
      "solid-js/web": await import("solid-js/web"),
      "node:child_process": await import("node:child_process"),
    }

    const module = { exports: {} as Record<string, unknown> }
    const customRequire = (id: string) => {
      if (!(id in shared)) throw new Error(`the bundle required a module the app does not provide: ${id}`)
      return shared[id]
    }
    Function("require", "module", "exports", code)(customRequire, module, module.exports)

    const definition = (module.exports.default ?? module.exports) as {
      setup?: unknown
      main?: unknown
      i18n?: { en?: Record<string, string> }
    }
    expect(typeof definition.setup).toBe("function")
    expect(typeof definition.main).toBe("function")
    expect(definition.i18n?.en?.["command.pick"]).toBeString()
  })
})
