import { clamp01, type ArenaDefinition } from "@deathmatch/shared";

/**
 * Pure minimap geometry: no DOM, no config, no game state.
 *
 * Kept apart from `Minimap.ts` on purpose. That file's `HTMLElement`s pull the
 * DOM lib into whatever TypeScript program imports it, and this arithmetic is
 * exactly the kind of thing worth unit-testing directly -- so it lives where a
 * test can import it without dragging a browser's types along.
 */

/** One dot's position, normalised to the arena so CSS can place it as a percentage. */
export interface MinimapPoint {
  nx: number;
  ny: number;
}

/** World coordinates as a fraction of the arena, 0..1 on each axis. */
export function normalisePosition(x: number, y: number, arena: ArenaDefinition): MinimapPoint {
  return {
    nx: clamp01(arena.width > 0 ? x / arena.width : 0),
    ny: clamp01(arena.height > 0 ? y / arena.height : 0),
  };
}

/**
 * Whether something at `(x, y)` earns a dot, measured from `(centerX, centerY)`.
 *
 * A radius of 0 (or anything not a positive, finite number) means no limit --
 * the whole arena is in range, which is what lets the admin field's "0 shows
 * everything" description stay literally true rather than a special case this
 * function has to be trusted to also implement correctly.
 */
export function withinRadius(
  centerX: number,
  centerY: number,
  x: number,
  y: number,
  radius: number,
): boolean {
  if (!Number.isFinite(radius) || radius <= 0) return true;
  return Math.hypot(x - centerX, y - centerY) <= radius;
}
