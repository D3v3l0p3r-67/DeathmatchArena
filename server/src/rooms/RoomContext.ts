import type { ArenaDefinition, CollisionWorld } from "@deathmatch/shared";
import type { Logger } from "../utils/logger.js";
import type { GameState } from "./schema/GameState.js";
import type { PlayerRuntime } from "./PlayerRuntime.js";

/**
 * The slice of the room that gameplay systems are allowed to touch.
 *
 * Systems depend on this interface rather than on `BattleRoom` itself, which keeps
 * them unit-testable and prevents circular imports between the room and its systems.
 */
export interface RoomContext {
  readonly state: GameState;
  readonly arena: ArenaDefinition;
  readonly world: CollisionWorld;
  readonly logger: Logger;
  readonly runtimes: Map<string, PlayerRuntime>;

  /** Authoritative wall clock in milliseconds. */
  now(): number;

  /** Deterministic RNG seeded per room (weapon spread). */
  random(): number;

  broadcast(type: string, payload: unknown, options?: { except?: string }): void;

  /** Lock the room so matchmaking routes new players to a fresh match instead. */
  setLocked(locked: boolean): void;
  sendTo(sessionId: string, type: string, payload: unknown): void;

  /**
   * Apply damage from `attackerId` (empty string for environmental damage).
   * Routed to the `MatchManager`, because a lethal hit drives the match lifecycle.
   */
  applyDamage(victimId: string, attackerId: string, amount: number, x: number, y: number, weaponId: string): void;

  /**
   * Damage a power-up crate. Routed to the `PowerUpSystem`, which owns crate
   * health and decides what a broken crate reveals.
   *
   * Like `applyDamage`, this is only ever called from a hit the server computed
   * itself -- a client never names a crate it claims to have hit.
   */
  damageCrate(crateId: string, amount: number, attackerId: string, now: number): void;
}
