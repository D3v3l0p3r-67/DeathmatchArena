import {
  PLAYER_HALF_HEIGHT,
  PLAYER_HALF_WIDTH,
  centeredBounds,
  segmentVsBounds,
  type CollisionWorld,
  type RayHit,
} from "@deathmatch/shared";
import type { PlayerState } from "../rooms/schema/PlayerState.js";

export interface PlayerHit extends RayHit {
  player: PlayerState;
}

/**
 * Authoritative collision queries.
 *
 * Every hit in the game is resolved here, on the server, from server-owned
 * positions. Clients report intent ("I fired at this angle"), never outcomes.
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
}
