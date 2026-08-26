import Phaser from "phaser";
import type { SyncedGrenade } from "@deathmatch/shared";
import { TextureKeys } from "../TextureFactory.js";
import { TrailRenderer } from "../fx/TrailRenderer.js";

/**
 * A grenade in flight.
 *
 * Rendered from server state and extrapolated between the 20 Hz patches, the
 * same way projectiles are, so it arcs smoothly at frame rate. It decides
 * nothing: the bounces and the blast are the server's.
 */
export class GrenadeView {
  readonly container: Phaser.GameObjects.Container;

  private readonly body: Phaser.GameObjects.Image;
  private readonly glow: Phaser.GameObjects.Image;
  /** Behind the grenade itself, so the head of the trail never covers it. */
  private readonly trail: TrailRenderer;

  private serverX: number;
  private serverY: number;
  private velocityX: number;
  private velocityY: number;
  private lastSyncAt: number;
  private spin = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    grenade: SyncedGrenade,
    now: number,
  ) {
    this.serverX = grenade.x;
    this.serverY = grenade.y;
    this.velocityX = grenade.velocityX;
    this.velocityY = grenade.velocityY;
    this.lastSyncAt = now;

    this.glow = scene.add
      .image(0, 0, TextureKeys.BulletGlow)
      .setTint(0xff6b6b)
      .setScale(1.4)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.body = scene.add.image(0, 0, TextureKeys.Grenade);

    this.container = scene.add.container(grenade.x, grenade.y, [this.glow, this.body]).setDepth(9);
    this.trail = new TrailRenderer(scene, "grenade", 8);
  }

  /**
   * Whether this snapshot shows a bounce since the last one.
   *
   * A sign flip on either axis means the server reflected it off something,
   * which is the only signal needed -- no extra message has to cross the wire.
   */
  detectBounce(grenade: SyncedGrenade): boolean {
    const flippedX = Math.sign(grenade.velocityX) !== Math.sign(this.velocityX);
    const flippedY = Math.sign(grenade.velocityY) !== Math.sign(this.velocityY);
    // A meaningful reversal only; near-zero drift flips sign constantly.
    const fast = Math.hypot(this.velocityX, this.velocityY) > 60;
    return fast && (flippedX || flippedY);
  }

  /** Adopt a fresh authoritative position. */
  syncFromServer(grenade: SyncedGrenade, now: number): void {
    this.serverX = grenade.x;
    this.serverY = grenade.y;
    this.velocityX = grenade.velocityX;
    this.velocityY = grenade.velocityY;
    this.lastSyncAt = now;
  }

  /**
   * Extrapolate from the last snapshot.
   *
   * Capped at a short window: a grenade that bounced since the last patch would
   * otherwise be drawn drifting through a wall until the next one arrives.
   */
  render(now: number, deltaSeconds: number, fuseSeconds: number): void {
    const elapsed = Math.min((now - this.lastSyncAt) / 1000, 0.12);
    this.container.setPosition(
      this.serverX + this.velocityX * elapsed,
      this.serverY + this.velocityY * elapsed,
    );

    // Fed the drawn position rather than the server's, so the trail is the arc
    // that was actually on screen -- extrapolation included -- rather than a
    // 20Hz dotted line through it.
    this.trail.update(this.container.x, this.container.y, now);

    // Tumble in the direction of travel, so a thrown grenade reads as thrown.
    this.spin += deltaSeconds * (this.velocityX >= 0 ? 9 : -9);
    this.body.setRotation(this.spin);

    // Blink faster as the fuse runs down.
    const urgency = fuseSeconds <= 1 ? 14 : 5;
    this.glow.setAlpha(0.35 + Math.abs(Math.sin(now / 1000 * urgency)) * 0.5);
  }

  destroy(): void {
    this.trail.destroy();
    this.container.destroy(true);
    void this.scene;
  }
}
