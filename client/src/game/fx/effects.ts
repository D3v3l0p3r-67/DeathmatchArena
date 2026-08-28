/**
 * The visual effects catalogue.
 *
 * Same idea as the sound catalogue: every burst, flash and shake is a set of
 * numbers here rather than magic constants scattered through gameplay code. That
 * makes the game's feel something you can tune in one file, and lets a player
 * scale the whole lot down if it is too busy.
 */

/** A burst of particles. */
export interface BurstSpec {
  /** Particles at full intensity. Scaled by the player's effects setting. */
  count: number;
  color: number;
  /** Speed range in px/s. */
  minSpeed: number;
  maxSpeed: number;
  /** Lifetime range in ms. */
  minLife: number;
  maxLife: number;
  /** Starting scale of each particle. */
  scale: number;
  /** Downward acceleration, so debris falls instead of floating. */
  gravity: number;
  /** Cone half-angle in radians around a given direction; omit for all-round. */
  spread?: number;
  additive?: boolean;
}

/**
 * A trail: the fading streak something leaves along the path it actually took.
 *
 * Deliberately one shape for everything that moves. A player sprinting, a
 * grenade arcing, and anything added later -- a projectile, a power-up drifting
 * to the ground -- differ only in these numbers, so giving something a trail is
 * a row in `TRAILS` rather than a new class.
 */
export interface TrailSpec {
  /** How long the trail is, in samples. Each pair of samples is one segment. */
  segments: number;
  /** How long a sample takes to fade from full to nothing, in ms. */
  fadeMs: number;
  /** Alpha of a brand-new segment, 0..1. The rest fade towards 0 from here. */
  alpha: number;
  /** Width of a brand-new segment, in px. */
  width: number;
  /**
   * What fraction of `width` the oldest segment has shrunk to, 0..1.
   *
   * Tied to the same fade curve as the alpha, so a segment thins and dims
   * together rather than staying full-width until it vanishes.
   */
  taper: number;
  color: number;
  additive: boolean;
  /**
   * Below this speed nothing is recorded, in px/s.
   *
   * Measured from the path itself rather than taken from anyone's velocity, so
   * it means the same thing for a player, a grenade and anything added later.
   * A trail that is not being fed simply ages out where it is, which is what
   * makes stopping fade rather than cut.
   */
  minSpeed: number;
  /** Nor below this distance from the last sample, in px. */
  minSampleDistance: number;
}

/** A camera shake. */
export interface ShakeSpec {
  durationMs: number;
  /** Phaser's shake intensity, a fraction of the viewport. */
  intensity: number;
}

export interface EffectsSettings {
  /**
   * Scales particle counts, 0..1. At 0 the game still plays every flash and
   * flourish, just without the debris.
   */
  particleIntensity: number;
  /** Scales every camera shake, 0..1. 0 disables shake entirely. */
  screenShake: number;
  /** Floating damage numbers over targets you hit. */
  damageNumbers: boolean;
}

export const DEFAULT_EFFECTS_SETTINGS: EffectsSettings = {
  particleIntensity: 1,
  screenShake: 1,
  damageNumbers: true,
};

/**
 * What a body does when it dies.
 *
 * A player used to simply vanish the frame their health hit zero, which reads as
 * a rendering glitch rather than as a kill. Throwing them, spinning them and
 * fading them costs nothing and makes the moment legible from across the arena.
 */
export const DEATH_ANIMATION = {
  /** How long the body is visible after dying, in ms. */
  durationMs: 700,
  /** Total spin over the animation, in radians. */
  spin: 2.6,
  /** How far it is thrown upwards before gravity takes it, px. */
  lift: 110,
  /** Downward acceleration on the body, px/s². Faster than a player falls. */
  gravity: 2600,
  /** How far it drifts away from whoever killed it, px/s. */
  driftSpeed: 90,
};

/**
 * The last kill of a match.
 *
 * Time drops away, the body falls in slow motion, and only once it is over does
 * the results screen appear -- so the moment somebody wins is something you
 * watch rather than something a menu interrupts.
 *
 * Purely presentational: the match is already decided on the server before any
 * of this starts, so nothing here can change who won.
 */
