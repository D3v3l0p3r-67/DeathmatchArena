import { detonate, grenadeBlast } from "./explosion.js";
import {
  PLAYER_HALF_WIDTH,
  clamp,
  type GrenadeConfig,
  type InputCommand,
  type WorldBounds,
} from "@deathmatch/shared";
import type { PlayerRuntime } from "../rooms/PlayerRuntime.js";
import type { RoomContext } from "../rooms/RoomContext.js";
import { GrenadeState } from "../rooms/schema/GrenadeState.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";

/** Server-only bookkeeping for one grenade in flight. */
interface GrenadeRuntime {
  state: GrenadeState;
  /** Timestamp at which it detonates. */
  explodesAt: number;
}

/**
 * Grenades, from the wind-up to the blast.
 *
 * The client's only contribution is a held button and an aim angle. Everything
 * else is decided here:
 *
 *   - whether the player has a grenade to throw at all;
 *   - **how long the button was held**, measured against the server clock, which
 *     is why a modified client cannot claim a full-power throw it never charged;
 *   - the resulting velocity, derived from the configured power curve;
 *   - the flight, the bounces, the fuse;
 *   - who the blast catches and how much it hurts them.
 *
 * A thrower is not immune to their own grenade -- the blast checks every living
 * player, including the one who threw it.
 */
export class GrenadeSystem {
  private readonly runtimes = new Map<string, GrenadeRuntime>();
  private nextId = 1;

  constructor(
    private readonly context: RoomContext,
    /** The playable limits; the closing walls bounce grenades too. */
    private readonly getBounds: () => WorldBounds,
  ) {}

  get activeCount(): number {
    return this.runtimes.size;
  }

  // -------------------------------------------------------------------------
  // Match lifecycle
  // -------------------------------------------------------------------------

  /** Issue a player their starting grenades. */
  resupply(player: PlayerState): void {
    const config = this.context.config.getGrenadeConfig();
    player.grenades = config.enabled ? clamp(config.startingCount, 0, config.maxCount) : 0;
    player.chargingGrenade = false;
  }

  /** Hand over grenades from a pickup, up to the carrying limit. */
  grant(player: PlayerState, amount: number): boolean {
    const config = this.context.config.getGrenadeConfig();
    if (!config.enabled || amount <= 0) return false;
    if (player.grenades >= config.maxCount) return false;

    player.grenades = Math.min(config.maxCount, player.grenades + Math.floor(amount));
    return true;
  }

  clear(): void {
    this.runtimes.clear();
    this.context.state.grenades.clear();
  }

  /** Cancel a wind-up, used when a player dies or a match ends. */
  cancelCharge(player: PlayerState, runtime: PlayerRuntime): void {
    runtime.grenadeChargeStartedAt = 0;
    player.chargingGrenade = false;
  }

