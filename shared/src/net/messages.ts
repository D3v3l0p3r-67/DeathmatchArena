import type { ArenaDefinition } from "../arena/types.js";
import type { GameConfig } from "../config/types.js";
import type { KillEvent, MatchResultPayload } from "../game/types.js";

export type {
  DebugNpcPayload,
  DebugNpcScore,
  DebugNpcSnapshot,
  DebugAuthRequest,
  DebugCommandRequest,
  DebugCommandResult,
  DebugCommandSpec,
  DebugConfigEntry,
  DebugParamSpec,
  DebugStatePayload,
} from "../debug/types.js";

/** Messages a client is allowed to send. Anything else is ignored by the server. */
export const ClientMessage = {
  /** Batched input commands (see `encodeInput`). The only gameplay message. */
  INPUT: "input",
  /** Round-trip time probe. */
  PING: "ping",
  /** Player pressed "play again" from the results screen. */
  REQUEUE: "requeue",
  /**
   * "Begin, with whoever is here." Only the host's asking means anything, and
   * only when the room holds a match's worth of players.
   */
  START_MATCH: "startMatch",
  /** Add one bot at the given difficulty. Host only, and only while waiting. */
  ADD_BOT: "addBot",
  /** Remove one bot from the room. Host only, and only while waiting. */
  REMOVE_BOT: "removeBot",
  /**
   * Request debug access. The server decides; a client saying "I am an admin"
   * proves nothing.
   */
  DEBUG_AUTH: "debugAuth",
  /**
   * Run a debug command. Refused outright unless the sending session already
   * holds a server-side grant.
   */
  DEBUG_COMMAND: "debugCommand",
} as const;

export type ClientMessageType = (typeof ClientMessage)[keyof typeof ClientMessage];

/** Payload of {@link ClientMessage.ADD_BOT}. */
export interface AddBotRequest {
  /** Which rung of the ladder this bot should play at, 1..5. */
  difficulty: number;
}

/** Payload of {@link ClientMessage.REMOVE_BOT}. */
export interface RemoveBotRequest {
  /** The bot to remove. Ignored unless it is a bot in this room. */
  sessionId: string;
}

/** Messages the server broadcasts. State itself travels via Colyseus schema sync. */
export const ServerMessage = {
  PONG: "pong",
  /** Sent once on join with everything the client needs to build the world. */
  WELCOME: "welcome",
  /** Ephemeral kill-feed event; not part of the synchronised state. */
  KILL: "kill",
  /** Hit confirmation for the shooter and damage indicator for the victim. */
  DAMAGE: "damage",
  /** Final standings when a match ends. */
  MATCH_RESULT: "matchResult",
  /** Human-readable rejection (bad name, throttled, ...). */
  NOTICE: "notice",
  /** A player collected a power-up; drives the pickup toast and a sound cue. */
  POWERUP_COLLECTED: "powerUpCollected",
  /** A crate broke open. Ephemeral, so it is a message rather than state. */
  CRATE_DESTROYED: "crateDestroyed",
  /** A melee weapon was swung; purely so clients can animate it. */
  MELEE_SWING: "meleeSwing",
  /** A grenade detonated. Ephemeral, so a message rather than state. */
  /** A grenade or a rocket went off; the client draws the blast. */
  EXPLOSION: "explosion",
  /**
   * The room has moved to a different arena for the next match.
   *
   * Carries the whole definition for the same reason the welcome does: an
   * administrator can create an arena after the client was built, and the client
   * predicts movement against this geometry.
   */
  ARENA_CHANGED: "arenaChanged",
  /**
   * Debug authorization result plus, when granted, the command catalogue and the
   * room's tunable values. Unauthorized sessions receive only a refusal.
   */
  DEBUG_STATE: "debugState",
  /** Outcome of one debug command. */
  DEBUG_RESULT: "debugResult",
  /** What the bots are thinking. Streamed only while an authorized console is open. */
  DEBUG_NPC: "debugNpc",
  /**
   * The room's configuration changed mid-match (only a debug command can do
   * this). Clients predict movement from these values, so they have to be told.
   */
  CONFIG_CHANGED: "configChanged",
} as const;

export type ServerMessageType = (typeof ServerMessage)[keyof typeof ServerMessage];

/** Options passed to `client.joinOrCreate`. */
export interface JoinOptions {
  name: string;
}

export interface WelcomePayload {
  sessionId: string;
  roomId: string;
  arenaId: string;
  /**
   * The arena itself, geometry and all.
   *
   * Sent rather than looked up: arenas are administered data, so one may have
   * been created long after this client was built. It also means what the client
   * draws and what the server collides against are the same object.
   */
  arena: ArenaDefinition;
  /**
   * The room's effective configuration.
   *
   * Not a convenience: the client predicts movement with these numbers, so
   * anything else would put prediction and simulation on different physics.
   */
  config: GameConfig;
  /** Server timestamp at the moment of joining; used to align clocks for debug output. */
  serverTime: number;
  /** The name actually assigned after server-side validation. */
  name: string;
}

export interface ConfigChangedPayload {
  config: GameConfig;
}

export interface PingPayload {
  /** Client timestamp, echoed back untouched. */
  clientTime: number;
}

export interface PongPayload {
  clientTime: number;
  serverTime: number;
}

export interface DamagePayload {
  /** Session id of the player who took the damage. */
  victimId: string;
  /** Session id of the shooter, empty for environmental damage. */
  attackerId: string;
  amount: number;
  /** Remaining health after the hit. */
  health: number;
  /** World position of the impact, for hit sparks. */
  x: number;
  y: number;
  /** True when the local client caused this damage (hit marker). */
  fatal: boolean;
}

export type KillPayload = KillEvent;
export type MatchResultMessage = MatchResultPayload;

export interface PowerUpCollectedPayload {
  /** Who picked it up. */
  sessionId: string;
  /** Id of the power-up *definition* that was applied. */
  powerUpId: string;
  /** Display name, so the client need not resolve the catalogue for a toast. */
  name: string;
  /** World position of the pickup, for the collect effect. */
  x: number;
  y: number;
}

export interface CrateDestroyedPayload {
  crateId: string;
  x: number;
  y: number;
  /** Session id of whoever broke it, empty when it expired on its own. */
  destroyedBy: string;
}

export interface MeleeSwingPayload {
  sessionId: string;
  weaponId: string;
  aimAngle: number;
  /** True when the swing connected with at least one player or crate. */
  connected: boolean;
}

/**
 * Something went off.
 *
 * One message for grenades and rockets alike: the client draws a blast, and what
 * threw it is not information the effect needs.
 */
export interface ExplosionPayload {
  /** Identifies this blast; the id of whatever produced it. */
  id: string;
  /** Session id of whoever caused it, for their own screen shake. */
  ownerId: string;
  x: number;
  y: number;
  /** Blast radius in px, so the effect matches the damage that was applied. */
  radius: number;
}

/** Payload of {@link ServerMessage.ARENA_CHANGED}. */
export interface ArenaChangedPayload {
  arena: ArenaDefinition;
}

export interface NoticePayload {
  code: "NAME_REJECTED" | "RATE_LIMITED" | "MATCH_IN_PROGRESS" | "INFO";
  message: string;
}
