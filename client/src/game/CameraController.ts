import Phaser from "phaser";
import { CAMERA, clamp, damp, type ArenaDefinition } from "@deathmatch/shared";

/**
 * Smooth, world-clamped camera.
 *
 * The arena is much larger than the viewport, so the camera scrolls in both axes
 * to follow whoever is being watched -- the local player normally, or a survivor
 * while spectating. It leans slightly towards where the player is aiming, which
 * reveals more of the direction that actually matters, and it is clamped to the
 * arena bounds so the void is never on screen.
 *
 * All positions here are world coordinates; screen space never enters gameplay.
 */
export class CameraController {
  private readonly camera: Phaser.Cameras.Scene2D.Camera;

  private targetX = 0;
  private targetY = 0;
  private lookAheadX = 0;
  private lookAheadY = 0;

  constructor(scene: Phaser.Scene, arena: ArenaDefinition) {
    this.camera = scene.cameras.main;
    this.camera.setBounds(0, 0, arena.width, arena.height);
    this.camera.setRoundPixels(true);
  }

  /** A different arena is a different box to stay inside. */
  setArena(arena: ArenaDefinition): void {
    this.camera.setBounds(0, 0, arena.width, arena.height);
  }

  /** Jump straight to a position, e.g. on spawn or when switching spectator target. */
  snapTo(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
    this.lookAheadX = 0;
    this.lookAheadY = 0;
    this.camera.centerOn(x, y);
  }

  /**
   * Follow a world position.
   *
   * @param aimAngle direction the watched player is aiming, for the look-ahead lean
   */
  follow(x: number, y: number, aimAngle: number, deltaSeconds: number): void {
    this.targetX = x;
    this.targetY = y;

    const desiredLookAheadX = Math.cos(aimAngle) * CAMERA.AIM_LOOK_AHEAD;
    const desiredLookAheadY = Math.sin(aimAngle) * CAMERA.AIM_LOOK_AHEAD * 0.5;

    this.lookAheadX = damp(this.lookAheadX, desiredLookAheadX, 0.02, deltaSeconds);
    this.lookAheadY = damp(this.lookAheadY, desiredLookAheadY, 0.02, deltaSeconds);

    const desiredScrollX = this.targetX + this.lookAheadX - this.camera.width / 2;
    const desiredScrollY = this.targetY + this.lookAheadY - this.camera.height / 2;

    // Frame-rate independent smoothing, so a 144Hz display is not "faster".
    const smoothing = Math.pow(1 - CAMERA.FOLLOW_LERP, deltaSeconds * 60);
    this.camera.scrollX = desiredScrollX + (this.camera.scrollX - desiredScrollX) * smoothing;
    this.camera.scrollY = desiredScrollY + (this.camera.scrollY - desiredScrollY) * smoothing;
  }

  /** Screen position of a world point, used to place DOM overlays like the crosshair. */
  worldToScreen(x: number, y: number): { x: number; y: number } {
    const view = this.camera.worldView;
    const scaleX = this.camera.width === 0 ? 1 : 1;
    return {
      x: (x - view.x) * scaleX,
      y: y - view.y,
    };
  }

  shake(durationMs: number, intensity: number): void {
    this.camera.shake(durationMs, intensity, true);
  }

  flash(durationMs: number, r: number, g: number, b: number): void {
    this.camera.flash(durationMs, r, g, b, true);
  }

  /** Clamp an arbitrary point into the visible area, for off-screen indicators. */
  clampToView(x: number, y: number): { x: number; y: number } {
    const view = this.camera.worldView;
    return {
      x: clamp(x, view.left, view.right),
      y: clamp(y, view.top, view.bottom),
    };
  }
}
