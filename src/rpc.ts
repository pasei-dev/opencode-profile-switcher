/**
 * The typed contract between the server half and its clients (TUI, desktop GUI,
 * or anything else with an OpenCode client).
 *
 * JSON Schema keeps this file dependency-free: the desktop window bundles it,
 * and the server validates calls against the same definition.
 */

import { Rpc } from "@opencode/plugin/rpc"

import type { BusyResult, ClaimResult, RestartPolicy, Snapshot } from "./types.ts"

const policy = { enum: ["ask", "always", "never"] } as const

const nullableString = {
  anyOf: [{ type: "string" }, { type: "null" }],
} as const

const strings = { type: "array", items: { type: "string" } } as const

const profileView = {
  type: "object",
  properties: {
    name: { type: "string" },
    label: { type: "string" },
    description: { type: "string" },
    directory: { type: "string" },
    configFile: { type: "string" },
    defaultAgent: { type: "string" },
    defaultModel: { type: "string" },
    agents: strings,
    applied: strings,
    relaunch: strings,
    adapted: strings,
    legacy: strings,
    unknown: strings,
    restart: { enum: ["none", "pending", "layered"] },
    hidden: { type: "boolean" },
    command: { type: "string" },
  },
  required: [
    "name",
    "label",
    "description",
    "directory",
    "configFile",
    "agents",
    "applied",
    "relaunch",
    "adapted",
    "legacy",
    "unknown",
    "restart",
    "hidden",
    "command",
  ],
  additionalProperties: false,
} as const

const snapshot = {
  type: "object",
  properties: {
    active: nullableString,
    layered: nullableString,
    expected: nullableString,
    policy,
    policyStored: { type: "boolean" },
    profilesRoot: { type: "string" },
    busy: { type: "boolean" },
    profiles: { type: "array", items: profileView },
  },
  required: ["active", "layered", "expected", "policy", "policyStored", "profilesRoot", "busy", "profiles"],
  additionalProperties: false,
} as const

const busyResult = {
  type: "object",
  properties: { busy: { type: "boolean" } },
  required: ["busy"],
  additionalProperties: false,
} as const

/** Methods without arguments still need a schema: JSON Schema input types are `unknown`. */
const noInput = { type: "object", additionalProperties: false } as const

export const Profiles = Rpc.define({
  id: "profile-switcher",
  methods: {
    /** The active profile, the restart verdict for every profile, and the policy. */
    list: { input: noInput, output: snapshot },
    /** Apply a profile (or `null` for base config) and return the new snapshot. */
    apply: {
      input: {
        type: "object",
        properties: {
          name: nullableString,
          sessionID: { type: "string" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      output: snapshot,
    },
    /** Persist the restart policy (shared by the TUI and the desktop app). */
    setPolicy: {
      input: {
        type: "object",
        properties: { policy },
        required: ["policy"],
        additionalProperties: false,
      },
      output: snapshot,
    },
    /** Whether a turn is running; a desktop restart waits for this to be false. */
    busy: { input: noInput, output: busyResult },
    /**
     * Ask the server for the right to restore a dropped layer. The handoff file
     * is shared, so this is what keeps two clients from bouncing the service at
     * the same time — and keeps either from doing it forever.
     */
    claimRestart: {
      input: {
        type: "object",
        properties: { profile: { type: "string" } },
        required: ["profile"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { allowed: { type: "boolean" } },
        required: ["allowed"],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          profile: nullableString,
          policy,
          busy: { type: "boolean" },
        },
        required: ["profile", "policy", "busy"],
        additionalProperties: false,
      },
    },
  },
})

export type ProfilesRpc = typeof Profiles

/** Narrow the RPC's `unknown` results without repeating the cast at every call site. */
export const asSnapshot = (value: unknown): Snapshot => value as Snapshot
export const asBusy = (value: unknown): BusyResult => value as BusyResult
export const asClaim = (value: unknown): ClaimResult => value as ClaimResult
export const asPolicy = (value: unknown): RestartPolicy => value as RestartPolicy
