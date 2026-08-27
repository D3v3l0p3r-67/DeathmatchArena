import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CollisionWorld,
  FIXED_DELTA,
  createEmptyArena,
  PLAYER_HALF_HEIGHT,
  PLAYER_HALF_WIDTH,
  createInputCommand,
  createMovementState,
  getArena,
  getPlayerConfig,
  stepPlayerMovement,
  type MovementState,
} from "@deathmatch/shared";

const arena = getArena("foundry");
const world = new CollisionWorld(arena);

/**
 * The movement tuning under test.
 *
 * Read from the configuration rather than from constants, because that is where
 * it now lives -- and because reading it the same way the simulation does is the
 * only way these assertions stay honest after a rebalance.
 */
const player = getPlayerConfig();

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
    assert.ok(arena.playerSpawns.length >= 10, "arena must provide one spawn per player");

    for (const [index, spawn] of arena.playerSpawns.entries()) {
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
    const spawn = arena.playerSpawns[1]!;
    const state = simulate(createMovementState(spawn.x, spawn.y - 200), createInputCommand(), 180);

    assert.equal(state.onGround, true);
    assert.equal(state.velocityY, 0);
  });

  it("reaches roughly the analytical jump height", () => {
    const spawn = arena.playerSpawns[1]!;
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

    const expected = (player.jumpVelocity * player.jumpVelocity) / (2 * player.gravity);
    const actual = startY - peak;
    assert.ok(
      Math.abs(actual - expected) < expected * 0.15,
      `jump height ${actual.toFixed(1)}px is far from the expected ${expected.toFixed(1)}px`,
    );
  });

  it("accelerates to the run speed cap and no further", () => {
    const spawn = arena.playerSpawns[1]!;
    const state = simulate(createMovementState(spawn.x, spawn.y), createInputCommand(), 30);

    const input = createInputCommand();
    input.moveRight = true;
    simulate(state, input, 120);

    assert.ok(state.velocityX <= player.moveSpeed + 1e-6, "exceeded the run speed cap");
    assert.ok(state.velocityX > 0 || state.x > spawn.x, "player did not move right");
    assert.equal(state.facing, 1);
  });

  /** Top speed reached over a run, so a wall at the end cannot skew the result. */
  function peakRunSpeed(configure: (state: ReturnType<typeof createMovementState>) => void): number {
    const spawn = arena.playerSpawns[1]!;
    const state = createMovementState(spawn.x, spawn.y);
    // Let them land first: a player still falling has not started running.
    simulate(state, createInputCommand(), 30);
    configure(state);

    const input = createInputCommand();
    input.moveRight = true;

    let peak = 0;
    for (let i = 0; i < 90; i++) {
      input.seq = i + 1;
      stepPlayerMovement(state, input, FIXED_DELTA, world);
      peak = Math.max(peak, Math.abs(state.velocityX));
    }
    return peak;
  }

  it("lets the weapon in hand raise or lower the run speed cap", () => {
    /*
     * The mechanism, tested at a value nothing ships with: every weapon is at 1
     * so the game plays exactly as it did, and this is what proves the knob is
     * wired rather than decorative.
     */
    const heavy = peakRunSpeed((state) => {
      state.weaponSpeedMultiplier = 0.5;
    });
    const plain = peakRunSpeed(() => {});

    assert.ok(heavy > 0, "a heavy weapon still lets you move");
    assert.ok(
      heavy <= player.moveSpeed * 0.5 + 1e-6,
      `a 0.5x weapon should cap at half the run speed, reached ${heavy}`,
    );
    assert.ok(plain > heavy, "and carrying nothing heavy should be faster");
  });

  it("multiplies the weapon's factor with a speed power-up rather than replacing it", () => {
    // Two different things that happen to compose: a boost belongs to the
    // player and is temporary, a weapon's weight belongs to the weapon.
    const both = peakRunSpeed((state) => {
      state.speedMultiplier = 2;
      state.weaponSpeedMultiplier = 0.5;
    });

    assert.ok(
      Math.abs(both - player.moveSpeed) < 2,
      `2x boost with a 0.5x weapon should land back at the plain run speed, got ${both}`,
    );
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

  it("slides past a ledge corner instead of stopping dead on it", () => {
    // The single most common way a platformer feels like it snagged: clipping
    // the edge of a ledge with the side of your head cancels the whole jump.
    const ledgeArena = createEmptyArena("corner", "Corner", 2000, 1400);
    ledgeArena.elements.push(
      { id: "floor", type: "floor", x: 0, y: 1000, width: 2000, height: 40 },
      { id: "ledge", type: "platform", x: 1000, y: 900, width: 400, height: 24 },
    );
    const ledgeWorld = new CollisionWorld(ledgeArena);

    /** Jump straight up with `overlap` px of the head under the ledge. */
    function apex(overlap: number): number {
      const state = createMovementState(1000 - PLAYER_HALF_WIDTH + overlap, 1000 - PLAYER_HALF_HEIGHT);
      state.onGround = true;

      const input = createInputCommand();
      input.jump = true;
      let highest = state.y;
      for (let i = 0; i < 40; i++) {
        input.seq = i + 1;
        stepPlayerMovement(state, input, FIXED_DELTA, ledgeWorld);
        highest = Math.min(highest, state.y);
      }
      return highest;
    }

    // A sliver of overlap is forgiven and the jump carries on past the ledge; a
    // squarely-blocked one still stops, or corner correction would be a wall
    // that is not there.
    const clipped = apex(4);
    const blocked = apex(22);
    const clear = apex(-40);

    assert.ok(
      clipped < blocked - 60,
      `a clipped corner should not cost the jump, ${clipped} vs ${blocked}`,
    );
    assert.ok(
      Math.abs(clipped - clear) < 2,
      `and should reach the same height as an unobstructed one, ${clipped} vs ${clear}`,
    );
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

describe("double jump", () => {
  /** Hold or tap jump for `ticks`, returning the state afterwards. */
  function run(state: MovementState, ticks: number, jump: boolean): void {
    for (let i = 0; i < ticks; i++) {
      const input = createInputCommand(i + 1);
      input.jump = jump;
      stepPlayerMovement(state, input, FIXED_DELTA, world);
    }
  }

  it("gives a grounded player two jumps and no more", () => {
    const state = createMovementState(600, 1700);
    run(state, 30, false);
    assert.equal(state.onGround, true, "settle on the floor first");
    assert.equal(state.jumpsRemaining, player.maxJumps);

    // First jump, off the ground.
    run(state, 1, true);
    assert.ok(state.velocityY < 0, "the first jump lifts");
    assert.equal(state.jumpsRemaining, player.maxJumps - 1);

    // Release, then press again in mid-air: the second jump.
    run(state, 4, false);
    const beforeAirJump = state.velocityY;
    run(state, 1, true);
    assert.ok(state.velocityY < beforeAirJump, "the mid-air jump lifts again");
    assert.equal(state.jumpsRemaining, 0);

    // A third press does nothing.
    run(state, 4, false);
    const beforeThird = state.velocityY;
    run(state, 1, true);
    assert.ok(state.velocityY > beforeThird, "still falling; no third jump");
    assert.equal(state.jumpsRemaining, 0);
  });

  it("refills the allowance on landing", () => {
    const state = createMovementState(600, 1700);
    run(state, 30, false);

    run(state, 1, true);
    run(state, 4, false);
    run(state, 1, true);
    assert.equal(state.jumpsRemaining, 0, "both jumps spent");

    // Fall back down and settle.
    run(state, 120, false);
    assert.equal(state.onGround, true);
    assert.equal(state.jumpsRemaining, player.maxJumps, "landing restores both");
  });

  it("gives only the air jump to a player who walked off a ledge", () => {
    // High above the mesa, with a long drop below and nothing to land on yet.
    const state = createMovementState(1600, 400);
    run(state, 20, false);
    assert.equal(state.onGround, false);
    assert.equal(
      state.jumpsRemaining,
      player.maxJumps - 1,
      "stepping off a platform forfeits the ground jump",
    );

    run(state, 1, true);
    assert.equal(state.jumpsRemaining, 0, "the single air jump is spent");
  });

  it("climbs higher with two jumps than with one", () => {
    /** Peak height reached, i.e. the smallest y seen during the run. */
    function peakOf(useSecondJump: boolean): number {
      const state = createMovementState(600, 1700);
      run(state, 30, false);

      let peak = state.y;
      const track = () => {
        peak = Math.min(peak, state.y);
      };

      run(state, 1, true);
      track();
      // Hold the ascent, then optionally release and press again at the apex.
      for (let i = 0; i < 20; i++) {
        run(state, 1, true);
        track();
      }
      if (useSecondJump) {
        run(state, 1, false);
        run(state, 1, true);
        track();
      }
      for (let i = 0; i < 40; i++) {
        run(state, 1, true);
        track();
      }
      return peak;
    }

    const single = peakOf(false);
    const double = peakOf(true);

    assert.ok(double < single, `the second jump must gain height: ${double} vs ${single}`);
  });

  it("stays deterministic, so prediction still reproduces it", () => {
    const inputs = Array.from({ length: 40 }, (_, i) => {
      const input = createInputCommand(i + 1);
      // Press, release, press again: a double jump inside the sequence.
      input.jump = i === 5 || i === 12;
      input.moveRight = i > 20;
      return input;
    });

    const a = createMovementState(600, 1700);
    const b = createMovementState(600, 1700);
    for (const input of inputs) stepPlayerMovement(a, input, FIXED_DELTA, world);
    for (const input of inputs) stepPlayerMovement(b, input, FIXED_DELTA, world);

    assert.equal(a.x, b.x);
    assert.equal(a.y, b.y);
    assert.equal(a.jumpsRemaining, b.jumpsRemaining);
  });
});

describe("closing walls", () => {
  it("clamps a player to the shrinking bounds instead of the arena edges", () => {
    const state = createMovementState(600, 1700);
    const bounds = { left: 500, right: 2000 };

    for (let i = 0; i < 60; i++) {
      const input = createInputCommand(i + 1);
      input.moveLeft = true;
      stepPlayerMovement(state, input, FIXED_DELTA, world, bounds);
    }

    assert.ok(
      state.x >= bounds.left + PLAYER_HALF_WIDTH - 0.001,
      `a closing wall must push the player: x=${state.x}`,
    );
  });

  it("centres a player when the gap is narrower than they are", () => {
    const state = createMovementState(600, 1700);
    // Degenerate on purpose: the walls have met.
    const bounds = { left: 900, right: 900 + PLAYER_HALF_WIDTH };

    const input = createInputCommand(1);
    stepPlayerMovement(state, input, FIXED_DELTA, world, bounds);

    assert.equal(state.x, (bounds.left + bounds.right) / 2);
  });

  it("uses the full arena when no bounds are given", () => {
    const state = createMovementState(600, 1700);
    for (let i = 0; i < 200; i++) {
      const input = createInputCommand(i + 1);
      input.moveLeft = true;
      stepPlayerMovement(state, input, FIXED_DELTA, world);
    }
    assert.ok(state.x >= PLAYER_HALF_WIDTH, "still inside the world box");
    assert.ok(state.x < 200, "and free to travel the whole arena");
  });
});
