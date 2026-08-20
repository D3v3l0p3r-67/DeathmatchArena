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

  /** Residual visual error, decayed towards zero every frame. */
  private smoothingX = 0;
  private smoothingY = 0;

  private lastErrorPx = 0;
  private initialised = false;

  constructor(private readonly world: CollisionWorld) {}

  get renderX(): number {
    return this.movement.x + this.smoothingX;
  }

  get renderY(): number {
    return this.movement.y + this.smoothingY;
  }

  get pendingCount(): number {
    return this.pending.length;
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
    this.initialised = true;
  }

  /** Apply one input locally, ahead of the server. */
  predict(input: InputCommand): void {
    if (!this.initialised) return;
    stepPlayerMovement(this.movement, input, FIXED_DELTA, this.world);
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

    // ...and replay whatever it has not seen yet.
    for (const input of this.pending) {
      stepPlayerMovement(this.movement, input, FIXED_DELTA, this.world);
    }

    const errorX = previousX - this.movement.x;
    const errorY = previousY - this.movement.y;
    this.lastErrorPx = distance(0, 0, errorX, errorY);

    if (this.lastErrorPx < NETWORK.RECONCILE_IGNORE_DISTANCE) {
      // Float noise; not worth a correction.
      return;
    }

    if (this.lastErrorPx > NETWORK.RECONCILE_SNAP_DISTANCE) {
      // Too far to hide (teleport, respawn, a long stall): accept the jump.
      this.smoothingX = 0;
      this.smoothingY = 0;
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