  /** Remove a player's grenades when they leave, so no orphan can detonate. */
  destroyOwnedBy(ownerId: string): void {
    for (const [id, runtime] of this.runtimes) {
      if (runtime.state.ownerId === ownerId) {
        this.runtimes.delete(id);
        this.context.state.grenades.delete(id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Throwing
  // -------------------------------------------------------------------------

  /**
   * Resolve one input command's grenade intent.
   *
   * Pressing starts a wind-up; releasing throws. The charge is the time between
   * the two *as the server saw them*, clamped to the configured maximum.
   */
  processInput(player: PlayerState, runtime: PlayerRuntime, input: InputCommand, now: number): void {
    const config = this.context.config.getGrenadeConfig();
    if (!config.enabled) return;

    const wasCharging = runtime.lastInput.chargeGrenade;

    if (input.chargeGrenade && !wasCharging) {
      // Only start a wind-up that could actually end in a throw.
      if (!player.alive || player.grenades <= 0) return;
      runtime.grenadeChargeStartedAt = now;
      player.chargingGrenade = true;
      return;
    }

    if (!input.chargeGrenade && wasCharging) {
      this.release(player, runtime, input.aimAngle, now, config);
    }
  }

  private release(
    player: PlayerState,
    runtime: PlayerRuntime,
    aimAngle: number,
    now: number,
    config: GrenadeConfig,
  ): void {
    // Read the wind-up before clearing it. `chargingGrenade` is the flag rather
    // than the timestamp, because a charge legitimately starting at t=0 must not
    // be mistaken for "no charge at all".
    const wasCharging = player.chargingGrenade;
    const startedAt = runtime.grenadeChargeStartedAt;
    this.cancelCharge(player, runtime);

    if (!wasCharging) return;

    // Re-check on release, not just on press: the player may have died, or spent
    // their last grenade, in between.
    if (!player.alive || !player.inMatch) return;
    if (player.grenades <= 0) return;

    const heldMs = clamp(now - startedAt, 0, Math.max(1, config.maxChargeMs));
    const charge = config.maxChargeMs > 0 ? heldMs / config.maxChargeMs : 1;
    const speed = config.minThrowSpeed + (config.maxThrowSpeed - config.minThrowSpeed) * charge;

    player.grenades -= 1;
    this.spawn(player, aimAngle, speed, now, config);
  }

  private spawn(
    player: PlayerState,
    aimAngle: number,
    speed: number,
    now: number,
    config: GrenadeConfig,
  ): void {
    const state = new GrenadeState();
    state.id = `g${this.nextId++}`;
    state.ownerId = player.sessionId;

    // Leave the hand just clear of the thrower's own hitbox, so a grenade never
    // spawns inside them and immediately resolves a collision.
    const offset = PLAYER_HALF_WIDTH + config.radius + 2;
    state.x = player.x + Math.cos(aimAngle) * offset;
    state.y = player.y + Math.sin(aimAngle) * offset;
    state.velocityX = Math.cos(aimAngle) * speed;
    state.velocityY = Math.sin(aimAngle) * speed;
    state.fuseSeconds = Math.ceil(config.fuseMs / 1000);

    this.runtimes.set(state.id, { state, explodesAt: now + config.fuseMs });
    this.context.state.grenades.set(state.id, state);
  }

  // -------------------------------------------------------------------------
  // Flight
  // -------------------------------------------------------------------------

  update(dt: number, now: number): void {
    if (this.runtimes.size === 0) return;

    const config = this.context.config.getGrenadeConfig();
    const bounds = this.getBounds();

    for (const runtime of Array.from(this.runtimes.values())) {
      if (now >= runtime.explodesAt) {
        this.explode(runtime, config, now);
        continue;
      }

      this.advance(runtime, dt, config, bounds);

      const remaining = Math.ceil((runtime.explodesAt - now) / 1000);
      if (runtime.state.fuseSeconds !== remaining) {
        runtime.state.fuseSeconds = Math.max(0, remaining);
      }
    }
  }

  /**
   * Move a grenade one step, bouncing off anything solid.
   *
   * Axes are resolved separately, the same way player movement is: it makes a
   * grenade slide along a floor and bounce off a wall without needing real
   * surface normals, and it cannot squeeze through a corner.
   */
  private advance(
    runtime: GrenadeRuntime,
    dt: number,
    config: GrenadeConfig,
    bounds: WorldBounds,
  ): void {
    const state = runtime.state;
    const radius = Math.max(1, config.radius);

    state.velocityY += config.gravity * dt;

    // Sub-step so a fast throw cannot pass through a thin platform.
    const distance = Math.hypot(state.velocityX, state.velocityY) * dt;
    const steps = Math.max(1, Math.ceil(distance / radius));
    const stepDt = dt / steps;

    for (let step = 0; step < steps; step++) {
      const previousX = state.x;
      state.x += state.velocityX * stepDt;
      if (this.context.world.isBoxBlocked(state.x, state.y, radius, radius)) {
        state.x = previousX;
        state.velocityX *= -config.bounciness;
        state.velocityY *= config.friction;
      }

      const previousY = state.y;
      state.y += state.velocityY * stepDt;
      if (this.context.world.isBoxBlocked(state.x, state.y, radius, radius)) {
        state.y = previousY;
        state.velocityY *= -config.bounciness;
        state.velocityX *= config.friction;
      }
    }

    // The closing walls are solid for grenades too.
    const minX = bounds.left + radius;
    const maxX = bounds.right - radius;
    if (state.x < minX) {
      state.x = minX;
      state.velocityX = Math.abs(state.velocityX) * config.bounciness;
    } else if (state.x > maxX) {
      state.x = maxX;
      state.velocityX = -Math.abs(state.velocityX) * config.bounciness;
    }

    state.y = clamp(state.y, radius, this.context.arena.height - radius);
  }

  // -------------------------------------------------------------------------
  // Explosion
  // -------------------------------------------------------------------------

  /**
   * Detonate, damaging everything in range.
   *
   * Damage falls off linearly with distance from the blast, and the thrower is
   * checked like anyone else -- standing next to your own grenade hurts.
   */
  private explode(runtime: GrenadeRuntime, config: GrenadeConfig, now: number): void {
    const { state } = runtime;

    this.runtimes.delete(state.id);
    this.context.state.grenades.delete(state.id);

    // The blast itself is not this system's business: a grenade and a rocket go
    // off the same way, and the day they stopped doing so would be the day one
    // of them quietly stopped opening crates.
    detonate(
      this.context,
      {
        ...grenadeBlast(config),
        id: state.id,
        ownerId: state.ownerId,
        x: state.x,
        y: state.y,
        weaponId: "grenade",
      },
      now,
    );
  }
}
