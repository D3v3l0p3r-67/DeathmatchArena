/**
 * Sides: allies neither target nor hurt one another.
 *
 * Deathmatch is team 0 for everyone -- no side, hostile to all -- and these
 * tests pin that first, because the campaign rule must cost multiplayer
 * nothing. Then the ally rules, on every combat path there is: bullets pass
 * through an allied body, blasts neither hurt nor shove an ally, a blade
 * skips one, and health only ever drops to hostile fire.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { areAllies, createInputCommand } from "@deathmatch/shared";
import { createHarness, fireAt, type Harness } from "./harness.js";

describe("teams: the predicate", () => {
  it("team 0 is no side at all: hostile even to itself", () => {
    assert.equal(areAllies(0, 0), false);
    assert.equal(areAllies(0, 1), false);
    assert.equal(areAllies(1, 0), false);
  });

  it("a shared non-zero team, and only that, is an alliance", () => {
    assert.equal(areAllies(1, 1), true);
    assert.equal(areAllies(2, 2), true);
    assert.equal(areAllies(1, 2), false);
  });
});

describe("teams: combat between sides", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("multiplayer stays exactly as it was: everyone spawns on team 0", () => {
    const player = harness.addPlayer("someone", 200, 1700);
    assert.equal(player.team, 0);
  });

  it("a bullet flies through an allied body and hits the hostile one behind it", () => {
    const shooter = harness.addPlayer("shooter", 200, 1700);
    const ally = harness.addPlayer("ally", 400, 1700);
    const foe = harness.addPlayer("foe", 600, 1700);
    shooter.team = 1;
    ally.team = 1;
    void foe; // team 0: hostile to the shooter.

    fireAt(harness, "shooter", 0, 0);
    harness.step(40);

    assert.equal(harness.damage.length, 1, "exactly one hit lands");
    assert.equal(harness.damage[0]!.victimId, "foe", "the ally in between was transparent");
    assert.equal(ally.health, ally.maxHealth, "the ally is untouched");
  });

  it("damage between allies is refused at the source, whatever dealt it", () => {
    const attacker = harness.addPlayer("attacker", 200, 1700);
    const ally = harness.addPlayer("ally", 240, 1700);
    attacker.team = 3;
    ally.team = 3;

    harness.matchManager.applyDamage("ally", "attacker", 50, ally.x, ally.y, "test");
    assert.equal(ally.health, ally.maxHealth, "an allied hit does nothing");

    harness.matchManager.applyDamage("ally", "", 50, ally.x, ally.y, "spikes");
    assert.ok(ally.health < ally.maxHealth, "the environment is on nobody's side");
  });

  it("an allied blast neither hurts nor shoves -- and the same blast hurts a stranger", () => {
    /*
     * The same throw twice, deterministic seed and geometry, with only the
     * bystander's team changed. The control run proves the blast is real and
     * in range; the ally run proves the team is the only thing sparing them.
     */
    const detonate = (bystanderTeam: number) => {
      const scenario = createHarness();
      const thrower = scenario.addPlayer("thrower", 400, 1700);
      const bystander = scenario.addPlayer("bystander", 470, 1700);
      thrower.team = 1;
      bystander.team = bystanderTeam;
      scenario.grenades.resupply(thrower);

      // Press, then release: the real loop copies each command into
      // `lastInput` after processing, and the edge detection depends on it.
      const runtime = scenario.runtimes.get("thrower")!;
      const send = (seq: number, charging: boolean, now: number) => {
        const input = createInputCommand(seq);
        input.chargeGrenade = charging;
        scenario.grenades.processInput(thrower, runtime, input, now);
        runtime.lastInput.seq = input.seq;
        runtime.lastInput.chargeGrenade = input.chargeGrenade;
      };
      send(1, true, 0);
      send(2, false, 150);

      for (let elapsed = 0; elapsed <= 6000; elapsed += 50) {
        scenario.stepGrenades(0.05, elapsed);
      }
      return {
        bystanderHit: scenario.damage.some((record) => record.victimId === "bystander"),
        bystanderVx: bystander.velocityX,
      };
    };

    const stranger = detonate(0);
    assert.equal(stranger.bystanderHit, true, "the control blast reaches the bystander");

    const ally = detonate(1);
    assert.equal(ally.bystanderHit, false, "the identical blast spares an ally");
    assert.equal(ally.bystanderVx, 0, "and does not shove them either");
  });

  it("a blade passes an allied body by", () => {
    const swinger = harness.addPlayer("swinger", 200, 1700);
    const ally = harness.addPlayer("ally", 240, 1700);
    swinger.team = 1;
    ally.team = 1;
    harness.weapons.equip(swinger, harness.runtimes.get("swinger")!, "chainsaw");

    const input = createInputCommand(1);
    input.fire = true;
    input.aimAngle = 0;
    harness.weapons.processInput(swinger, harness.runtimes.get("swinger")!, input, 1000);

    assert.equal(harness.damage.length, 0, "the swing connects with nothing allied");
    assert.equal(ally.health, ally.maxHealth);
  });
});
