/**
 * Traps, from the server's side.
 *
 * The property under test throughout: **the client decides nothing**. A trap
 * activates, moves and hurts people entirely here, and there is no message a
 * client could send that would change any of it -- so these tests drive the
 * simulation directly and check what it does to health.
 *
 * The other property worth defending is that the system stays generic. Nothing
 * below asks the trap system about spikes or crushers by name; it configures a
 * placement and checks the behaviour that description implies.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  FIXED_DELTA,
  MatchState,
  TrapActivation,
  createEmptyArena,
  trapRegistry,
  type ArenaDefinition,
  type TrapDefinition,
} from "@deathmatch/shared";
import { createHarness, type Harness } from "./harness.js";
import { MAX_HEALTH } from "./helpers.js";

/** An arena holding exactly one trap, built where the test wants it. */
function arenaWith(trap: TrapDefinition): ArenaDefinition {
  const arena = createEmptyArena("trap-test", "Trap Test");
  arena.traps = [trap];
  return arena;
}

function place(
  type: string,
  x: number,
  y: number,
  overrides: Partial<TrapDefinition> = {},
): TrapDefinition {
  const trap = trapRegistry.createTrap(type, "trap-1", x, y);
  assert.ok(trap, `unknown trap type ${type}`);
  return { ...trap, ...overrides };
}

/** Advance the traps by `seconds` of simulated time. */
function run(harness: Harness, seconds: number, startAt = 0): void {
  const steps = Math.round(seconds / FIXED_DELTA);
  for (let i = 0; i < steps; i++) {
    harness.stepTraps(FIXED_DELTA, startAt + i * FIXED_DELTA * 1000);
  }
}

