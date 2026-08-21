import Phaser from "phaser";
import { getWeapon } from "@deathmatch/shared";
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
    const style = getWeapon(weaponId).projectileStyle;

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
