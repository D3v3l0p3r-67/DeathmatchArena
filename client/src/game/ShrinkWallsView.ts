import Phaser from "phaser";
import type { ArenaDefinition } from "@deathmatch/shared";

const WALL_COLOR = 0xff4d5e;
const EDGE_COLOR = 0xff8a94;

/**
 * The closing walls of a shrinking arena.
 *
 * Two shaded slabs covering everything outside the playable width, plus a bright
 * edge on each inner face. Positions come straight from server state — this only
 * draws where the walls already are.
 */
export class ShrinkWallsView {
  private readonly leftSlab: Phaser.GameObjects.Rectangle;
  private readonly rightSlab: Phaser.GameObjects.Rectangle;
  private readonly leftEdge: Phaser.GameObjects.Rectangle;
  private readonly rightEdge: Phaser.GameObjects.Rectangle;

  private pulse = 0;

  constructor(scene: Phaser.Scene, private readonly arena: ArenaDefinition) {
    const height = arena.height;
    const depth = 12;

    this.leftSlab = scene.add.rectangle(0, 0, 1, height, WALL_COLOR, 0.16).setOrigin(1, 0).setDepth(depth);
    this.rightSlab = scene.add.rectangle(0, 0, 1, height, WALL_COLOR, 0.16).setOrigin(0, 0).setDepth(depth);

    this.leftEdge = scene.add.rectangle(0, 0, 5, height, EDGE_COLOR, 0.9).setOrigin(0.5, 0).setDepth(depth);
    this.rightEdge = scene.add.rectangle(0, 0, 5, height, EDGE_COLOR, 0.9).setOrigin(0.5, 0).setDepth(depth);

    this.setVisible(false);
  }

  setVisible(visible: boolean): void {
    this.leftSlab.setVisible(visible);
    this.rightSlab.setVisible(visible);
    this.leftEdge.setVisible(visible);
    this.rightEdge.setVisible(visible);
  }

  /**
   * Move the walls to the server's current limits.
   *
   * Hidden entirely while the arena is still full width, so an untouched match
   * shows no clutter at its edges.
   */
  update(left: number, right: number, shrinking: boolean, deltaSeconds: number): void {
    const active = shrinking && (left > 0 || right < this.arena.width);
    this.setVisible(active);
    if (!active) return;

    // The slabs cover everything beyond the playable width.
    this.leftSlab.setPosition(left, 0).setSize(Math.max(1, left), this.arena.height);
    this.rightSlab
      .setPosition(right, 0)
      .setSize(Math.max(1, this.arena.width - right), this.arena.height);

    this.leftEdge.setPosition(left, 0);
    this.rightEdge.setPosition(right, 0);

    // A slow pulse on the inner edges, so a closing wall reads as a threat
    // rather than as scenery.
    this.pulse = (this.pulse + deltaSeconds * 3) % (Math.PI * 2);
    const alpha = 0.65 + Math.sin(this.pulse) * 0.25;
    this.leftEdge.setAlpha(alpha);
    this.rightEdge.setAlpha(alpha);
  }

  destroy(): void {
    this.leftSlab.destroy();
    this.rightSlab.destroy();
    this.leftEdge.destroy();
    this.rightEdge.destroy();
  }
}
