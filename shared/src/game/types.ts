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
}

export function createMovementState(x = 0, y = 0): MovementState {
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
  target.speedMultiplier = source.speedMultiplier;
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
