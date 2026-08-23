/**
 * The sound catalogue.
 *
 * Every sound is *synthesised at runtime* from the parameters below — there are
 * no audio files to load, license or ship. That keeps the whole thing local and,
 * more usefully, makes each sound a handful of numbers anyone can retune without
 * opening an audio editor.
 *
 * A sound is a stack of layers. Each layer is either a tone (an oscillator, with
 * an optional pitch sweep) or noise (filtered), shaped by an attack/decay
 * envelope. Layering a swept tone under filtered noise is what turns a beep into
 * a gunshot, an explosion or a footstep.
 */

/** Which mixer channel a sound belongs to, so players can balance them. */
export const SoundChannel = {
  /** Weapons, impacts, explosions — the loud half of the game. */
  COMBAT: "combat",
  /** Movement, pickups, crates — the world reacting. */
  WORLD: "world",
  /** Menus, countdowns, notifications. */
  INTERFACE: "interface",
} as const;

export type SoundChannelValue = (typeof SoundChannel)[keyof typeof SoundChannel];

/**
 * The oscillator shapes used here.
 *
 * Spelled out rather than borrowing the DOM's `OscillatorType`, so this
 * catalogue stays plain data that can be read anywhere -- including by tests
 * running in Node, where there is no DOM.
 */
export type WaveShape = "sine" | "square" | "sawtooth" | "triangle";

export interface ToneLayer {
  kind: "tone";
  wave: WaveShape;
  /** Starting frequency in Hz. */
  frequency: number;
  /** Frequency to sweep towards over `duration`. Omit to hold a steady pitch. */
  sweepTo?: number;
  /** Peak gain of this layer, 0..1. */
  gain: number;
  /** Seconds to reach peak gain. Short is punchy, longer is soft. */
  attack: number;
  /** Seconds to fade back to silence. */
  duration: number;
  /** Seconds to wait before this layer starts, for two-part sounds. */
  delay?: number;
}

export interface NoiseLayer {
  kind: "noise";
  gain: number;
  attack: number;
  duration: number;
  /** Low-pass cutoff in Hz. Low is a thud, high is a hiss. */
  cutoff: number;
  /** Cutoff to sweep towards, for a "whoosh" that darkens as it fades. */
  cutoffTo?: number;
  /** Resonance. Higher rings more, which reads as metallic. */
  resonance?: number;
  delay?: number;
}

export type SoundLayer = ToneLayer | NoiseLayer;

export interface SoundDefinition {
  id: string;
  channel: SoundChannelValue;
  layers: SoundLayer[];
  /**
   * Random pitch variation, as a fraction. 0.1 means ±10%.
   *
   * The single most valuable setting here: without it, a rifle firing ten times
   * a second sounds like a machine, not a gun.
   */
  pitchJitter?: number;
  /** Overall level for this sound, applied on top of the layer gains. */
  volume?: number;
  /**
   * Minimum time between two plays of this sound, in ms.
   *
   * Guards against a shotgun's nine pellets landing nine impact sounds in the
   * same millisecond, which is heard as one distorted clack rather than a hit.
   */
  throttleMs?: number;
}

const { COMBAT, WORLD, INTERFACE } = SoundChannel;

/** Stable ids, referenced from gameplay code. */
export const SoundId = {
  RifleShot: "rifle-shot",
  ShotgunShot: "shotgun-shot",
  ChainsawSwing: "chainsaw-swing",
  ChainsawHit: "chainsaw-hit",
  Reload: "reload",
  BulletImpact: "bullet-impact",
  FleshImpact: "flesh-impact",
  Hurt: "hurt",
  Death: "death",
  Jump: "jump",
  DoubleJump: "double-jump",
  Land: "land",
  GrenadeThrow: "grenade-throw",
  GrenadeBounce: "grenade-bounce",
  GrenadeBeep: "grenade-beep",
  Explosion: "explosion",
  CrateIncoming: "crate-incoming",
  CrateHit: "crate-hit",
  CrateBreak: "crate-break",
  PickupWeapon: "pickup-weapon",
  PickupHealth: "pickup-health",
  PickupSpeed: "pickup-speed",
  PickupGrenade: "pickup-grenade",
  CountdownTick: "countdown-tick",
  MatchStart: "match-start",
  Victory: "victory",
  Defeat: "defeat",
  KillConfirm: "kill-confirm",
  ShrinkWarning: "shrink-warning",
  TrapArm: "trap-arm",
  TrapFire: "trap-fire",
  UiClick: "ui-click",
} as const;

