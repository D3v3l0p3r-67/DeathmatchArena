import {
  MatchState,
  PowerUpType,
  ServerMessage,
  applyHealthRestore,
  type CrateDestroyedPayload,
  type PowerUpCollectedPayload,
  type PowerUpDefinition,
  type ArenaSpawnPoint,
} from "@deathmatch/shared";
import type { PlayerRuntime } from "../rooms/PlayerRuntime.js";
import type { RoomContext } from "../rooms/RoomContext.js";
import { CrateState } from "../rooms/schema/CrateState.js";
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
        runtime.movement.speedMultiplier = powerUp.speedMultiplier;
        player.speedMultiplier = powerUp.speedMultiplier;
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
    this.pickups.clear();
    this.occupiedSpawns.clear();
    this.context.state.crates.clear();
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

    this.expireEntities(now);
    this.collectPickups(now);
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
    runtime.movement.speedMultiplier = 1;
    player.speedMultiplier = 1;
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

    if (this.crates.size >= config.maxActiveCrates) return;

    const spawnIndex = this.pickFreeSpawnIndex();
    if (spawnIndex === -1) return;

    const contents = this.context.config.pickWeightedPowerUp(this.context.random);
    if (!contents) return;

    this.spawnCrate(spawnIndex, contents, now);
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

  /** Uniformly random choice among unoccupied power-up spawn points. */
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
  damageCrate(crateId: string, amount: number, attackerId: string, now: number): void {
    const runtime = this.crates.get(crateId);
    if (!runtime) return;

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
