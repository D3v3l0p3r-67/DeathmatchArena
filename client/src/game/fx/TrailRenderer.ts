import Phaser from "phaser";
import { TextureKeys } from "../TextureFactory.js";
import { TRAILS, type TrailName, type TrailSpec } from "./effects.js";
import { TrailPath } from "./trailPath.js";

/**
 * Draws a fading trail behind anything that moves.
 *
 * One of these belongs to whatever leaves the trail -- a `PlayerView`, a
 * `GrenadeView`, and anything given one later -- and knows nothing about what
 * that is. It is handed a position once per frame and draws the path that
 * position has actually taken, which is what makes a grenade's arc read as an
 * arc rather than as a straight line to wherever it is now.
 *
 * **Nothing is created per frame.** The sprites are a pool allocated once at
 * construction, one per segment the spec asks for, and every frame each is
 * either repositioned or hidden. Phaser's `Graphics` was the obvious
 * alternative and the wrong one: it re-tessellates on every `clear()`, and a
 * trail changes every single frame by definition -- see the note on
 * `PlayerView.drawHealthBar` for the same reasoning pointing the other way,
 * where a bar that rarely changes is cheaper as geometry.
 *
 * The path arithmetic lives in `TrailPath`, which has no Phaser in it at all.
 */
export class TrailRenderer {
  private readonly path: TrailPath;
  private readonly spec: TrailSpec;
  private readonly sprites: Phaser.GameObjects.Image[] = [];
  private visible = true;

  constructor(scene: Phaser.Scene, name: TrailName, depth: number) {
    this.spec = TRAILS[name];
    this.path = new TrailPath(this.spec);

    for (let i = 0; i < this.spec.segments; i++) {
      const sprite = scene.add
        .image(0, 0, TextureKeys.Pixel)
        // Anchored at the older end and stretched towards the newer one, so a
        // segment is placed by one point and aimed at the other.
        .setOrigin(0, 0.5)
        .setTint(this.spec.color)
        .setDepth(depth)
        .setVisible(false);
      if (this.spec.additive) sprite.setBlendMode(Phaser.BlendModes.ADD);
      this.sprites.push(sprite);
    }
  }

  /**
   * Offer this frame's position and redraw.
   *
   * Safe to call every frame whatever the emitter is doing: the sampling gate
   * in `TrailPath` decides whether the position is worth recording, and a trail
   * that stops being fed fades out where it is rather than disappearing.
   */
  update(x: number, y: number, nowMs: number): void {
    this.path.sample(x, y, nowMs);
    this.draw(nowMs);
  }

  /**
   * Let the trail fade without adding to it.
   *
   * For an emitter that is still there but should stop trailing -- a player who
   * has died and is being thrown by the death animation, whose body is moving
   * but is no longer *travelling*.
   */
  fade(nowMs: number): void {
    this.draw(nowMs);
  }

  /** Drop the path outright, for a jump in position that is not travel. */
  clear(): void {
    this.path.clear();
    for (const sprite of this.sprites) sprite.setVisible(false);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) for (const sprite of this.sprites) sprite.setVisible(false);
  }

  destroy(): void {
    for (const sprite of this.sprites) sprite.destroy();
    this.sprites.length = 0;
  }

  private draw(nowMs: number): void {
    if (!this.visible) return;

    const live = this.path.update(nowMs);
    for (let i = 0; i < this.sprites.length; i++) {
      const sprite = this.sprites[i]!;
      if (i >= live) {
        sprite.setVisible(false);
        continue;
      }

      const segment = this.path.segmentAt(i);
      const dx = segment.x1 - segment.x0;
      const dy = segment.y1 - segment.y0;

      sprite.setVisible(true);
      sprite.setPosition(segment.x0, segment.y0);
      sprite.setRotation(Math.atan2(dy, dx));
      sprite.setDisplaySize(Math.hypot(dx, dy), segment.width);
      sprite.setAlpha(segment.alpha);
    }
  }
}