export const SOUNDS: Readonly<Record<string, SoundDefinition>> = Object.freeze({
  // --- Weapons -------------------------------------------------------------
  [SoundId.RifleShot]: {
    id: SoundId.RifleShot,
    channel: COMBAT,
    pitchJitter: 0.12,
    volume: 0.5,
    layers: [
      { kind: "noise", gain: 0.9, attack: 0.001, duration: 0.09, cutoff: 5200, cutoffTo: 900 },
      { kind: "tone", wave: "square", frequency: 220, sweepTo: 60, gain: 0.5, attack: 0.001, duration: 0.07 },
    ],
  },
  [SoundId.ShotgunShot]: {
    id: SoundId.ShotgunShot,
    channel: COMBAT,
    pitchJitter: 0.1,
    volume: 0.62,
    layers: [
      { kind: "noise", gain: 1, attack: 0.001, duration: 0.22, cutoff: 3800, cutoffTo: 380 },
      { kind: "tone", wave: "square", frequency: 150, sweepTo: 40, gain: 0.6, attack: 0.002, duration: 0.16 },
    ],
  },
  [SoundId.ChainsawSwing]: {
    id: SoundId.ChainsawSwing,
    channel: COMBAT,
    pitchJitter: 0.18,
    volume: 0.32,
    throttleMs: 90,
    layers: [
      { kind: "noise", gain: 0.55, attack: 0.004, duration: 0.14, cutoff: 2600, cutoffTo: 700, resonance: 6 },
      { kind: "tone", wave: "sawtooth", frequency: 110, sweepTo: 150, gain: 0.3, attack: 0.01, duration: 0.14 },
    ],
  },
  [SoundId.ChainsawHit]: {
    id: SoundId.ChainsawHit,
    channel: COMBAT,
    pitchJitter: 0.15,
    volume: 0.5,
    layers: [
      { kind: "noise", gain: 0.9, attack: 0.001, duration: 0.18, cutoff: 1800, cutoffTo: 300, resonance: 9 },
      { kind: "tone", wave: "sawtooth", frequency: 90, sweepTo: 44, gain: 0.5, attack: 0.002, duration: 0.16 },
    ],
  },
  [SoundId.Reload]: {
    id: SoundId.Reload,
    channel: COMBAT,
    volume: 0.42,
    layers: [
      { kind: "noise", gain: 0.5, attack: 0.002, duration: 0.07, cutoff: 3000, cutoffTo: 900, resonance: 4 },
      { kind: "tone", wave: "square", frequency: 320, gain: 0.25, attack: 0.002, duration: 0.05, delay: 0.13 },
      { kind: "noise", gain: 0.6, attack: 0.002, duration: 0.09, cutoff: 2200, resonance: 6, delay: 0.26 },
    ],
  },

  // --- Impacts and damage --------------------------------------------------
  [SoundId.BulletImpact]: {
    id: SoundId.BulletImpact,
    channel: COMBAT,
    pitchJitter: 0.3,
    volume: 0.3,
    throttleMs: 45,
    layers: [
      { kind: "noise", gain: 0.7, attack: 0.001, duration: 0.05, cutoff: 6000, cutoffTo: 1400 },
    ],
  },
  [SoundId.FleshImpact]: {
    id: SoundId.FleshImpact,
    channel: COMBAT,
    pitchJitter: 0.2,
    volume: 0.45,
    throttleMs: 45,
    layers: [
      { kind: "noise", gain: 0.8, attack: 0.001, duration: 0.09, cutoff: 1500, cutoffTo: 260 },
      { kind: "tone", wave: "triangle", frequency: 180, sweepTo: 70, gain: 0.4, attack: 0.001, duration: 0.08 },
    ],
  },
  [SoundId.Hurt]: {
    id: SoundId.Hurt,
    channel: COMBAT,
    pitchJitter: 0.12,
    volume: 0.5,
    throttleMs: 140,
    layers: [
      { kind: "tone", wave: "sawtooth", frequency: 260, sweepTo: 140, gain: 0.45, attack: 0.004, duration: 0.2 },
      { kind: "noise", gain: 0.35, attack: 0.002, duration: 0.12, cutoff: 1100, cutoffTo: 300 },
    ],
  },
  [SoundId.Death]: {
    id: SoundId.Death,
    channel: COMBAT,
    volume: 0.62,
    layers: [
      { kind: "tone", wave: "sawtooth", frequency: 320, sweepTo: 50, gain: 0.5, attack: 0.006, duration: 0.7 },
      { kind: "noise", gain: 0.5, attack: 0.002, duration: 0.45, cutoff: 1600, cutoffTo: 160 },
    ],
  },
  [SoundId.KillConfirm]: {
    id: SoundId.KillConfirm,
    channel: INTERFACE,
    volume: 0.4,
    layers: [
      { kind: "tone", wave: "square", frequency: 880, gain: 0.3, attack: 0.002, duration: 0.06 },
      { kind: "tone", wave: "square", frequency: 1320, gain: 0.3, attack: 0.002, duration: 0.09, delay: 0.06 },
    ],
  },

  // --- Movement ------------------------------------------------------------
  [SoundId.Jump]: {
    id: SoundId.Jump,
    channel: WORLD,
    pitchJitter: 0.1,
    volume: 0.3,
    layers: [
      { kind: "tone", wave: "sine", frequency: 300, sweepTo: 620, gain: 0.35, attack: 0.004, duration: 0.13 },
      { kind: "noise", gain: 0.2, attack: 0.002, duration: 0.08, cutoff: 2400, cutoffTo: 800 },
    ],
  },
  [SoundId.DoubleJump]: {
    id: SoundId.DoubleJump,
    channel: WORLD,
    pitchJitter: 0.08,
    volume: 0.36,
    layers: [
      // Higher and brighter than the first jump, so the two are distinguishable.
      { kind: "tone", wave: "triangle", frequency: 520, sweepTo: 980, gain: 0.4, attack: 0.003, duration: 0.16 },
      { kind: "noise", gain: 0.3, attack: 0.002, duration: 0.11, cutoff: 4200, cutoffTo: 1200 },
    ],
  },
  [SoundId.Land]: {
    id: SoundId.Land,
    channel: WORLD,
    pitchJitter: 0.15,
    volume: 0.3,
    throttleMs: 120,
    layers: [
      { kind: "noise", gain: 0.6, attack: 0.001, duration: 0.1, cutoff: 900, cutoffTo: 200 },
      { kind: "tone", wave: "sine", frequency: 120, sweepTo: 60, gain: 0.3, attack: 0.002, duration: 0.09 },
    ],
  },

  // --- Grenades ------------------------------------------------------------
  [SoundId.GrenadeThrow]: {
    id: SoundId.GrenadeThrow,
    channel: COMBAT,
    pitchJitter: 0.12,
    volume: 0.4,
    layers: [
      { kind: "noise", gain: 0.55, attack: 0.01, duration: 0.2, cutoff: 1800, cutoffTo: 500 },
    ],
  },
  [SoundId.GrenadeBounce]: {
    id: SoundId.GrenadeBounce,
    channel: WORLD,
    pitchJitter: 0.25,
    volume: 0.3,
    throttleMs: 70,
    layers: [
      { kind: "tone", wave: "triangle", frequency: 420, sweepTo: 210, gain: 0.35, attack: 0.001, duration: 0.06 },
      { kind: "noise", gain: 0.3, attack: 0.001, duration: 0.04, cutoff: 3200, resonance: 5 },
    ],
  },
  [SoundId.GrenadeBeep]: {
    id: SoundId.GrenadeBeep,
    channel: WORLD,
    volume: 0.3,
    layers: [{ kind: "tone", wave: "square", frequency: 1500, gain: 0.22, attack: 0.001, duration: 0.05 }],
  },
  [SoundId.Explosion]: {
    id: SoundId.Explosion,
    channel: COMBAT,
    pitchJitter: 0.1,
    volume: 0.85,
    layers: [
      { kind: "noise", gain: 1, attack: 0.002, duration: 0.75, cutoff: 3000, cutoffTo: 120 },
      { kind: "tone", wave: "sawtooth", frequency: 120, sweepTo: 28, gain: 0.75, attack: 0.004, duration: 0.55 },
      { kind: "tone", wave: "sine", frequency: 60, sweepTo: 20, gain: 0.6, attack: 0.01, duration: 0.9 },
    ],
  },

  // --- Crates and pickups --------------------------------------------------
  [SoundId.CrateIncoming]: {
    id: SoundId.CrateIncoming,
    channel: WORLD,
    volume: 0.36,
    layers: [
      // Two rising notes: an announcement rather than an alarm. The visual
      // warning carries the urgency; this only says "look over there".
      { kind: "tone", wave: "sine", frequency: 520, sweepTo: 700, gain: 0.32, attack: 0.01, duration: 0.16 },
      { kind: "tone", wave: "sine", frequency: 700, sweepTo: 940, gain: 0.28, attack: 0.01, duration: 0.2, delay: 0.14 },
    ],
  },
  [SoundId.CrateHit]: {
    id: SoundId.CrateHit,
    channel: WORLD,
    pitchJitter: 0.25,
    volume: 0.33,
    throttleMs: 55,
    layers: [
      { kind: "tone", wave: "triangle", frequency: 260, sweepTo: 150, gain: 0.35, attack: 0.001, duration: 0.07 },
      { kind: "noise", gain: 0.4, attack: 0.001, duration: 0.05, cutoff: 2600, cutoffTo: 700 },
    ],
  },
  [SoundId.CrateBreak]: {
    id: SoundId.CrateBreak,
    channel: WORLD,
    pitchJitter: 0.12,
    volume: 0.5,
    layers: [
      { kind: "noise", gain: 0.8, attack: 0.001, duration: 0.3, cutoff: 3400, cutoffTo: 400, resonance: 3 },
      { kind: "tone", wave: "triangle", frequency: 200, sweepTo: 90, gain: 0.4, attack: 0.002, duration: 0.2 },
    ],
  },
  [SoundId.PickupWeapon]: {
    id: SoundId.PickupWeapon,
    channel: WORLD,
    volume: 0.45,
    layers: [
      { kind: "tone", wave: "square", frequency: 440, gain: 0.3, attack: 0.002, duration: 0.07 },
      { kind: "tone", wave: "square", frequency: 660, gain: 0.3, attack: 0.002, duration: 0.11, delay: 0.07 },
    ],
  },
  [SoundId.PickupHealth]: {
    id: SoundId.PickupHealth,
    channel: WORLD,
    volume: 0.45,
    layers: [
      { kind: "tone", wave: "sine", frequency: 520, gain: 0.32, attack: 0.004, duration: 0.1 },
      { kind: "tone", wave: "sine", frequency: 780, gain: 0.32, attack: 0.004, duration: 0.16, delay: 0.09 },
    ],
  },
  [SoundId.PickupSpeed]: {
    id: SoundId.PickupSpeed,
    channel: WORLD,
    volume: 0.45,
    layers: [
      { kind: "tone", wave: "triangle", frequency: 400, sweepTo: 1400, gain: 0.32, attack: 0.003, duration: 0.24 },
    ],
  },
  [SoundId.PickupGrenade]: {
    id: SoundId.PickupGrenade,
    channel: WORLD,
    volume: 0.45,
    layers: [
      { kind: "tone", wave: "square", frequency: 300, gain: 0.28, attack: 0.002, duration: 0.08 },
      { kind: "noise", gain: 0.35, attack: 0.002, duration: 0.1, cutoff: 1800, resonance: 5, delay: 0.06 },
    ],
  },

  // --- Match and interface -------------------------------------------------
  [SoundId.CountdownTick]: {
    id: SoundId.CountdownTick,
    channel: INTERFACE,
    volume: 0.4,
    layers: [{ kind: "tone", wave: "square", frequency: 660, gain: 0.3, attack: 0.002, duration: 0.11 }],
  },
  [SoundId.MatchStart]: {
    id: SoundId.MatchStart,
    channel: INTERFACE,
    volume: 0.55,
    layers: [
      { kind: "tone", wave: "square", frequency: 880, gain: 0.35, attack: 0.003, duration: 0.28 },
      { kind: "tone", wave: "square", frequency: 1320, gain: 0.28, attack: 0.003, duration: 0.3, delay: 0.02 },
    ],
  },
  [SoundId.Victory]: {
    id: SoundId.Victory,
    channel: INTERFACE,
    volume: 0.55,
    layers: [
      { kind: "tone", wave: "triangle", frequency: 523, gain: 0.3, attack: 0.006, duration: 0.2 },
      { kind: "tone", wave: "triangle", frequency: 659, gain: 0.3, attack: 0.006, duration: 0.2, delay: 0.16 },
      { kind: "tone", wave: "triangle", frequency: 784, gain: 0.32, attack: 0.006, duration: 0.45, delay: 0.32 },
    ],
  },
  [SoundId.Defeat]: {
    id: SoundId.Defeat,
    channel: INTERFACE,
    volume: 0.5,
    layers: [
      { kind: "tone", wave: "triangle", frequency: 440, gain: 0.3, attack: 0.008, duration: 0.24 },
      { kind: "tone", wave: "triangle", frequency: 349, gain: 0.3, attack: 0.008, duration: 0.5, delay: 0.2 },
    ],
  },
  [SoundId.ShrinkWarning]: {
    id: SoundId.ShrinkWarning,
    channel: INTERFACE,
    volume: 0.5,
    layers: [
      { kind: "tone", wave: "sawtooth", frequency: 180, sweepTo: 120, gain: 0.4, attack: 0.02, duration: 0.6 },
      { kind: "tone", wave: "square", frequency: 360, gain: 0.2, attack: 0.01, duration: 0.5, delay: 0.05 },
    ],
  },
  // --- Traps ---------------------------------------------------------------
  [SoundId.TrapArm]: {
    id: SoundId.TrapArm,
    channel: WORLD,
    pitchJitter: 0.08,
    volume: 0.34,
    throttleMs: 120,
    layers: [
      // A rising click-and-whine: the sound of something deciding to hurt you.
      { kind: "tone", wave: "square", frequency: 180, sweepTo: 420, gain: 0.3, attack: 0.004, duration: 0.22 },
      { kind: "noise", gain: 0.3, attack: 0.002, duration: 0.1, cutoff: 2400, resonance: 7 },
    ],
  },
  [SoundId.TrapFire]: {
    id: SoundId.TrapFire,
    channel: COMBAT,
    pitchJitter: 0.14,
    volume: 0.5,
    throttleMs: 60,
    layers: [
      { kind: "noise", gain: 0.9, attack: 0.001, duration: 0.26, cutoff: 4200, cutoffTo: 420 },
      { kind: "tone", wave: "sawtooth", frequency: 200, sweepTo: 55, gain: 0.5, attack: 0.002, duration: 0.2 },
    ],
  },

  [SoundId.UiClick]: {
    id: SoundId.UiClick,
    channel: INTERFACE,
    volume: 0.3,
    layers: [{ kind: "tone", wave: "square", frequency: 520, gain: 0.22, attack: 0.001, duration: 0.045 }],
  },
});

export function getSound(soundId: string): SoundDefinition | null {
  return SOUNDS[soundId] ?? null;
}
