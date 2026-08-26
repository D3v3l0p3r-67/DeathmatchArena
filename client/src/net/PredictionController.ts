import {
  FIXED_DELTA,
  NETWORK,
  applyKnockback,
  createMovementState,
  distance,
  getPlayerConfig,
  getWeapon,
  stepPlayerMovement,
  type CollisionWorld,
  type InputCommand,
  type MovementState,
  type SyncedPlayer,
  type WorldBounds,
} from "@deathmatch/shared";
import { LocalFireModel, type PredictedShot } from "./LocalFireModel.js";

/**
 * What the weapon in hand does to top running speed.
 *
 * Derived from the synchronised weapon id rather than sent: the catalogue is
 * shared, so this reads the very row the server's `equip` read. An unknown id
 * falls back to no effect, which is what `getWeapon` already guarantees.
 */
function weaponSpeedFactor(weaponId: string): number {
  return getWeapon(weaponId).moveSpeedMultiplier || 1;
}

export interface PredictionDebugInfo {
  /** Distance between the last prediction and the server-corrected result. */
  lastErrorPx: number;
  /** Inputs sent but not yet acknowledged. */
  pendingInputs: number;
  /** Remaining visual correction offset. */
  smoothingPx: number;
}

/**
 * Client-side prediction and server reconciliation for the local player.
 *
 * The loop:
 *   1. Every fixed tick, apply the local input immediately with the *same*
 *      `stepPlayerMovement` the server runs. Controls respond with zero latency.
 *   2. Keep every input until the server acknowledges it (`lastProcessedInput`).
 *   3. On each patch, snap the simulation to the authoritative state and replay
 *      the unacknowledged inputs on top. The result is where the server will be.
 *   4. Any difference between that and what we were already drawing becomes a
 *      smoothing offset that decays over a few frames, so a correction reads as a
 *      slight drift rather than a teleport.
 *
 * Recoil is part of the prediction. The server shoves the shooter when a shot
 * fires, and a shove the client does not predict becomes a correction on every
 * single shot -- the stutter you feel when firing on a real connection. So a
 * local mirror of the fire gate decides "the server will fire here" and applies
 * the same `applyKnockback` on the same tick, and reconciliation re-applies it
 * when replaying inputs the server has not seen yet.
 *
 * The server always wins; the player just never feels the round trip.
 */
export class PredictionController {
  /** Predicted authoritative state (no smoothing applied). */
  readonly movement: MovementState = createMovementState();

  private readonly pending: InputCommand[] = [];
  private readonly fireModel = new LocalFireModel();

  /**
   * The playable limits to predict against.
   *
   * Kept in step with the server's closing walls, so the client clamps exactly
   * where the server does and a player pressed against a wall does not fight a
   * correction every patch.
   */
  private bounds: WorldBounds | undefined;

  /** Residual visual error, decayed towards zero every frame. */
  private smoothingX = 0;
  private smoothingY = 0;

  /**
   * Where the last fixed step started, and how far into the next one we are.
   *
   * The simulation advances 60 times a second in whole steps; the display draws
   * whenever it likes. Without these the player is redrawn at the same position
   * for one frame and two steps' worth the next -- which is exactly the stutter
   * you feel in a jump, where the vertical speed is large and changing.
   */
  private previousX = 0;
  private previousY = 0;
  private alpha = 1;

  private lastErrorPx = 0;
  private initialised = false;

  constructor(private readonly world: CollisionWorld) {}

  get renderX(): number {
    return this.previousX + (this.movement.x - this.previousX) * this.alpha + this.smoothingX;
  }

  get renderY(): number {
    return this.previousY + (this.movement.y - this.previousY) * this.alpha + this.smoothingY;
  }