export const FINALE = {
  /** How slow time gets at the deepest point, as a fraction of normal. */
  timeScale: 0.22,
  /** Dropping into slow motion, in ms of real time. */
  easeInMs: 140,
  /** How long it stays there. */
  holdMs: 900,
  /** Coming back to normal speed. */
  easeOutMs: 900,

  /**
   * The camera's part, in ms of real time from the last kill.
   *
   * Two beats. First the body: the camera pushes in on whoever just died, which
   * is the moment the slow motion exists to show. Then the survivor, because the
   * question the arena is asking by then is "who won", and an answer you watch
   * is worth more than a line on a menu.
   */
  victimZoom: 1.9,
  winnerZoom: 1.35,
  /** When the camera leaves the body and finds the winner. */
  winnerAtMs: 1150,
  /** How long the camera takes to move between the two, and to zoom at all. */
  cameraEaseMs: 620,

  /** How long the winner celebrates for, from `winnerAtMs`. */
  celebrateMs: 2200,
  /** Height of one celebratory hop, in px, and how many per second. */
  celebrateHop: 34,
  celebrateHz: 2.4,

  /** Confetti: how many waves, how far apart, and how many pieces in each. */
  confettiWaves: 4,
  confettiGapMs: 260,
  confettiPerWave: 26,

  /**
   * How long after the final kill the results appear, in ms of real time.
   *
   * Long enough for both beats: the body, then the winner celebrating. The
   * standings arrive once there is nothing left to watch rather than on top of
   * the best moment in the match.
   */
  resultsAfterMs: 3400,
} as const;

/**
 * How quickly a pose relaxes to neutral once there is nothing left to animate.
 *
 * Higher settles faster. It exists so the end of a match *concludes* an
 * animation rather than cutting it: a running player's bob and a winner's hop
 * both ease back to standing rather than snapping to it, and then stop being
 * written at all.
 */
export const POSE_SETTLE_RATE = 9;

/**
 * Confetti colours.
 *
 * Bright and unmistakably celebratory -- nothing in the arena's own palette is
 * any of these, so a screen full of them cannot be mistaken for gameplay.
 */
export const CONFETTI_COLORS = Object.freeze([
  0xff5d8f, 0xffd166, 0x4ade80, 0x38bdf8, 0xc084fc, 0xfb923c,
]);

/** Bursts, keyed by what caused them. */
export const BURSTS = Object.freeze({
  bulletImpact: {
    count: 7,
    color: 0xffd166,
    minSpeed: 60,
    maxSpeed: 200,
    minLife: 160,
    maxLife: 320,
    scale: 1,
    gravity: 420,
    additive: true,
  },
  fleshImpact: {
    count: 10,
    color: 0xff4d5e,
    minSpeed: 70,
    maxSpeed: 240,
    minLife: 180,
    maxLife: 380,
    scale: 1.1,
    gravity: 600,
  },
  death: {
    count: 26,
    color: 0xffffff,
    minSpeed: 90,
    maxSpeed: 420,
    minLife: 320,
    maxLife: 760,
    scale: 1.4,
    gravity: 520,
  },
  explosion: {
    count: 30,
    color: 0xffb347,
    minSpeed: 160,
    maxSpeed: 620,
    minLife: 260,
    maxLife: 700,
    scale: 1.6,
    gravity: 380,
    additive: true,
  },
  crateHit: {
    count: 6,
    color: 0xc9a227,
    minSpeed: 50,
    maxSpeed: 190,
    minLife: 180,
    maxLife: 380,
    scale: 1,
    gravity: 700,
  },
  crateBreak: {
    count: 20,
    color: 0xc9a227,
    minSpeed: 90,
    maxSpeed: 340,
    minLife: 300,
    maxLife: 700,
    scale: 1.3,
    gravity: 780,
  },
  pickup: {
    count: 14,
    color: 0xffffff,
    minSpeed: 60,
    maxSpeed: 210,
    minLife: 260,
    maxLife: 520,
    scale: 1.1,
    gravity: -160,
    additive: true,
  },
  /** Kicked up when a player lands, thrown along the ground. */
  landing: {
    count: 8,
    color: 0x9fb3d1,
    minSpeed: 40,
    maxSpeed: 150,
    minLife: 180,
    maxLife: 340,
    scale: 0.9,
    gravity: 240,
    spread: 0.5,
  },
  /** The ring under a mid-air jump. */
  doubleJump: {
    count: 12,
    color: 0x9fe8ff,
    minSpeed: 90,
    maxSpeed: 210,
    minLife: 200,
    maxLife: 380,
    scale: 1,
    gravity: 180,
    additive: true,
  },
  grenadeBounce: {
    count: 4,
    color: 0xd7e35f,
    minSpeed: 40,
    maxSpeed: 130,
    minLife: 120,
    maxLife: 260,
    scale: 0.8,
    gravity: 500,
  },
  /** Thrown out when a trap fires -- spikes, flame, a crusher landing. */
  trapFire: {
    count: 16,
    color: 0xff8a5b,
    minSpeed: 80,
    maxSpeed: 340,
    minLife: 200,
    maxLife: 480,
    scale: 1.2,
    gravity: 260,
    additive: true,
  },
  /** Embers drifting off a closing wall. */
  shrinkEmber: {
    count: 3,
    color: 0xff6b6b,
    minSpeed: 20,
    maxSpeed: 90,
    minLife: 400,
    maxLife: 900,
    scale: 0.9,
    gravity: -60,
    additive: true,
  },
} satisfies Record<string, BurstSpec>);

