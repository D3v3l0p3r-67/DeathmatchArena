import Phaser from "phaser";
import { getWeapon, type SyncedProjectile } from "@deathmatch/shared";
import { TextureKeys } from "../TextureFactory.js";

/** Never extrapolate a bullet further than this; a wrong guess looks worse than a pause. */
const MAX_EXTRAPOLATION_MS = 120;

/**
 * Renders one server-owned projectile.
 *
 * The server decides where bullets are and what they hit. Between the 20Hz
 * patches the view extrapolates along the synchronised velocity so a 1500px/s
 * round still looks like a continuous streak at 60+ FPS.
 */
export class ProjectileView {
  private readonly sprite: Phaser.GameObjects.Image;
  private readonly trail: Phaser.GameObjects.Image;

  private serverX: number;
  private serverY: number;
  private velocityX: number;
  private velocityY: number;
  private lastPatchAt: number;

  constructor(
    scene: Phaser.Scene,
    readonly projectile: SyncedProjectile,
    now: number,
  ) {
    const style = getWeapon(projectile.weaponId).projectileStyle;

    this.serverX = projectile.x;
    this.serverY = projectile.y;
    this.velocityX = projectile.velocityX;
    this.velocityY = projectile.velocityY;
    this.lastPatchAt = now;

    const angle = Math.atan2(projectile.velocityY, projectile.velocityX);

    this.trail = scene.add
      .image(projectile.x, projectile.y, TextureKeys.Pixel)
      .setOrigin(1, 0.5)
      .setDisplaySize(style.trailLength, 2)
      .setTint(style.color)
      .setAlpha(0.55)
      .setRotation(angle)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(14);

    this.sprite = scene.add
      .image(projectile.x, projectile.y, TextureKeys.Bullet)
      .setOrigin(0.5, 0.5)
      .setDisplaySize(style.radius * 2.4, style.radius * 2.4)
      .setTint(style.color)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(15);
  }

  /** Fold in the newest authoritative position. */
  syncFromServer(now: number): void {
    this.serverX = this.projectile.x;
    this.serverY = this.projectile.y;
    this.velocityX = this.projectile.velocityX;
    this.velocityY = this.projectile.velocityY;
    this.lastPatchAt = now;
  }

  render(now: number): void {
    const aheadSeconds = Math.min(now - this.lastPatchAt, MAX_EXTRAPOLATION_MS) / 1000;
    const x = this.serverX + this.velocityX * aheadSeconds;
    const y = this.serverY + this.velocityY * aheadSeconds;

    this.sprite.setPosition(x, y);
    this.trail.setPosition(x, y);
  }

  get x(): number {
    return this.sprite.x;
  }

  get y(): number {
    return this.sprite.y;
  }

  destroy(): void {
    this.sprite.destroy();
    this.trail.destroy();
  }
}
