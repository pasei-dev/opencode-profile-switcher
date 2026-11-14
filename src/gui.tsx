/**
 * profile-switcher — desktop GUI half.
 *
 * The app evaluates this file in every window and in its main process, then
 * runs `setup` or `main`. The server half owns the profiles; this half is the
 * UI and the one privileged action a window cannot take (restarting the
 * background service).
 */

import { Plugin } from "@opencode/plugin/gui"

import { messages } from "./gui/i18n.ts"
import { main } from "./gui/main.ts"
import { setup } from "./gui/window.tsx"

export default Plugin.define({
  i18n: { en: messages },
  setup,
  main,
})
