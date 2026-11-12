/**
 * The one token the desktop window and the app's main process share.
 *
 * Restarting the background service belongs in main: it is not the server, it
 * knows the CLI argv the app actually runs, and it can set OPENCODE_CONFIG on
 * the daemon it starts.
 */

import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"

export const Restart = Ipc.define({
  id: "profile-switcher.restart",
  methods: {
    run: {
      input: Schema.Struct({
        profile: Schema.NullOr(Schema.String),
        configFile: Schema.NullOr(Schema.String),
      }),
      output: Schema.Struct({
        ok: Schema.Boolean,
        error: Schema.optional(Schema.String),
      }),
    },
  },
})
