import Phaser from "phaser";
import { SurfaceType, type ArenaDefinition, type Surface } from "@deathmatch/shared";

/** Fill / edge colours per surface type, so geometry reads at a glance. */
const SURFACE_STYLE: Record<string, { fill: number; edge: number; accent: number }> = {
  [SurfaceType.FLOOR]: { fill: 0x232c3f, edge: 0x3d4d6e, accent: 0x4d6592 },
  [SurfaceType.PLATFORM]: { fill: 0x2a3550, edge: 0x4a5f8f, accent: 0x6a86c4 },
  [SurfaceType.WALL]: { fill: 0x1d2435, edge: 0x36425f, accent: 0x44547a },
  [SurfaceType.OBSTACLE]: { fill: 0x33283a, edge: 0x5c4468, accent: 0x7d5c8f },
};

/**
 * Draws the arena.
 *
 * Purely visual: collision comes from the same `ArenaDefinition` via
 * `CollisionWorld` in `@deathmatch/shared`, so what you see is exactly what the
 * server simulates. Geometry is static, so everything is drawn once into a couple
 * of Graphics objects instead of per-frame.
 */
export class ArenaRenderer {
  private readonly background: Phaser.GameObjects.Graphics;
  private readonly geometry: Phaser.GameObjects.Graphics;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly arena: ArenaDefinition,
  ) {
    this.background = scene.add.graphics().setDepth(-100);
    this.geometry = scene.add.graphics().setDepth(-10);

    this.drawBackground();
    this.drawSurfaces();
    this.drawSpawnMarkers();
  }

  private drawBackground(): void {
    const { width, height } = this.arena;

    this.background.fillStyle(this.arena.backgroundColor, 1);
    this.background.fillRect(0, 0, width, height);

    // Faint grid: gives the eye a sense of scale and speed while scrolling.
    this.background.lineStyle(1, 0xffffff, 0.03);
    for (let x = 0; x <= width; x += 160) {
      this.background.lineBetween(x, 0, x, height);
    }
    for (let y = 0; y <= height; y += 160) {
      this.background.lineBetween(0, y, width, y);
    }

    // Depth haze towards the bottom of the arena.
    this.background.fillStyle(this.arena.fogColor, 0.35);
    this.background.fillRect(0, height - 420, width, 420);
  }

  private drawSurfaces(): void {
    for (const surface of this.arena.surfaces) {
      this.drawSurface(surface);
    }
  }

  private drawSurface(surface: Surface): void {
    const style = SURFACE_STYLE[surface.type] ?? SURFACE_STYLE[SurfaceType.PLATFORM]!;

    this.geometry.fillStyle(style.fill, 1);
    this.geometry.fillRect(surface.x, surface.y, surface.width, surface.height);

    this.geometry.lineStyle(2, style.edge, 1);
    this.geometry.strokeRect(surface.x, surface.y, surface.width, surface.height);

    // Highlight the walkable top edge -- the surface players actually land on.
    if (surface.height >= 8) {
      this.geometry.fillStyle(style.accent, 0.9);
      this.geometry.fillRect(surface.x, surface.y, surface.width, 3);
    }
  }

  /** Subtle markers so the level design is readable while testing. */
  private drawSpawnMarkers(): void {
    const markers = this.scene.add.graphics().setDepth(-9);
    markers.lineStyle(1, 0x37d0ff, 0.18);
    for (const spawn of this.arena.spawnPoints) {
      markers.strokeCircle(spawn.x, spawn.y, 20);
    }
  }

  destroy(): void {
    this.background.destroy();
    this.geometry.destroy();
  }
}
