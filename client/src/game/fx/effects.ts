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

/** Camera shakes, keyed by what caused them. */
export const SHAKES = Object.freeze({
  ownShot: { durationMs: 60, intensity: 0.0016 },
  ownShotgun: { durationMs: 110, intensity: 0.005 },
  meleeConnect: { durationMs: 70, intensity: 0.0022 },
  tookDamage: { durationMs: 120, intensity: 0.004 },
  died: { durationMs: 320, intensity: 0.008 },
  crateBreak: { durationMs: 90, intensity: 0.003 },
  /** Scaled by how close the trap was. */
  trapFire: { durationMs: 140, intensity: 0.005 },
  /** Scaled by how close the blast was. */
  explosionNear: { durationMs: 260, intensity: 0.016 },
  explosionFar: { durationMs: 200, intensity: 0.004 },
} satisfies Record<string, ShakeSpec>);

export type ShakeName = keyof typeof SHAKES;
