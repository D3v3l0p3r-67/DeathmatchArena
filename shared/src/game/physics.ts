import { centeredBounds } from "../core/geometry.js";
import { clamp } from "../core/math.js";
import type { CollisionWorld } from "./CollisionWorld.js";
import { PHYSICS, PLAYER_HALF_HEIGHT, PLAYER_HALF_WIDTH } from "./constants.js";
import type { InputCommand, MovementState } from "./types.js";

/**
 * The one and only player movement integrator.
 *
 * The server runs it to produce authoritative state; the client runs the exact same
 * function for prediction and for replaying unacknowledged inputs during
 * reconciliation. Because it is pure, deterministic and always advanced with the
 * same fixed `dt`, both sides agree bit-for-bit as long as they saw the same inputs.
 *
 * Do not add randomness, wall-clock time or entity lookups here.
 */
export function stepPlayerMovement(
  state: MovementState,
  input: InputCommand,
  dt: number,
  world: CollisionWorld,
  bounds?: WorldBounds,
): void {
  applyHorizontalIntent(state, input, dt);
  applyJump(state, input, dt);
  applyGravity(state, dt);
  integrateAndCollide(state, dt, world, bounds);
}

/**
 * The horizontal limits a player may occupy.
 *
 * Normally the arena's own edges, but the closing walls of a shrinking arena
 * narrow them over time. Passed in rather than read from anywhere global so the
 * step stays pure: the server supplies its authoritative values and the client
 * supplies the ones it was told, and replaying inputs reproduces the same result.
 */
export interface WorldBounds {
  left: number;
  right: number;
}

function applyHorizontalIntent(state: MovementState, input: InputCommand, dt: number): void {
  const direction = (input.moveRight ? 1 : 0) - (input.moveLeft ? 1 : 0);

  if (direction !== 0) {
    const acceleration = state.onGround ? PHYSICS.GROUND_ACCELERATION : PHYSICS.AIR_ACCELERATION;
    // A speed power-up raises the cap, not the acceleration, so a boosted player
    // still feels the same to steer -- they just keep gaining until a higher top speed.
    const maxSpeed = PHYSICS.MAX_RUN_SPEED * (state.speedMultiplier || 1);
    state.velocityX = clamp(state.velocityX + direction * acceleration * dt, -maxSpeed, maxSpeed);
    state.facing = direction;
    return;
  }

  const friction = (state.onGround ? PHYSICS.GROUND_FRICTION : PHYSICS.AIR_FRICTION) * dt;
  if (Math.abs(state.velocityX) <= friction) {
    state.velocityX = 0;
  } else {
    state.velocityX -= Math.sign(state.velocityX) * friction;
  }
}

function applyJump(state: MovementState, input: InputCommand, dt: number): void {
  const pressed = input.jump && !state.jumpHeld;

  // Landing refills the whole allowance, so the mid-air jump comes back.
  if (state.onGround) state.jumpsRemaining = PHYSICS.MAX_JUMPS;

  // Buffered jump: a press slightly before landing still triggers on touchdown.
  state.jumpBufferTimer = pressed
    ? PHYSICS.JUMP_BUFFER_TIME
    : Math.max(0, state.jumpBufferTimer - dt);

  // Coyote time: a jump shortly after walking off a ledge still counts.
  state.coyoteTimer = state.onGround ? PHYSICS.COYOTE_TIME : Math.max(0, state.coyoteTimer - dt);

  // Walking off a ledge without jumping forfeits the ground jump once coyote
  // time lapses -- otherwise stepping off a platform would grant two air jumps.
  if (!state.onGround && state.coyoteTimer <= 0 && state.jumpsRemaining >= PHYSICS.MAX_JUMPS) {
    state.jumpsRemaining = PHYSICS.MAX_JUMPS - 1;
  }

  if (state.jumpBufferTimer > 0 && state.coyoteTimer > 0) {
    // Jump from the ground (or within coyote time).
    state.velocityY = PHYSICS.JUMP_VELOCITY;
    state.jumpBufferTimer = 0;
    state.coyoteTimer = 0;
    state.onGround = false;
    state.jumpsRemaining = Math.max(0, state.jumpsRemaining - 1);
  } else if (pressed && !state.onGround && state.jumpsRemaining > 0) {
    // Mid-air jump. Velocity is *replaced* rather than added to, so it lifts you
    // just as reliably while falling fast as it does at the top of an arc.
    state.velocityY = PHYSICS.JUMP_VELOCITY * PHYSICS.AIR_JUMP_MULTIPLIER;
    state.jumpBufferTimer = 0;
    state.jumpsRemaining -= 1;
  }

  // Variable jump height: releasing the button early cuts the ascent short.
  if (!input.jump && state.jumpHeld && state.velocityY < 0) {
    state.velocityY *= PHYSICS.JUMP_CUT_MULTIPLIER;
  }

  state.jumpHeld = input.jump;
}

