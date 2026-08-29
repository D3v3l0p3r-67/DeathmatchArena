import {
  PLAYER,
  PLAYER_HALF_WIDTH,
  clamp01,
  type CollisionWorld,
  type GrenadeConfig,
} from "@deathmatch/shared";

/**
 * Where a throw would end up.
 *
 * A grenade is the one thing a bot can do that hurts *itself* if it is wrong,
 * and the wrong that actually happened was never "misjudged the distance": it
 * was throwing into the ledge overhead or the crate at knee height, so the
 * grenade came straight back down at its feet. The distance guard in the action
 * cannot see that, because the target really was far away.
 *
 * So this flies the throw. Only the opening of the flight, and only up to the
 * first thing it hits -- a grenade that gets clear of the thrower has stopped
 * being a danger to them, and how it bounces after that is the grenade system's
 * business, not a bot's guess.
 */

/** How far along the flight to look before calling it clear, in seconds. */
const HORIZON_SEC = 1.1;
/** Simulation step. Fine enough to catch a ledge, coarse enough to be free. */
const STEP_SEC = 1 / 60;

/**
 * The speed the combat controller will throw at for this distance.
 *
 * Shared with the controller rather than reproduced, so a bot's plan and the
 * throw it actually makes cannot drift apart.
 */
export function throwSpeedFor(distance: number, config: GrenadeConfig): number {
  const min = config.minThrowSpeed;
  const max = Math.max(min + 1, config.maxThrowSpeed);
  // The inverse of the ballistic range for a lob: v = sqrt(distance * g).
  const needed = Math.sqrt(Math.max(0, distance) * config.gravity);
  return min + clamp01((needed - min) / (max - min)) * (max - min);
}

/**
 * How far a throw at this target gets before it hits something, in px.
 *
 * Measured from the thrower, so it compares directly against a blast radius.
 * `Infinity` means nothing was hit inside the horizon.
 */
export function throwClearance(
  world: CollisionWorld,
  config: GrenadeConfig,
  fromX: number,
  fromY: number,
  aimAngle: number,
  speed: number,
): number {
  // The same hand position the grenade system spawns from.
  const offset = PLAYER_HALF_WIDTH + config.radius + 2;
  let x = fromX + Math.cos(aimAngle) * offset;
  let y = fromY + PLAYER.AIM_ORIGIN_Y + Math.sin(aimAngle) * offset;
  const velocityX = Math.cos(aimAngle) * speed;
  let velocityY = Math.sin(aimAngle) * speed;

  for (let elapsed = 0; elapsed < HORIZON_SEC; elapsed += STEP_SEC) {
    velocityY += config.gravity * STEP_SEC;
    x += velocityX * STEP_SEC;
    y += velocityY * STEP_SEC;

    if (world.isBoxBlocked(x, y, config.radius, config.radius)) {
      return Math.hypot(x - fromX, y - fromY);
    }
  }

  return Infinity;
}

/**
 * The angle the combat controller will throw at.
 *
 * Aimed above the target, because a thrown grenade falls. Kept here beside the
 * flight so the prediction and the throw share one idea of "upwards a bit".
 */
export function throwAngleFor(dx: number, dy: number): number {
  const loft = clamp01(Math.abs(dx) / 900) * 0.55;
  return Math.atan2(dy, dx) - loft;
}
