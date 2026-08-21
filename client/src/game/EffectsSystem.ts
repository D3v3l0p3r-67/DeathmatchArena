import Phaser from "phaser";
import { getProjectileStyle, getWeapon } from "@deathmatch/shared";
import { TextureKeys } from "./TextureFactory.js";

/**
 * Short-lived visual feedback: muzzle flashes, impact sparks, death bursts and
 * floating damage numbers.
 *
 * Every effect here is cosmetic. None of it decides anything -- the server has
 * already resolved the hit by the time an effect plays.
 */
export class EffectsSystem {
  constructor(private readonly scene: Phaser.Scene) {}

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

    this.impact(x, y, 0xffb347, 22);
  }

  impact(x: number, y: number, color = 0xffd166, count = 6): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 140;

      const spark = this.scene.add
        .image(x, y, TextureKeys.Spark)
        .setTint(color)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(17);

      this.scene.tweens.add({
        targets: spark,
        x: x + Math.cos(angle) * speed * 0.25,
        y: y + Math.sin(angle) * speed * 0.25,
        alpha: { from: 1, to: 0 },
        scale: { from: 1, to: 0.3 },
        duration: 180 + Math.random() * 160,
        onComplete: () => spark.destroy(),
      });
    }
  }

  deathBurst(x: number, y: number, color: number): void {
    this.impact(x, y, color, 22);

    const ring = this.scene.add
      .image(x, y, TextureKeys.BulletGlow)
      .setTint(color)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(17);

    this.scene.tweens.add({
      targets: ring,
      scale: { from: 0.6, to: 3.4 },
      alpha: { from: 0.9, to: 0 },
      duration: 420,
      onComplete: () => ring.destroy(),
    });
  }

  damageNumber(x: number, y: number, amount: number, fatal: boolean): void {
    const text = this.scene.add
      .text(x, y, String(amount), {
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: fatal ? "22px" : "17px",
        color: fatal ? "#ff4d5e" : "#ffd166",
      })
      .setOrigin(0.5, 0.5)
      .setDepth(25)
      .setShadow(0, 2, "#000000", 4);

    this.scene.tweens.add({
      targets: text,
      y: y - 46,
      alpha: { from: 1, to: 0 },
      duration: 720,
      ease: "Cubic.easeOut",
      onComplete: () => text.destroy(),
    });
  }
}
