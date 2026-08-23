import Phaser from "phaser";
import { getProjectileStyle, getWeapon } from "@deathmatch/shared";
import { TextureKeys } from "./TextureFactory.js";
import {
  BURSTS,
  CONFETTI_COLORS,
  DEFAULT_EFFECTS_SETTINGS,
  SHAKES,
  type BurstName,
  type BurstSpec,
  type EffectsSettings,
  type ShakeName,
} from "./fx/effects.js";

/**
 * Short-lived visual feedback: muzzle flashes, impacts, debris, blasts and
 * floating damage numbers.
 *
 * Every effect is described by data in `fx/effects.ts` rather than by constants
 * inline, so the game's feel can be retuned in one place — and scaled down by a
 * player who finds it too busy, via `applySettings`.
 *
 * All of it is cosmetic. The server has already resolved whatever is being
 * illustrated by the time an effect plays.
 */
export class EffectsSystem {
  private settings: EffectsSettings = { ...DEFAULT_EFFECTS_SETTINGS };

  constructor(private readonly scene: Phaser.Scene) {}

  applySettings(settings: EffectsSettings): void {
    this.settings = { ...settings };
  }

  // -------------------------------------------------------------------------
  // Weapons
  // -------------------------------------------------------------------------

  muzzleFlash(x: number, y: number, angle: number, weaponId: string): void {
    const style = getProjectileStyle(getWeapon(weaponId));

    const flash = this.scene.add
      .image(x, y, TextureKeys.MuzzleFlash)
      .setOrigin(0.1, 0.5)
      .setRotation(angle)
      .setTint(style.color)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(18);

    this.scene.tweens.add({
      targets: flash,
      alpha: { from: 1, to: 0 },
      scaleX: { from: 0.85, to: 1.25 },
      duration: 70,
      onComplete: () => flash.destroy(),
    });
  }

  /**
   * A melee swing arc, sized from the weapon's configured reach.
   *
   * `connected` comes from the server, which already decided what the swing hit;
   * this only makes the outcome visible.
   */
  meleeSwing(x: number, y: number, angle: number, weaponId: string, connected: boolean): void {
    const weapon = getWeapon(weaponId);
    // The texture is drawn at a 96px radius, so scale it to the configured range.
    const scale = Math.max(0.2, (weapon.range * 1.6) / 96);

    const arc = this.scene.add
      .image(x, y, TextureKeys.MeleeArc)
      .setOrigin(0, 0.5)
      .setRotation(angle)
      .setScale(scale)
      .setTint(connected ? 0xff6b6b : 0xdfe7f5)
      .setAlpha(connected ? 0.75 : 0.4)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(17);

    this.scene.tweens.add({
      targets: arc,
      alpha: 0,
      scaleX: scale * 1.15,
      scaleY: scale * 1.15,
      duration: 130,
      ease: "Quad.easeOut",
      onComplete: () => arc.destroy(),
    });
  }

  // -------------------------------------------------------------------------
  // Bursts
  // -------------------------------------------------------------------------

  /**
   * Throw a burst of debris.
   *
   * `direction` aims the cone for bursts that specify a spread; without one the
   * particles go in every direction.
   */
  burst(name: BurstName, x: number, y: number, direction?: number, scale = 1): void {
    const spec = BURSTS[name];
    const count = Math.round(spec.count * this.settings.particleIntensity * scale);
    if (count <= 0) return;

    this.spawnParticles(spec, x, y, count, direction);
  }

  /** A coloured burst, for effects tinted by something at runtime. */
  tintedBurst(name: BurstName, x: number, y: number, color: number, scale = 1): void {
    const spec = { ...BURSTS[name], color };
    const count = Math.round(spec.count * this.settings.particleIntensity * scale);
    if (count <= 0) return;

    this.spawnParticles(spec, x, y, count, undefined);
  }

