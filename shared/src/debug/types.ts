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

/**
 * A single tunable value the console can display and change for this room.
 *
 * A projection of the shared configuration metadata, so the console and the
 * administration interface show the same parameters with the same limits. The
 * grouping travels with it because there are now enough parameters that a flat
 * list would be unusable.
 */
export interface DebugConfigEntry {
  /** Dotted key into the room's `GameConfig`, e.g. `crate.health`. */
  path: string;
  label: string;
  category: string;
  subcategory: string;
  value: number | boolean | string;
  /** True once this room's value differs from the server's configured value. */
  overridden: boolean;
  /** False for values shown for reference but not changeable. */
  editable: boolean;
  min?: number;
  max?: number;
  step?: number;
  /** Allowed values, when the parameter is a choice rather than a number. */
  options?: { value: string; label: string }[];
}

/** One action's score at the moment a bot last decided. */
export interface DebugNpcScore {
  id: string;
  label: string;
  score: number;
  /** True for the action actually running. */
  chosen: boolean;
}

/**
 * What a bot is thinking, for the console.
 *
 * Sent only to authorized sessions, and only while a console is open. It is a
 * read-only picture: nothing here is an input, and a client that fabricated one
 * would change nothing about how the bot plays.
 */
export interface DebugNpcSnapshot {
  sessionId: string;
  name: string;
  profileId: string;
  profileName: string;
  /** Whatever the brain settled on, and where its state machine has got to. */
  action: string;
  state: string;
  targetName: string;
  scores: DebugNpcScore[];

  /** The handful of context values worth watching while balancing. */
  danger: number;
  health: number;
  ammo: number;
  grenadeDanger: number;
  weaponEffectiveness: number;
  enemyDistance: number;
  visibleEnemies: number;

  /** True for the one bot whose decisions are being logged. */
  watched: boolean;
  /** Newest last. Empty for every bot but the watched one. */
  log: string[];
}

export interface DebugNpcPayload {
  npcs: DebugNpcSnapshot[];
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