function applyGravity(state: MovementState, dt: number): void {
  state.velocityY = Math.min(state.velocityY + PHYSICS.GRAVITY * dt, PHYSICS.MAX_FALL_SPEED);
}

/**
 * Move on one axis at a time and push out of anything we ended up inside.
 * Separating the axes is what makes sliding along walls and floors behave.
 */
function integrateAndCollide(
  state: MovementState,
  dt: number,
  world: CollisionWorld,
  bounds?: WorldBounds,
): void {
  const epsilon = PHYSICS.COLLISION_EPSILON;

  // ---- Horizontal ----
  state.x += state.velocityX * dt;
  const horizontalArea = centeredBounds(state.x, state.y, PLAYER_HALF_WIDTH, PLAYER_HALF_HEIGHT);
  let candidates = world.querySurfaceIndices(horizontalArea);
  for (let i = 0; i < candidates.length; i++) {
    const solid = world.getSurfaceBounds(candidates[i]!);
    const box = centeredBounds(state.x, state.y, PLAYER_HALF_WIDTH, PLAYER_HALF_HEIGHT);
    if (box.right <= solid.left || box.left >= solid.right) continue;
    if (box.bottom <= solid.top || box.top >= solid.bottom) continue;

    if (state.velocityX > 0) {
      state.x = solid.left - PLAYER_HALF_WIDTH - epsilon;
      state.velocityX = 0;
    } else if (state.velocityX < 0) {
      state.x = solid.right + PLAYER_HALF_WIDTH + epsilon;
      state.velocityX = 0;
    }
  }

  // ---- Vertical ----
  state.y += state.velocityY * dt;
  state.onGround = false;
  const verticalArea = centeredBounds(state.x, state.y, PLAYER_HALF_WIDTH, PLAYER_HALF_HEIGHT);
  candidates = world.querySurfaceIndices(verticalArea);
  for (let i = 0; i < candidates.length; i++) {
    const solid = world.getSurfaceBounds(candidates[i]!);
    const box = centeredBounds(state.x, state.y, PLAYER_HALF_WIDTH, PLAYER_HALF_HEIGHT);
    if (box.right <= solid.left || box.left >= solid.right) continue;
    if (box.bottom <= solid.top || box.top >= solid.bottom) continue;

    if (state.velocityY > 0) {
      state.y = solid.top - PLAYER_HALF_HEIGHT - epsilon;
      state.velocityY = 0;
      state.onGround = true;
    } else if (state.velocityY < 0) {
      state.y = solid.bottom + PLAYER_HALF_HEIGHT + epsilon;
      state.velocityY = 0;
    }
  }

  // Final clamp to the playable box. Normally the arena shell already handles
  // this; once the arena starts shrinking, these are the closing walls, and the
  // clamp is what physically pushes a player ahead of them.
  const left = bounds ? bounds.left : 0;
  const right = bounds ? bounds.right : world.arena.width;
  const minX = left + PLAYER_HALF_WIDTH;
  const maxX = right - PLAYER_HALF_WIDTH;

  // A gap narrower than the player would make min > max; centring is the only
  // sane answer, and the crush damage resolves it from there.
  state.x = minX <= maxX ? clamp(state.x, minX, maxX) : (left + right) / 2;
  state.y = clamp(state.y, PLAYER_HALF_HEIGHT, world.arena.height - PLAYER_HALF_HEIGHT);
}

/**
 * Nudge a spawn position out of geometry, searching upwards then sideways.
 * Guards against arena edits that accidentally bury a spawn point.
 */
export function findFreeSpawnPosition(
  world: CollisionWorld,
  x: number,
  y: number,
): { x: number; y: number } {
  if (!world.isBoxBlocked(x, y, PLAYER_HALF_WIDTH, PLAYER_HALF_HEIGHT)) return { x, y };

  for (let step = 1; step <= 24; step++) {
    const offset = step * 8;
    const candidates = [
      { x, y: y - offset },
      { x: x - offset, y },
      { x: x + offset, y },
      { x, y: y + offset },
    ];
    for (const candidate of candidates) {
      if (!world.isBoxBlocked(candidate.x, candidate.y, PLAYER_HALF_WIDTH, PLAYER_HALF_HEIGHT)) {
        return candidate;
      }
    }
  }

  return { x, y };
}
