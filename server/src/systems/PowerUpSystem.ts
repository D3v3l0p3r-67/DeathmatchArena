import {
  MatchState,
  PowerUpType,
  ServerMessage,
  FIXED_DELTA,
  PLAYER_HALF_HEIGHT,
  PLAYER_HALF_WIDTH,
  applyHealthRestore,
  clamp,
  stepBox,
  type BoxBody,
  type CrateDestroyedPayload,
  type PowerUpCollectedPayload,
  type PowerUpDefinition,
  type ArenaSpawnPoint,
} from "@deathmatch/shared";
import type { PlayerRuntime } from "../rooms/PlayerRuntime.js";
import type { RoomContext } from "../rooms/RoomContext.js";
import { CrateState } from "../rooms/schema/CrateState.js";
import { PendingCrateState } from "../rooms/schema/PendingCrateState.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";
import { PowerUpState } from "../rooms/schema/PowerUpState.js";
import type { GrenadeSystem } from "./GrenadeSystem.js";
import type { WeaponSystem } from "./WeaponSystem.js";

/** Server-only bookkeeping for a crate. Crucially, this is where its contents hide. */
interface CrateRuntime {
  state: CrateState;
  /** The power-up revealed when this crate breaks. Never synchronised. */
  contents: PowerUpDefinition;
  /** Index into the arena's power-up spawn points, so it can be freed again. */
  spawnIndex: number;
  expiresAt: number;
  /**
   * Where the crate is and how it is moving.
   *
   * Server-side, like the contents: a crate that clients could shove would be a
   * client deciding where a power-up ends up. `state.x`/`state.y` are written
   * from this every tick, so the wire carries the result and never the cause.
   */
  body: BoxBody;
  /**
   * The height the current fall started from, or null while resting.
   *
   * Kept rather than derived from velocity because what breaks a crate is *how
   * far it fell*, and a crate that clips a ledge on the way down has survived
   * the drop so far -- so each airborne stretch is measured on its own.
   */
  fellFrom: number | null;
}

/**
 * A crate that has been announced but has not landed.
 *
 * The contents live here for the length of the warning and are never
 * synchronised: knowing *where* a crate is coming is the point, knowing what is
 * in it would defeat the crate.
 */
interface PendingCrateRuntime {
  state: PendingCrateState;
  contents: PowerUpDefinition;
  spawnIndex: number;
  announcedAt: number;
  landsAt: number;
}

interface PickupRuntime {
  state: PowerUpState;
  definition: PowerUpDefinition;
  expiresAt: number;
}

/**
 * Applies one kind of power-up. Registered per `PowerUpType`, never per id.
 *
 * Returning false means the pickup had no effect and should stay on the ground —
 * a player already on full health, for instance.
 */
type PowerUpApplier = (
  powerUp: PowerUpDefinition,
  player: PlayerState,
  runtime: PlayerRuntime,
  now: number,
) => boolean;

/**
 * Crates, the power-ups inside them, and the effects they grant.
 *
 * The whole flow is server-owned and follows the configured data:
 *
 *   spawn timer -> free spawn point -> crate (contents chosen by weight)
 *   -> damage -> destruction -> revealed pickup -> contact -> effect
 *
 * Two properties are deliberate. First, a crate's contents live in `CrateRuntime`
 * and never reach the wire, so no client can see inside an unopened crate.
 * Second, nothing here branches on a specific power-up id: `appliers` is keyed by
 * *type*, so a new weapon power-up is a config entry and nothing more.
 */
export class PowerUpSystem {
  private readonly crates = new Map<string, CrateRuntime>();
  private readonly pending = new Map<string, PendingCrateRuntime>();
  private readonly pickups = new Map<string, PickupRuntime>();

  /** Spawn points currently holding a crate or an uncollected pickup. */
  private readonly occupiedSpawns = new Map<number, string>();

  private nextEntityId = 1;
  private nextSpawnAt = 0;

  private readonly appliers: Record<string, PowerUpApplier>;

