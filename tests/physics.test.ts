import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CollisionWorld,
  FIXED_DELTA,
  PHYSICS,
  PLAYER_HALF_HEIGHT,
  PLAYER_HALF_WIDTH,
  createInputCommand,
  createMovementState,
  getArena,
  stepPlayerMovement,
} from "@deathmatch/shared";

const arena = getArena("foundry");
const world = new CollisionWorld(arena);

/** Run `steps` simulation ticks with a fixed input, mirroring the server loop. */
function simulate(state: ReturnType<typeof createMovementState>, input = createInputCommand(), steps = 60) {
  for (let i = 0; i < steps; i++) {
    input.seq = i + 1;
    stepPlayerMovement(state, input, FIXED_DELTA, world);
  }
  return state;
}

describe("arena", () => {
  it("has spawn points that are free and grounded", () => {
    assert.ok(arena.spawnPoints.length >= 10, "arena must provide one spawn per player");

    for (const [index, spawn] of arena.spawnPoints.entries()) {
      assert.ok(
        !world.isBoxBlocked(spawn.x, spawn.y, PLAYER_HALF_WIDTH, PLAYER_HALF_HEIGHT),
        `spawn ${index} is inside geometry`,
      );

      // Falling from the spawn must land on something rather than drift forever.
      const state = simulate(createMovementState(spawn.x, spawn.y), createInputCommand(), 240);
      assert.equal(state.onGround, true, `spawn ${index} has no ground beneath it`);
    }
  });

  it("is fully enclosed, so nothing can leave the world", () => {
    const corners = [
      [10, 10],
      [arena.width - 10, 10],
      [10, arena.height - 10],
      [arena.width - 10, arena.height - 10],
    ] as const;

    for (const [x, y] of corners) {
      assert.ok(world.isBoxBlocked(x, y, 4, 4), `world edge at ${x},${y} is not solid`);
    }
  });
});

describe("player movement", () => {
  it("falls, lands and stays on the ground", () => {
    const spawn = arena.spawnPoints[1]!;
    const state = simulate(createMovementState(spawn.x, spawn.y - 200), createInputCommand(), 180);

    assert.equal(state.onGround, true);
    assert.equal(state.velocityY, 0);
  });

  it("reaches roughly the analytical jump height", () => {
    const spawn = arena.spawnPoints[1]!;
    const grounded = simulate(createMovementState(spawn.x, spawn.y), createInputCommand(), 60);
    const startY = grounded.y;

    const input = createInputCommand();
    input.jump = true;

    let peak = startY;
    for (let i = 0; i < 45; i++) {
      input.seq = i + 1;
      stepPlayerMovement(grounded, input, FIXED_DELTA, world);
      peak = Math.min(peak, grounded.y);
    }

    const expected = (PHYSICS.JUMP_VELOCITY * PHYSICS.JUMP_VELOCITY) / (2 * PHYSICS.GRAVITY);
    const actual = startY - peak;
    assert.ok(
      Math.abs(actual - expected) < expected * 0.15,
      `jump height ${actual.toFixed(1)}px is far from the expected ${expected.toFixed(1)}px`,
    );
  });

  it("accelerates to the run speed cap and no further", () => {
    const spawn = arena.spawnPoints[1]!;
    const state = simulate(createMovementState(spawn.x, spawn.y), createInputCommand(), 30);

    const input = createInputCommand();
    input.moveRight = true;
    simulate(state, input, 120);

    assert.ok(state.velocityX <= PHYSICS.MAX_RUN_SPEED + 1e-6, "exceeded the run speed cap");
    assert.ok(state.velocityX > 0 || state.x > spawn.x, "player did not move right");
    assert.equal(state.facing, 1);
  });

  it("is blocked by walls instead of passing through them", () => {
    // Run hard into the left wall for two seconds.
    const state = createMovementState(200, 1700);
    const input = createInputCommand();
    input.moveLeft = true;
    simulate(state, input, 120);

    assert.ok(state.x >= PLAYER_HALF_WIDTH, "player left the world through the wall");
    assert.ok(state.x >= 40, "player tunnelled into the wall surface");
  });

  it("is deterministic: identical inputs produce identical results", () => {
    const inputs = Array.from({ length: 120 }, (_, i) => {
      const input = createInputCommand(i + 1);
      input.moveRight = i % 3 !== 0;
      input.moveLeft = i % 7 === 0;
      input.jump = i % 11 === 0;
      return input;
    });

    const run = () => {
      const state = createMovementState(600, 1600);
      for (const input of inputs) stepPlayerMovement(state, input, FIXED_DELTA, world);
      return state;
    };

    const a = run();
    const b = run();
    assert.deepEqual(a, b, "the simulation must be reproducible for prediction to work");
  });
});

describe("raycasting", () => {
  it("stops at the floor", () => {
    const hit = world.raycast(600, 1600, 600, 1790);
    assert.ok(hit, "ray should hit the floor");
    assert.ok(Math.abs(hit.y - 1740) < 1, `expected floor at y=1740, hit at ${hit.y}`);
    assert.equal(hit.normalY, -1);
  });

  it("returns null when nothing is in the way", () => {
    const hit = world.raycast(600, 1600, 700, 1600);
    assert.equal(hit, null);
  });
});
