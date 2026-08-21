import type { KillEvent, MatchResultPayload } from "../game/types.js";

/** Messages a client is allowed to send. Anything else is ignored by the server. */
export const ClientMessage = {
  /** Batched input commands (see `encodeInput`). The only gameplay message. */
  INPUT: "input",
  /** Round-trip time probe. */
  PING: "ping",
  /** Player pressed "play again" from the results screen. */
  REQUEUE: "requeue",
} as const;

export type ClientMessageType = (typeof ClientMessage)[keyof typeof ClientMessage];

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
  /** Server timestamp at the moment of joining; used to align clocks for debug output. */
  serverTime: number;
  /** The name actually assigned after server-side validation. */
  name: string;
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

export interface NoticePayload {
  code: "NAME_REJECTED" | "RATE_LIMITED" | "MATCH_IN_PROGRESS" | "INFO";
  message: string;
}
