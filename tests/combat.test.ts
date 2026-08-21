/**
 * Deterministic coverage of the server-authoritative combat path:
 * weapon validation -> projectile spawn -> swept collision -> damage -> elimination.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  ASSAULT_RIFLE_ID,
  CHAINSAW_ID,
  FIXED_DELTA,
  MatchState,
  PLAYER,
  SHOTGUN_ID,
  ServerMessage,
  createInputCommand,
  getDamageAtDistance,
  getFireIntervalMs,
  getWeapon,
  type KillPayload,
} from "@deathmatch/shared";
import { createHarness, fireAt, type Harness } from "./harness.js";


describe("projectile collision", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("damages a player in the line of fire", () => {
    // Open stretch of floor: nothing between x=200 and x=600 at y=1700.
    harness.addPlayer("shooter", 200, 1700);
    const target = harness.addPlayer("target", 600, 1700);

    fireAt(harness, "shooter", 0, 0);
    assert.equal(harness.state.projectiles.size, 1, "a projectile should have been spawned");

    harness.step(30);

    assert.equal(harness.damage.length, 1, "exactly one hit should register");
    assert.equal(harness.damage[0]!.victimId, "target");
    assert.equal(harness.damage[0]!.attackerId, "shooter");
    assert.equal(harness.damage[0]!.amount, getWeapon(target.weaponId).damage);
    assert.equal(target.health, PLAYER.MAX_HEALTH - getWeapon(target.weaponId).damage);
    assert.equal(harness.state.projectiles.size, 0, "the projectile is consumed by the hit");
  });

  it("is stopped by geometry before reaching a player behind it", () => {
    // The wall at x=820 spans y 1260..1740, squarely between these two.
    harness.addPlayer("shooter", 600, 1700);
    const target = harness.addPlayer("target", 1000, 1700);

    fireAt(harness, "shooter", 0, 0);
    harness.step(30);

    assert.equal(harness.damage.length, 0, "the wall should absorb the shot");
    assert.equal(target.health, PLAYER.MAX_HEALTH);
    assert.equal(harness.state.projectiles.size, 0, "the projectile is destroyed on impact");
  });

  it("never hits the player who fired it", () => {
    const shooter = harness.addPlayer("shooter", 200, 1700);

    // Fire straight into the wall to the left; the bullet passes through the
    // shooter's own hitbox on the way out.
    fireAt(harness, "shooter", Math.PI, 0);
    harness.step(30);

    assert.equal(harness.damage.length, 0);
    assert.equal(shooter.health, PLAYER.MAX_HEALTH);
  });

  it("cannot tunnel past a target or a wall, however fast the round travels", () => {
    // A hypersonic round covers 333px per 60Hz tick. A naive per-tick position
    // test would sample straight past both a 28px player and a 26px wall; only the
    // swept sub-stepped segment cast catches them.
    const base = getWeapon(ASSAULT_RIFLE_ID);
    const hypersonic = {
      ...base,
      id: "test-railgun",
      ranged: { ...base.ranged!, bulletSpeed: 20000 },
    };
    const perTick = hypersonic.ranged.bulletSpeed * FIXED_DELTA;
    assert.ok(perTick > 300, "the test round must out-run a single tick");

    harness.addPlayer("shooter", 200, 1700);
    const target = harness.addPlayer("target", 600, 1700);

    harness.projectiles.spawn("shooter", hypersonic, 240, 1700, 0, 0);
    harness.step(4);

    assert.equal(harness.damage.length, 1, `round moving ${perTick}px/tick skipped the target`);
    assert.equal(harness.damage[0]!.victimId, "target");
    assert.ok(target.health < PLAYER.MAX_HEALTH);

    // Same round, this time with the x=820 wall in the way.
    const second = createHarness();
    second.addPlayer("shooter", 600, 1700);
    const shielded = second.addPlayer("target", 1000, 1700);
    second.projectiles.spawn("shooter", hypersonic, 640, 1700, 0, 0);
    second.step(4);

    assert.equal(second.damage.length, 0, `round moving ${perTick}px/tick tunnelled through the wall`);
    assert.equal(shielded.health, PLAYER.MAX_HEALTH);
  });

  it("expires instead of living forever", () => {
    harness.addPlayer("shooter", 200, 1700);

    // Fire upward into open air; the ceiling is ~1700px away, beyond the 1400px range.
    fireAt(harness, "shooter", -Math.PI / 2, 0);
    assert.equal(harness.state.projectiles.size, 1);

    harness.step(120);
    assert.equal(harness.state.projectiles.size, 0, "projectile should expire at max range");
  });
});

describe("weapon validation", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("enforces the fire-rate cooldown against the server clock", () => {
    const player = harness.addPlayer("shooter", 200, 1700);
    const weapon = getWeapon(player.weaponId);
    const interval = getFireIntervalMs(weapon);

    // Ten trigger pulls inside a single cooldown window must yield one shot.
    for (let i = 0; i < 10; i++) fireAt(harness, "shooter", 0, i);
    assert.equal(player.ammo, weapon.magazineSize - 1, "fire rate was not enforced");

    fireAt(harness, "shooter", 0, interval + 1);
    assert.equal(player.ammo, weapon.magazineSize - 2, "a shot after the cooldown should be allowed");
  });

  it("empties the magazine, auto-reloads, and refills only when the reload completes", () => {
    const player = harness.addPlayer("shooter", 200, 1700);
    const runtime = harness.runtimes.get("shooter")!;
    const weapon = getWeapon(player.weaponId);
    const interval = getFireIntervalMs(weapon);

    let now = 0;
    for (let shot = 0; shot < weapon.magazineSize; shot++) {
      now += interval + 1;
      fireAt(harness, "shooter", 0, now);
    }

    assert.equal(player.ammo, 0, "the magazine should be empty");
    assert.equal(player.reloading, true, "an empty magazine should trigger a reload");

    // The reload deadline is measured from the shot that emptied the magazine.
    const emptiedAt = now;

    // Firing mid-reload is refused.
    fireAt(harness, "shooter", 0, emptiedAt + interval + 1);
    assert.equal(player.ammo, 0, "firing during a reload must be rejected");

    // The reload only completes once its duration has elapsed on the server clock.
    const input = createInputCommand(2);
    harness.weapons.processInput(player, runtime, input, emptiedAt + weapon.reloadTime - 10);
    assert.equal(player.ammo, 0, "reload finished early");

    harness.weapons.processInput(player, runtime, input, emptiedAt + weapon.reloadTime + 1);
    assert.equal(player.ammo, weapon.magazineSize, "reload should refill the magazine");
    assert.equal(player.reloading, false);
  });

  it("refuses to fire for a dead player", () => {
    const player = harness.addPlayer("ghost", 200, 1700);
    player.alive = false;

    fireAt(harness, "ghost", 0, 1000);

    assert.equal(harness.state.projectiles.size, 0, "the dead must not shoot");
    assert.equal(player.ammo, getWeapon(player.weaponId).magazineSize);
  });
});

describe("elimination", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("kills the victim, credits the killer, and lets the server crown the winner", () => {
    const shooter = harness.addPlayer("shooter", 200, 1700);
    const target = harness.addPlayer("target", 600, 1700);
    harness.state.startingPlayerCount = 2;

    const rifle = getWeapon(shooter.weaponId);
    const shotsToKill = Math.ceil(PLAYER.MAX_HEALTH / rifle.damage);
    const interval = getFireIntervalMs(rifle) + 1;

    let now = 0;
    for (let shot = 0; shot < shotsToKill; shot++) {
      fireAt(harness, "shooter", 0, now);
      harness.step(30, now);
      now += interval;
    }

    assert.equal(target.alive, false, "the victim is dead");
    assert.equal(target.health, 0, "health floors at zero rather than going negative");
    assert.equal(target.deaths, 1);
    assert.equal(target.placement, 2, "the last of two players out finishes second");
    assert.equal(shooter.kills, 1, "the killer is credited exactly once");
    assert.equal(shooter.alive, true);
    assert.equal(harness.state.aliveCount, 1);

    const kill = harness.broadcasts.find((entry) => entry.type === ServerMessage.KILL);
    assert.ok(kill, "the elimination is broadcast to the kill feed");
    const payload = kill.payload as KillPayload;
    assert.equal(payload.killerId, "shooter");
    assert.equal(payload.victimId, "target");
    assert.equal(payload.weaponId, rifle.id);
    assert.equal(payload.selfInflicted, false);

    // Only the server decides this, and only once one player is left standing.
    harness.matchManager.update(now);
    assert.equal(harness.state.matchState, MatchState.FINISHED);
    assert.equal(harness.state.winnerId, "shooter");
    assert.equal(harness.state.winnerName, "shooter");
  });

  it("ignores further hits on a player who is already dead", () => {
    const shooter = harness.addPlayer("shooter", 200, 1700);
    const target = harness.addPlayer("target", 600, 1700);

    target.alive = false;
    target.health = 0;

    fireAt(harness, "shooter", 0, 0);
    harness.step(30);

    assert.equal(target.deaths, 0, "a corpse is not eliminated a second time");
    assert.equal(shooter.kills, 0, "and nobody is credited for shooting it");
    assert.equal(
      harness.broadcasts.filter((entry) => entry.type === ServerMessage.KILL).length,
      0,
    );
  });

  it("does not resolve damage outside a running match", () => {
    const shooter = harness.addPlayer("shooter", 200, 1700);
    const target = harness.addPlayer("target", 600, 1700);
    harness.state.matchState = MatchState.COUNTDOWN;

    fireAt(harness, "shooter", 0, 0);
    harness.step(30);

    assert.equal(target.health, PLAYER.MAX_HEALTH, "no damage lands before the match starts");
    assert.equal(shooter.kills, 0);
  });
});

describe("shotgun", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("fires its configured pellet count in a single shot", () => {
    const shooter = harness.addPlayer("shooter", 200, 1700);
    harness.weapons.equip(shooter, harness.runtimes.get("shooter")!, SHOTGUN_ID);

    const shotgun = getWeapon(SHOTGUN_ID);
    fireAt(harness, "shooter", 0, 0);

    assert.equal(
      harness.state.projectiles.size,
      shotgun.ranged!.pellets,
      "one trigger pull spawns one projectile per configured pellet",
    );
    // A magazine is spent per shot, not per pellet.
    assert.equal(shooter.ammo, shotgun.magazineSize - 1);
  });

  it("hits far harder up close than at range", () => {
    const shotgun = getWeapon(SHOTGUN_ID);
    const falloff = shotgun.ranged!.falloff!;

    const pointBlank = getDamageAtDistance(shotgun, falloff.startDistance);
    const longRange = getDamageAtDistance(shotgun, falloff.endDistance);

    assert.equal(pointBlank, shotgun.damage, "full damage inside the falloff start");
    assert.ok(longRange < pointBlank * 0.5, "damage must fall off significantly with distance");
    assert.ok(
      Math.abs(longRange - shotgun.damage * falloff.minMultiplier) < 0.001,
      "damage at the far end matches the configured minimum multiplier",
    );

    // Beyond the curve it stays at the floor rather than continuing to drop.
    assert.equal(getDamageAtDistance(shotgun, falloff.endDistance * 4), longRange);
  });

  it("applies the distance actually flown, not the base damage", () => {
    const shooter = harness.addPlayer("shooter", 200, 1700);
    harness.weapons.equip(shooter, harness.runtimes.get("shooter")!, SHOTGUN_ID);
    // Far enough down the open stretch of floor for falloff to bite.
    harness.addPlayer("target", 700, 1700);

    fireAt(harness, "shooter", 0, 0);
    harness.step(40);

    assert.ok(harness.damage.length > 0, "pellets should reach the target");
    const shotgun = getWeapon(SHOTGUN_ID);
    for (const hit of harness.damage) {
      assert.ok(hit.amount < shotgun.damage, "a distant pellet must be weakened by falloff");
    }
  });
});

describe("chainsaw", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  /** Equip the chainsaw and swing towards `angle`. */
  function swing(harness: Harness, attackerId: string, angle: number, now: number): void {
    const attacker = harness.state.players.get(attackerId)!;
    harness.weapons.equip(attacker, harness.runtimes.get(attackerId)!, CHAINSAW_ID);
    fireAt(harness, attackerId, angle, now);
  }

  it("damages a player within contact range without creating a projectile", () => {
    harness.addPlayer("attacker", 400, 1700);
    const victim = harness.addPlayer("victim", 440, 1700);

    swing(harness, "attacker", 0, 0);

    assert.equal(harness.state.projectiles.size, 0, "melee must never spawn a projectile");
    assert.equal(harness.damage.length, 1);
    assert.equal(harness.damage[0]!.victimId, "victim");
    assert.equal(harness.damage[0]!.amount, getWeapon(CHAINSAW_ID).damage);
    assert.ok(victim.health < PLAYER.MAX_HEALTH);
  });

  it("cannot reach a player standing beyond its range", () => {
    harness.addPlayer("attacker", 400, 1700);
    const victim = harness.addPlayer("victim", 400 + getWeapon(CHAINSAW_ID).range + 80, 1700);

    swing(harness, "attacker", 0, 0);

    assert.equal(harness.damage.length, 0, "a swing into empty air hits nothing");
    assert.equal(victim.health, PLAYER.MAX_HEALTH);
  });

  it("cannot hit a player behind the attacker", () => {
    harness.addPlayer("attacker", 440, 1700);
    const behind = harness.addPlayer("victim", 400, 1700);

    // Aiming right, with the victim to the left: outside the arc.
    swing(harness, "attacker", 0, 0);

    assert.equal(harness.damage.length, 0, "the swing arc must not wrap around the attacker");
    assert.equal(behind.health, PLAYER.MAX_HEALTH);
  });

  it("cannot cut through a wall", () => {
    // The wall at x=820 spans y 1260..1740; stand on either side of it.
    harness.addPlayer("attacker", 800, 1700);
    const shielded = harness.addPlayer("victim", 860, 1700);

    swing(harness, "attacker", 0, 0);

    assert.equal(harness.damage.length, 0, "geometry must block a melee swing");
    assert.equal(shielded.health, PLAYER.MAX_HEALTH);
  });

  it("honours its configured attack interval", () => {
    harness.addPlayer("attacker", 400, 1700);
    harness.addPlayer("victim", 440, 1700);

    const interval = getFireIntervalMs(getWeapon(CHAINSAW_ID));
    assert.ok(interval > 0, "the chainsaw must have a configured attack interval");

    swing(harness, "attacker", 0, 0);
    assert.equal(harness.damage.length, 1);

    // A second swing before the interval elapses is refused by the server clock.
    fireAt(harness, "attacker", 0, interval - 1);
    assert.equal(harness.damage.length, 1, "swinging faster than the interval must not land");

    fireAt(harness, "attacker", 0, interval + 1);
    assert.equal(harness.damage.length, 2, "the next swing lands once the interval has passed");
  });

  it("needs no ammunition and never reloads", () => {
    const attacker = harness.addPlayer("attacker", 400, 1700);
    harness.weapons.equip(attacker, harness.runtimes.get("attacker")!, CHAINSAW_ID);

    assert.equal(attacker.ammo, 0, "a melee weapon carries no magazine");

    // Swing far more times than any magazine would allow, into empty air.
    const interval = getFireIntervalMs(getWeapon(CHAINSAW_ID)) + 1;
    for (let swingIndex = 0; swingIndex < 20; swingIndex++) {
      fireAt(harness, "attacker", 0, swingIndex * interval);
    }

    assert.equal(attacker.ammo, 0, "swinging never consumes ammunition");
    assert.equal(attacker.reloading, false, "a melee weapon never enters a reload");
  });

  it("is the strongest weapon at contact range", () => {
    const attacker = harness.addPlayer("attacker", 400, 1700);
    const victim = harness.addPlayer("victim", 440, 1700);
    harness.weapons.equip(attacker, harness.runtimes.get("attacker")!, CHAINSAW_ID);

    const chainsaw = getWeapon(CHAINSAW_ID);
    const rifle = getWeapon(ASSAULT_RIFLE_ID);
    assert.ok(chainsaw.damage > rifle.damage, "a swing must out-damage a rifle round");

    const swingsToKill = Math.ceil(PLAYER.MAX_HEALTH / chainsaw.damage);
    const interval = getFireIntervalMs(chainsaw) + 1;
    for (let swingIndex = 0; swingIndex < swingsToKill; swingIndex++) {
      fireAt(harness, "attacker", 0, swingIndex * interval);
    }

    assert.equal(victim.alive, false, `${swingsToKill} swings should be lethal`);
  });
});
