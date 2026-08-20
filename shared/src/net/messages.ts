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

export interface NoticePayload {
  code: "NAME_REJECTED" | "RATE_LIMITED" | "MATCH_IN_PROGRESS" | "INFO";
  message: string;
}
