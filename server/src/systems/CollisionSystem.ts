import {
  PLAYER_HALF_HEIGHT,
  PLAYER_HALF_WIDTH,
  centeredBounds,
  segmentVsBounds,
  type CollisionWorld,
  type RayHit,
} from "@deathmatch/shared";
import type { CrateState } from "../rooms/schema/CrateState.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";

export interface PlayerHit extends RayHit {
  player: PlayerState;
}

export interface CrateHit extends RayHit {
  crate: CrateState;
}

/**
 * Authoritative collision queries.
 *
 * Every hit in the game is resolved here, on the server, from server-owned
 * positions. Clients report intent ("I fired at this angle", "I swung"), never
 * outcomes.
 */
export class CollisionSystem {
  constructor(private readonly world: CollisionWorld) {}

  /** First arena surface hit along a segment, or null. */
  raycastWorld(x0: number, y0: number, x1: number, y1: number): RayHit | null {
    return this.world.raycast(x0, y0, x1, y1);
  }

  /**
   * Closest living player intersected by a segment.
   *
   * @param players  candidate players (already-dead players are skipped)
   * @param excludeId shooter's session id, so bullets never hit their owner
   */
  raycastPlayers(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    players: Iterable<PlayerState>,
    excludeId: string,
  ): PlayerHit | null {
    let closest: PlayerHit | null = null;

    for (const player of players) {
      if (!player.alive || player.sessionId === excludeId) continue;

      const bounds = centeredBounds(player.x, player.y, PLAYER_HALF_WIDTH, PLAYER_HALF_HEIGHT);
      const hit = segmentVsBounds(x0, y0, x1, y1, bounds);
      if (hit && (closest === null || hit.t < closest.t)) {
        closest = { ...hit, player };
      }
    }

    return closest;
  }

  /** Closest crate intersected by a segment. Crates are shootable, not solid. */
  raycastCrates(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    crates: Iterable<CrateState>,
  ): CrateHit | null {
    let closest: CrateHit | null = null;

    for (const crate of crates) {
      const bounds = centeredBounds(crate.x, crate.y, crate.width / 2, crate.height / 2);
      const hit = segmentVsBounds(x0, y0, x1, y1, bounds);
      if (hit && (closest === null || hit.t < closest.t)) {
        closest = { ...hit, crate };
      }
    }

    return closest;
  }

  /**
   * Living players a melee swing actually reaches.
   *
   * A target counts only when all three hold, all measured from server state:
   *   1. its hitbox is within `range` of the attacker's aim origin;
   *   2. the direction to it lies inside the swing arc;
   *   3. nothing solid stands between the two.
   *
   * Distance is measured to the *closest point on the target's box*, not to its
   * centre, so a chainsaw touching the edge of an opponent connects — which is
   * what "the chainsaw reaches the target" means to a player.
   */
  findMeleeTargets(
    originX: number,
    originY: number,
    aimAngle: number,
    range: number,
    halfArcRadians: number,
    players: Iterable<PlayerState>,
    excludeId: string,
  ): PlayerState[] {
    const hits: PlayerState[] = [];
    if (range <= 0) return hits;

    const aimX = Math.cos(aimAngle);
    const aimY = Math.sin(aimAngle);
    const cosLimit = Math.cos(halfArcRadians);

    for (const player of players) {
      if (!player.alive || player.sessionId === excludeId) continue;

      const bounds = centeredBounds(player.x, player.y, PLAYER_HALF_WIDTH, PLAYER_HALF_HEIGHT);
      const nearestX = clampTo(originX, bounds.left, bounds.right);
      const nearestY = clampTo(originY, bounds.top, bounds.bottom);

      const toX = nearestX - originX;
      const toY = nearestY - originY;
      const distance = Math.hypot(toX, toY);
      if (distance > range) continue;

      // Standing inside the target's own box counts as contact regardless of aim;
      // there is no meaningful direction to test at zero distance.
      if (distance > 0) {
        const dot = (toX / distance) * aimX + (toY / distance) * aimY;
        if (dot < cosLimit) continue;
      }

      // No reaching through walls: a target on the other side of geometry is safe.
      if (this.world.raycast(originX, originY, nearestX, nearestY)) continue;

      hits.push(player);
    }

    return hits;
  }

  /** Crates a melee swing reaches, using the same rules as `findMeleeTargets`. */
  findMeleeCrates(
    originX: number,
    originY: number,
    aimAngle: number,
    range: number,
    halfArcRadians: number,
    crates: Iterable<CrateState>,
  ): CrateState[] {
    const hits: CrateState[] = [];
    if (range <= 0) return hits;

    const aimX = Math.cos(aimAngle);
    const aimY = Math.sin(aimAngle);
    const cosLimit = Math.cos(halfArcRadians);

    for (const crate of crates) {
      const bounds = centeredBounds(crate.x, crate.y, crate.width / 2, crate.height / 2);
      const nearestX = clampTo(originX, bounds.left, bounds.right);
      const nearestY = clampTo(originY, bounds.top, bounds.bottom);

      const toX = nearestX - originX;
      const toY = nearestY - originY;
      const distance = Math.hypot(toX, toY);
      if (distance > range) continue;

      if (distance > 0) {
        const dot = (toX / distance) * aimX + (toY / distance) * aimY;
        if (dot < cosLimit) continue;
      }

      if (this.world.raycast(originX, originY, nearestX, nearestY)) continue;

      hits.push(crate);
    }

    return hits;
  }
}

function clampTo(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