export type BurstName = keyof typeof BURSTS;

/**
 * Trails, keyed by what leaves them.
 *
 * The player's is short and cool-toned -- a hint of speed rather than a comet.
 * Its `minSpeed` sits just under a flat-out run (`player.moveSpeed`, 330px/s by
 * default), because movement here is binary: you are either standing still or
 * running at full speed, so that is the only line that separates "travelling"
 * from "not". Standing, turning and being nudged leave nothing; running leaves
 * a streak, and a fall, a boosted run or a shove from a rocket leaves a longer
 * one on its own -- covering more ground inside the same fade window is what
 * makes a trail longer, so speed scales it without a second setting.
 *
 * The grenade's is longer, brighter and always on, because it is answering a
 * different question -- not "how fast" but "where is that going to land".
 */
export const TRAILS = Object.freeze({
  player: {
    segments: 12,
    fadeMs: 280,
    // Matched to the grenade's, which reads clearly against the arena's very
    // dark palette. Lower was legible in a still frame and close to invisible
    // in motion, which is the only way anybody actually sees it. Dimmer than
    // the grenade's, though: at this width the same alpha was a glare.
    alpha: 0.45,
    // Nearly the body's 48px, so the newest stretch of trail reads as an
    // afterimage of the player rather than a ribbon behind their feet...
    width: 44,
    // ...and a hard taper narrows it to a thin tail within a few segments,
    // giving the wedge its silhouette.
    taper: 0.09,
    color: 0x9fe8ff,
    additive: true,
    // Below every weapon's run speed. At 300 it was above most of them --
    // moveSpeed 330 x a multiplier as low as 0.75 -- so the trail only ever
    // appeared in falls and speed boosts, one isolated square at a time.
    minSpeed: 180,
    minSampleDistance: 6,
  },
  grenade: {
    segments: 16,
    fadeMs: 620,
    alpha: 0.6,
    width: 5,
    taper: 0.2,
    color: 0xd7e35f,
    additive: true,
    // Always on in flight: the arc is the point, and a lobbed grenade slows
    // almost to a stop at the top of it, which is exactly where the trail is
    // most worth seeing.
    minSpeed: 0,
    minSampleDistance: 4,
  },
} satisfies Record<string, TrailSpec>);

export type TrailName = keyof typeof TRAILS;

/** Camera shakes, keyed by what caused them. */
export const SHAKES = Object.freeze({
  ownShot: { durationMs: 60, intensity: 0.0016 },
  ownShotgun: { durationMs: 110, intensity: 0.005 },
  meleeConnect: { durationMs: 70, intensity: 0.0022 },
  tookDamage: { durationMs: 120, intensity: 0.004 },
  died: { durationMs: 320, intensity: 0.008 },
  crateBreak: { durationMs: 90, intensity: 0.003 },
  /** The kill that ends a match: a heavier thump than an ordinary death. */
  finalKill: { durationMs: 420, intensity: 0.012 },
  /** Scaled by how close the trap was. */
  trapFire: { durationMs: 140, intensity: 0.005 },
  /** Scaled by how close the blast was. */
  explosionNear: { durationMs: 260, intensity: 0.016 },
  explosionFar: { durationMs: 200, intensity: 0.004 },
} satisfies Record<string, ShakeSpec>);

export type ShakeName = keyof typeof SHAKES;