  /**
   * Confetti, across the top of what the player can currently see.
   *
   * Screen-wide rather than centred on anybody: the point is that the *screen*
   * is celebrating. Spawned in the world above the camera's view so the pieces
   * fall into it, and built from tweens like every other particle here, which
   * means they slow down with the finale rather than racing it.
   */
  confetti(view: { left: number; right: number; top: number }, count: number): void {
    const pieces = Math.round(count * this.settings.particleIntensity);
    if (pieces <= 0) return;

    const width = Math.max(1, view.right - view.left);

    for (let i = 0; i < pieces; i++) {
      const x = view.left + Math.random() * width;
      const y = view.top - 40 - Math.random() * 120;
      const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]!;

      const piece = this.scene.add
        .rectangle(x, y, 7 + Math.random() * 5, 11 + Math.random() * 7, color)
        .setDepth(19)
        .setAngle(Math.random() * 360);

      const fall = 3.1 + Math.random() * 1.9;
      const drift = (Math.random() * 2 - 1) * 190;

      this.scene.tweens.add({
        targets: piece,
        x: x + drift,
        y: y + 260 * fall,
        // Tumbling, at its own rate: uniform confetti reads as a texture rather
        // than as paper.
        angle: piece.angle + (Math.random() * 2 - 1) * 900,
        scaleX: { from: 1, to: 0.2 },
        alpha: { from: 1, to: 0.75 },
        duration: fall * 1000,
        ease: "Sine.easeIn",
        onComplete: () => piece.destroy(),
      });
    }
  }

  private spawnParticles(
    spec: BurstSpec,
    x: number,
    y: number,
    count: number,
    direction: number | undefined,
  ): void {
    for (let i = 0; i < count; i++) {
      const angle =
        direction !== undefined && spec.spread !== undefined
          ? direction + (Math.random() * 2 - 1) * spec.spread
          : Math.random() * Math.PI * 2;

      const speed = spec.minSpeed + Math.random() * (spec.maxSpeed - spec.minSpeed);
      const life = spec.minLife + Math.random() * (spec.maxLife - spec.minLife);

      const particle = this.scene.add
        .image(x, y, TextureKeys.Spark)
        .setTint(spec.color)
        .setScale(spec.scale)
        .setDepth(16);
      if (spec.additive) particle.setBlendMode(Phaser.BlendModes.ADD);

      const velocityX = Math.cos(angle) * speed;
      const velocityY = Math.sin(angle) * speed;
      const seconds = life / 1000;

      this.scene.tweens.add({
        targets: particle,
        // Ballistic: constant horizontal drift, gravity on the vertical.
        x: x + velocityX * seconds,
        y: y + velocityY * seconds + 0.5 * spec.gravity * seconds * seconds,
        alpha: { from: 1, to: 0 },
        scale: { from: spec.scale, to: spec.scale * 0.3 },
        duration: life,
        ease: "Quad.easeOut",
        onComplete: () => particle.destroy(),
      });
    }
  }

  /** Impact sparks. Kept as a named helper because it is used everywhere. */
  impact(x: number, y: number, color = 0xffd166, count = 6): void {
    const spec = { ...BURSTS.bulletImpact, color, count };
    const scaled = Math.round(count * this.settings.particleIntensity);
    if (scaled <= 0) return;
    this.spawnParticles(spec, x, y, scaled, undefined);
  }

  deathBurst(x: number, y: number, color: number): void {
    this.tintedBurst("death", x, y, color);

    const flash = this.scene.add
      .image(x, y, TextureKeys.BulletGlow)
      .setTint(color)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(2.4)
      .setDepth(18);

    this.scene.tweens.add({
      targets: flash,
      alpha: { from: 0.9, to: 0 },
      scale: 4.2,
      duration: 420,
      ease: "Quad.easeOut",
      onComplete: () => flash.destroy(),
    });
  }

  /**
   * A grenade blast, drawn at the radius the server actually used.
   *
   * The ring is the damage radius, so what you see is what hurt you.
   */
  explosion(x: number, y: number, radius: number): void {
    const flash = this.scene.add
      .image(x, y, TextureKeys.BulletGlow)
      .setTint(0xffb347)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(19)
      .setScale(radius / 24);

    this.scene.tweens.add({
      targets: flash,
      alpha: { from: 1, to: 0 },
      scale: (radius / 24) * 1.5,
      duration: 380,
      ease: "Quad.easeOut",
      onComplete: () => flash.destroy(),
    });

    const ring = this.scene.add
      .circle(x, y, radius, 0xff6b6b, 0)
      .setStrokeStyle(3, 0xff8a4a, 0.9)
      .setDepth(19);

    this.scene.tweens.add({
      targets: ring,
      alpha: 0,
      duration: 420,
      ease: "Quad.easeOut",
      onComplete: () => ring.destroy(),
    });

    this.burst("explosion", x, y);
  }

  /** An expanding ring, used for the mid-air jump. */
  ring(x: number, y: number, color: number, radius: number, durationMs: number): void {
    const ring = this.scene.add
      .circle(x, y, radius * 0.3, color, 0)
      .setStrokeStyle(2, color, 0.8)
      .setDepth(15);

    this.scene.tweens.add({
      targets: ring,
      radius,
      alpha: 0,
      duration: durationMs,
      ease: "Quad.easeOut",
      onUpdate: () => ring.setRadius(ring.radius),
      onComplete: () => ring.destroy(),
    });
  }

  damageNumber(x: number, y: number, amount: number, fatal: boolean): void {
    if (!this.settings.damageNumbers) return;

    const label = this.scene.add
      .text(x, y, String(Math.round(amount)), {
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: fatal ? "22px" : "16px",
        color: fatal ? "#ff4d5e" : "#ffd166",
        fontStyle: "700",
      })
      .setOrigin(0.5, 0.5)
      .setDepth(20);
    label.setStroke("#05070c", 4);

    this.scene.tweens.add({
      targets: label,
      y: y - 42,
      alpha: { from: 1, to: 0 },
      duration: fatal ? 900 : 640,
      ease: "Quad.easeOut",
      onComplete: () => label.destroy(),
    });
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  /** The configured shake for an event, scaled by the player's setting. */
  shakeFor(name: ShakeName, scale = 1): { durationMs: number; intensity: number } {
    const spec = SHAKES[name];
    return {
      durationMs: spec.durationMs,
      intensity: spec.intensity * this.settings.screenShake * scale,
    };
  }
}
