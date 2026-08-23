import {
  angleDelta,
  clamp,
  clamp01,
  getFireIntervalMs,
  getMeleeArcRadians,
  isMelee,
  normalizeAngle,
  usesAmmo,
  type BrainProfile,
  type GrenadeConfig,
} from "@deathmatch/shared";
import type { BrainContext, PerceivedEnemy } from "./context.js";
import { throwAngleFor, throwSpeedFor } from "./throwArc.js";

/** Worst-case aim error at zero skill, in radians (~17°). */
const MAX_AIM_ERROR = 0.3;
/** How often the aim wobble is re-rolled, in ms. A steady hand is a still one. */
const AIM_DRIFT_INTERVAL_MS = 380;
/** How fast a perfect shot swings its aim, in radians per second. */
const MAX_TURN_RATE = 14;
/** How much clearance a bot wants beyond its own blast radius, in px. */
const SELF_BLAST_MARGIN = 45;
/** Worst-case misjudged throw angle at zero grenade accuracy, in radians (~9°). */
const MAX_THROW_ANGLE_ERROR = 0.16;
/** Worst-case misjudged throw power at zero grenade accuracy, as a fraction. */
const MAX_THROW_CHARGE_ERROR = 0.4;

export interface CombatOutput {
  aimAngle: number;
  fire: boolean;
  reload: boolean;
  chargeGrenade: boolean;
}

/**
 * Aiming, shooting and throwing.
 *
 * The interesting part is that it is deliberately imperfect, and imperfect in
 * ways a person would recognise. A weak bot is not one with less health or a
 * damage penalty -- it is one that takes longer to notice you, swings its aim
 * more slowly, misjudges where you are going, and holds its crosshair a little
 * off. All four come from the profile, and all four are visible to play against.
 *
 * It never reads the room: everything it needs arrives in the context, so a bot
 * cannot shoot at something it has not perceived.
 */
export class CombatController {
  private aimAngle = 0;
  /** The current wobble, re-rolled periodically rather than every tick. */
  private aimDrift = 0;
  private driftRolledAt = 0;

  /** When the current target was first noticed, for reaction time. */
  private targetId: string | null = null;
  private targetAcquiredAt = 0;

  private grenadeChargeStartedAt = 0;
  /**
   * How well this bot judges a throw, 0..1. Set from its difficulty.
   *
   * Applied as a misjudged angle and a misjudged charge, drawn once when the
   * wind-up starts: a throw that wobbled every tick would simply never leave.
   */
  private grenadeAccuracy = 1;
  private throwAngleError = 0;
  private throwChargeScale = 1;
  private throwing = false;

  constructor(private readonly random: () => number) {}

  get currentAim(): number {
    return this.aimAngle;
  }

  get isThrowing(): boolean {
    return this.throwing;
  }

  reset(angle = 0): void {
    this.aimAngle = angle;
    this.aimDrift = 0;
    this.targetId = null;
    this.targetAcquiredAt = 0;
    this.grenadeChargeStartedAt = 0;
    this.throwing = false;
  }

  /**
   * Track a target without shooting at it.
   *
   * Used while closing distance or repositioning: the gun follows you around
   * even when the bot has decided not to pull the trigger yet, which is most of
   * what makes it feel like it is paying attention.
   */
  track(target: PerceivedEnemy | null, context: BrainContext, profile: BrainProfile, dt: number): void {
    if (!target) return;
    this.acquire(target, context.now);
    this.aimAt(this.predictedAim(target, context, profile), profile, dt, context.now);
  }

  /** Aim at a fixed point, e.g. the last place an enemy was seen. */
  lookAt(x: number, y: number, context: BrainContext, profile: BrainProfile, dt: number): void {
    const desired = Math.atan2(y - context.self.y, x - context.self.x);
    this.aimAt(desired, profile, dt, context.now);
  }

