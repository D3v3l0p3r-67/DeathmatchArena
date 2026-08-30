import { detonate } from "./explosion.js";
import {
  PROJECTILE,
  getDamageAtDistance,
  getProjectileLifetimeMs,
  type WeaponDefinition,
} from "@deathmatch/shared";
import type { RoomContext } from "../rooms/RoomContext.js";
import { ProjectileState } from "../rooms/schema/ProjectileState.js";
import type { CrateState } from "../rooms/schema/CrateState.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";
import type { CollisionSystem } from "./CollisionSystem.js";

/** Server-only bookkeeping that clients do not need. */
interface ProjectileRuntime {
  state: ProjectileState;
  expiresAt: number;
  /** Distance travelled so far, checked against the weapon's range. */
  travelled: number;
  maxDistance: number;
  /** Kept so damage can be re-evaluated against the distance actually flown. */
  weapon: WeaponDefinition;
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
    // The owner's pace, not the weapon's alone: the same rifle in a slowed
    // enemy's hands fires a slower bullet. 1 for everyone in multiplayer.
    const speedScale = this.context.runtimes.get(ownerId)?.projectileSpeedMultiplier ?? 1;
    const bulletSpeed = (weapon.ranged?.bulletSpeed ?? 0) * speedScale;
    state.velocityX = Math.cos(angle) * bulletSpeed;
    state.velocityY = Math.sin(angle) * bulletSpeed;
    state.damage = weapon.damage;
    state.createdAt = now;
    state.weaponId = weapon.id;

    // Lifetime covers the weapon's range at the *actual* speed, so a slowed
    // bullet still reaches as far instead of dying early in the air.
    const lifetime = Math.min(getProjectileLifetimeMs(weapon) / speedScale, PROJECTILE.MAX_LIFETIME_MS);
    this.runtimes.set(state.id, {
      state,
      expiresAt: now + lifetime,
      travelled: 0,
      maxDistance: weapon.range,
      weapon,
    });
    this.context.state.projectiles.set(state.id, state);

    return state;
  }

  /** Advance every projectile by `dt` seconds and resolve hits. */
  update(dt: number, now: number): void {
    if (this.runtimes.size === 0) return;

    const playerList = Array.from(this.context.state.players.values());
    const crateList = Array.from(this.context.state.crates.values());

    for (const runtime of Array.from(this.runtimes.values())) {
      if (now >= runtime.expiresAt) {
        this.destroy(runtime.state.id);
        continue;
      }
      this.advance(runtime, dt, playerList, crateList);
    }
  }

  private advance(
    runtime: ProjectileRuntime,
    dt: number,
    players: readonly PlayerState[],
    crates: readonly CrateState[],
  ): void {
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
      const crateHit = this.collision.raycastCrates(fromX, fromY, toX, toY, crates);
      const worldHit = this.collision.raycastWorld(fromX, fromY, toX, toY);

      // Whichever of the three the bullet reaches first is what it hits.
      const firstT = Math.min(
        playerHit?.t ?? Number.POSITIVE_INFINITY,
        crateHit?.t ?? Number.POSITIVE_INFINITY,
        worldHit?.t ?? Number.POSITIVE_INFINITY,
      );

      if (playerHit && playerHit.t === firstT) {
        // An explosive round never applies its own damage: the blast is the
        // weapon, and it catches whoever it caught -- including the shooter, if
        // they fired it at somebody standing next to them.
        if (runtime.weapon.ranged?.explosion) {
          this.detonate(runtime, playerHit.x, playerHit.y);
          return;
        }

        // Damage is evaluated at the distance actually flown, so a falloff weapon
        // is only as strong as the range it hit from.
        const distance = runtime.travelled + stepDistance * playerHit.t;
        this.context.applyDamage(
          playerHit.player.sessionId,
          state.ownerId,
          getDamageAtDistance(runtime.weapon, distance),
          playerHit.x,
          playerHit.y,
          state.weaponId,
        );
        // Shoved the way the bullet was already going. Applied after the damage
        // so a lethal hit still throws the body rather than nothing at all.
        this.context.applyKnockback(
          playerHit.player.sessionId,
          state.velocityX,
          state.velocityY,
          runtime.weapon.knockbackForce,
        );
        this.destroy(state.id);
        return;
      }

      if (crateHit && crateHit.t === firstT) {
        if (runtime.weapon.ranged?.explosion) {
          this.detonate(runtime, crateHit.x, crateHit.y);
          return;
        }

        const distance = runtime.travelled + stepDistance * crateHit.t;
        state.x = crateHit.x;
        state.y = crateHit.y;
        this.context.damageCrate(
          crateHit.crate.id,
          getDamageAtDistance(runtime.weapon, distance),
          state.ownerId,
          this.context.now(),
          // The round's own direction: a crate is shoved the way it was shot.
          state.velocityX,
        );
        this.destroy(state.id);
        return;
      }

      if (worldHit) {
        state.x = worldHit.x;
        state.y = worldHit.y;
        if (runtime.weapon.ranged?.explosion) {
          this.detonate(runtime, worldHit.x, worldHit.y);
          return;
        }
        this.destroy(state.id);
        return;
      }

      state.x = toX;
      state.y = toY;
      runtime.travelled += stepDistance;

      if (runtime.travelled >= runtime.maxDistance) {
        // Out of range is an impact too: a rocket that simply vanished at the
        // limit of its flight would be a weapon players could not read.
        if (runtime.weapon.ranged?.explosion) {
          this.detonate(runtime, state.x, state.y);
          return;
        }
        this.destroy(state.id);
        return;
      }
    }
  }

  /**
   * Set off an explosive round where it stopped.
   *
   * Every way a projectile can end -- a player, a crate, a wall, the end of its
   * range -- goes through here, because a rocket that only exploded on people
   * would be a rocket nobody could use for anything else.
   */
  private detonate(runtime: ProjectileRuntime, x: number, y: number): void {
    const blast = runtime.weapon.ranged?.explosion;
    if (!blast) return;

    const { state } = runtime;
    this.destroy(state.id);

    detonate(
      this.context,
      {
        ...blast,
        id: state.id,
        ownerId: state.ownerId,
        weaponId: state.weaponId,
        x,
        y,
      },
      this.context.now(),
    );
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
