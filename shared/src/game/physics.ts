import { centeredBounds } from "../core/geometry.js";
import { clamp } from "../core/math.js";
import { getPlayerConfig } from "../config/registry.js";
import type { PlayerConfig } from "../config/types.js";
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
 * The tuning now arrives as an argument rather than from a constant, because an
 * administrator can change gravity and jump strength. That makes the agreement
 * between client and server explicit: the server sends the room's player
 * configuration on join, the client predicts with those exact numbers, and both
 * sides keep stepping the same integrator.
 *
 * Do not add randomness, wall-clock time or entity lookups here.
 */
export function stepPlayerMovement(
  state: MovementState,
  input: InputCommand,
  dt: number,
  world: CollisionWorld,
  bounds?: WorldBounds,
  player: PlayerConfig = getPlayerConfig(),
): void {
  applyHorizontalIntent(state, input, dt, player);
  applyJump(state, input, dt, player);
  applyGravity(state, dt, player);
  integrateAndCollide(state, dt, world, bounds);

  // Counted down after the step, so a shove that lands between steps is worth a
  // full recovery window rather than however much of one is left.
  if (state.knockbackTimer > 0) state.knockbackTimer = Math.max(0, state.knockbackTimer - dt);
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

function applyHorizontalIntent(
  state: MovementState,
  input: InputCommand,
  dt: number,
  player: PlayerConfig,
): void {
  const direction = (input.moveRight ? 1 : 0) - (input.moveLeft ? 1 : 0);

  // A live shove bleeds off by its own damping instead of through friction, and
  // keeps doing so whether or not the player is steering. Ground friction would
  // otherwise erase the whole impulse within a frame or two of it landing.
  const knocked = state.knockbackTimer > 0;
  if (knocked) {
    state.velocityX -= state.velocityX * Math.min(1, player.knockbackDamping * dt);
  }

  if (direction !== 0) {
    const acceleration = state.onGround ? player.groundAcceleration : player.airAcceleration;
    // A speed power-up raises the cap, not the acceleration, so a boosted player
    // still feels the same to steer -- they just keep gaining until a higher top speed.
    const maxSpeed = player.moveSpeed * (state.speedMultiplier || 1);

    // The limit never clips below the speed already carried. Clamping to the run
    // cap outright would mean a knocked-back player cancels the knockback simply
    // by holding a movement key -- the shove would land and then vanish. Holding
    // a key still cannot push *past* the cap; friction is what bleeds the excess.
    const limit = Math.max(maxSpeed, Math.abs(state.velocityX));
    state.velocityX = clamp(state.velocityX + direction * acceleration * dt, -limit, limit);
    state.facing = direction;
    return;
  }

  if (knocked) return;

  const friction = (state.onGround ? player.groundFriction : player.airFriction) * dt;
  if (Math.abs(state.velocityX) <= friction) {
    state.velocityX = 0;
  } else {
    state.velocityX -= Math.sign(state.velocityX) * friction;
  }
}

function applyJump(
  state: MovementState,
  input: InputCommand,
  dt: number,
  player: PlayerConfig,
): void {
  const pressed = input.jump && !state.jumpHeld;
  const maxJumps = Math.max(1, Math.round(player.maxJumps));
  // Configured as "how hard you jump"; the simulation wants it as an upward
  // (negative) velocity.
  const jumpVelocity = -Math.abs(player.jumpVelocity);
  const coyoteTime = player.coyoteTimeMs / 1000;
  const jumpBufferTime = player.jumpBufferMs / 1000;

  // Landing refills the whole allowance, so the mid-air jump comes back.
  if (state.onGround) state.jumpsRemaining = maxJumps;

  // Buffered jump: a press slightly before landing still triggers on touchdown.
  state.jumpBufferTimer = pressed ? jumpBufferTime : Math.max(0, state.jumpBufferTimer - dt);

  // Coyote time: a jump shortly after walking off a ledge still counts.
  state.coyoteTimer = state.onGround ? coyoteTime : Math.max(0, state.coyoteTimer - dt);

  // Walking off a ledge without jumping forfeits the ground jump once coyote
  // time lapses -- otherwise stepping off a platform would grant two air jumps.
  if (!state.onGround && state.coyoteTimer <= 0 && state.jumpsRemaining >= maxJumps) {
    state.jumpsRemaining = maxJumps - 1;
  }

  if (state.jumpBufferTimer > 0 && state.coyoteTimer > 0) {
    // Jump from the ground (or within coyote time).
    state.velocityY = jumpVelocity;
    state.jumpBufferTimer = 0;
    state.coyoteTimer = 0;
    state.onGround = false;
    state.jumpsRemaining = Math.max(0, state.jumpsRemaining - 1);
  } else if (pressed && !state.onGround && state.jumpsRemaining > 0) {
    // Mid-air jump. Velocity is *replaced* rather than added to, so it lifts you
    // just as reliably while falling fast as it does at the top of an arc.
    state.velocityY = jumpVelocity * player.airJumpMultiplier;
    state.jumpBufferTimer = 0;
    state.jumpsRemaining -= 1;
  }

  // Variable jump height: releasing the button early cuts the ascent short.
  if (!input.jump && state.jumpHeld && state.velocityY < 0) {
    state.velocityY *= player.jumpCutMultiplier;
  }

  state.jumpHeld = input.jump;
}

function applyGravity(state: MovementState, dt: number, player: PlayerConfig): void {
  state.velocityY = Math.min(state.velocityY + player.gravity * dt, player.maxFallSpeed);
}

/**
 * How far past a ledge's corner an upward move may be nudged, in px.
 *
 * Deliberately well under half the player's width: it forgives clipping a
 * corner, never lets somebody through a wall they were squarely under.
 */
const CORNER_CORRECTION = 9;

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
      // Corner correction: clipping a ledge with the edge of your head is
      // almost always a jump you meant to make, and stopping it dead is the
      // single most common way a platformer feels like it snagged. If the
      // overlap is only a sliver, nudge past the corner and keep going.
      const fromLeft = box.right - solid.left;
      const fromRight = solid.right - box.left;
      const nudge = Math.min(fromLeft, fromRight);

      if (nudge <= CORNER_CORRECTION && nudge > 0) {
        state.x += fromLeft < fromRight ? -(nudge + epsilon) : nudge + epsilon;
        continue;
      }

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
 * One unit of knockback, in px/s.
 *
 * The scale that turns a weapon's `knockbackForce` into a velocity, so the
 * per-weapon numbers read as multiples of each other (0.3 shoves, 2.0 launches)
 * rather than as raw speeds nobody can compare.
 */
export const KNOCKBACK_IMPULSE = 260;

/**
 * Shove a player.
 *
 * Added to whatever they were already doing rather than replacing it, so a
 * knockback compounds with a jump the way it should, and clamped so no single
 * hit -- however a weapon is configured -- can exceed what the player
 * configuration says is survivable for the simulation.
 *
 * Deliberately a velocity change and never a position change: teleporting
 * somebody out of a hit would put them through geometry, and would arrive on
 * every other client as a jump rather than as a shove.
 */
export function applyKnockback(
  state: MovementState,
  directionX: number,
  directionY: number,
  force: number,
  player: PlayerConfig,
  lift = 0,
): void {
  if (force <= 0) return;

  const length = Math.hypot(directionX, directionY);
  if (length <= 0) return;

  const speed = Math.min(force * KNOCKBACK_IMPULSE, Math.max(0, player.maxKnockbackSpeed));
  state.velocityX += (directionX / length) * speed;
  state.velocityY += (directionY / length) * speed;

  // Taken off their feet, so the shove carries instead of being scrubbed off by
  // the floor. Only for hits landing on somebody standing: a shooter's own
  // recoil passes lift 0, or firing would hop them with every round.
  if (lift > 0 && state.onGround) {
    state.velocityY -= speed * lift;
  }

  // Whatever the shove is worth, it now decays on its own terms for a while.
  state.knockbackTimer = Math.max(state.knockbackTimer, player.knockbackRecoveryMs / 1000);

  // A hit can lift somebody off the ground; leaving `onGround` set would let them
  // jump again in mid-air off the back of being shot.
  if (state.velocityY < -1) state.onGround = false;
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
