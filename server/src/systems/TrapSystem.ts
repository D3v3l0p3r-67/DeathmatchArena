import {
  MatchState,
  PLAYER_HALF_HEIGHT,
  PLAYER_HALF_WIDTH,
  TrapActivation,
  TrapDamageMode,
  TrapMotion,
  TrapPhase,
  directionVector,
  resolveTrap,
  trapParamNumber,
  trapParamString,
  trapRegistry,
  type ArenaDefinition,
  type ResolvedTrap,
  type TrapPhaseValue,
} from "@deathmatch/shared";
import { DamageSource, type RoomContext } from "../rooms/RoomContext.js";
import { TrapState } from "../rooms/schema/TrapState.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";

/** Server-only bookkeeping for one placed trap. */
interface TrapRuntime {
  resolved: ResolvedTrap;
  state: TrapState;
  phase: TrapPhaseValue;
  /** Timestamp the current phase ends. 0 means "until something changes it". */
  phaseEndsAt: number;

  /** Unit vector the trap travels along, and how far it may go. */
  direction: { x: number; y: number };
  travel: number;
  /** Distance travelled from the placed position, in px. */
  offset: number;
  /** Current speed along `direction`, used by falling traps. */
  fallSpeed: number;
  /** Which way a patrolling trap is currently going. */
  patrolSign: 1 | -1;

  /** Players already hurt by this activation, for `on-enter` damage. */
  struck: Set<string>;
  /** Fractional damage carried between ticks, for `continuous` damage. */
  carry: Map<string, number>;
}

/**
 * Traps: when they go off, what they hit, and how much it hurts.
 *
 * Entirely server-side, and entirely *generic*. There is no `if (trap.type ===
 * "spikes")` anywhere here -- a trap type is a description (how its body moves,
 * how it meters damage) and this system runs that description. Adding a hazard is
 * a registration in the trap catalogue, not a branch in this file.
 *
 * Clients receive position, size and phase so they can draw a trap and read its
 * warning. They never report a hit, never decide whether a trap is active, and
 * never influence how much damage it does.
 */
export class TrapSystem {
  private readonly runtimes = new Map<string, TrapRuntime>();

  constructor(private readonly context: RoomContext) {}

