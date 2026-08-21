/**
 * The debug protocol contract.
 *
 * Two properties shape everything here:
 *
 *   1. **Authorization is server-side.** The client is told what it may do; it
 *      never decides. A client that fabricates any of these messages without a
 *      grant gets nothing back but a refusal.
 *   2. **The command catalogue is server-owned.** The client renders whatever
 *      specs the server sends rather than shipping its own list, so an
 *      unauthorized client cannot even enumerate what exists, and adding a
 *      command needs no client change.
 */

/** One input on a debug command form. */
export interface DebugParamSpec {
  key: string;
  label: string;
  type: "number" | "boolean" | "string" | "select";
  /** Pre-filled value shown in the form. */
  defaultValue?: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  /** Options for `select`. Values are opaque strings to the client. */
  options?: { value: string; label: string }[];
  hint?: string;
}

/** A command the authorized client may invoke, as described by the server. */
export interface DebugCommandSpec {
  id: string;
  label: string;
  description: string;
  /** Free-form grouping used only to lay the console out. */
  category: string;
  params: DebugParamSpec[];
}

/** A single tunable value the console can display and change for this room. */
export interface DebugConfigEntry {
  /** Dotted path into the room's `GameConfig`, e.g. `crate.health`. */
  path: string;
  label: string;
  value: number | boolean | string;
  /** True once this room's value differs from the server's baseline. */
  overridden: boolean;
  min?: number;
  max?: number;
  step?: number;
}

/**
 * Everything an authorized console needs, sent only to granted sessions.
 *
 * Sent once on grant and again after any command that changes it, so the console
 * never has to guess or poll.
 */
export interface DebugStatePayload {
  /** False for every unauthorized session; the client keeps its console shut. */
  granted: boolean;
  /** Why access was refused, or how it was granted. Safe to show to the user. */
  reason: string;
  /** Empty unless granted. */
  commands: DebugCommandSpec[];
  /** Empty unless granted. Room-scoped configuration values. */
  config: DebugConfigEntry[];
  /** Room this grant applies to; a grant never spans rooms. */
  roomId: string;
}

/** A client's request to be granted debug access. */
export interface DebugAuthRequest {
  /** Shared secret, matched against the server's configured tokens. */
  token?: string;
}

/** A client's request to run one command. */
export interface DebugCommandRequest {
  commandId: string;
  /** Raw, untrusted. Every value is validated against the command's spec. */
  params?: Record<string, unknown>;
}

export interface DebugCommandResult {
  commandId: string;
  ok: boolean;
  /** Human-readable outcome, shown in the console log. */
  message: string;
}
