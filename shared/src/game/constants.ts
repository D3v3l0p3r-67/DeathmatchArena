/**
 * Gameplay tuning constants.
 *
 * This file is the single source of truth: the server simulates with these values and
 * the client predicts with the very same numbers. Never duplicate a value into
 * `client/` or `server/` — import it from here instead.
 */

/** Fixed simulation step. Both client prediction and server simulation advance in
 *  exact multiples of this, which is what makes prediction reproducible. */
export const SIMULATION_HZ = 60;
export const FIXED_DELTA = 1 / SIMULATION_HZ;
export const FIXED_DELTA_MS = 1000 / SIMULATION_HZ;

export const NETWORK = {
  /** Colyseus patch rate — how often the room broadcasts state deltas. */
  PATCH_RATE_HZ: 20,
  /** How often the client flushes its queued input commands. */
  INPUT_SEND_RATE_HZ: 30,
  /** Max input commands packed into a single flush. */
  MAX_INPUTS_PER_MESSAGE: 8,
  /**
   * Remote entities are rendered this far in the past so there are always two
   * buffered snapshots to interpolate between.
   */
  INTERPOLATION_DELAY_MS: 110,
  /** Snapshot history kept per remote entity. */
  SNAPSHOT_BUFFER_SIZE: 24,
  /** Server-side cap on queued (unsimulated) inputs per player. */
  MAX_QUEUED_INPUTS: 90,
  /**
   * Token bucket that bounds how many simulation steps a player may consume.
   * Refills at SIMULATION_HZ; the burst allowance absorbs jitter without letting a
   * modified client "fast-forward" its own character.
   */
  INPUT_BUDGET_BURST: 8,
  /** Round-trip ping interval. */
  PING_INTERVAL_MS: 1000,
  /** Position error above which the client hard-snaps instead of easing. */
  RECONCILE_SNAP_DISTANCE: 120,
  /** Errors below this are ignored entirely (avoids jitter from float noise). */
  RECONCILE_IGNORE_DISTANCE: 0.5,
  /** Exponential smoothing factor per second for correcting prediction error. */
  RECONCILE_SMOOTHING: 0.0000001,
} as const;

export const MATCH = {
  MAX_PLAYERS: 10,
  /** Lowered to 2 so the game is testable with two browser windows. */
  MIN_PLAYERS_TO_START: 2,
  COUNTDOWN_MS: 5000,
  /** How long the results screen stays up before the room recycles into WAITING. */
  RESULTS_MS: 12000,
  /** Safety valve: a match can never run longer than this. */
  MAX_MATCH_DURATION_MS: 10 * 60 * 1000,
  /** Grace period for a disconnected player to reclaim their seat. */
  RECONNECTION_WINDOW_SEC: 20,
  /** Kill feed entries kept client-side and how long each stays visible. */
  KILL_FEED_MAX_ENTRIES: 5,
  KILL_FEED_ENTRY_TTL_MS: 6000,
} as const;

export const PLAYER = {
  WIDTH: 28,
  HEIGHT: 48,
  MAX_HEALTH: 100,
  /** Distance from the aim pivot to the muzzle, along the aim direction. */
  MUZZLE_OFFSET_X: 22,
  /** Vertical offset of the aim pivot from the body centre (roughly shoulder height). */
  AIM_ORIGIN_Y: -6,
  NAME_LABEL_OFFSET_Y: -44,
} as const;

export const PLAYER_HALF_WIDTH = PLAYER.WIDTH / 2;
export const PLAYER_HALF_HEIGHT = PLAYER.HEIGHT / 2;

export const PHYSICS = {
  GRAVITY: 2200,
  MAX_FALL_SPEED: 1500,
  MAX_RUN_SPEED: 330,
  GROUND_ACCELERATION: 3600,
  AIR_ACCELERATION: 2000,
  GROUND_FRICTION: 3200,
  AIR_FRICTION: 260,
  JUMP_VELOCITY: -780,
  /** Releasing jump early cuts upward velocity to this fraction (variable jump height). */
  JUMP_CUT_MULTIPLIER: 0.45,
  /** Jump still allowed shortly after walking off a ledge. */
  COYOTE_TIME: 0.09,
  /** Jump pressed slightly before landing is remembered. */
  JUMP_BUFFER_TIME: 0.12,
  /** Skin width used when resolving AABB overlaps. */
  COLLISION_EPSILON: 0.01,
} as const;

export const NAME_RULES = {
  MIN_LENGTH: 2,
  MAX_LENGTH: 16,
  /** Letters, digits, space, dash and underscore. Deliberately conservative. */
  ALLOWED_PATTERN: /^[A-Za-z0-9 _-]+$/,
  FALLBACK_PREFIX: "Player",
} as const;

/**
 * Per-message rate limits enforced by the server. A client exceeding these is
 * throttled (messages dropped) rather than disconnected, so ordinary jitter is
 * harmless while scripted floods are neutralised.
 */
export const RATE_LIMITS = {
  input: { maxEvents: 90, windowMs: 1000 },
  ping: { maxEvents: 10, windowMs: 1000 },
  chatOrMisc: { maxEvents: 10, windowMs: 1000 },
} as const;

export const PROJECTILE = {
  RADIUS: 3,
  /** Projectiles are integrated in sub-steps so fast bullets cannot tunnel. */
  MAX_STEP_DISTANCE: 24,
  /** Absolute lifetime cap regardless of weapon configuration. */
  MAX_LIFETIME_MS: 4000,
  /** Hard cap on simultaneously live projectiles per room. */
  MAX_ACTIVE: 400,
} as const;

export const CAMERA = {
  /** Logical render resolution; scaled to the browser window. */
  VIEW_WIDTH: 1280,
  VIEW_HEIGHT: 720,
  FOLLOW_LERP: 0.12,
  /** How far the camera leans towards the aim direction, in pixels. */
  AIM_LOOK_AHEAD: 90,
  DEADZONE_WIDTH: 120,
  DEADZONE_HEIGHT: 90,
} as const;
