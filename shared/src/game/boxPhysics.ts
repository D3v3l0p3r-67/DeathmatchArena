import { PHYSICS } from "./constants.js";
import type { CollisionWorld } from "./CollisionWorld.js";
import { centeredBounds } from "../core/geometry.js";

/**
 * A box that falls, slides and stops against the arena.
 *
 * Written once and sized by its caller, rather than copied out of
 * `stepPlayerMovement` with the player's half-extents swapped for a crate's.
 * The player's version stays its own because it carries a platformer's worth of
 * feel -- coyote time, corner correction, jump buffering -- that a crate has no
 * business having. What is shared is the honest part: integrate, then push back
 * out of whatever you ended up inside.
 *
 * Pure arithmetic over a `CollisionWorld`, so it is testable directly and runs
 * identically wherever it is called.
 */
export interface BoxBody {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  /** True when the last step ended resting on a surface. */
  onGround: boolean;
}

export interface BoxPhysicsSpec {
  gravity: number;
  /** Terminal velocity, downwards. */
  maxFallSpeed: number;
  /** Deceleration while resting on a surface, in px/s². */
  groundFriction: number;
  /** Deceleration while airborne. Usually far lower, so a shove carries. */
  airFriction: number;
}

/**
 * Advance one fixed step.
 *
 * Axis at a time -- horizontal, then vertical -- which is what makes "slid into
 * a wall" and "landed on a ledge" two separate, unambiguous outcomes rather
 * than one diagonal resolution that has to guess which the caller meant.
 */
export function stepBox(
  body: BoxBody,
  halfWidth: number,
  halfHeight: number,
  dt: number,
  world: CollisionWorld,
  spec: BoxPhysicsSpec,
): void {
  const epsilon = PHYSICS.COLLISION_EPSILON;

  body.velocityY = Math.min(body.velocityY + spec.gravity * dt, spec.maxFallSpeed);

  const friction = (body.onGround ? spec.groundFriction : spec.airFriction) * dt;
  if (Math.abs(body.velocityX) <= friction) body.velocityX = 0;
  else body.velocityX -= Math.sign(body.velocityX) * friction;

  // ---- Horizontal ----
  body.x += body.velocityX * dt;
  let candidates = world.querySurfaceIndices(centeredBounds(body.x, body.y, halfWidth, halfHeight));
  for (let i = 0; i < candidates.length; i++) {
    const solid = world.getSurfaceBounds(candidates[i]!);
    const box = centeredBounds(body.x, body.y, halfWidth, halfHeight);
    if (box.right <= solid.left || box.left >= solid.right) continue;
    if (box.bottom <= solid.top || box.top >= solid.bottom) continue;

    if (body.velocityX > 0) body.x = solid.left - halfWidth - epsilon;
    else if (body.velocityX < 0) body.x = solid.right + halfWidth + epsilon;
    body.velocityX = 0;
  }

  // ---- Vertical ----
  body.y += body.velocityY * dt;
  body.onGround = false;
  candidates = world.querySurfaceIndices(centeredBounds(body.x, body.y, halfWidth, halfHeight));
  for (let i = 0; i < candidates.length; i++) {
    const solid = world.getSurfaceBounds(candidates[i]!);
    const box = centeredBounds(body.x, body.y, halfWidth, halfHeight);
    if (box.right <= solid.left || box.left >= solid.right) continue;
    if (box.bottom <= solid.top || box.top >= solid.bottom) continue;

    if (body.velocityY > 0) {
      body.y = solid.top - halfHeight - epsilon;
      body.velocityY = 0;
      body.onGround = true;
    } else if (body.velocityY < 0) {
      body.y = solid.bottom + halfHeight + epsilon;
      body.velocityY = 0;
    }
  }
}
