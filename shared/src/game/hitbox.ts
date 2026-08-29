/**
 * The box a shot, a swing or a blast is tested against.
 *
 * Movement uses a plain `PLAYER.WIDTH x PLAYER.HEIGHT` box for everybody, and
 * deliberately so: a boss drawn half as large again still has to walk through
 * the gaps its level was drawn around. Damage is the other question -- what a
 * player can see and aim at -- and there the answer has to be the figure on
 * screen, or shooting a boss in the head does nothing and the boss reads as
 * broken.
 *
 * So the two boxes are allowed to differ, and this is the one that matters to
 * anything that hurts. For everybody but a campaign boss the scale is 1 and the
 * two are the same box.
 */
import { centeredBounds, type Bounds } from "../core/geometry.js";
import { PLAYER_HALF_HEIGHT, PLAYER_HALF_WIDTH } from "./constants.js";

/** Anything with a position and a drawn size: a `PlayerState`, or a test double. */
export interface HittableBody {
  readonly x: number;
  readonly y: number;
  readonly bodyScale: number;
}

/** Half-extents of the damage box, scaled to what is drawn. */
export function hitHalfExtents(bodyScale: number): { halfWidth: number; halfHeight: number } {
  // A zero or negative scale would make a target unhittable, which is never
  // what a level meant; treat anything unset or nonsensical as a plain player.
  const scale = bodyScale > 0 ? bodyScale : 1;
  return { halfWidth: PLAYER_HALF_WIDTH * scale, halfHeight: PLAYER_HALF_HEIGHT * scale };
}

/** The damage box of one body, in world space. */
export function hitBounds(body: HittableBody): Bounds {
  const { halfWidth, halfHeight } = hitHalfExtents(body.bodyScale);
  return centeredBounds(body.x, body.y, halfWidth, halfHeight);
}
