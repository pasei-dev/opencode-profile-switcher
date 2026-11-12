/**
 * Types shared by the server, TUI and desktop halves.
 *
 * This file must stay free of Node imports: the desktop GUI bundle evaluates it
 * in a browser window, where `node:*` modules are inert placeholders.
 */

export type RestartPolicy = "ask" | "always" | "never"

export type StartupKind = "none" | "pending" | "layered"

export type StartupInfo = {
  kind: StartupKind
  keys: string[]
  command?: string
}

/** One profile as the server reports it to its clients. */
export type ProfileView = {
  name: string
  label: string
  description: string
  directory: string
  configFile: string
  defaultAgent?: string
  defaultModel?: string
  agents: string[]
  applied: string[]
  relaunch: string[]
  adapted: string[]
  legacy: string[]
  unknown: string[]
  /** Server-side verdict: does this profile need a restart, and is it layered already? */
  restart: StartupKind
  hidden: boolean
  /** The exact command a manual restart needs for this profile. */
  command: string
}

/** Everything a client needs to render the picker, badge and settings page. */
export type Snapshot = {
  active: string | null
  /** The profile whose config file the server was started with, if any. */
  layered: string | null
  policy: RestartPolicy
  /** False while the policy is still the implicit default (used to migrate old TUI prefs). */
  policyStored: boolean
  profilesRoot: string
  /** A turn is running somewhere on this server. */
  busy: boolean
  profiles: ProfileView[]
}

export type ChangedEvent = {
  profile: string | null
  policy: RestartPolicy
  busy: boolean
}

export type BusyResult = { busy: boolean }
