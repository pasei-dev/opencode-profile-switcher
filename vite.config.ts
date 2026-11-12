import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// Builds the desktop app's ./gui-experimental bundle. The app provides
// solid-js, effect and @opencode/plugin/gui at runtime, so the preset keeps them
// external and emits one CommonJS file.
export default defineConfig({
  plugins: [gui({ entry: "src/gui.tsx", outFile: "dist/gui-experimental.cjs" })],
})
