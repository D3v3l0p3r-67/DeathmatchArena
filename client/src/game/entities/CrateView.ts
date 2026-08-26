import Phaser from "phaser";
import { damp, type SyncedCrate } from "@deathmatch/shared";
import { TextureKeys } from "../TextureFactory.js";

/** How quickly the drawn crate closes on the server's position, 0..1 per frame. */
const SMOOTHING = 0.001;
/** Past this the gap is a teleport, not travel, and is taken in one step. */
const SNAP_DISTANCE = 140;

const HEALTHY_TINT = 0xc9a227;
const DAMAGED_TINT = 0xb4623a;

/**
 * A power-up crate.
 *
 * Purely presentational: position and health come from server state, and the
 * view deliberately shows nothing about the contents — the client is not told
 * what is inside until the crate breaks.
 */
export class CrateView {
  readonly container: Phaser.GameObjects.Container;

  private readonly body: Phaser.GameObjects.Image;
  private readonly healthBar: Phaser.GameObjects.Rectangle;
  private readonly healthBarBack: Phaser.GameObjects.Rectangle;
  private lastHealth: number;
  /** Where the server says it is; the container eases towards this. */
  private targetX = 0;
  private targetY = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    readonly crate: SyncedCrate,
  ) {
    const barWidth = crate.width;

    this.body = scene.add
      .image(0, 0, TextureKeys.Crate)
      .setDisplaySize(crate.width, crate.height)
      .setTint(HEALTHY_TINT);

    this.healthBarBack = scene.add
      .rectangle(0, -crate.height / 2 - 9, barWidth, 4, 0x000000, 0.55)
      .setOrigin(0.5, 0.5);
    this.healthBar = scene.add
      .rectangle(-barWidth / 2, -crate.height / 2 - 9, barWidth, 4, 0x9be36b, 1)
      .setOrigin(0, 0.5);

    this.container = scene.add
      .container(crate.x, crate.y, [this.body, this.healthBarBack, this.healthBar])
      .setDepth(6);

    this.lastHealth = crate.health;
    this.targetX = crate.x;
    this.targetY = crate.y;
    this.refresh(crate);

    // A slow bob makes crates readable against busy geometry.
    scene.tweens.add({
      targets: this.body,
      y: -3,
      duration: 1400,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  /**
   * Close the gap to the authoritative position.
   *
   * Called every frame. Snapped outright when the gap is large -- a crate that
   * broke and respawned elsewhere, or a match starting -- because easing across
   * the arena would draw a journey nothing made.
   */
  render(deltaSeconds: number): void {
    const dx = this.targetX - this.container.x;
    const dy = this.targetY - this.container.y;

    if (Math.abs(dx) > SNAP_DISTANCE || Math.abs(dy) > SNAP_DISTANCE) {
      this.container.setPosition(this.targetX, this.targetY);
      return;
    }

    this.container.setPosition(
      damp(this.container.x, this.targetX, SMOOTHING, deltaSeconds),
      damp(this.container.y, this.targetY, SMOOTHING, deltaSeconds),
    );
  }

  /** Mirror the authoritative crate state. */
  refresh(crate: SyncedCrate): void {
    /*
     * Aimed at rather than snapped to. A crate is a physical object now -- it
     * is shoved, it falls -- and patches arrive at 20Hz, so writing the
     * position straight in would step a sliding crate five times a second.
     * `render` closes the gap every frame instead.
     */
    this.targetX = crate.x;
    this.targetY = crate.y;

    const ratio = crate.maxHealth > 0 ? crate.health / crate.maxHealth : 0;
    this.healthBar.width = crate.width * Math.max(0, Math.min(1, ratio));
    this.healthBar.setFillStyle(ratio > 0.5 ? 0x9be36b : ratio > 0.25 ? 0xffd166 : 0xff6b6b);

    // The health bar only earns its space once the crate has actually been hit.
    const untouched = ratio >= 1;
    this.healthBar.setVisible(!untouched);
    this.healthBarBack.setVisible(!untouched);

    this.body.setTint(ratio > 0.4 ? HEALTHY_TINT : DAMAGED_TINT);

    if (crate.health < this.lastHealth) this.flinch();
    this.lastHealth = crate.health;
  }

  /** Brief shake so a hit registers even when the crate survives it. */
  private flinch(): void {
    this.scene.tweens.add({
      targets: this.container,
      scaleX: 1.12,
      scaleY: 0.88,
      duration: 70,
      yoyo: true,
      ease: "Quad.easeOut",
    });
  }

  destroy(): void {
    this.scene.tweens.killTweensOf(this.body);
    this.scene.tweens.killTweensOf(this.container);
    this.container.destroy(true);
  }
}
