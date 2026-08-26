/**
 * Deterministic coverage of the server-authoritative combat path:
 * weapon validation -> projectile spawn -> swept collision -> damage -> elimination.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  ASSAULT_RIFLE_ID,
  CHAINSAW_ID,
  LASER_ID,
  ROCKET_LAUNCHER_ID,
  FIXED_DELTA,
  KNOCKBACK_IMPULSE,
  MatchState,
  PowerUpType,
  SHOTGUN_ID,
  ServerMessage,
  createInputCommand,
  cloneConfig,
  getBotDifficulty,
  getDamageAtDistance,
  getGameConfig,
  getDefaultWeaponId,
  getFireIntervalMs,
  getMatchConfig,
  getNpcConfig,
  getPlayerConfig,
  getReloadDurationMs,
  getWeapon,
  listPowerUps,
  listWeapons,
  stepPlayerMovement,
  type DamagePayload,
  type KillPayload,
} from "@deathmatch/shared";
import { DamageSource } from "../server/src/rooms/RoomContext.js";
import { createHarness, fireAt, type Harness } from "./harness.js";
import { MAX_HEALTH } from "./helpers.js";


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
    assert.equal(target.health, MAX_HEALTH - getWeapon(target.weaponId).damage);
    assert.equal(harness.state.projectiles.size, 0, "the projectile is consumed by the hit");
  });

  it("is stopped by geometry before reaching a player behind it", () => {
    // The wall at x=820 spans y 1260..1740, squarely between these two.
    harness.addPlayer("shooter", 600, 1700);
    const target = harness.addPlayer("target", 1000, 1700);

    fireAt(harness, "shooter", 0, 0);
    harness.step(30);

    assert.equal(harness.damage.length, 0, "the wall should absorb the shot");
    assert.equal(target.health, MAX_HEALTH);
    assert.equal(harness.state.projectiles.size, 0, "the projectile is destroyed on impact");
  });

  it("never hits the player who fired it", () => {
    const shooter = harness.addPlayer("shooter", 200, 1700);

    // Fire straight into the wall to the left; the bullet passes through the
    // shooter's own hitbox on the way out.
    fireAt(harness, "shooter", Math.PI, 0);
    harness.step(30);

    assert.equal(harness.damage.length, 0);
    assert.equal(shooter.health, MAX_HEALTH);
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
    assert.ok(target.health < MAX_HEALTH);

    // Same round, this time with the x=820 wall in the way.
    const second = createHarness();
    second.addPlayer("shooter", 600, 1700);
    const shielded = second.addPlayer("target", 1000, 1700);
    second.projectiles.spawn("shooter", hypersonic, 640, 1700, 0, 0);
    second.step(4);

    assert.equal(second.damage.length, 0, `round moving ${perTick}px/tick tunnelled through the wall`);
    assert.equal(shielded.health, MAX_HEALTH);
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

describe("the laser", () => {
  it("carries three rounds and then has to reload", () => {
    const laser = getWeapon(LASER_ID);
    assert.equal(laser.magazineSize, 3);
    assert.ok(laser.enabled, "a weapon nobody can be given is not in the game");
    assert.ok(laser.reloadTime > 0, "three rounds and no reload is not a magazine");
  });

  it("empties in three shots and starts its own reload", () => {
    const harness = createHarness();
    const player = harness.addPlayer("shooter", 200, 1700);
    const runtime = harness.runtimes.get("shooter")!;
    harness.weapons.equip(player, runtime, LASER_ID);

    const laser = getWeapon(LASER_ID);
    const interval = getFireIntervalMs(laser) + 1;

    assert.equal(player.ammo, 3, "picking it up fills the magazine");

    let now = 0;
    for (let shot = 0; shot < 3; shot++) {
      fireAt(harness, "shooter", 0, now);
      now += interval;
    }

    assert.equal(player.ammo, 0, "three shots is the whole magazine");
    assert.equal(player.reloading, true, "an empty magazine reloads itself");

    // And a fourth trigger pull does nothing while it does.
    fireAt(harness, "shooter", 0, now);
    assert.equal(player.ammo, 0);
  });

  it("can be found in a crate", () => {
    // A weapon with no power-up exists only for whoever starts with it.
    const laserDrop = listPowerUps().find(
      (powerUp) => powerUp.type === PowerUpType.WEAPON && powerUp.weaponId === LASER_ID,
    );
    assert.ok(laserDrop, "the laser has no crate power-up");
    assert.ok(laserDrop.enabled && laserDrop.spawnWeight > 0, "it could never actually spawn");
  });
});

describe("a weapon's weight", () => {
  it("ships neutral on every weapon, so nothing plays differently yet", () => {
    /*
     * The request was for the mechanism, explicitly behaving as before for now.
     * This is the line that keeps that promise: the moment somebody tunes a
     * weapon away from 1 it is deliberate, not an accident that shipped.
     */
    for (const weapon of listWeapons()) {
      assert.equal(
        weapon.moveSpeedMultiplier,
        1,
        `${weapon.id} would change how fast its carrier runs`,
      );
    }
  });

  it("is handed to the movement state the moment a weapon changes hands", () => {
    // Equipping is the one place a weapon is given, so it is the one place the
    // factor has to be set -- otherwise a pickup would leave the old weight on.
    const harness = createHarness();
    const player = harness.addPlayer("carrier", 200, 1700);
    const runtime = harness.runtimes.get("carrier")!;

    const retuned = cloneConfig(getGameConfig());
    retuned.weapons.find((weapon) => weapon.id === SHOTGUN_ID)!.moveSpeedMultiplier = 0.6;
    harness.replaceConfig(retuned);

    harness.weapons.equip(player, runtime, SHOTGUN_ID);
    assert.equal(runtime.movement.weaponSpeedMultiplier, 0.6);

    harness.weapons.equip(player, runtime, ASSAULT_RIFLE_ID);
    assert.equal(runtime.movement.weaponSpeedMultiplier, 1, "swapping must drop the old weight");
  });
});

