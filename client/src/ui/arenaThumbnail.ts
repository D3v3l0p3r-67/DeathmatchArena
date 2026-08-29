/**
 * Draws a map as a small picture.
 *
 * A level list without thumbnails asks the player to remember what "Refinery"
 * looks like; one with them tells you at a glance whether it is a tower, a
 * yard or a long corridor. There is no art to load: an arena already *is* a
 * list of rectangles, so the thumbnail is the same data drawn small.
 *
 * Kept out of the game's rendering entirely -- this is a 2D canvas in the DOM
 * layer, not a Phaser scene, so a menu can show a map it is not playing.
 */
import { SurfaceType, type ArenaDefinition } from "@deathmatch/shared";

/** Ink for each kind of surface, so the shape of a level reads immediately. */
const INK: Record<string, string> = {
  [SurfaceType.FLOOR]: "#39506f",
  [SurfaceType.PLATFORM]: "#41608a",
  [SurfaceType.WALL]: "#2b3b53",
  [SurfaceType.OBSTACLE]: "#6b4a63",
};

const TRAP_INK = "rgba(255, 107, 107, 0.75)";
const SPAWN_INK = "rgba(82, 224, 138, 0.9)";

/**
 * Render `arena` into `canvas`, fitted and centred.
 *
 * Sized from the element's own box so it stays crisp on a high-density
 * display, and drawn once -- a thumbnail never animates.
 */
export function drawArenaThumbnail(canvas: HTMLCanvasElement, arena: ArenaDefinition): void {
  const context = canvas.getContext("2d");
  if (!context) return;

  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || Number(canvas.getAttribute("width")) || 160;
  const height = canvas.clientHeight || Number(canvas.getAttribute("height")) || 60;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);

  context.clearRect(0, 0, width, height);
  context.fillStyle = "#0a0e16";
  context.fillRect(0, 0, width, height);

  /*
   * Filled and cropped, not letterboxed.
   *
   * A campaign level is 7.5:1 and a thumbnail is under 3:1, so fitting the
   * whole thing squeezed it into a smear across the middle. Scaling to fill
   * and cropping shows the level's opening at its true proportions -- a
   * picture of a place rather than a diagram of a strip. Anchored at the first
   * player spawn, which is where the level actually begins.
   */
  const scale = Math.max(width / arena.width, height / arena.height);
  const start = arena.playerSpawns.find((point) => point.enabled) ?? arena.playerSpawns[0];
  const focusX = start ? start.x : arena.width / 2;
  const focusY = start ? start.y : arena.height / 2;
  // Keep the crop inside the arena, so no edge of empty space is shown.
  const offsetX = clamp(width / 2 - focusX * scale, width - arena.width * scale, 0);
  const offsetY = clamp(height / 2 - focusY * scale, height - arena.height * scale, 0);
  const place = (x: number, y: number, w: number, h: number) => ({
    x: offsetX + x * scale,
    y: offsetY + y * scale,
    // Never thinner than a pixel, or a platform vanishes at this size.
    w: Math.max(1, w * scale),
    h: Math.max(1, h * scale),
  });

  for (const element of arena.elements) {
    const box = place(element.x, element.y, element.width, element.height);
    context.fillStyle = INK[element.type] ?? INK[SurfaceType.PLATFORM]!;
    context.fillRect(box.x, box.y, box.w, box.h);
  }

  for (const trap of arena.traps) {
    if (!trap.enabled) continue;
    const box = place(trap.x, trap.y, trap.width, trap.height);
    context.fillStyle = TRAP_INK;
    context.fillRect(box.x, box.y, box.w, box.h);
  }

  for (const spawn of arena.playerSpawns) {
    if (!spawn.enabled) continue;
    const point = place(spawn.x, spawn.y, 1, 1);
    context.fillStyle = SPAWN_INK;
    context.beginPath();
    context.arc(point.x, point.y, 2, 0, Math.PI * 2);
    context.fill();
  }
}

/** Clamp that tolerates a reversed range, which a small arena produces. */
function clamp(value: number, min: number, max: number): number {
  if (min > max) return (min + max) / 2;
  return Math.min(max, Math.max(min, value));
}