  constructor(
    private readonly context: RoomContext,
    private readonly weapons: WeaponSystem,
    private readonly grenades: GrenadeSystem,
  ) {
    this.appliers = {
      [PowerUpType.WEAPON]: (powerUp, player, runtime) => {
        if (powerUp.type !== PowerUpType.WEAPON) return false;
        // Equipping through the weapon system means the magazine, reload state and
        // fire-rate cooldown are all reset the same way as at spawn.
        this.weapons.equip(player, runtime, powerUp.weaponId);
        return true;
      },

      [PowerUpType.HEALTH]: (powerUp, player) => {
        if (powerUp.type !== PowerUpType.HEALTH) return false;
        const maxHealth = this.context.config.getPlayerConfig().maxHealth;
        if (player.health >= maxHealth) return false;
        player.health = applyHealthRestore(player.health, maxHealth, powerUp);
        return true;
      },

      [PowerUpType.GRENADE]: (powerUp, player) => {
        if (powerUp.type !== PowerUpType.GRENADE) return false;
        // Declines when the player is already carrying the maximum, so the
        // pickup stays on the ground rather than being wasted.
        return this.grenades.grant(player, powerUp.amount);
      },

      [PowerUpType.SPEED]: (powerUp, player, runtime, now) => {
        if (powerUp.type !== PowerUpType.SPEED) return false;
        runtime.speedBoostEndsAt = now + powerUp.durationMs;
        runtime.movement.speedMultiplier = runtime.baseSpeedMultiplier * powerUp.speedMultiplier;
        player.speedMultiplier = runtime.movement.speedMultiplier;
        return true;
      },
    };
  }

  get activeCrateCount(): number {
    return this.crates.size;
  }

  get activePickupCount(): number {
    return this.pickups.size;
  }

  // -------------------------------------------------------------------------
  // Match lifecycle
  // -------------------------------------------------------------------------

  /** Called when a match starts: clear anything stale and arm the spawn timer. */
  onMatchStarted(now: number): void {
    this.clear();
    this.nextSpawnAt = now + this.context.config.getPowerUpSpawnConfig().firstSpawnDelayMs;
  }

  /** Called when a match ends: nothing should linger into the lobby. */
  clear(): void {
    this.crates.clear();
    this.pending.clear();
    this.pickups.clear();
    this.occupiedSpawns.clear();
    this.context.state.crates.clear();
    this.context.state.pendingCrates.clear();
    this.context.state.powerUps.clear();
    this.nextSpawnAt = 0;
  }

  // -------------------------------------------------------------------------
  // Per-tick
  // -------------------------------------------------------------------------

  update(now: number): void {
    // Effects keep ticking whatever the match state, so a boost cannot outlive a
    // match and follow a player into the next one.
    this.expireEffects(now);

    if (this.context.state.matchState !== MatchState.PLAYING) return;

    this.stepCrates(now);
    this.expireEntities(now);
    this.collectPickups(now);
    this.updatePending(now);
    this.maybeSpawnCrate(now);
  }

  /** Drop expired speed effects back to normal movement. */
  private expireEffects(now: number): void {
    for (const [sessionId, player] of this.context.state.players) {
      const runtime = this.context.runtimes.get(sessionId);
      if (!runtime || runtime.speedBoostEndsAt === 0) continue;

      if (now >= runtime.speedBoostEndsAt) {
        this.clearSpeedBoost(player, runtime);
        continue;
      }

      // Whole seconds only, so this field changes once a second rather than every patch.
      const remaining = Math.ceil((runtime.speedBoostEndsAt - now) / 1000);
      if (player.boostSeconds !== remaining) player.boostSeconds = remaining;
    }
  }

  /** Remove a player's speed effect. Also used when they die or a match resets. */
  clearSpeedBoost(player: PlayerState, runtime: PlayerRuntime): void {
    runtime.speedBoostEndsAt = 0;
    runtime.movement.speedMultiplier = runtime.baseSpeedMultiplier;
    player.speedMultiplier = runtime.baseSpeedMultiplier;
    player.boostSeconds = 0;
  }

