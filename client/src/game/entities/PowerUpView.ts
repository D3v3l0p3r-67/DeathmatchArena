import Phaser from "phaser";
import { getPowerUp, type SyncedPowerUp } from "@deathmatch/shared";
import { TextureKeys } from "../TextureFactory.js";

/** Fallback styling for a power-up id this build does not know about. */
const UNKNOWN = { name: "Power-up", color: 0xffffff };

/**
 * A revealed power-up waiting to be collected.
 *
 * Its appearance is read from the power-up *definition* — colour and label both
 * come from config, so a new power-up needs no code here to be drawn correctly.
 */
export class PowerUpView {
  readonly container: Phaser.GameObjects.Container;

  private readonly orb: Phaser.GameObjects.Image;

  constructor(
    private readonly scene: Phaser.Scene,
    readonly powerUp: SyncedPowerUp,
  ) {
    const definition = getPowerUp(powerUp.powerUpId);
    const color = definition?.color ?? UNKNOWN.color;
    const label = definition?.name ?? UNKNOWN.name;

    const halo = scene.add.image(0, 0, TextureKeys.PowerUpOrb).setTint(color).setAlpha(0.35).setScale(1.7);
    this.orb = scene.add.image(0, 0, TextureKeys.PowerUpOrb).setTint(color);

    const caption = scene.add
      .text(0, 26, label, {
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: "12px",
        color: "#e8eef7",
      })
      .setOrigin(0.5, 0.5);
    caption.setStroke("#05070c", 4);

    this.container = scene.add.container(powerUp.x, powerUp.y, [halo, this.orb, caption]).setDepth(7);

    // Bob and pulse, so a dropped power-up is visible from across the arena.
    scene.tweens.add({
      targets: this.container,
      y: powerUp.y - 8,
      duration: 1100,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
    scene.tweens.add({
      targets: halo,
      alpha: 0.12,
      scale: 2.1,
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  refresh(powerUp: SyncedPowerUp): void {
    this.container.setX(powerUp.x);
  }

  get color(): number {
    return this.orb.tintTopLeft;
  }

  destroy(): void {
    this.scene.tweens.killTweensOf(this.container);
    this.container.each((child: Phaser.GameObjects.GameObject) => this.scene.tweens.killTweensOf(child));
    this.container.destroy(true);
  }
}
