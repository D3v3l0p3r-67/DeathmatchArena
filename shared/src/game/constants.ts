/**
 * Structural constants.
 *
 * What is left here is what genuinely cannot be tuned at runtime: the simulation
 * rate both sides step at, the network contract, and the handful of numbers that
 * describe the shape of the world rather than how it plays.
 *
 * Everything a designer would want to change -- movement, jumping, health, match
 * pacing, weapons, traps -- moved to the game configuration, which an
 * administrator owns and the server sends to each client on join. If you are
 * looking for gravity or maximum health, they are in `config/`.
 *
 * Never duplicate a value into `client/` or `server/` — import it from here.
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

/**
 * Match plumbing that is not gameplay.
 *
 * Player counts, the countdown and the results screen are configurable and live
 * in `config.match`; what is left here is the reconnection window (a property of
 * the transport) and the kill feed (a property of the client's UI).
 */
export const MATCH = {
  /** Grace period for a disconnected player to reclaim their seat. */
  RECONNECTION_WINDOW_SEC: 20,
  /** Kill feed entries kept client-side and how long each stays visible. */
  KILL_FEED_MAX_ENTRIES: 5,
  KILL_FEED_ENTRY_TTL_MS: 6000,
} as const;

/** The body. Its size is structural: hitboxes, spawn clearance and art depend on it. */
export const PLAYER = {
  WIDTH: 28,
  HEIGHT: 48,
  /** Distance from the aim pivot to the muzzle, along the aim direction. */
  MUZZLE_OFFSET_X: 22,
  /** Vertical offset of the aim pivot from the body centre (roughly shoulder height). */
  AIM_ORIGIN_Y: -6,
  NAME_LABEL_OFFSET_Y: -44,
} as const;

export const PLAYER_HALF_WIDTH = PLAYER.WIDTH / 2;
export const PLAYER_HALF_HEIGHT = PLAYER.HEIGHT / 2;

/**
 * What is left of the physics constants.
 *
 * Gravity, jump strength, run speed and the rest are configurable and reach the
 * integrator as an argument -- see `config.player`. The collision skin is not a
 * tuning knob but a numerical detail of how overlaps are resolved, so it stays.
 */
export const PHYSICS = {
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
  /**
   * Debug traffic. Deliberately tight: an authorized console is driven by hand,
   * and a tight budget also bounds how fast an unauthorized client can probe.
   */
  debug: { maxEvents: 12, windowMs: 1000 },
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
