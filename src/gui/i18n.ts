/** English copy for the desktop GUI. Add another locale beside `en` in gui.tsx. */
export const messages = {
  base: "base",
  "base.description": "No profile overlay",

  "command.pick": "Switch profile",
  "command.pick.description": "Apply an OpenCode config profile without editing config",
  "command.group": "Profile",

  "picker.title": "Profile",
  "picker.search": "Search profiles",
  "picker.base": "Base config",
  "picker.base.description": "No profile overlay",
  "picker.warnings": "{{count}} field(s) ignored",
  "picker.unavailable": "The profile-switcher server half is not reachable yet.",

  "menu.title": "Profile",
  "menu.base": "Base config",

  "toast.applied": "{{profile}} applied",
  "toast.removed": "Profile removed — back to base config",
  "toast.failed": "Could not switch profile: {{error}}",
  "toast.restartTitle": "Restart needed",

  "restart.title": "Restart the server?",
  "restart.description": "{{profile}} sets {{keys}} — those keys are read when the server starts. Restarting ends a running turn and reconnects the app.",
  "restart.base.description": "Switching back to base config removes the profile's plugins and providers, which only a restart can do.",
  "restart.confirm": "Restart server",
  "restart.cancel": "Not now",
  "restart.queued": "The server restarts when the running turn finishes.",
  "restart.done": "Restarting with {{profile}} layered in…",
  "restart.doneBase": "Restarting with no profile layered in…",
  "restart.now": "Restart now",
  "restart.failed": "Could not restart the server: {{error}}",

  "settings.title": "Profiles",
  "settings.description": "Switch the whole OpenCode configuration without editing a file.",
  "settings.active.section": "Active profile",
  "settings.active": "Profile",
  "settings.active.description": "Applied live: agents, models, MCP servers, permissions, references and websearch.",
  "settings.policy": "Restart policy",
  "settings.policy.description": "Startup-only keys (plugins, providers, compaction, …) need a server restart.",
  "settings.restart": "Restart server",
  "settings.restart.description": "Apply the active profile's startup-only keys now.",
  "settings.restart.action": "Restart",
  "settings.folder": "Profiles folder",
  "settings.folder.action": "Reveal",
  "settings.profiles": "Profiles",
  "settings.apply": "Apply",
  "settings.applied": "Active",

  "policy.always": "Always restart",
  "policy.ask": "Ask first",
  "policy.never": "Never restart",

  "profile.pending": "⟳ needs restart: {{keys}}",
  "profile.layered": "✓ startup loaded",
  "profile.agents": "{{count}} agents",
} as const
