import {
  PROJECTILE,
  getProjectileLifetimeMs,
  type WeaponDefinition,
} from "@deathmatch/shared";
import type { RoomContext } from "../rooms/RoomContext.js";
import { ProjectileState } from "../rooms/schema/ProjectileState.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";
import type { CollisionSystem } from "./CollisionSystem.js";

/** Server-only bookkeeping that clients do not need. */
interface ProjectileRuntime {
  state: ProjectileState;
  expiresAt: number;
  /** Distance travelled so far, checked against the weapon's range. */
  travelled: number;
  maxDistance: number;
}

/**
 * Authoritative projectile simulation.
 *
 * Bullets are swept along their path in sub-steps no longer than
 * `PROJECTILE.MAX_STEP_DISTANCE`, and each sub-step is a segment cast against
 * players first and geometry second. That makes tunnelling impossible even at
 * 1500 px/s and 60Hz, where a naive per-tick position test would miss a 28px-wide
 * player entirely.
 */
export class ProjectileSystem {
  private readonly runtimes = new Map<string, ProjectileRuntime>();
  private nextId = 1;

  constructor(
    private readonly context: RoomContext,
    private readonly collision: CollisionSystem,
  ) {}

  get activeCount(): number {
    return this.runtimes.size;
  }

  spawn(
    ownerId: string,
    weapon: WeaponDefinition,
    x: number,
    y: number,
    angle: number,
    now: number,
  ): ProjectileState | null {
    if (this.runtimes.size >= PROJECTILE.MAX_ACTIVE) {
      this.context.logger.warn("Projectile cap reached, dropping shot", { ownerId });
      return null;
    }

    const state = new ProjectileState();
    state.id = `p${this.nextId++}`;
    state.ownerId = ownerId;
    state.x = x;
    state.y = y;
    state.velocityX = Math.cos(angle) * weapon.bulletSpeed;
    state.velocityY = Math.sin(angle) * weapon.bulletSpeed;
    state.damage = weapon.damage;
    state.createdAt = now;
    state.weaponId = weapon.id;

    const lifetime = Math.min(getProjectileLifetimeMs(weapon), PROJECTILE.MAX_LIFETIME_MS);
    this.runtimes.set(state.id, {
      state,
      expiresAt: now + lifetime,
      travelled: 0,
      maxDistance: weapon.range,
    });
    this.context.state.projectiles.set(state.id, state);

    return state;
  }

  /** Advance every projectile by `dt` seconds and resolve hits. */
  update(dt: number, now: number): void {
    if (this.runtimes.size === 0) return;

    const playerList = Array.from(this.context.state.players.values());

    for (const runtime of Array.from(this.runtimes.values())) {
      if (now >= runtime.expiresAt) {
        this.destroy(runtime.state.id);
        continue;
      }
      this.advance(runtime, dt, playerList);
    }
  }

  private advance(runtime: ProjectileRuntime, dt: number, players: readonly PlayerState[]): void {
    const state = runtime.state;
    const totalDx = state.velocityX * dt;
    const totalDy = state.velocityY * dt;
    const totalDistance = Math.hypot(totalDx, totalDy);
    if (totalDistance === 0) return;

    const steps = Math.max(1, Math.ceil(totalDistance / PROJECTILE.MAX_STEP_DISTANCE));
    const stepDx = totalDx / steps;
    const stepDy = totalDy / steps;
    const stepDistance = totalDistance / steps;

    for (let step = 0; step < steps; step++) {
      const fromX = state.x;
      const fromY = state.y;
      const toX = fromX + stepDx;
      const toY = fromY + stepDy;

      // Players take priority: a bullet that would clip a wall behind a player
      // must still register the hit.
      const playerHit = this.collision.raycastPlayers(fromX, fromY, toX, toY, players, state.ownerId);
      const worldHit = this.collision.raycastWorld(fromX, fromY, toX, toY);

      if (playerHit && (!worldHit || playerHit.t <= worldHit.t)) {
        this.context.applyDamage(
          playerHit.player.sessionId,
          state.ownerId,
          state.damage,
          playerHit.x,
          playerHit.y,
          state.weaponId,
        );
        this.destroy(state.id);
        return;
      }

      if (worldHit) {
        state.x = worldHit.x;
        state.y = worldHit.y;
        this.destroy(state.id);
        return;
      }

      state.x = toX;
      state.y = toY;
      runtime.travelled += stepDistance;

      if (runtime.travelled >= runtime.maxDistance) {
        this.destroy(state.id);
        return;
      }
    }
  }

  destroy(projectileId: string): void {
    if (!this.runtimes.delete(projectileId)) return;
    this.context.state.projectiles.delete(projectileId);
  }

  /** Remove every projectile owned by a player (used when they leave mid-match). */
  destroyOwnedBy(ownerId: string): void {
    for (const [id, runtime] of this.runtimes) {
      if (runtime.state.ownerId === ownerId) {
        this.runtimes.delete(id);
        this.context.state.projectiles.delete(id);
      }
    }
  }

  clear(): void {
    this.runtimes.clear();
    this.context.state.projectiles.clear();
  }
}