  /**
   * Aim at a target and shoot when it is worth shooting.
   *
   * Fire is withheld until the reaction time has elapsed, the aim is actually on
   * target, and the shot could plausibly land -- a bot that empties its magazine
   * at a wall because someone is behind it is not a hard opponent, just a noisy one.
   */
  engage(
    target: PerceivedEnemy,
    context: BrainContext,
    profile: BrainProfile,
    dt: number,
  ): CombatOutput {
    this.acquire(target, context.now);
    const desired = this.predictedAim(target, context, profile);
    this.aimAt(desired, profile, dt, context.now);

    const weapon = context.self.weapon;
    const reacted = context.now - this.targetAcquiredAt >= profile.reactionTimeMs;
    const onTarget = Math.abs(angleDelta(this.aimAngle, desired)) <= this.tolerance(weapon, target);

    // Reload when there is nothing to shoot with. Doing it here rather than as
    // an action keeps "I am out" from competing with "I want to attack".
    const empty = usesAmmo(weapon) && context.self.ammo <= 0;
    const reload = empty && !context.self.reloading;

    const inRange = target.distance <= weapon.range;
    // An explosive round caught by the wall behind a target standing on top of
    // you takes you with it. The same reasoning the grenade action applies, at
    // the trigger rather than at the plan: a bot holding a launcher backs off
    // instead of killing itself.
    const tooCloseToDetonate =
      weapon.ranged?.explosion != null &&
      target.distance < weapon.ranged.explosion.radius + SELF_BLAST_MARGIN;

    const canFire =
      reacted &&
      onTarget &&
      inRange &&
      target.visible &&
      // Seeing them is not having a shot. A head over a low wall is visible and
      // unhittable, and a bot that fired anyway put its rounds into the wall --
      // or, with a launcher, put the blast on its own feet.
      target.shootable &&
      !empty &&
      !context.self.reloading &&
      !tooCloseToDetonate;

    return {
      aimAngle: this.aimAngle,
      fire: canFire,
      reload,
      chargeGrenade: false,
    };
  }

  /**
   * Wind up and let go.
   *
   * Charge time is derived from the distance and the configured power curve, so
   * a bot lobs a grenade at a target ten metres away rather than firing it over
   * the horizon. Returns true while still holding.
   */
  throwGrenade(
    target: { x: number; y: number },
    context: BrainContext,
    profile: BrainProfile,
    config: GrenadeConfig,
    dt: number,
  ): CombatOutput {
    if (!this.throwing) {
      this.throwing = true;
      this.grenadeChargeStartedAt = context.now;
      // Drawn once per throw, so the whole wind-up commits to one misjudgement
      // rather than wobbling until it happens to be right.
      const error = 1 - clamp01(this.grenadeAccuracy);
      this.throwAngleError = (this.random() * 2 - 1) * MAX_THROW_ANGLE_ERROR * error;
      this.throwChargeScale = 1 + (this.random() * 2 - 1) * MAX_THROW_CHARGE_ERROR * error;
    }

    const dx = target.x - context.self.x;
    const dy = target.y - context.self.y;

    // Aim above the target: a thrown grenade falls, so throwing flat lands short.
    const desired = normalizeAngle(throwAngleFor(dx, dy) + this.throwAngleError);
    this.aimAt(desired, profile, dt, context.now);

    const needed = this.chargeForDistance(Math.hypot(dx, dy), config) * this.throwChargeScale;

    const held = context.now - this.grenadeChargeStartedAt;
    // Releasing is simply stopping the hold; the server measures the interval.
    const release = held >= needed && Math.abs(angleDelta(this.aimAngle, desired)) < 0.25;
    if (release) this.throwing = false;

    return {
      aimAngle: this.aimAngle,
      fire: false,
      reload: false,
      chargeGrenade: !release,
    };
  }

  /** How well this bot judges a throw, 0..1. Comes from its difficulty. */
  setGrenadeAccuracy(accuracy: number): void {
    this.grenadeAccuracy = clamp01(accuracy);
  }

  cancelThrow(): void {
    this.throwing = false;
    this.grenadeChargeStartedAt = 0;
  }

