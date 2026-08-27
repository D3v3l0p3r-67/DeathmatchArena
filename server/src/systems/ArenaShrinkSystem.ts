import { MatchState, PLAYER_HALF_WIDTH, type WorldBounds } from "@deathmatch/shared";
import { DamageSource, type RoomContext } from "../rooms/RoomContext.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";

/**
 * The closing walls that end a stalling match.
 *
 * After a configured time the arena's left and right edges start advancing
 * towards each other, squeezing the survivors together until someone wins. The
 * walls are authoritative: the server owns their positions, and the shared
 * movement step clamps players to them, so a player is physically pushed ahead
 * of a wall rather than politely asked to move.
 *
 * A player the walls are pressing against also takes damage. Without that, one
 * wedged between a closing wall and solid geometry would simply stop moving, and
 * the match could stall in exactly the situation the shrink exists to resolve.
 */
export class ArenaShrinkSystem {
  /** Fractional damage carried between ticks, so slow rates are not lost to rounding. */
  private readonly pendingCrushDamage = new Map<string, number>();

  /**
   * Whether the current game mode wants closing walls at all.
   *
   * A supplier rather than a flag because the answer belongs to the match's
   * mode instance (and, behind it, to configuration an admin can retune
   * mid-match). `MatchManager` wires it; until then everything is allowed,
   * which is exactly the pre-modes behaviour.
   */
  private modeAllows: () => boolean = () => true;

  constructor(private readonly context: RoomContext) {}

  setModeGate(allows: () => boolean): void {
    this.modeAllows = allows;
  }

  /** Reset the walls to the arena's own edges and show the initial countdown. */
  onMatchStarted(): void {
    const state = this.context.state;
    const config = this.context.config.getArenaShrinkConfig();

    state.shrinkLeft = 0;
    state.shrinkRight = this.context.arena.width;
    state.shrinking = false;
    state.shrinkCountdownSeconds =
      config.enabled && this.modeAllows()
        ? Math.ceil(Math.max(0, config.startAfterMs) / 1000)
        : 0;

    this.pendingCrushDamage.clear();
  }

  /** Put the walls back and stop, used when a match ends or a room recycles. */
  reset(): void {
    const state = this.context.state;
    state.shrinkLeft = 0;
    state.shrinkRight = this.context.arena.width;
    state.shrinking = false;
    state.shrinkCountdownSeconds = 0;
    this.pendingCrushDamage.clear();
  }

  /** The limits the movement step should clamp players to right now. */
  get bounds(): WorldBounds {
    return { left: this.context.state.shrinkLeft, right: this.context.state.shrinkRight };
  }

  update(dt: number, now: number): void {
    if (this.context.state.matchState !== MatchState.PLAYING) return;

    const config = this.context.config.getArenaShrinkConfig();
    if (!config.enabled) return;

    // A mode that forbids the walls (Flag Hunt runs on its own clock) keeps
    // the arena at full size for the whole match. Checked every tick so an
    // admin flipping the setting mid-match takes effect at once -- including
    // putting the walls back if they had already started.
    if (!this.modeAllows()) {
      if (this.context.state.shrinking || this.context.state.shrinkCountdownSeconds !== 0) {
        this.reset();
      }
      return;
    }

    const startedAt = this.context.state.matchStartedAt;
    if (startedAt <= 0) return;

    // Derived from the match clock every tick rather than latched at match start,
    // so retuning `startAfterMs` through the debug console takes effect at once
    // instead of only for the next match.
    const startsAt = startedAt + Math.max(0, config.startAfterMs);

    if (now < startsAt) {
      // Whole seconds only, so the countdown changes once a second.
      const remaining = Math.ceil((startsAt - now) / 1000);
      if (this.context.state.shrinkCountdownSeconds !== remaining) {
        this.context.state.shrinkCountdownSeconds = remaining;
      }
      return;
    }

    if (!this.context.state.shrinking) {
      this.context.state.shrinking = true;
      this.context.state.shrinkCountdownSeconds = 0;
      this.context.logger.info("Arena is closing in");
    }

    this.advanceWalls(dt, config.speedPerSecond, config.minWidth);
    this.applyCrushDamage(dt, config.crushDamagePerSecond);
  }

  private advanceWalls(dt: number, speedPerSecond: number, minWidth: number): void {
    const state = this.context.state;
    const width = state.shrinkRight - state.shrinkLeft;
    if (width <= minWidth) return;

    // Both walls advance, so the safe zone stays centred on the arena.
    const step = Math.max(0, speedPerSecond) * dt;
    const room = (width - minWidth) / 2;
    const advance = Math.min(step, room);

    state.shrinkLeft += advance;
    state.shrinkRight -= advance;
  }

  /**
   * Damage anyone the walls are pressing against.
   *
   * "Pressing against" means standing within half a player-width of a wall,
   * which is exactly where the movement clamp holds someone it is pushing.
   */
  private applyCrushDamage(dt: number, damagePerSecond: number): void {
    if (damagePerSecond <= 0) return;

    const state = this.context.state;
    // A small tolerance, so floating point does not decide whether a player who
    // is plainly against the wall is taking damage.
    const contact = PLAYER_HALF_WIDTH + 1;

    for (const player of state.players.values()) {
      if (!player.alive || !player.inMatch) continue;

      const squeezed =
        player.x <= state.shrinkLeft + contact || player.x >= state.shrinkRight - contact;

      if (!squeezed) {
        this.pendingCrushDamage.delete(player.sessionId);
        continue;
      }

      this.accumulateDamage(player, damagePerSecond * dt);
    }
  }

  /** Apply damage in whole points, carrying the remainder to the next tick. */
  private accumulateDamage(player: PlayerState, amount: number): void {
    const carried = (this.pendingCrushDamage.get(player.sessionId) ?? 0) + amount;
    const whole = Math.floor(carried);
    this.pendingCrushDamage.set(player.sessionId, carried - whole);

    if (whole <= 0) return;

    // Environmental damage: no attacker, so an elimination here is self-inflicted
    // and the kill feed reads accordingly. Said explicitly rather than left to be
    // inferred, because the weapon id passed here is the victim's own -- there is
    // nothing in it to tell a crush apart from a gunshot.
    this.context.applyDamage(
      player.sessionId,
      "",
      whole,
      player.x,
      player.y,
      player.weaponId,
      DamageSource.ENVIRONMENT,
    );
  }

  /** Drop a player's carried damage when they leave. */
  onPlayerRemoved(sessionId: string): void {
    this.pendingCrushDamage.delete(sessionId);
  }
}