describe("reload duration scales with what's missing", () => {
  // reloadTime is the configured full-reload time -- empty to full -- so a
  // round 10/1000 weapon makes the arithmetic easy to read back.
  const weapon = { ...getWeapon(getDefaultWeaponId()), magazineSize: 10, reloadTime: 1000 };

  it("takes the full time from empty, none at all when already full", () => {
    assert.equal(getReloadDurationMs(weapon, 0), 1000);
    assert.equal(getReloadDurationMs(weapon, 10), 0);
  });

  it("costs exactly the time for the rounds actually missing", () => {
    // The three cases from the spec, verbatim: capacity 10, reloadTime 1000ms.
    assert.equal(getReloadDurationMs(weapon, 5), 500, "5/10: missing 5, half the time");
    assert.equal(getReloadDurationMs(weapon, 6), 400, "6/10: missing 4, four tenths");
    assert.equal(getReloadDurationMs(weapon, 9), 100, "9/10: missing 1, a tenth");
  });

  it("never goes negative or past a full reload for an out-of-range ammo count", () => {
    // A defensive clamp, not a real scenario: ammo never legitimately exceeds
    // the magazine or drops below zero.
    assert.equal(getReloadDurationMs(weapon, -5), 1000);
    assert.equal(getReloadDurationMs(weapon, 999), 0);
  });

  it("is 0 for a weapon with no magazine", () => {
    assert.equal(getReloadDurationMs({ ...weapon, magazineSize: 0 }, 0), 0);
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

  it("reloads faster the fewer rounds are missing, and never longer than a full reload", () => {
    /*
     * weapon.reloadTime is the time for a full reload, empty to full. Topping
     * off nine of ten rounds should cost a tenth of that, not the whole thing --
     * a player who taps reload after one shot must not be punished as though
     * they emptied the magazine.
     */
    const player = harness.addPlayer("shooter", 200, 1700);
    const runtime = harness.runtimes.get("shooter")!;
    const weapon = getWeapon(player.weaponId);
    const interval = getFireIntervalMs(weapon);

    // Fire once, leaving all but one round -- the smallest possible reload.
    let now = 0;
    fireAt(harness, "shooter", 0, now);
    const ammoBeforeReload = player.ammo;
    assert.equal(ammoBeforeReload, weapon.magazineSize - 1);

    now += interval + 1;
    const reloadPress = createInputCommand(2);
    reloadPress.reload = true;
    harness.weapons.processInput(player, runtime, reloadPress, now);

    assert.equal(player.reloading, true, "pressing reload with rounds still in the magazine should start one");

    const expected = getReloadDurationMs(weapon, ammoBeforeReload);
    assert.ok(
      expected > 0 && expected < weapon.reloadTime,
      `a one-round reload (${expected}ms) should take less than a full one (${weapon.reloadTime}ms)`,
    );

    const stillHeld = createInputCommand(3);
    harness.weapons.processInput(player, runtime, stillHeld, now + expected - 5);
    assert.equal(player.ammo, ammoBeforeReload, "reload finished before its proportional deadline");

    harness.weapons.processInput(player, runtime, stillHeld, now + expected + 1);
    assert.equal(player.ammo, weapon.magazineSize, "the magazine should be full once the shorter reload elapses");
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

describe("difficulty and damage", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  /** A player who is a bot at this rung, standing where they are put. */
  function bot(sessionId: string, x: number, level: number) {
    const player = harness.addPlayer(sessionId, x, 1700);
    player.bot = true;
    player.botDifficulty = level;
    return player;
  }

  const rung = (level: number) => getBotDifficulty(getNpcConfig(), level);
  const rifle = () => getWeapon(getDefaultWeaponId());

  it("hurts an easy bot more than the weapon says, without touching the weapon", () => {
    const shooter = harness.addPlayer("human", 200, 1700);
    const victim = bot("easy", 600, 1);

    fireAt(harness, "human", 0, 0);
    harness.step(30, 0);

    const expected = Math.round(rifle().damage * rung(1).damageTakenMultiplier);
    assert.equal(getPlayerConfig().maxHealth - victim.health, expected);
    assert.ok(expected > rifle().damage, "an easy bot should take more than the weapon's damage");
    assert.equal(getWeapon(shooter.weaponId).damage, rifle().damage, "the weapon itself is untouched");
  });

  it("lands less of a hit when the easy bot is the one shooting", () => {
    const victim = harness.addPlayer("human", 600, 1700);
    bot("easy", 200, 1);

    fireAt(harness, "easy", 0, 0);
    harness.step(30, 0);

    const expected = Math.round(rifle().damage * rung(1).damageDealtMultiplier);
    assert.equal(getPlayerConfig().maxHealth - victim.health, expected);
    assert.ok(expected < rifle().damage, "an easy bot should land less than the weapon's damage");
  });

  it("reads each multiplier off the bot it belongs to, not off its target", () => {
    // The easy bot's shot into a top-rung bot: 60% dealt into somebody who
    // takes 100%. The same shot the other way is 100% into somebody on 150%.
    const hard = bot("hard", 600, 5);
    bot("easy", 200, 1);

    fireAt(harness, "easy", 0, 0);
    harness.step(30, 0);

    const easyIntoHard = Math.round(
      rifle().damage * rung(1).damageDealtMultiplier * rung(5).damageTakenMultiplier,
    );
    assert.equal(getPlayerConfig().maxHealth - hard.health, easyIntoHard);

    const easy = harness.state.players.get("easy")!;
    fireAt(harness, "hard", Math.PI, 200);
    harness.step(30, 200);

    const hardIntoEasy = Math.round(
      rifle().damage * rung(5).damageDealtMultiplier * rung(1).damageTakenMultiplier,
    );
    assert.equal(getPlayerConfig().maxHealth - easy.health, hardIntoEasy);
    assert.ok(hardIntoEasy > easyIntoHard, "the same rifle should hurt the easy bot more");
  });

  it("leaves a human alone in both directions", () => {
    const victim = harness.addPlayer("target", 600, 1700);
    harness.addPlayer("shooter", 200, 1700);

    fireAt(harness, "shooter", 0, 0);
    harness.step(30, 0);

    assert.equal(getPlayerConfig().maxHealth - victim.health, rifle().damage);
  });

  it("leaves the arena's own damage at its own setting", () => {
    /*
     * Traps and the closing walls are what a bot is supposed to avoid by
     * playing better, so softening them for an easy bot would hide the failure
     * rather than fix it. Their multiplier is separate and 1 by default.
     */
    const victim = bot("easy", 600, 1);
    const before = victim.health;

    harness.matchManager.applyDamage("easy", "", 20, victim.x, victim.y, "trap:spikes", DamageSource.ENVIRONMENT);

    assert.equal(before - victim.health, 20, "environmental damage is not scaled by the combat multiplier");
  });

  it("takes a change made mid-match on the next hit", () => {
    /*
     * The point of these being settings rather than constants: an admin
     * retunes the ladder while people are playing on it. Read per hit rather
     * than captured when the bot spawned, or a change would only reach the
     * match after it.
     */
    const victim = bot("easy", 600, 1);
    harness.addPlayer("human", 200, 1700);

    fireAt(harness, "human", 0, 0);
    harness.step(30, 0);
    const before = Math.round(rifle().damage * rung(1).damageTakenMultiplier);
    assert.equal(getPlayerConfig().maxHealth - victim.health, before);

    const retuned = cloneConfig(getGameConfig());
    retuned.npc.difficulties.find((entry) => entry.level === 1)!.damageTakenMultiplier = 3;
    harness.replaceConfig(retuned);

    const health = victim.health;
    fireAt(harness, "human", 0, 200);
    harness.step(30, 200);

    assert.equal(health - victim.health, Math.round(rifle().damage * 3), "the new setting is in force");
  });

  it("counts a bot blowing itself up once", () => {
    // One bot on both sides of the same hit: it takes what it took. Applying
    // the dealt multiplier as well would square a mistake for no reason anybody
    // could read off the settings.
    const victim = bot("easy", 600, 1);
    const before = victim.health;

    harness.matchManager.applyDamage("easy", "easy", 20, victim.x, victim.y, "grenade");

    assert.equal(before - victim.health, Math.round(20 * rung(1).damageTakenMultiplier));
  });
});

describe("the countdown promises spawns", () => {
  it("publishes everybody's spawn before anyone stands on it, and keeps the promise", () => {
    /*
     * The client's flyover dives to the local player's spawn during the last
     * second of the countdown, which only works if the spot is decided and
     * published while the numbers are still running -- spawns used to be dealt
     * out at the moment the match started.
     */
    const harness = createHarness();
    harness.state.matchState = MatchState.WAITING;

    const players = ["one", "two", "three"].map((id) => {
      const player = harness.addPlayer(id, 100, 100);
      player.connected = true;
      return player;
    });
    harness.state.hostId = "one";

    harness.matchManager.requestStart();
    harness.run(0.5);

    assert.equal(harness.state.matchState, MatchState.COUNTDOWN);
    const promised = new Map(players.map((player) => [player.sessionId, { x: player.spawnX, y: player.spawnY }]));
    for (const [id, spot] of promised) {
      assert.ok(spot.x > 0, `${id} has no published spawn during the countdown`);
    }

    harness.run(getMatchConfig().countdownMs / 1000 + 0.5);
    assert.equal(harness.state.matchState, MatchState.PLAYING);

    for (const player of players) {
      const spot = promised.get(player.sessionId)!;
      assert.ok(
        Math.hypot(player.x - spot.x, player.y - spot.y) < 60,
        `${player.sessionId} spawned at ${Math.round(player.x)},${Math.round(player.y)} but was promised ${spot.x},${spot.y}`,
      );
    }
  });
});

describe("who hears about a hit", () => {
  it("tells the whole room, not only the two players involved", () => {
    /*
     * A bystander needs this: without it, watching two other players trade
     * fire showed flashes and no numbers, and spectating after your own
     * elimination showed a silent fight. It leaks nothing -- every player's
     * position and health is already in the state every client receives.
     */
    const harness = createHarness();
    const shooter = harness.addPlayer("shooter", 200, 1700);
    harness.addPlayer("target", 600, 1700);
    harness.addPlayer("bystander", 1200, 1700);

    fireAt(harness, "shooter", 0, 0);
    harness.step(30, 0);

    const damage = harness.broadcasts.filter((entry) => entry.type === ServerMessage.DAMAGE);
    assert.equal(damage.length, 1, "one hit, announced once to everybody");

    const payload = damage[0]!.payload as DamagePayload;
    assert.equal(payload.victimId, "target");
    assert.equal(payload.attackerId, "shooter");
    assert.equal(payload.amount, getWeapon(shooter.weaponId).damage);
    assert.equal(payload.fatal, false);
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
    const shotsToKill = Math.ceil(MAX_HEALTH / rifle.damage);
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
    assert.equal(payload.endsMatch, true, "one player left standing means this kill ended it");

    // Only the server decides this, and only once one player is left standing.
    harness.matchManager.update(now);
    assert.equal(harness.state.matchState, MatchState.FINISHED);
    assert.equal(harness.state.winnerId, "shooter");
    assert.equal(harness.state.winnerName, "shooter");
  });

  it("only flags the kill that actually ends the match", () => {
    // Three players: the first elimination leaves two standing, so it is an
    // ordinary kill and the client must not treat it as the finish.
    harness.addPlayer("shooter", 200, 1700);
    harness.addPlayer("target", 600, 1700);
    harness.addPlayer("bystander", 700, 1700);

    const rifle = getWeapon(ASSAULT_RIFLE_ID);
    const interval = getFireIntervalMs(rifle) + 1;
    let now = 0;
    for (let shot = 0; shot < Math.ceil(MAX_HEALTH / rifle.damage); shot++) {
      fireAt(harness, "shooter", 0, now);
      harness.step(30, now);
      now += interval;
    }

    const kill = harness.broadcasts.find((entry) => entry.type === ServerMessage.KILL);
    assert.ok(kill, "somebody was eliminated");
    assert.equal((kill.payload as KillPayload).endsMatch, false);
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

    assert.equal(target.health, MAX_HEALTH, "no damage lands before the match starts");
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
    assert.ok(victim.health < MAX_HEALTH);
  });

  it("cannot reach a player standing beyond its range", () => {
    harness.addPlayer("attacker", 400, 1700);
    const victim = harness.addPlayer("victim", 400 + getWeapon(CHAINSAW_ID).range + 80, 1700);

    swing(harness, "attacker", 0, 0);

    assert.equal(harness.damage.length, 0, "a swing into empty air hits nothing");
    assert.equal(victim.health, MAX_HEALTH);
  });

  it("cannot hit a player behind the attacker", () => {
    harness.addPlayer("attacker", 440, 1700);
    const behind = harness.addPlayer("victim", 400, 1700);

    // Aiming right, with the victim to the left: outside the arc.
    swing(harness, "attacker", 0, 0);

    assert.equal(harness.damage.length, 0, "the swing arc must not wrap around the attacker");
    assert.equal(behind.health, MAX_HEALTH);
  });

  it("cannot cut through a wall", () => {
    // The wall at x=820 spans y 1260..1740; stand on either side of it.
    harness.addPlayer("attacker", 800, 1700);
    const shielded = harness.addPlayer("victim", 860, 1700);

    swing(harness, "attacker", 0, 0);

    assert.equal(harness.damage.length, 0, "geometry must block a melee swing");
    assert.equal(shielded.health, MAX_HEALTH);
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

    const swingsToKill = Math.ceil(MAX_HEALTH / chainsaw.damage);
    const interval = getFireIntervalMs(chainsaw) + 1;
    for (let swingIndex = 0; swingIndex < swingsToKill; swingIndex++) {
      fireAt(harness, "attacker", 0, swingIndex * interval);
    }

    assert.equal(victim.alive, false, `${swingsToKill} swings should be lethal`);
  });
});

describe("knockback and recoil", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  /** Velocity as the movement integrator actually holds it. */
  function velocity(sessionId: string) {
    const movement = harness.runtimes.get(sessionId)!.movement;
    return { x: movement.velocityX, y: movement.velocityY };
  }

  /**
   * Two players on the open stretch of floor, with their movement states where
   * they actually are.
   *
   * `addPlayer` positions the synchronised state; the integrator keeps its own,
   * and a knockback lands on that one -- so a test that only set the first would
   * be simulating somebody standing in the far wall.
   */
  function facingPair(target: Harness = harness, shooterX = 200, targetX = 600) {
    const shooter = target.addPlayer("shooter", shooterX, 1700);
    const victim = target.addPlayer("target", targetX, 1700);

    for (const [id, x] of [["shooter", shooterX], ["target", targetX]] as const) {
      const movement = target.runtimes.get(id)!.movement;
      movement.x = x;
      movement.y = 1700;
    }

    return { shooter, victim };
  }

  it("shoves the victim the way the bullet was going", () => {
    facingPair();

    assert.equal(velocity("target").x, 0);
    fireAt(harness, "shooter", 0, 0);
    harness.step(40);

    assert.ok(velocity("target").x > 0, "a shot travelling right should push them right");
  });

  it("shoves them the other way when shot from the other side", () => {
    facingPair(harness, 600, 200);

    fireAt(harness, "shooter", Math.PI, 0);
    harness.step(40);

    assert.ok(velocity("target").x < 0);
  });

  it("pushes harder for a weapon configured to", () => {
    /** Fire one shot with the rifle tuned to `force`, and report the shove. */
    function shoveWith(force: number): number {
      const room = createHarness();
      const config = structuredClone(room.context.baselineConfig);
      config.weapons.find((weapon) => weapon.id === "assault-rifle")!.knockbackForce = force;
      room.replaceConfig(config);

      const { shooter } = facingPair(room);
      room.weapons.equip(shooter, room.runtimes.get("shooter")!, "assault-rifle");

      fireAt(room, "shooter", 0, 0);
      room.step(40);
      return room.runtimes.get("target")!.movement.velocityX;
    }

    const soft = shoveWith(0.1);
    const hard = shoveWith(1);

    assert.ok(soft > 0, "even a light weapon should shove");
    assert.ok(hard > soft * 3, `expected a much bigger shove, ${soft} vs ${hard}`);
  });

  it("never exceeds the configured limit, however absurd the weapon", () => {
    // Physics that a configuration value can break is not really configurable.
    const config = structuredClone(harness.context.baselineConfig);
    config.weapons.find((weapon) => weapon.id === "assault-rifle")!.knockbackForce = 500;
    harness.replaceConfig(config);

    const { shooter } = facingPair();
    harness.weapons.equip(shooter, harness.runtimes.get("shooter")!, "assault-rifle");

    fireAt(harness, "shooter", 0, 0);
    harness.step(40);

    const limit = config.player.maxKnockbackSpeed;
    assert.ok(velocity("target").x <= limit + 1, `${velocity("target").x} exceeded the ${limit} limit`);
  });

  it("adds to the speed already carried rather than replacing it", () => {
    facingPair();

    const movement = harness.runtimes.get("target")!.movement;
    movement.velocityX = 200;

    fireAt(harness, "shooter", 0, 0);
    harness.step(40);

    assert.ok(velocity("target").x > 200, "the shove should compound with the run");
  });

  it("moves the victim rather than teleporting them", () => {
    // A teleport would put somebody through geometry and would read as a jump
    // on every other client.
    const { victim: target } = facingPair();
    const before = target.x;

    fireAt(harness, "shooter", 0, 0);
    harness.step(40);

    assert.equal(target.x, before, "position must only change through the integrator");
    assert.ok(velocity("target").x > 0, "but the velocity should have changed");
  });

  /**
   * Let the simulation actually run for a while.
   *
   * Movement only advances on queued input -- a player the server has heard
   * nothing from stands still -- so covering ground means feeding the same
   * do-nothing command the client sends when no key is held.
   */
  function idleFor(seconds: number, ids: string[]): void {
    const steps = Math.round(seconds / FIXED_DELTA);
    for (let step = 0; step < steps; step++) {
      // Held every step: the match manager is running too, and it has every
      // right to call a two-player match over -- this test is about physics.
      harness.state.matchState = MatchState.PLAYING;
      for (const id of ids) {
        harness.runtimes.get(id)!.inputQueue.push(createInputCommand(1000 + step));
      }
      harness.run(FIXED_DELTA);
    }
  }

  it("carries the victim a visible distance rather than being scrubbed off by the floor", () => {
    // The failure this pins: ground friction is 3200px/s², which under ordinary
    // deceleration erases a rifle's shove within two frames and about half a
    // pixel of travel -- landing a hit then looks like nothing happened at all.
    const { victim: target } = facingPair();
    const before = target.x;

    fireAt(harness, "shooter", 0, 0);
    harness.step(40);
    idleFor(0.5, ["target"]);

    assert.ok(target.x - before > 25, `a hit should move somebody, moved ${target.x - before}px`);
  });

  it("stops carrying the shove once the recovery window is over", () => {
    // The window is what keeps a shove alive; it must not leave the player
    // permanently frictionless.
    const { victim: target } = facingPair();

    fireAt(harness, "shooter", 0, 0);
    harness.step(40);
    assert.ok(harness.runtimes.get("target")!.movement.knockbackTimer > 0);

    idleFor(1.5, ["target"]);
    assert.equal(harness.runtimes.get("target")!.movement.knockbackTimer, 0);
    assert.ok(Math.abs(velocity("target").x) < 1, "and they should have come to rest");
    void target;
  });

  it("takes a standing victim off their feet", () => {
    // A purely horizontal push against the floor is fought by friction and by
    // the victim's own footing; lifting them is what makes a hit read as one.
    facingPair();
    const movement = harness.runtimes.get("target")!.movement;
    movement.onGround = true;

    fireAt(harness, "shooter", 0, 0);
    harness.step(40);

    assert.ok(velocity("target").y < 0, "the shove should have lifted them");
  });

  it("does not hop the shooter with their own recoil", () => {
    // Recoil passes no lift: an automatic weapon would otherwise bounce its
    // owner off the floor several times a second.
    const shooter = harness.addPlayer("shooter", 200, 1700);
    const movement = harness.runtimes.get("shooter")!.movement;
    movement.x = 200;
    movement.y = 1700;
    movement.onGround = true;
    harness.weapons.equip(shooter, harness.runtimes.get("shooter")!, "shotgun");

    fireAt(harness, "shooter", 0, 0);

    assert.equal(velocity("shooter").y, 0, "firing level should not lift the shooter");
    assert.ok(velocity("shooter").x < 0, "but it should still kick them backwards");
  });

  it("kicks the shooter backwards", () => {
    const shooter = harness.addPlayer("shooter", 200, 1700);
    harness.weapons.equip(shooter, harness.runtimes.get("shooter")!, "shotgun");

    fireAt(harness, "shooter", 0, 0);

    assert.ok(velocity("shooter").x < 0, "firing right should push the shooter left");
  });

  it("kicks once per shot, not once per pellet", () => {
    const config = structuredClone(harness.context.baselineConfig);
    const shotgun = config.weapons.find((weapon) => weapon.id === "shotgun")!;
    const pellets = shotgun.ranged!.pellets;
    assert.ok(pellets > 1, "this test needs a multi-pellet weapon");
    harness.replaceConfig(config);

    const shooter = harness.addPlayer("shooter", 200, 1700);
    harness.weapons.equip(shooter, harness.runtimes.get("shooter")!, "shotgun");
    fireAt(harness, "shooter", 0, 0);

    const kick = Math.abs(velocity("shooter").x);
    const perShot = shotgun.recoilForce * KNOCKBACK_IMPULSE;
    assert.ok(
      Math.abs(kick - perShot) < 1,
      `expected one shot's worth of recoil (${perShot}), got ${kick}`,
    );
  });

  it("leaves a weapon with no recoil alone", () => {
    const shooter = harness.addPlayer("shooter", 200, 1700);
    harness.weapons.equip(shooter, harness.runtimes.get("shooter")!, "chainsaw");

    fireAt(harness, "shooter", 0, 0);

    assert.equal(velocity("shooter").x, 0, "a chainsaw has nothing to recoil against");
  });

  it("throws whoever a melee weapon catches, along the swing", () => {
    const attacker = harness.addPlayer("attacker", 200, 1700);
    harness.addPlayer("victim", 240, 1700);
    harness.weapons.equip(attacker, harness.runtimes.get("attacker")!, "chainsaw");

    fireAt(harness, "attacker", 0, 0);

    assert.ok(velocity("victim").x > 0, "the chainsaw should push what it is pointed at");
  });

  it("does not knock a knocked-back player back to walking pace", () => {
    // The interaction that quietly cancels the whole feature: the run-speed cap
    // used to clip any velocity above it, so holding a movement key erased a
    // shove the instant it landed.
    facingPair();

    const movement = harness.runtimes.get("target")!.movement;
    movement.velocityX = 700;

    const input = createInputCommand(1);
    input.moveRight = true;
    stepPlayerMovement(movement, input, FIXED_DELTA, harness.context.world, undefined, getPlayerConfig());

    assert.ok(movement.velocityX > getPlayerConfig().moveSpeed, "the shove was clipped away");
  });
});

describe("explosive weapons", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  /** Put a player where the collision world actually agrees they are. */
  function place(sessionId: string, x: number, y = 1700) {
    const player = harness.addPlayer(sessionId, x, y);
    const movement = harness.runtimes.get(sessionId)!.movement;
    movement.x = x;
    movement.y = y;
    return player;
  }

  it("hurts through the blast rather than on contact", () => {
    // A rocket's own damage is zero: everything it does comes from the
    // explosion, which is what lets a near miss still matter.
    const launcher = getWeapon(ROCKET_LAUNCHER_ID);
    assert.equal(launcher.damage, 0, "the round itself should do nothing");
    assert.ok(launcher.ranged?.explosion, "and the blast should be the weapon");

    const shooter = place("shooter", 200);
    const victim = place("target", 600);
    harness.weapons.equip(shooter, harness.runtimes.get("shooter")!, ROCKET_LAUNCHER_ID);

    fireAt(harness, "shooter", 0, 0);
    harness.step(60);

    assert.ok(victim.health < MAX_HEALTH, "a direct hit should hurt");
  });

  it("catches somebody standing next to the person it hit", () => {
    // Splash is the entire point, and the reason a launcher is not simply a
    // better rifle: it hits what you aimed at and whatever was beside it.
    const shooter = place("shooter", 200);
    const target = place("target", 600);
    const bystander = place("bystander", 660);
    harness.weapons.equip(shooter, harness.runtimes.get("shooter")!, ROCKET_LAUNCHER_ID);

    fireAt(harness, "shooter", 0, 0);
    harness.step(60);

    assert.ok(target.health < MAX_HEALTH, "the target should be hit");
    assert.ok(bystander.health < MAX_HEALTH, "and so should whoever was next to them");
  });

  it("catches the shooter who fires it at their own feet", () => {
    // Nobody is immune to their own explosion. It is what makes firing a
    // launcher at somebody standing next to you a decision.
    const shooter = place("shooter", 600);
    harness.weapons.equip(shooter, harness.runtimes.get("shooter")!, ROCKET_LAUNCHER_ID);

    // Straight down into the floor.
    fireAt(harness, "shooter", Math.PI / 2, 0);
    harness.step(30);

    assert.ok(shooter.health < MAX_HEALTH, "the shooter should feel their own blast");
  });

  it("goes off on the wall it hit, not silently", () => {
    const shooter = place("shooter", 200);
    harness.weapons.equip(shooter, harness.runtimes.get("shooter")!, ROCKET_LAUNCHER_ID);

    fireAt(harness, "shooter", 0, 0);
    harness.step(90);

    const blast = harness.broadcasts.find((entry) => entry.type === ServerMessage.EXPLOSION);
    assert.ok(blast, "a rocket must announce itself wherever it stops");
  });

  it("throws the shooter hard enough to jump with", () => {
    // The rocket jump: recoil plus the blast under your feet. Both numbers are
    // tuned for it, so this is a promise rather than a side effect.
    const shooter = place("shooter", 600);
    harness.weapons.equip(shooter, harness.runtimes.get("shooter")!, ROCKET_LAUNCHER_ID);
    const movement = harness.runtimes.get("shooter")!.movement;
    movement.onGround = true;

    fireAt(harness, "shooter", Math.PI / 2, 0);
    harness.step(30);

    assert.ok(movement.velocityY < -200, `expected real lift, got ${movement.velocityY}`);
  });

  it("leaves ordinary bullets alone", () => {
    const shooter = place("shooter", 200);
    place("target", 600);
    harness.weapons.equip(shooter, harness.runtimes.get("shooter")!, ASSAULT_RIFLE_ID);

    fireAt(harness, "shooter", 0, 0);
    harness.step(60);

    assert.equal(
      harness.broadcasts.filter((entry) => entry.type === ServerMessage.EXPLOSION).length,
      0,
      "a rifle round is not an explosion",
    );
  });
});