  private expireEntities(now: number): void {
    for (const runtime of Array.from(this.crates.values())) {
      if (runtime.expiresAt > 0 && now >= runtime.expiresAt) {
        // An untouched crate simply vanishes -- it does not drop its contents,
        // otherwise expiry would be a free power-up for whoever stood nearby.
        this.removeCrate(runtime.state.id);
      }
    }

    for (const runtime of Array.from(this.pickups.values())) {
      if (runtime.expiresAt > 0 && now >= runtime.expiresAt) {
        this.removePickup(runtime.state.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  private maybeSpawnCrate(now: number): void {
    const config = this.context.config.getPowerUpSpawnConfig();
    if (config.intervalMs <= 0) return;
    if (now < this.nextSpawnAt) return;

    // Re-arm regardless of the outcome, so a full arena does not spawn a burst
    // the moment a single point frees up.
    this.nextSpawnAt = now + config.intervalMs;

    // Announced crates count towards the limit: three warnings and no crates is
    // still three crates on the way.
    if (this.crates.size + this.pending.size >= config.maxActiveCrates) return;

    const spawnIndex = this.pickFreeSpawnIndex();
    if (spawnIndex === -1) return;

    const contents = this.context.config.pickWeightedPowerUp(this.context.random);
    if (!contents) return;

    // With no warning configured, land it immediately -- the announcement is a
    // courtesy, not a rule of the game.
    if (config.warningMs <= 0) {
      this.spawnCrate(spawnIndex, contents, now);
      return;
    }

    this.announceCrate(spawnIndex, contents, now, config.warningMs);
  }

  /**
   * Mark where a crate is going to land.
   *
   * The spawn point is reserved from this moment, so nothing else claims it
   * while the warning runs and the crate really does arrive where it was
   * promised. The contents are held here and never synchronised -- a warning
   * gives away the place, never the prize.
   */
  private announceCrate(
    spawnIndex: number,
    contents: PowerUpDefinition,
    now: number,
    warningMs: number,
  ): void {
    const point = this.enabledSpawnPoints()[spawnIndex]!;
    const crate = this.context.config.getCrateConfig();

    const state = new PendingCrateState();
    state.id = `w${this.nextEntityId++}`;
    state.x = point.x;
    state.y = point.y;
    state.width = crate.width;
    state.height = crate.height;
    state.progress = 0;

    this.pending.set(state.id, {
      state,
      contents,
      spawnIndex,
      announcedAt: now,
      landsAt: now + warningMs,
    });
    this.occupiedSpawns.set(spawnIndex, state.id);
    this.context.state.pendingCrates.set(state.id, state);

    this.context.logger.debug("Crate announced", { warning: state.id, landsIn: warningMs });
  }

  /**
   * Advance the warnings, and land the ones whose time is up.
   *
   * `progress` is recomputed every tick rather than counted down, so a warning
   * stays truthful even if the configured time is changed underneath it.
   */
  private updatePending(now: number): void {
    if (this.pending.size === 0) return;

    for (const [id, entry] of Array.from(this.pending)) {
      const span = Math.max(1, entry.landsAt - entry.announcedAt);
      const progress = clamp((now - entry.announcedAt) / span, 0, 1);

      if (progress < 1) {
        entry.state.progress = progress;
        continue;
      }

      // Landing: the reservation passes straight from the warning to the crate,
      // so the point is never briefly free for something else to take.
      this.pending.delete(id);
      this.context.state.pendingCrates.delete(id);
      this.occupiedSpawns.delete(entry.spawnIndex);
      this.spawnCrate(entry.spawnIndex, entry.contents, now);
    }
  }

  /**
   * The points crates may actually use.
   *
   * Disabled points are filtered out here rather than at load, so an
   * administrator switching one off reaches a running match at the next spawn.
   */
  private enabledSpawnPoints(): readonly ArenaSpawnPoint[] {
    return this.context.arena.powerUpSpawns.filter((point) => point.enabled);
  }

  /** Warnings and crates alike hold a spawn point, so nothing doubles up. */
  private pickFreeSpawnIndex(): number {
    const points = this.enabledSpawnPoints();
    const free: number[] = [];
    for (let index = 0; index < points.length; index++) {
      if (!this.occupiedSpawns.has(index)) free.push(index);
    }
    if (free.length === 0) return -1;

    return free[Math.floor(this.context.random() * free.length)] ?? free[0]!;
  }

  private spawnCrate(spawnIndex: number, contents: PowerUpDefinition, now: number): void {
    const point: ArenaSpawnPoint = this.enabledSpawnPoints()[spawnIndex]!;
    const config = this.context.config.getCrateConfig();

    const state = new CrateState();
    state.id = `c${this.nextEntityId++}`;
    state.x = point.x;
    state.y = point.y;
    state.width = config.width;
    state.height = config.height;
    state.health = config.health;
    state.maxHealth = config.health;

    this.crates.set(state.id, {
      state,
      contents,
      spawnIndex,
      expiresAt: config.lifetimeMs > 0 ? now + config.lifetimeMs : 0,
      // Starts resting where it landed, which is what it did before it had a
      // body at all -- the first tick settles it onto whatever is underneath.
      body: { x: state.x, y: state.y, velocityX: 0, velocityY: 0, onGround: false },
      fellFrom: null,
    });
    this.occupiedSpawns.set(spawnIndex, state.id);
    this.context.state.crates.set(state.id, state);

    this.context.logger.debug("Crate spawned", { crate: state.id, contents: contents.id });
  }

  /**
   * Force a crate to appear, optionally with chosen contents.
   *
   * Used only by authorized debug tooling. It goes through the same spawn path as
   * the timer, so a debug crate is indistinguishable from a natural one, and it
   * still refuses to occupy a spawn point that is already taken.
   *
   * Returns the name of the power-up inside, or null when nowhere is free.
   */
  /**
   * Put a crate on a specific spawn point, with chosen contents.
   *
   * The campaign's way of dressing a level: placed pickups and destructible
   * scenery are ordinary crates, spawned deliberately instead of on the
   * timer. Returns the crate id, or null when the point is taken or unknown.
   */
  spawnCrateAt(spawnIndex: number, contents: PowerUpDefinition | null, now: number): string | null {
    const points = this.enabledSpawnPoints();
    if (spawnIndex < 0 || spawnIndex >= points.length) return null;
    if (this.occupiedSpawns.has(spawnIndex)) return null;

    const chosen = contents ?? this.context.config.pickWeightedPowerUp(this.context.random);
    if (!chosen) return null;

    this.spawnCrate(spawnIndex, chosen, now);
    return this.occupiedSpawns.get(spawnIndex) ?? null;
  }

  debugSpawnCrate(contents: PowerUpDefinition | null, now: number): string | null {
    const spawnIndex = this.pickFreeSpawnIndex();
    if (spawnIndex === -1) return null;

    const chosen = contents ?? this.context.config.pickWeightedPowerUp(this.context.random);
    if (!chosen) return null;

    this.spawnCrate(spawnIndex, chosen, now);
    return chosen.name;
  }

  // -------------------------------------------------------------------------
  // Damage and destruction
  // -------------------------------------------------------------------------

  /**
   * Apply damage to a crate. The only way a crate's health ever changes.
   *
   * Called from projectile and melee resolution, both of which computed the hit
   * server-side — a client never names a crate it claims to have hit.
   */
  /**
   * Move every crate: gravity, shoves, and the landing that can break one.
   *
   * A crate is not solid to players -- shots pass through it and it is
   * shootable, but you walk through it -- so "pushing" is exactly that: walk
   * into one and it is carried along in front of you. Making crates solid
   * instead would put a moving obstacle into the collision the client predicts
   * against, which is a far larger promise than "a crate can be shoved".
   */
  private stepCrates(now: number): void {
    const config = this.context.config.getCrateConfig();
    if (!config.physicsEnabled) return;

    const halfWidth = config.width / 2;
    const halfHeight = config.height / 2;

    for (const runtime of Array.from(this.crates.values())) {
      const { body } = runtime;

      this.pushCrate(runtime, config.pushSpeed, halfWidth, halfHeight);

      const wasAirborne = !body.onGround;
      stepBox(body, halfWidth, halfHeight, FIXED_DELTA, this.context.world, config);

      if (!body.onGround) {
        // Airborne: remember the top of this fall, and only the top. Rising
        // (a blast, a bounce) restarts the measurement from the new peak.
        runtime.fellFrom = runtime.fellFrom === null ? body.y : Math.min(runtime.fellFrom, body.y);
      } else {
        if (wasAirborne && runtime.fellFrom !== null) {
          this.applyFallDamage(runtime, body.y - runtime.fellFrom, config, now);
        }
        runtime.fellFrom = null;
      }

      // The wire carries where it ended up, never how it got there.
      runtime.state.x = body.x;
      runtime.state.y = body.y;
    }
  }

  /**
   * Carry a crate in front of anyone walking into it.
   *
   * A speed rather than a force, so a crate moves with you at a believable pace
   * whatever weapon you happen to be carrying, and only when you are actually
   * moving towards it -- standing inside one does not slowly drag it away.
   */
  private pushCrate(
    runtime: CrateRuntime,
    pushSpeed: number,
    halfWidth: number,
    halfHeight: number,
  ): void {
    if (pushSpeed <= 0) return;
    const { body } = runtime;

    for (const player of this.context.state.players.values()) {
      if (!player.alive || !player.inMatch) continue;
      if (Math.abs(player.x - body.x) > halfWidth + PLAYER_HALF_WIDTH) continue;
      if (Math.abs(player.y - body.y) > halfHeight + PLAYER_HALF_HEIGHT) continue;

      // Shoved away from the player, and only if they are heading that way.
      const away = Math.sign(body.x - player.x) || (player.facing >= 0 ? 1 : -1);
      if (Math.sign(player.velocityX) !== away) continue;

      const wanted = away * Math.min(pushSpeed, Math.abs(player.velocityX));
      if (Math.abs(wanted) > Math.abs(body.velocityX) || Math.sign(body.velocityX) !== away) {
        body.velocityX = wanted;
      }
    }
  }

  /** A drop long enough to matter breaks a crate open by itself. */
  private applyFallDamage(
    runtime: CrateRuntime,
    drop: number,
    config: ReturnType<RoomContext["config"]["getCrateConfig"]>,
    now: number,
  ): void {
    const beyond = drop - config.fallDamageMinDrop;
    if (beyond <= 0 || config.fallDamagePer100px <= 0) return;

    const damage = Math.round((beyond / 100) * config.fallDamagePer100px);
    if (damage <= 0) return;

    // No attacker: nobody gets credit for gravity, and the kill feed reads the
    // same way it does for a trap.
    this.damageCrate(runtime.state.id, damage, "", now);
  }

  /**
   * A crate's physics body, for tests and debug tooling.
   *
   * Read-write on purpose: placing a crate mid-air is the only way to test a
   * fall, and every spawn point is deliberately on the ground.
   */
  crateBody(crateId: string): BoxBody | null {
    return this.crates.get(crateId)?.body ?? null;
  }

  damageCrate(crateId: string, amount: number, attackerId: string, now: number, impulseX = 0): void {
    const runtime = this.crates.get(crateId);
    if (!runtime) return;

    /*
     * A hit shoves as well as damages. Scaled by the shot's own direction and
     * added rather than assigned, so sustained fire walks a crate along instead
     * of pinning it at one speed -- and so a shotgun's nine pellets shove nine
     * times, exactly as they damage nine times.
     */
    const config = this.context.config.getCrateConfig();
    if (config.physicsEnabled && impulseX !== 0 && config.shotImpulse > 0) {
      runtime.body.velocityX += Math.sign(impulseX) * config.shotImpulse;
    }

    const damage = Math.max(0, Math.round(amount));
    runtime.state.health = Math.max(0, runtime.state.health - damage);
    if (runtime.state.health > 0) return;

    this.destroyCrate(runtime, attackerId, now);
  }

  /** Break a crate open and reveal what it held. */
  private destroyCrate(runtime: CrateRuntime, destroyedBy: string, now: number): void {
    const { state, contents, spawnIndex } = runtime;

    this.crates.delete(state.id);
    this.context.state.crates.delete(state.id);

    const payload: CrateDestroyedPayload = {
      crateId: state.id,
      x: state.x,
      y: state.y,
      destroyedBy,
    };
    this.context.broadcast(ServerMessage.CRATE_DESTROYED, payload);

    this.spawnPickup(contents, state.x, state.y, spawnIndex, now);
  }

  private spawnPickup(
    definition: PowerUpDefinition,
    x: number,
    y: number,
    spawnIndex: number,
    now: number,
  ): void {
    const config = this.context.config.getPowerUpSpawnConfig();

    const state = new PowerUpState();
    state.id = `u${this.nextEntityId++}`;
    state.powerUpId = definition.id;
    state.x = x;
    state.y = y;

    this.pickups.set(state.id, {
      state,
      definition,
      expiresAt: config.revealedLifetimeMs > 0 ? now + config.revealedLifetimeMs : 0,
    });
    // The spawn point stays occupied until the pickup is gone, so a new crate
    // cannot land on top of an uncollected power-up.
    this.occupiedSpawns.set(spawnIndex, state.id);
    this.context.state.powerUps.set(state.id, state);
  }

  // -------------------------------------------------------------------------
  // Collection
  // -------------------------------------------------------------------------

  /** Give any living player standing on a pickup its effect. */
  private collectPickups(now: number): void {
    if (this.pickups.size === 0) return;

    const radius = this.context.config.getPowerUpSpawnConfig().pickupRadius;
    const radiusSquared = radius * radius;

    for (const pickup of Array.from(this.pickups.values())) {
      for (const [sessionId, player] of this.context.state.players) {
        if (!player.alive || !player.inMatch) continue;

        const dx = player.x - pickup.state.x;
        const dy = player.y - pickup.state.y;
        if (dx * dx + dy * dy > radiusSquared) continue;

        const runtime = this.context.runtimes.get(sessionId);
        if (!runtime) continue;

        if (this.applyPowerUp(pickup.definition, player, runtime, now)) {
          this.announceCollection(pickup, player);
          this.removePickup(pickup.state.id);
          break;
        }
      }
    }
  }

  /**
   * Apply a power-up to a player.
   *
   * Dispatch is by `type` through the applier table, so this method never learns
   * that a shotgun or a medkit exists.
   */
  applyPowerUp(
    definition: PowerUpDefinition,
    player: PlayerState,
    runtime: PlayerRuntime,
    now: number,
  ): boolean {
    const applier = this.appliers[definition.type];
    if (!applier) {
      this.context.logger.warn("No applier registered for power-up type", {
        powerUp: definition.id,
        type: definition.type,
      });
      return false;
    }
    return applier(definition, player, runtime, now);
  }

  private announceCollection(pickup: PickupRuntime, player: PlayerState): void {
    const payload: PowerUpCollectedPayload = {
      sessionId: player.sessionId,
      powerUpId: pickup.definition.id,
      name: pickup.definition.name,
      x: pickup.state.x,
      y: pickup.state.y,
    };
    this.context.broadcast(ServerMessage.POWERUP_COLLECTED, payload);
  }

  // -------------------------------------------------------------------------
  // Removal
  // -------------------------------------------------------------------------

  private removeCrate(crateId: string): void {
    const runtime = this.crates.get(crateId);
    if (!runtime) return;

    this.crates.delete(crateId);
    this.context.state.crates.delete(crateId);
    this.freeSpawn(runtime.spawnIndex, crateId);
  }

  private removePickup(pickupId: string): void {
    if (!this.pickups.delete(pickupId)) return;
    this.context.state.powerUps.delete(pickupId);

    for (const [index, occupantId] of this.occupiedSpawns) {
      if (occupantId === pickupId) {
        this.occupiedSpawns.delete(index);
        break;
      }
    }
  }

  /** Release a spawn point, but only if the expected entity still holds it. */
  private freeSpawn(spawnIndex: number, expectedOccupantId: string): void {
    if (this.occupiedSpawns.get(spawnIndex) === expectedOccupantId) {
      this.occupiedSpawns.delete(spawnIndex);
    }
  }
}
