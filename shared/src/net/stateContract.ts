import type { MatchStateValue } from "../game/types.js";

/**
 * The shape of the synchronised room state, as seen by a client.
 *
 * The server's Colyseus `Schema` classes declare `implements` against these
 * interfaces, so adding or renaming a synchronised field without updating both
 * sides is a compile error rather than a runtime surprise. Clients type their
 * decoded state with these interfaces instead of importing server code, which
 * keeps the packages properly separated.
 *
 * `MapSchema` implements `Map`, so `ReadonlyMap` describes it exactly while making
 * it obvious that clients must never mutate synchronised state.
 */

export interface SyncedPlayer {
  readonly sessionId: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly velocityX: number;
  readonly velocityY: number;
  readonly aimAngle: number;
  readonly facing: number;
  readonly health: number;
  readonly alive: boolean;
  readonly onGround: boolean;
  readonly kills: number;
  readonly deaths: number;
  readonly ammo: number;
  readonly reloading: boolean;
  readonly weaponId: string;
  /** Sequence number of the last input included in this snapshot. */
  readonly lastProcessedInput: number;
  readonly connected: boolean;
  readonly placement: number;
  readonly inMatch: boolean;
}

export interface SyncedProjectile {
  readonly id: string;
  readonly ownerId: string;
  readonly x: number;
  readonly y: number;
  readonly velocityX: number;
  readonly velocityY: number;
  readonly damage: number;
  readonly createdAt: number;
  readonly weaponId: string;
}

export interface SyncedGameState {
  readonly matchState: MatchStateValue;
  readonly arenaId: string;
  readonly players: ReadonlyMap<string, SyncedPlayer>;
  readonly projectiles: ReadonlyMap<string, SyncedProjectile>;
  readonly countdownSeconds: number;
  readonly playerCount: number;
  readonly aliveCount: number;
  readonly startingPlayerCount: number;
  readonly winnerId: string;
  readonly winnerName: string;
  readonly matchStartedAt: number;
  readonly minPlayersToStart: number;
  readonly maxPlayers: number;
}