  /** Nothing to shoot at: hold the aim, reload if the magazine is short. */
  idle(context: BrainContext): CombatOutput {
    const weapon = context.self.weapon;
    const wantsReload =
      usesAmmo(weapon) && context.self.ammo < 0.4 && !context.self.reloading && !context.self.ammo;

    return { aimAngle: this.aimAngle, fire: false, reload: wantsReload, chargeGrenade: false };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Start the reaction clock when the target changes. */
  private acquire(target: PerceivedEnemy, now: number): void {
    if (this.targetId === target.sessionId) return;
    this.targetId = target.sessionId;
    this.targetAcquiredAt = now;
  }

  /**
   * Where to point, allowing for where the target is going.
   *
   * Leading a moving target is a skill, so a poor bot under-leads and a good one
   * gets it nearly right. The travel time comes from the weapon's own muzzle
   * velocity, which means the same code leads correctly for a slow shotgun and a
   * fast rifle without knowing which is which.
   */
  private predictedAim(target: PerceivedEnemy, context: BrainContext, profile: BrainProfile): number {
    const weapon = context.self.weapon;
    const speed = weapon.ranged?.bulletSpeed ?? 0;

    let aimX = target.x;
    let aimY = target.y;

    if (speed > 0 && profile.predictionSkill > 0) {
      const travel = target.distance / speed;
      aimX += target.velocityX * travel * profile.predictionSkill;
      aimY += target.velocityY * travel * profile.predictionSkill;
    }

    return Math.atan2(aimY - context.self.y, aimX - context.self.x);
  }

  /**
   * Swing towards the desired angle, with a hand that is not quite steady.
   *
   * The wobble is re-rolled a few times a second rather than every tick: noise at
   * tick rate averages out to nothing and looks like a vibrating gun, while a
   * slow drift looks like a person not quite holding still.
   */
  private aimAt(desired: number, profile: BrainProfile, dt: number, now: number): void {
    if (now - this.driftRolledAt >= AIM_DRIFT_INTERVAL_MS) {
      this.driftRolledAt = now;
      this.aimDrift = (this.random() * 2 - 1) * MAX_AIM_ERROR * (1 - clamp01(profile.aimSkill));
    }

    const target = normalizeAngle(desired + this.aimDrift);
    const delta = angleDelta(this.aimAngle, target);

    // Turn rate scales with skill: a poor shot is still swinging round while a
    // good one is already firing.
    const rate = MAX_TURN_RATE * (0.25 + 0.75 * clamp01(profile.aimSkill));
    const step = clamp(delta, -rate * dt, rate * dt);

    this.aimAngle = normalizeAngle(this.aimAngle + step);
  }

  /** How far off the aim may be and still be worth firing. */
  private tolerance(weapon: BrainContext["self"]["weapon"], target: PerceivedEnemy): number {
    if (isMelee(weapon)) return getMeleeArcRadians(weapon);

    // A body is about 28px wide, so the angle it subtends shrinks with distance.
    // Shotguns get their own spread thrown in, because they are meant to be
    // fired roughly.
    const subtended = Math.atan2(20, Math.max(40, target.distance));
    return subtended + (weapon.ranged?.spread ?? 0) * 0.5;
  }

  /**
   * How long to hold for a throw of roughly this distance.
   *
   * Inverts the configured power curve rather than guessing: minimum power
   * covers the short throws, and the hold grows towards the configured maximum
   * as the target gets further away.
   */
  private chargeForDistance(distance: number, config: GrenadeConfig): number {
    const min = config.minThrowSpeed;
    const max = Math.max(min + 1, config.maxThrowSpeed);

    // Ballistic range for a 45-degree-ish lob: v² / g. `throwSpeedFor` solves
    // for the speed that covers the distance; this maps it back onto the charge
    // curve, so what the bot plans and what it throws are the same number.
    const fraction = clamp01((throwSpeedFor(distance, config) - min) / (max - min));

    return fraction * config.maxChargeMs;
  }

  /** Fire interval of the held weapon, exposed for actions that pace themselves. */
  static fireInterval(context: BrainContext): number {
    return getFireIntervalMs(context.self.weapon);
  }
}
