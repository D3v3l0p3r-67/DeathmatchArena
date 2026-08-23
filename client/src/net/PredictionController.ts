import {
  FIXED_DELTA,
  NETWORK,
  createMovementState,
  distance,
  stepPlayerMovement,
  type CollisionWorld,
  type InputCommand,
  type MovementState,
  type SyncedPlayer,
  type WorldBounds,
} from "@deathmatch/shared";

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
 * The server always wins; the player just never feels the round trip.
 */
export class PredictionController {
  /** Predicted authoritative state (no smoothing applied). */
  readonly movement: MovementState = createMovementState();

  private readonly pending: InputCommand[] = [];

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
    this.movement.knockbackTimer = player.knockbackTimer || 0;
    this.previousX = this.movement.x;
    this.previousY = this.movement.y;
    this.initialised = true;
  }

  /** Apply one input locally, ahead of the server. */
  predict(input: InputCommand): void {
    if (!this.initialised) return;

    // Where this step began, so the frames drawn before the next one can be
    // placed between the two rather than all on top of this one.
    this.previousX = this.movement.x;
    this.previousY = this.movement.y;
    stepPlayerMovement(this.movement, input, FIXED_DELTA, this.world, this.bounds);
    this.pending.push(input);

    if (this.pending.length > NETWORK.MAX_QUEUED_INPUTS) this.pending.shift();
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

    // Rewind to server truth...
    this.movement.x = player.x;
    this.movement.y = player.y;
    this.movement.velocityX = player.velocityX;
    this.movement.velocityY = player.velocityY;
    this.movement.onGround = player.onGround;
    // The speed cap is part of server truth too: replaying a boosted player with
    // the default cap would manufacture an error the server never had.
    this.movement.speedMultiplier = player.speedMultiplier || 1;
    // Likewise the shove window: replaying it under ordinary friction would
    // scrub off a knockback the server is still carrying.
    this.movement.knockbackTimer = player.knockbackTimer || 0;
    // The jump allowance is server truth too: replaying from a stale one would
    // predict a mid-air jump the server never granted.
    this.movement.jumpsRemaining = player.jumpsRemaining;

    // ...and replay whatever it has not seen yet.
    for (const input of this.pending) {
      stepPlayerMovement(this.movement, input, FIXED_DELTA, this.world, this.bounds);
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
