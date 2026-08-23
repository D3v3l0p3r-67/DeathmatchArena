import { getPlayerConfig } from "../config/registry.js";

/** Lifecycle of a single match, owned exclusively by the server. */
export const MatchState = {
  WAITING: "WAITING",
  COUNTDOWN: "COUNTDOWN",
  PLAYING: "PLAYING",
  FINISHED: "FINISHED",
} as const;

export type MatchStateValue = (typeof MatchState)[keyof typeof MatchState];

/** Collision/rendering role of a piece of arena geometry. All types are solid. */
export const SurfaceType = {
  FLOOR: "floor",
  PLATFORM: "platform",
  WALL: "wall",
  OBSTACLE: "obstacle",
} as const;

export type SurfaceTypeValue = (typeof SurfaceType)[keyof typeof SurfaceType];

/** Mutable movement state advanced by `stepPlayerMovement`. */
export interface MovementState {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  onGround: boolean;
  /** Remaining time during which a jump is still allowed after leaving ground. */
  coyoteTimer: number;
  /** Remaining time during which a buffered jump press stays valid. */
  jumpBufferTimer: number;
  /** -1 facing left, 1 facing right. */
  facing: number;
  /** True while the player holds jump; used for variable jump height. */
  jumpHeld: boolean;
  /**
   * Multiplier on the horizontal speed cap, driven by power-up effects.
   *
   * It lives here rather than being looked up during the step so the movement
   * integrator stays pure: the client copies the server's value before replaying
   * unacknowledged inputs, and prediction still reproduces the server exactly.
   */
  speedMultiplier: number;
  /**
   * Jumps left before touching the ground again.
   *
   * Refilled on landing and spent by each jump, so the mid-air jump is simply
   * "the second one". Part of the movement state because prediction replays it.
   */
  jumpsRemaining: number;
  /**
   * Seconds left in which a shove decays at its own rate rather than through
   * friction. Part of the movement state, and mirrored to the client, because
   * prediction has to replay a knocked-back player exactly as the server did.
   */
  knockbackTimer: number;
}

/**
 * A fresh movement state.
 *
 * `maxJumps` defaults to the process-wide configuration; the server passes its
 * room's value explicitly, so a room with a retuned jump allowance starts its
 * players with the right one.
 */
export function createMovementState(
  x = 0,
  y = 0,
  maxJumps = getPlayerConfig().maxJumps,
): MovementState {
  return {
    x,
    y,
    velocityX: 0,
    velocityY: 0,
    onGround: false,
    coyoteTimer: 0,
    jumpBufferTimer: 0,
    facing: 1,
    jumpHeld: false,
    speedMultiplier: 1,
    knockbackTimer: 0,
    jumpsRemaining: Math.max(1, Math.round(maxJumps)),
  };
}

export function copyMovementState(source: MovementState, target: MovementState): MovementState {
  target.x = source.x;
  target.y = source.y;
  target.velocityX = source.velocityX;
  target.velocityY = source.velocityY;
  target.onGround = source.onGround;
  target.coyoteTimer = source.coyoteTimer;
  target.jumpBufferTimer = source.jumpBufferTimer;
  target.facing = source.facing;
  target.jumpHeld = source.jumpHeld;
  target.knockbackTimer = source.knockbackTimer;
  target.speedMultiplier = source.speedMultiplier;
  target.jumpsRemaining = source.jumpsRemaining;
  return target;
}

/** A single tick's worth of player intent. This is the ONLY gameplay data a client sends. */
export interface InputCommand {
  /** Monotonically increasing per-connection sequence number, used for reconciliation. */
  seq: number;
  moveLeft: boolean;
  moveRight: boolean;
  jump: boolean;
  fire: boolean;
  reload: boolean;
  /**
   * True while the throw button is held.
   *
   * Deliberately a *held state* rather than a "throw with strength X" event: the
   * server counts how many ticks it stayed down and derives the throw speed
   * itself, so charge duration is not something a client can claim.
   */
  chargeGrenade: boolean;
  /** Aim direction in world space, radians. The client computes it, the server validates it. */
  aimAngle: number;
}

export function createInputCommand(seq = 0): InputCommand {
  return {
    seq,
    moveLeft: false,
    moveRight: false,
    jump: false,
    fire: false,
    reload: false,
    chargeGrenade: false,
    aimAngle: 0,
  };
}

export interface KillEvent {
  killerId: string;
  killerName: string;
  victimId: string;
  victimName: string;
  weaponId: string;
  /** True when nobody scored the kill (fall damage, disconnect, ...). */
  selfInflicted: boolean;
  /**
   * True when this elimination is the one that ends the match.
   *
   * The client cannot work this out for itself: the kill arrives immediately
   * and the match state that follows it arrives with the next patch, so without
   * this the last kill of a match looks exactly like any other for a fifth of a
   * second -- which is precisely the moment worth marking.
   */
  endsMatch: boolean;
}

export interface MatchStanding {
  sessionId: string;
  name: string;
  kills: number;
  /** 1 = winner. */
  placement: number;
}

export interface MatchResultPayload {
  winnerId: string;
  winnerName: string;
  standings: MatchStanding[];
}
