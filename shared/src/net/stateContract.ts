import type { TrapPhaseValue } from "../game/traps.js";
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
  /** True for an NPC. Presentation only -- the simulation treats them alike. */
  readonly bot: boolean;
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
  /** Movement speed multiplier from an active effect; 1 when nothing is active. */
  readonly speedMultiplier: number;
  /**
   * Whole seconds left on the active speed effect, 0 when none.
   * Whole seconds rather than a deadline so the value changes at most once per
   * second -- no clock synchronisation, and almost nothing on the wire.
   */
  readonly boostSeconds: number;
  /** Jumps left before landing; 0 means the mid-air jump is spent. */
  readonly jumpsRemaining: number;
  /** Grenades left to throw. */
  readonly grenades: number;
  /** True while this player is winding up a grenade throw. */
  readonly chargingGrenade: boolean;
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

/**
 * A breakable crate.
 *
 * Note what is *absent*: the power-up inside. The server keeps that to itself
 * until the crate breaks, so a modified client cannot see through crates and
 * cherry-pick which ones to open.
 */
export interface SyncedCrate {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly health: number;
  readonly maxHealth: number;
}

/** A power-up revealed by a broken crate, waiting to be collected. */
export interface SyncedPowerUp {
  /** Entity id, unique per spawned pickup. */
  readonly id: string;
  /** Id of the power-up *definition*, which the client uses only to draw it. */
  readonly powerUpId: string;
  readonly x: number;
  readonly y: number;
}

/** A grenade in flight. The explosion is resolved entirely server-side. */
export interface SyncedGrenade {
  readonly id: string;
  readonly ownerId: string;
  readonly x: number;
  readonly y: number;
  readonly velocityX: number;
  readonly velocityY: number;
  /** Whole seconds left on the fuse. */
  readonly fuseSeconds: number;
}

/**
 * A trap, as far as a client is concerned.
 *
 * Enough to draw it and to read the warning: where it is, how big it is, and
 * which phase of its cycle it is in. Damage, activation and overlap are resolved
 * entirely on the server and never appear here.
 */
export interface SyncedTrap {
  readonly id: string;
  readonly trapType: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly phase: TrapPhaseValue;
}

export interface SyncedGameState {
  readonly matchState: MatchStateValue;
  readonly arenaId: string;
  readonly players: ReadonlyMap<string, SyncedPlayer>;
  readonly projectiles: ReadonlyMap<string, SyncedProjectile>;
  readonly crates: ReadonlyMap<string, SyncedCrate>;
  readonly powerUps: ReadonlyMap<string, SyncedPowerUp>;
  readonly grenades: ReadonlyMap<string, SyncedGrenade>;
  readonly traps: ReadonlyMap<string, SyncedTrap>;
  readonly countdownSeconds: number;
  readonly playerCount: number;
  readonly aliveCount: number;
  readonly startingPlayerCount: number;
  readonly winnerId: string;
  readonly winnerName: string;
  readonly matchStartedAt: number;
  readonly minPlayersToStart: number;
  readonly maxPlayers: number;
  /**
   * Whole seconds until bots take the lobby's free places; 0 when nothing is
   * waiting. Whole seconds so it changes once a second rather than every patch.
   */
  readonly botFillSeconds: number;
  /** True while somebody could skip that wait and start now. */
  readonly canStartNow: boolean;

  /**
   * Current playable width, as the closing walls define it.
   *
   * Equal to the arena's own edges until the shrink begins. Clients need these
   * both to draw the walls and to predict movement against the same limits the
   * server clamps to.
   */
  readonly shrinkLeft: number;
  readonly shrinkRight: number;
  /** True once the walls have started moving. */
  readonly shrinking: boolean;
  /**
   * Whole seconds until the walls start, 0 once they have.
   * Whole seconds so it changes at most once a second instead of every patch.
   */
  readonly shrinkCountdownSeconds: number;
}