  /**
   * How far the frame being drawn falls between the last step and the next.
   *
   * The leftover in the scene's fixed-step accumulator, as a fraction of a step.
   */
  setStepProgress(alpha: number): void {
    this.alpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Track the closing walls, so prediction clamps where the server clamps. */
  setBounds(bounds: WorldBounds): void {
    this.bounds = bounds;
  }

  /** Hard reset, used on spawn and when a new match begins. */
  reset(player: SyncedPlayer): void {
    this.pending.length = 0;
    this.smoothingX = 0;
    this.smoothingY = 0;
    this.lastErrorPx = 0;
    this.movement.x = player.x;
    this.movement.y = player.y;
    this.movement.velocityX = player.velocityX;
    this.movement.velocityY = player.velocityY;
    this.movement.onGround = player.onGround;
    this.movement.facing = player.facing;
    this.movement.coyoteTimer = 0;
    this.movement.jumpBufferTimer = 0;
    this.movement.jumpHeld = false;
    this.movement.speedMultiplier = player.speedMultiplier || 1;
    this.movement.weaponSpeedMultiplier = weaponSpeedFactor(player.weaponId);
    this.movement.knockbackTimer = player.knockbackTimer || 0;
    this.previousX = this.movement.x;
    this.previousY = this.movement.y;
    this.fireModel.reset(player);
    this.initialised = true;
  }

  /**
   * Apply one input locally, ahead of the server.
   *
   * Returns the shot this tick fires, when the fire model says the server will
   * fire one -- the scene turns that into immediate muzzle feedback.
   */
  predict(input: InputCommand): PredictedShot | null {
    if (!this.initialised) return null;

    // Where this step began, so the frames drawn before the next one can be
    // placed between the two rather than all on top of this one.
    this.previousX = this.movement.x;
    this.previousY = this.movement.y;
    stepPlayerMovement(this.movement, input, FIXED_DELTA, this.world, this.bounds);

    // Movement first, then the shot: the server steps the same input before it
    // processes the weapon, so the recoil lands on the post-step velocity there
    // and must land on it here.
    const shot = this.fireModel.advance(input);
    if (shot) this.applyRecoil(shot);

    this.pending.push(input);
    if (this.pending.length > NETWORK.MAX_QUEUED_INPUTS) this.pending.shift();
    return shot;
  }

  /** The same shove the server applies for this shot: backwards along the aim,
   *  no lift, clamped by the same player configuration. */
  private applyRecoil(shot: PredictedShot): void {
    applyKnockback(
      this.movement,
      -Math.cos(shot.aimAngle),
      -Math.sin(shot.aimAngle),
      shot.recoilForce,
      getPlayerConfig(),
      0,
    );
  }

  /**
   * Fold an authoritative snapshot back into the prediction.
   * Call once per received patch.
   */
  reconcile(player: SyncedPlayer): void {
    if (!this.initialised) {
      this.reset(player);
      return;
    }

    const previousX = this.movement.x;
    const previousY = this.movement.y;

    // Drop everything the server has already simulated.
    while (this.pending.length > 0 && this.pending[0]!.seq <= player.lastProcessedInput) {
      this.pending.shift();
    }
    this.fireModel.reconcile(player);

    // Rewind to server truth...
    this.movement.x = player.x;
    this.movement.y = player.y;
    this.movement.velocityX = player.velocityX;
    this.movement.velocityY = player.velocityY;
    this.movement.onGround = player.onGround;
    // The speed cap is part of server truth too: replaying a boosted player with
    // the default cap would manufacture an error the server never had.
    this.movement.speedMultiplier = player.speedMultiplier || 1;
    // The weapon's own factor is derived rather than sent: the weapon id is
    // already synchronised and the catalogue is shared, so both sides read the
    // same number out of the same row without a byte crossing the wire.
    this.movement.weaponSpeedMultiplier = weaponSpeedFactor(player.weaponId);
    // Likewise the shove window: replaying it under ordinary friction would
    // scrub off a knockback the server is still carrying.
    this.movement.knockbackTimer = player.knockbackTimer || 0;
    // The jump allowance is server truth too: replaying from a stale one would
    // predict a mid-air jump the server never granted.
    this.movement.jumpsRemaining = player.jumpsRemaining;

    // ...and replay whatever it has not seen yet -- including the recoil of any
    // shot predicted on one of those ticks, or the correction would reintroduce
    // the very error predicting the recoil removed.
    const shots = this.fireModel.pendingShots;
    let nextShot = 0;
    for (const input of this.pending) {
      stepPlayerMovement(this.movement, input, FIXED_DELTA, this.world, this.bounds);
      while (nextShot < shots.length && shots[nextShot]!.seq <= input.seq) {
        if (shots[nextShot]!.seq === input.seq) this.applyRecoil(shots[nextShot]!);
        nextShot++;
      }
    }

    const errorX = previousX - this.movement.x;
    const errorY = previousY - this.movement.y;
    this.lastErrorPx = distance(0, 0, errorX, errorY);

    // The correction moved the *end* of the current step; move its start by the
    // same amount so the interpolation between them stays the size of one step
    // rather than stretching across the whole correction.
    this.previousX -= errorX;
    this.previousY -= errorY;

    if (this.lastErrorPx < NETWORK.RECONCILE_IGNORE_DISTANCE) {
      // Float noise; not worth a correction.
      return;
    }

    if (this.lastErrorPx > NETWORK.RECONCILE_SNAP_DISTANCE) {
      // Too far to hide (teleport, respawn, a long stall): accept the jump.
      this.smoothingX = 0;
      this.smoothingY = 0;
      this.previousX = this.movement.x;
      this.previousY = this.movement.y;
      return;
    }

    // Keep drawing where we were, then glide to the corrected position.
    this.smoothingX += errorX;
    this.smoothingY += errorY;
  }

  /** Decay the visual correction. Call once per rendered frame. */
  update(deltaSeconds: number): void {
    if (this.smoothingX === 0 && this.smoothingY === 0) return;

    const factor = Math.pow(NETWORK.RECONCILE_SMOOTHING, deltaSeconds);
    this.smoothingX *= factor;
    this.smoothingY *= factor;

    if (Math.abs(this.smoothingX) < 0.05) this.smoothingX = 0;
    if (Math.abs(this.smoothingY) < 0.05) this.smoothingY = 0;
  }

  getDebugInfo(): PredictionDebugInfo {
    return {
      lastErrorPx: this.lastErrorPx,
      pendingInputs: this.pending.length,
      smoothingPx: distance(0, 0, this.smoothingX, this.smoothingY),
    };
  }
}