describe("traps", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("hurts a player standing in a permanently active hazard", () => {
    // Spikes: always on, damage once per contact.
    harness.loadTraps(arenaWith(place("spikes", 500, 500, { activation: TrapActivation.ALWAYS })));
    const victim = harness.addPlayer("victim", 560, 510);

    run(harness, 0.5);
    assert.ok(victim.health < MAX_HEALTH, "standing on spikes should hurt");
  });

  it("hurts once per contact rather than every tick", () => {
    harness.loadTraps(arenaWith(place("spikes", 500, 500, { activation: TrapActivation.ALWAYS, damage: 20 })));
    const victim = harness.addPlayer("victim", 560, 510);

    run(harness, 2);
    assert.equal(victim.health, MAX_HEALTH - 20, "two seconds of standing still is one hit");
  });

  it("re-arms once the player leaves and comes back", () => {
    harness.loadTraps(arenaWith(place("spikes", 500, 500, { activation: TrapActivation.ALWAYS, damage: 20 })));
    const victim = harness.addPlayer("victim", 560, 510);

    run(harness, 0.5);
    assert.equal(victim.health, MAX_HEALTH - 20);

    victim.x = 2000;
    run(harness, 0.5);
    victim.x = 560;
    run(harness, 0.5);
    assert.equal(victim.health, MAX_HEALTH - 40, "stepping off and back on hurts again");
  });

  it("leaves a player just outside the trap alone", () => {
    const trap = place("spikes", 500, 500, { activation: TrapActivation.ALWAYS, width: 100, height: 20 });
    harness.loadTraps(arenaWith(trap));
    // Well clear of the box, allowing for the player's own half-width.
    const safe = harness.addPlayer("safe", 700, 510);

    run(harness, 1);
    assert.equal(safe.health, MAX_HEALTH);
  });

  it("meters a continuous hazard per second", () => {
    // Fire: damage is a rate, so two seconds of standing in it costs twice as
    // much as one. Always-on so the whole window is active.
    harness.loadTraps(
      arenaWith(place("fire", 500, 400, { activation: TrapActivation.ALWAYS, damage: 20, activationDelayMs: 0 })),
    );
    const victim = harness.addPlayer("victim", 540, 460);

    run(harness, 1);
    const afterOne = MAX_HEALTH - victim.health;
    assert.ok(afterOne >= 19 && afterOne <= 21, `expected about 20 damage, got ${afterOne}`);

    run(harness, 1, 1000);
    const afterTwo = MAX_HEALTH - victim.health;
    assert.ok(afterTwo >= 38 && afterTwo <= 42, `expected about 40 damage, got ${afterTwo}`);
  });

  it("warns before it hurts", () => {
    // The activation delay is the whole reason a trap is fair, so nothing may
    // happen during it.
    harness.loadTraps(
      arenaWith(
        place("fire", 500, 400, {
          activation: TrapActivation.PERIODIC,
          activationDelayMs: 500,
          activeDurationMs: 500,
          damage: 60,
        }),
      ),
    );
    const victim = harness.addPlayer("victim", 540, 460);

    run(harness, 0.4);
    assert.equal(victim.health, MAX_HEALTH, "the wind-up must be harmless");

    run(harness, 0.4, 400);
    assert.ok(victim.health < MAX_HEALTH, "and then it should not be");
  });

  it("cycles: active, then spent, then dangerous again", () => {
    harness.loadTraps(
      arenaWith(
        place("spikes", 500, 500, {
          activation: TrapActivation.PERIODIC,
          activationDelayMs: 0,
          activeDurationMs: 200,
          cooldownMs: 400,
          damage: 10,
        }),
      ),
    );
    const victim = harness.addPlayer("victim", 560, 510);

    run(harness, 0.1);
    assert.equal(victim.health, MAX_HEALTH - 10, "one hit from the first activation");

    // Through the rest of the active window and the whole cooldown.
    run(harness, 0.5, 100);
    assert.equal(victim.health, MAX_HEALTH - 10, "no second hit while it is spent");

    run(harness, 0.2, 600);
    assert.equal(victim.health, MAX_HEALTH - 20, "and it comes back round");
  });

  it("waits for someone to come near before triggering", () => {
    harness.loadTraps(
      arenaWith(
        place("crusher", 500, 300, {
          activation: TrapActivation.PROXIMITY,
          triggerRadius: 120,
          activationDelayMs: 0,
          damage: 40,
          params: { direction: "down", travel: 0 },
        }),
      ),
    );

    const distant = harness.addPlayer("distant", 2000, 300);
    run(harness, 1);
    assert.equal(distant.health, MAX_HEALTH, "nobody near, nothing happens");
    assert.equal(harness.traps.activeCount, 0);

    // Inside the trap body, which is also inside the trigger radius.
    const victim = harness.addPlayer("victim", 560, 340);
    run(harness, 0.2, 1000);
    assert.ok(victim.health < MAX_HEALTH, "coming close sets it off");
  });

  it("moves, and hurts what it moves into", () => {
    // A crusher that travels 200px down should reach a player standing below it
    // who was never in its resting position.
    harness.loadTraps(
      arenaWith(
        place("crusher", 500, 200, {
          activation: TrapActivation.PROXIMITY,
          triggerRadius: 600,
          activationDelayMs: 0,
          activeDurationMs: 2000,
          moveSpeed: 400,
          damage: 50,
          width: 140,
          height: 90,
          params: { direction: "down", travel: 300 },
        }),
      ),
    );

    // Below the trap's resting box (200..290), inside its travel path.
    const victim = harness.addPlayer("victim", 560, 520);
    assert.equal(victim.health, MAX_HEALTH);

    run(harness, 1.5);
    assert.ok(victim.health < MAX_HEALTH, "the crusher should have reached them");
  });

  it("credits a trap kill to nobody", () => {
    // Environmental damage: no attacker, so no kill is credited and the feed
    // says so.
    harness.loadTraps(
      arenaWith(place("spikes", 500, 500, { activation: TrapActivation.ALWAYS, damage: 200 })),
    );
    const victim = harness.addPlayer("victim", 560, 510);
    harness.addPlayer("bystander", 2000, 500);

    run(harness, 0.5);
    assert.equal(victim.alive, false);
    assert.equal(harness.damage.at(-1)?.attackerId, "", "a trap has no killer");
  });

  it("never builds a disabled trap", () => {
    harness.loadTraps(
      arenaWith(place("spikes", 500, 500, { activation: TrapActivation.ALWAYS, enabled: false })),
    );
    const victim = harness.addPlayer("victim", 560, 510);

    run(harness, 1);
    assert.equal(victim.health, MAX_HEALTH);
    assert.equal(harness.state.traps.size, 0, "a disabled trap costs nothing at runtime");
  });

  it("stops entirely when traps are switched off globally", () => {
    harness.loadTraps(arenaWith(place("spikes", 500, 500, { activation: TrapActivation.ALWAYS })));
    const victim = harness.addPlayer("victim", 560, 510);

    // The master switch is read every tick, so it reaches a running match.
    const config = structuredClone(harness.context.baselineConfig);
    config.traps.enabled = false;
    harness.replaceConfig(config);

    run(harness, 1);
    assert.equal(victim.health, MAX_HEALTH);
  });

  it("hurts nobody outside a live match", () => {
    harness.loadTraps(arenaWith(place("spikes", 500, 500, { activation: TrapActivation.ALWAYS })));
    const victim = harness.addPlayer("victim", 560, 510);
    harness.state.matchState = MatchState.FINISHED;

    run(harness, 1);
    assert.equal(victim.health, MAX_HEALTH);
  });

  it("leaves the dead alone", () => {
    harness.loadTraps(
      arenaWith(place("spikes", 500, 500, { activation: TrapActivation.ALWAYS, damage: 10 })),
    );
    const victim = harness.addPlayer("victim", 560, 510);
    victim.alive = false;

    run(harness, 1);
    assert.equal(victim.health, MAX_HEALTH);
  });

  it("inherits its numbers from the game configuration", () => {
    // Nothing overridden, so retuning traps globally reaches this placement.
    const inheriting = place("spikes", 500, 500, {
      activation: TrapActivation.ALWAYS,
      damage: null,
      activationDelayMs: null,
    });

    const config = structuredClone(harness.context.baselineConfig);
    config.traps.damage = 17;
    harness.replaceConfig(config);
    harness.loadTraps(arenaWith(inheriting));

    const victim = harness.addPlayer("victim", 560, 510);
    run(harness, 0.5);
    assert.equal(victim.health, MAX_HEALTH - 17);
  });

  it("lets one placement override what the rest inherit", () => {
    const config = structuredClone(harness.context.baselineConfig);
    config.traps.damage = 17;
    harness.replaceConfig(config);
    harness.loadTraps(
      arenaWith(place("spikes", 500, 500, { activation: TrapActivation.ALWAYS, damage: 5 })),
    );

    const victim = harness.addPlayer("victim", 560, 510);
    run(harness, 0.5);
    assert.equal(victim.health, MAX_HEALTH - 5);
  });

  it("publishes position and phase, and nothing that decides damage", () => {
    harness.loadTraps(
      arenaWith(
        place("fire", 500, 400, {
          activation: TrapActivation.PERIODIC,
          activationDelayMs: 200,
          activeDurationMs: 400,
          damage: 30,
        }),
      ),
    );

    const state = harness.state.traps.get("trap-1")!;
    assert.equal(state.phase, "idle");
    assert.equal(state.trapType, "fire");
    assert.equal(state.x, 500);

    run(harness, 0.1);
    assert.equal(state.phase, "arming", "the warning is visible to clients");

    run(harness, 0.2, 100);
    assert.equal(state.phase, "active");

    // What a client is told is enough to draw it and no more.
    assert.deepEqual(
      Object.keys(state.toJSON()).sort(),
      ["height", "id", "phase", "trapType", "width", "x", "y"],
    );
  });

  it("resets to rest between matches", () => {
    harness.loadTraps(
      arenaWith(
        place("crusher", 500, 200, {
          activation: TrapActivation.PROXIMITY,
          triggerRadius: 600,
          activationDelayMs: 0,
          moveSpeed: 400,
          params: { direction: "down", travel: 300 },
        }),
      ),
    );
    harness.addPlayer("victim", 560, 520);

    run(harness, 0.5);
    const moved = harness.state.traps.get("trap-1")!;
    assert.ok(moved.y > 200, "it should have driven out");

    harness.traps.reset();
    assert.equal(moved.y, 200, "and be back home for the next match");
    assert.equal(moved.phase, "idle");
  });
});