  get activeCount(): number {
    let count = 0;
    for (const runtime of this.runtimes.values()) {
      if (runtime.phase === TrapPhase.ACTIVE) count++;
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Build the trap simulation from an arena definition.
   *
   * Called once when the room takes on an arena. A trap whose type is unknown or
   * whose placement is disabled is simply not built, so it costs nothing at
   * runtime and cannot be triggered.
   */
  load(arena: ArenaDefinition): void {
    this.clear();

    const defaults = this.context.config.getTrapConfig();

    for (const definition of arena.traps) {
      if (!definition.enabled) continue;

      const resolved = resolveTrap(definition, defaults, trapRegistry);
      if (!resolved) {
        this.context.logger.warn("Skipping trap of unknown type", {
          trap: definition.id,
          type: definition.type,
        });
        continue;
      }

      const state = new TrapState();
      state.id = definition.id;
      state.trapType = definition.type;
      state.x = definition.x;
      state.y = definition.y;
      state.width = Math.round(definition.width);
      state.height = Math.round(definition.height);
      state.phase = TrapPhase.IDLE;

      this.runtimes.set(definition.id, {
        resolved,
        state,
        phase: TrapPhase.IDLE,
        phaseEndsAt: 0,
        direction: directionVector(trapParamString(resolved, "direction", "down")),
        travel: trapParamNumber(resolved, "travel", 0),
        offset: 0,
        fallSpeed: 0,
        patrolSign: 1,
        struck: new Set(),
        carry: new Map(),
      });

      this.context.state.traps.set(definition.id, state);
    }

    if (this.runtimes.size > 0) {
      this.context.logger.info("Traps loaded", { arena: arena.id, traps: this.runtimes.size });
    }
  }

  /** Put every trap back to its resting position and phase. */
  reset(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.phase = TrapPhase.IDLE;
      runtime.phaseEndsAt = 0;
      runtime.offset = 0;
      runtime.fallSpeed = 0;
      runtime.patrolSign = 1;
      runtime.struck.clear();
      runtime.carry.clear();
      this.writeBack(runtime);
    }
  }

  clear(): void {
    this.runtimes.clear();
    this.context.state.traps.clear();
  }

  /** Forget a departed player, so their contact state cannot leak into a rejoin. */
  onPlayerRemoved(sessionId: string): void {
    for (const runtime of this.runtimes.values()) {
      runtime.struck.delete(sessionId);
      runtime.carry.delete(sessionId);
    }
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  update(dt: number, now: number): void {
    if (this.runtimes.size === 0) return;

    // The master switch is read every tick rather than at load, so turning traps
    // off in the admin interface (or the debug console) takes effect in the very
    // next tick of a running match.
    const enabled = this.context.config.getTrapConfig().enabled;
    const playing = this.context.state.matchState === MatchState.PLAYING;
    const targets = playing ? this.livingPlayers() : [];

    for (const runtime of this.runtimes.values()) {
      if (!enabled || !playing) {
        this.retire(runtime, dt);
        continue;
      }

      this.advancePhase(runtime, now, targets);
      this.advanceMotion(runtime, dt);
      if (runtime.phase === TrapPhase.ACTIVE) this.applyDamage(runtime, dt, targets);
      this.writeBack(runtime);
    }
  }

  /**
   * Wind a trap down when nothing is being played.
   *
   * Between matches a trap must not stay lethal, but it should not teleport home
   * either -- a crusher visibly withdrawing reads far better in a lobby than one
   * that snaps back the instant the match ends.
   */
  private retire(runtime: TrapRuntime, dt: number): void {
    if (runtime.phase !== TrapPhase.IDLE) {
      runtime.phase = TrapPhase.IDLE;
      runtime.phaseEndsAt = 0;
      runtime.struck.clear();
      runtime.carry.clear();
    }
    this.advanceMotion(runtime, dt);
    this.writeBack(runtime);
  }

  /**
   * The activation state machine, identical for every trap type.
   *
   *   idle → arming → active → cooldown → idle
   *
   * What differs is only what moves it out of `idle`: a permanent hazard leaves
   * immediately and never comes back, a periodic one cycles by itself, and a
   * proximity or contact trap waits for a player.
   */
  private advancePhase(runtime: TrapRuntime, now: number, targets: readonly PlayerState[]): void {
    const { activation } = runtime.resolved.definition;
    const { activationDelayMs, activeDurationMs, cooldownMs } = runtime.resolved;

    switch (runtime.phase) {
      case TrapPhase.IDLE: {
        if (!this.shouldTrigger(runtime, activation, targets)) return;
        // A trap with no wind-up goes straight to dangerous; anything else gets
        // its warning period first.
        if (activationDelayMs > 0) {
          runtime.phase = TrapPhase.ARMING;
          runtime.phaseEndsAt = now + activationDelayMs;
        } else {
          this.activate(runtime, now);
        }
        return;
      }

      case TrapPhase.ARMING: {
        if (now >= runtime.phaseEndsAt) this.activate(runtime, now);
        return;
      }

      case TrapPhase.ACTIVE: {
        // A permanent hazard, or one configured with no duration, stays active.
        if (runtime.phaseEndsAt === 0 || now < runtime.phaseEndsAt) return;
        runtime.phase = TrapPhase.COOLDOWN;
        runtime.phaseEndsAt = now + cooldownMs;
        runtime.struck.clear();
        runtime.carry.clear();
        return;
      }

      default: {
        if (now >= runtime.phaseEndsAt) {
          runtime.phase = TrapPhase.IDLE;
          runtime.phaseEndsAt = 0;
        }
      }
    }

    void activeDurationMs;
  }

  private activate(runtime: TrapRuntime, now: number): void {
    const permanent = runtime.resolved.definition.activation === TrapActivation.ALWAYS;
    const duration = runtime.resolved.activeDurationMs;

    runtime.phase = TrapPhase.ACTIVE;
    // Zero duration means "until something else stops it", which is exactly what
    // a permanent hazard wants -- and what a misconfigured one gets, visibly.
    runtime.phaseEndsAt = permanent || duration <= 0 ? 0 : now + duration;
    runtime.struck.clear();
    runtime.carry.clear();
    runtime.fallSpeed = 0;
  }

  private shouldTrigger(
    runtime: TrapRuntime,
    activation: string,
    targets: readonly PlayerState[],
  ): boolean {
    switch (activation) {
      case TrapActivation.ALWAYS:
      case TrapActivation.PERIODIC:
        return true;

      case TrapActivation.CONTACT:
        return targets.some((player) => this.overlaps(runtime, player));

      default: {
        // Proximity: measured from the trap's centre to the player's centre, so a
        // wide trap is not accidentally easier to set off from its edge.
        const radius = runtime.resolved.triggerRadius;
        if (radius <= 0) return false;
        const box = this.currentBox(runtime);
        const centreX = box.x + box.width / 2;
        const centreY = box.y + box.height / 2;
        return targets.some(
          (player) => squaredDistance(centreX, centreY, player.x, player.y) <= radius * radius,
        );
      }
    }
  }

  /**
   * Move the trap body.
   *
   * Every motion is expressed as a distance travelled along one direction, which
   * is what keeps collision, damage and rendering working off a single rectangle
   * no matter what kind of trap it is.
   */
  private advanceMotion(runtime: TrapRuntime, dt: number): void {
    const { motion } = runtime.resolved.type;
    if (motion === TrapMotion.STATIC || runtime.travel <= 0) return;

    const speed = runtime.resolved.moveSpeed;

    switch (motion) {
      case TrapMotion.PATROL: {
        // Runs its route whatever the phase: a saw does not stop to think.
        runtime.offset += speed * runtime.patrolSign * dt;
        if (runtime.offset >= runtime.travel) {
          runtime.offset = runtime.travel;
          runtime.patrolSign = -1;
        } else if (runtime.offset <= 0) {
          runtime.offset = 0;
          runtime.patrolSign = 1;
        }
        return;
      }

      case TrapMotion.SLAM: {
        if (runtime.phase === TrapPhase.ACTIVE) {
          runtime.offset = Math.min(runtime.travel, runtime.offset + speed * dt);
        } else {
          // Withdrawing is deliberately slower than striking: the strike should
          // be the part that feels sudden.
          runtime.offset = Math.max(0, runtime.offset - speed * 0.6 * dt);
        }
        return;
      }

      default: {
        // Drop: accelerates while active, is winched back up otherwise.
        if (runtime.phase === TrapPhase.ACTIVE) {
          runtime.fallSpeed += trapParamNumber(runtime.resolved, "fallGravity", 2400) * dt;
          runtime.offset = Math.min(runtime.travel, runtime.offset + runtime.fallSpeed * dt);
        } else {
          runtime.fallSpeed = 0;
          runtime.offset = Math.max(0, runtime.offset - speed * dt);
        }
      }
    }
  }

  /**
   * Hurt whoever the trap is touching.
   *
   * Both metering modes exist because both are needed: a fire that damages per
   * second and spikes that damage per contact are the same trap with a different
   * answer to "what does standing still do to you".
   */
  private applyDamage(runtime: TrapRuntime, dt: number, targets: readonly PlayerState[]): void {
    const mode = runtime.resolved.type.damageMode;
    if (mode === TrapDamageMode.LAUNCH) {
      this.applyLaunch(runtime, targets);
      return;
    }

    const damage = runtime.resolved.damage;
    if (damage <= 0) return;

    const continuous = mode === TrapDamageMode.CONTINUOUS;
    const box = this.currentBox(runtime);
    const hitX = box.x + box.width / 2;
    const hitY = box.y + box.height / 2;

    for (const player of targets) {
      const touching = this.overlaps(runtime, player);

      if (!touching) {
        // Leaving re-arms the trap against this player, so walking back onto
        // spikes hurts again.
        runtime.struck.delete(player.sessionId);
        runtime.carry.delete(player.sessionId);
        continue;
      }

      if (!continuous) {
        if (runtime.struck.has(player.sessionId)) continue;
        runtime.struck.add(player.sessionId);
        this.hurt(player, damage, hitX, hitY, runtime);
        continue;
      }

      // Damage is a rate, and a tick is a sixtieth of a second, so almost every
      // tick owes a fraction of a point. Carrying the remainder is what makes
      // "25 per second" actually deal 25 per second.
      const owed = (runtime.carry.get(player.sessionId) ?? 0) + damage * dt;
      const whole = Math.floor(owed);
      runtime.carry.set(player.sessionId, owed - whole);
      if (whole > 0) this.hurt(player, whole, hitX, hitY, runtime);
    }
  }

  /**
   * Throw whoever is standing on it.
   *
   * Once per contact, like spikes: a pad that fired every tick would pin
   * somebody in the air above it. The push goes through the same knockback the
   * weapons use, so the player's configured limit caps a mistyped pad rather
   * than launching anyone into orbit -- and the client predicts it exactly as it
   * predicts being shot.
   */
  private applyLaunch(runtime: TrapRuntime, targets: readonly PlayerState[]): void {
    const force = trapParamNumber(runtime.resolved, "force", 2.6);
    if (force <= 0) return;

    for (const player of targets) {
      if (!this.overlaps(runtime, player)) {
        runtime.struck.delete(player.sessionId);
        continue;
      }

      if (runtime.struck.has(player.sessionId)) continue;
      runtime.struck.add(player.sessionId);
      // Straight up, and no lift on top of it: the force *is* the lift.
      this.context.applyKnockback(player.sessionId, 0, -1, force, false);
    }
  }

  private hurt(
    player: PlayerState,
    amount: number,
    x: number,
    y: number,
    runtime: TrapRuntime,
  ): void {
    // No attacker: a trap kill is environmental, and the kill feed says so.
    this.context.applyDamage(
      player.sessionId,
      "",
      amount,
      x,
      y,
      `trap:${runtime.resolved.type.id}`,
      DamageSource.ENVIRONMENT,
    );
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  /** Where the trap body is right now, after its motion offset. */
  private currentBox(runtime: TrapRuntime): { x: number; y: number; width: number; height: number } {
    const definition = runtime.resolved.definition;
    return {
      x: definition.x + runtime.direction.x * runtime.offset,
      y: definition.y + runtime.direction.y * runtime.offset,
      width: definition.width,
      height: definition.height,
    };
  }

  private overlaps(runtime: TrapRuntime, player: PlayerState): boolean {
    const box = this.currentBox(runtime);
    return (
      player.x - PLAYER_HALF_WIDTH < box.x + box.width &&
      player.x + PLAYER_HALF_WIDTH > box.x &&
      player.y - PLAYER_HALF_HEIGHT < box.y + box.height &&
      player.y + PLAYER_HALF_HEIGHT > box.y
    );
  }

  private livingPlayers(): PlayerState[] {
    const players: PlayerState[] = [];
    for (const player of this.context.state.players.values()) {
      if (player.alive && player.inMatch) players.push(player);
    }
    return players;
  }

  /** Mirror the trap's position and phase into the synchronised state. */
  private writeBack(runtime: TrapRuntime): void {
    const box = this.currentBox(runtime);
    if (runtime.state.x !== box.x) runtime.state.x = box.x;
    if (runtime.state.y !== box.y) runtime.state.y = box.y;
    if (runtime.state.phase !== runtime.phase) runtime.state.phase = runtime.phase;
  }
}

function squaredDistance(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}
