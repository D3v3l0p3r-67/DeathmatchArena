/**
 * Coverage of the crate and power-up pipeline:
 *
 *   spawn point -> crate -> damage -> destruction -> revealed pickup -> effect
 *
 * Everything is driven through the real `PowerUpSystem` against a stub room, so
 * these exercise the same code the server runs, including the parts a client must
 * never influence: what a crate contains, and when it opens.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  CHAINSAW_ID,
  DEFAULT_GAME_CONFIG,
  FIXED_DELTA,
  MatchState,
  PLAYER,
  PowerUpType,
  SHOTGUN_ID,
  ServerMessage,
  applyHealthRestore,
  getArena,
  getCrateConfig,
  getGameConfig,
  getPowerUpSpawnConfig,
  getWeapon,
  listSpawnablePowerUps,
  loadGameConfig,
  pickWeightedPowerUp,
  resetGameConfig,
  type GameConfig,
  type HealthPowerUp,
  type PowerUpCollectedPayload,
} from "@deathmatch/shared";
import { clock, createHarness, fireAt, type Harness } from "./harness.js";

/** Deep-ish clone of the shipped config, so a test can retune it in isolation. */
function cloneDefaultConfig(): GameConfig {
  return JSON.parse(JSON.stringify(DEFAULT_GAME_CONFIG)) as GameConfig;
}

describe("power-up configuration", () => {
  it("ships every power-up the game advertises, each with a stable id", () => {
    const ids = getGameConfig().powerUps.map((powerUp) => powerUp.id);

    assert.equal(new Set(ids).size, ids.length, "ids must be unique");
    for (const id of ids) {
      assert.match(id, /^[a-z0-9-]+$/, `"${id}" should be a stable kebab-case id`);
    }

    // Display names are separate from ids, so renaming one never breaks the other.
    for (const powerUp of getGameConfig().powerUps) {
      assert.ok(powerUp.name.length > 0, `${powerUp.id} needs a display name`);
      assert.notEqual(powerUp.name, powerUp.id, `${powerUp.id} should not reuse its id as a name`);
    }
  });

  it("offers a weapon power-up for every non-default weapon", () => {
    const granted = new Set(
      getGameConfig()
        .powerUps.filter((powerUp) => powerUp.type === PowerUpType.WEAPON)
        .map((powerUp) => (powerUp.type === PowerUpType.WEAPON ? powerUp.weaponId : "")),
    );

    assert.ok(granted.has(SHOTGUN_ID), "the shotgun must be obtainable");
    assert.ok(granted.has(CHAINSAW_ID), "the chainsaw must be obtainable");
  });

  it("respects spawn weights rather than treating power-ups as equally likely", () => {
    const config = cloneDefaultConfig();
    // Two candidates, 3:1. Anything that ignores weights would land near 50/50.
    config.powerUps = [
      { ...config.powerUps[0]!, id: "common", spawnWeight: 75 },
      { ...config.powerUps[1]!, id: "rare", spawnWeight: 25 },
    ];
    loadGameConfig(config);

    try {
      const counts = new Map<string, number>();
      const samples = 4000;
      let seed = 1;
      // Deterministic pseudo-random stream, so the assertion cannot flake.
      const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };

      for (let i = 0; i < samples; i++) {
        const picked = pickWeightedPowerUp(random)!;
        counts.set(picked.id, (counts.get(picked.id) ?? 0) + 1);
      }

      const commonShare = (counts.get("common") ?? 0) / samples;
      assert.ok(
        commonShare > 0.7 && commonShare < 0.8,
        `expected the 75-weight entry near 75% of picks, got ${(commonShare * 100).toFixed(1)}%`,
      );
    } finally {
      resetGameConfig();
    }
  });

  it("never spawns a disabled power-up, or one granting a disabled weapon", () => {
    const config = cloneDefaultConfig();
    config.powerUps = config.powerUps.map((powerUp) =>
      powerUp.type === PowerUpType.HEALTH ? { ...powerUp, enabled: false } : powerUp,
    );
    // Disabling the weapon must also retire the power-up that grants it.
    config.weapons = config.weapons.map((weapon) =>
      weapon.id === SHOTGUN_ID ? { ...weapon, enabled: false } : weapon,
    );
    loadGameConfig(config);

    try {
      const spawnable = listSpawnablePowerUps();
      for (const powerUp of spawnable) {
        assert.notEqual(powerUp.type, PowerUpType.HEALTH, "a disabled power-up must not spawn");
        if (powerUp.type === PowerUpType.WEAPON) {
          assert.notEqual(powerUp.weaponId, SHOTGUN_ID, "a disabled weapon must not be granted");
        }
      }
      assert.ok(spawnable.length > 0, "the remaining power-ups should still spawn");
    } finally {
      resetGameConfig();
    }
  });

  it("places every power-up spawn point in open space", () => {
    const arena = getArena("foundry");
    const crate = getCrateConfig();

    assert.ok(arena.powerUpSpawnPoints.length > 0, "the map needs power-up spawn points");

    for (const point of arena.powerUpSpawnPoints) {
      assert.ok(
        point.x > 0 && point.x < arena.width && point.y > 0 && point.y < arena.height,
        `spawn point ${point.x},${point.y} is outside the arena`,
      );
      // A crate buried in geometry could never be shot open.
      const world = createHarness().context.world;
      assert.equal(
        world.isBoxBlocked(point.x, point.y, crate.width / 2, crate.height / 2),
        false,
        `a crate at ${point.x},${point.y} would be stuck inside geometry`,
      );
    }
  });
});

describe("health power-up", () => {
  const medkit = DEFAULT_GAME_CONFIG.powerUps.find(
    (powerUp): powerUp is HealthPowerUp => powerUp.type === PowerUpType.HEALTH,
  )!;

  it("restores the configured percentage of maximum health", () => {
    // The worked example from the spec: 30 HP + 50% of 100 = 80 HP.
    assert.equal(applyHealthRestore(30, 100, medkit), 80);
  });

  it("never exceeds maximum health", () => {
    assert.equal(applyHealthRestore(70, 100, medkit), 100);
    assert.equal(applyHealthRestore(100, 100, medkit), 100);
  });

  it("scales with the configured fraction rather than a fixed number", () => {
    const quarter: HealthPowerUp = { ...medkit, restoreFraction: 0.25 };
    assert.equal(applyHealthRestore(20, 100, quarter), 45);
  });
});

describe("crates", () => {
  let harness: Harness;

  beforeEach(() => {
    clock.now = 0;
    harness = createHarness();
    harness.powerUps.onMatchStarted(0);
  });

  /** Advance far enough for the spawn timer to fire at least once. */
  function runUntilCrateSpawns(harness: Harness): string {
    const config = getPowerUpSpawnConfig();
    let now = config.firstSpawnDelayMs;
    for (let attempt = 0; attempt < 10 && harness.state.crates.size === 0; attempt++) {
      clock.now = now;
      harness.stepPowerUps(now);
      now += config.intervalMs;
    }
    const id = Array.from(harness.state.crates.keys())[0];
    assert.ok(id, "a crate should have spawned");
    return id;
  }

  it("spawns crates only at the map's configured spawn points", () => {
    const crateId = runUntilCrateSpawns(harness);
    const crate = harness.state.crates.get(crateId)!;

    const points = harness.arena.powerUpSpawnPoints;
    const matching = points.some((point) => point.x === crate.x && point.y === crate.y);
    assert.ok(matching, `crate at ${crate.x},${crate.y} is not on a configured spawn point`);
  });

  it("does not put two crates on the same spawn point", () => {
    const config = getPowerUpSpawnConfig();
    let now = config.firstSpawnDelayMs;

    // Run well past the crate cap so every spawn opportunity is taken.
    for (let attempt = 0; attempt < 40; attempt++) {
      clock.now = now;
      harness.stepPowerUps(now);
      now += config.intervalMs;
    }

    const positions = Array.from(harness.state.crates.values()).map((crate) => `${crate.x},${crate.y}`);
    assert.equal(new Set(positions).size, positions.length, "spawn points must not be reused");
    assert.ok(
      harness.state.crates.size <= config.maxActiveCrates,
      "the active crate cap must be respected",
    );
  });

  it("keeps its contents off the wire until it breaks", () => {
    const crateId = runUntilCrateSpawns(harness);
    const crate = harness.state.crates.get(crateId)!;

    // The synchronised crate exposes position and health -- and nothing else.
    assert.equal(
      Object.prototype.hasOwnProperty.call(crate, "powerUpId"),
      false,
      "a client must not be able to see inside an unopened crate",
    );
    assert.equal(harness.state.powerUps.size, 0, "nothing is revealed before the crate breaks");
  });

  it("takes damage and reveals a power-up once destroyed", () => {
    const crateId = runUntilCrateSpawns(harness);
    const crate = harness.state.crates.get(crateId)!;
    const startHealth = crate.health;

    harness.powerUps.damageCrate(crateId, 10, "attacker", clock.now);
    assert.equal(crate.health, startHealth - 10, "the server owns crate health");
    assert.equal(harness.state.crates.size, 1, "the crate survives a partial hit");

    harness.powerUps.damageCrate(crateId, startHealth, "attacker", clock.now);

    assert.equal(harness.state.crates.size, 0, "the crate is gone once destroyed");
    assert.equal(harness.state.powerUps.size, 1, "destroying it reveals exactly one power-up");

    const destroyed = harness.broadcasts.find((entry) => entry.type === ServerMessage.CRATE_DESTROYED);
    assert.ok(destroyed, "the destruction is announced");
  });

  it("can be broken by gunfire, from a hit the server computed", () => {
    // Put a crate in the open stretch of floor the combat tests use.
    const crateId = runUntilCrateSpawns(harness);
    const crate = harness.state.crates.get(crateId)!;

    harness.addPlayer("shooter", crate.x - 300, crate.y);
    const before = crate.health;

    fireAt(harness, "shooter", 0, 0);
    harness.step(40);

    assert.ok(crate.health < before, "a bullet must damage the crate it hits");
  });
});

describe("power-up effects", () => {
  let harness: Harness;

  beforeEach(() => {
    clock.now = 0;
    harness = createHarness();
    harness.powerUps.onMatchStarted(0);
  });

  function definition(id: string) {
    return getGameConfig().powerUps.find((powerUp) => powerUp.id === id)!;
  }

  it("grants the weapon a weapon power-up names, without any id-specific logic", () => {
    const player = harness.addPlayer("p1", 400, 1700);
    const runtime = harness.runtimes.get("p1")!;

    const shotgunPowerUp = getGameConfig().powerUps.find(
      (powerUp) => powerUp.type === PowerUpType.WEAPON && powerUp.weaponId === SHOTGUN_ID,
    )!;

    assert.equal(harness.powerUps.applyPowerUp(shotgunPowerUp, player, runtime, 0), true);
    assert.equal(player.weaponId, SHOTGUN_ID);
    assert.equal(player.ammo, getWeapon(SHOTGUN_ID).magazineSize, "the pickup arrives loaded");
  });

  it("applies a speed boost and lets it expire back to normal", () => {
    const player = harness.addPlayer("p1", 400, 1700);
    const runtime = harness.runtimes.get("p1")!;

    const speed = definition("speed-boost");
    assert.equal(speed.type, PowerUpType.SPEED);
    const duration = speed.type === PowerUpType.SPEED ? speed.durationMs : 0;
    const multiplier = speed.type === PowerUpType.SPEED ? speed.speedMultiplier : 1;

    harness.powerUps.applyPowerUp(speed, player, runtime, 0);

    assert.equal(player.speedMultiplier, multiplier, "the effect is server-owned state");
    assert.equal(runtime.movement.speedMultiplier, multiplier, "and reaches the movement step");

    // Halfway through, the effect is still running and reports its countdown.
    harness.stepPowerUps(duration / 2);
    assert.equal(player.speedMultiplier, multiplier);
    assert.ok(player.boostSeconds > 0, "the HUD countdown is server-sent");

    // Past the deadline it is gone, and movement is back to normal.
    harness.stepPowerUps(duration + 1);
    assert.equal(player.speedMultiplier, 1, "speed returns to normal when the effect expires");
    assert.equal(runtime.movement.speedMultiplier, 1);
    assert.equal(player.boostSeconds, 0);
  });

  it("restores health on pickup, capped at the maximum", () => {
    const player = harness.addPlayer("p1", 400, 1700);
    const runtime = harness.runtimes.get("p1")!;
    player.health = 30;

    const medkit = definition("health-50");
    assert.equal(harness.powerUps.applyPowerUp(medkit, player, runtime, 0), true);
    assert.equal(player.health, 80);

    // On full health there is nothing to give, so the pickup is declined and
    // stays on the ground rather than being wasted.
    player.health = PLAYER.MAX_HEALTH;
    assert.equal(harness.powerUps.applyPowerUp(medkit, player, runtime, 0), false);
    assert.equal(player.health, PLAYER.MAX_HEALTH);
  });

  it("is collected by walking into the revealed power-up", () => {
    const config = getPowerUpSpawnConfig();
    let now = config.firstSpawnDelayMs;
    for (let attempt = 0; attempt < 10 && harness.state.crates.size === 0; attempt++) {
      clock.now = now;
      harness.stepPowerUps(now);
      now += config.intervalMs;
    }

    const crateId = Array.from(harness.state.crates.keys())[0]!;
    const crate = harness.state.crates.get(crateId)!;
    const crateX = crate.x;
    const crateY = crate.y;

    harness.powerUps.damageCrate(crateId, crate.maxHealth, "breaker", now);
    assert.equal(harness.state.powerUps.size, 1);

    // Standing away from it changes nothing...
    harness.addPlayer("p1", crateX + 400, crateY);
    harness.stepPowerUps(now);
    assert.equal(harness.state.powerUps.size, 1, "a distant player collects nothing");

    // ...but standing on it does.
    const player = harness.state.players.get("p1")!;
    player.x = crateX;
    player.y = crateY;
    player.health = 20;
    harness.stepPowerUps(now);

    assert.equal(harness.state.powerUps.size, 0, "the pickup is consumed on contact");

    const collected = harness.broadcasts.find(
      (entry) => entry.type === ServerMessage.POWERUP_COLLECTED,
    );
    assert.ok(collected, "the pickup is announced");
    assert.equal((collected.payload as PowerUpCollectedPayload).sessionId, "p1");
  });

  it("clears an active effect when the player dies", () => {
    const player = harness.addPlayer("p1", 400, 1700);
    const runtime = harness.runtimes.get("p1")!;

    harness.powerUps.applyPowerUp(definition("speed-boost"), player, runtime, 0);
    assert.ok(player.speedMultiplier > 1);

    harness.matchManager.eliminate(player, null, player.weaponId);

    assert.equal(player.speedMultiplier, 1, "a boost must not survive its owner");
    assert.equal(player.boostSeconds, 0);
  });
});

describe("closing arena", () => {
  let harness: Harness;

  beforeEach(() => {
    clock.now = 0;
    harness = createHarness();
    // The shrink derives its deadline from the match clock, so a started match
    // needs a start time -- 1 rather than 0, since 0 means "no match".
    harness.state.matchStartedAt = 1;
  });

  /** Advance the walls by `seconds`, in fixed ticks, starting at `startAt`. */
  function shrinkFor(harness: Harness, seconds: number, startAt: number): void {
    const ticks = Math.round(seconds / FIXED_DELTA);
    for (let i = 0; i < ticks; i++) {
      clock.now = startAt + i * FIXED_DELTA * 1000;
      harness.stepArenaShrink(FIXED_DELTA, clock.now);
    }
  }

  it("leaves the arena at full width until the configured time", () => {
    const config = getGameConfig().arenaShrink;
    harness.arenaShrink.onMatchStarted();

    assert.equal(harness.state.shrinkLeft, 0);
    assert.equal(harness.state.shrinkRight, harness.arena.width);
    assert.equal(harness.state.shrinking, false);
    assert.ok(harness.state.shrinkCountdownSeconds > 0, "the HUD gets a countdown");

    // One tick short of the deadline changes nothing.
    clock.now = config.startAfterMs - 100;
    harness.stepArenaShrink(FIXED_DELTA, clock.now);

    assert.equal(harness.state.shrinking, false);
    assert.equal(harness.state.shrinkLeft, 0);
    assert.equal(harness.state.shrinkRight, harness.arena.width);
  });

  it("closes both walls symmetrically once it starts", () => {
    const config = getGameConfig().arenaShrink;
    harness.arenaShrink.onMatchStarted();

    shrinkFor(harness, 4, config.startAfterMs);

    assert.equal(harness.state.shrinking, true);
    assert.equal(harness.state.shrinkCountdownSeconds, 0);

    const left = harness.state.shrinkLeft;
    const right = harness.state.shrinkRight;
    assert.ok(left > 0, "the left wall advanced");
    assert.ok(right < harness.arena.width, "the right wall advanced");

    // Symmetric, so the safe zone stays centred on the arena.
    const leftTravel = left;
    const rightTravel = harness.arena.width - right;
    assert.ok(Math.abs(leftTravel - rightTravel) < 0.001, "both walls move at the same rate");
    assert.ok(leftTravel > config.speedPerSecond * 3, "roughly the configured speed");
  });

  it("stops at the configured minimum width", () => {
    const config = getGameConfig().arenaShrink;
    harness.arenaShrink.onMatchStarted();

    // Far longer than it could ever need.
    shrinkFor(harness, 400, config.startAfterMs);

    const width = harness.state.shrinkRight - harness.state.shrinkLeft;
    assert.ok(
      Math.abs(width - config.minWidth) < 1,
      `the walls must stop at the minimum width, got ${width}`,
    );
  });

  it("damages a player the walls are pressing against", () => {
    const config = getGameConfig().arenaShrink;
    harness.arenaShrink.onMatchStarted();

    // Against the left edge, where the wall will reach them.
    const squeezed = harness.addPlayer("squeezed", 30, 1700);
    const safe = harness.addPlayer("safe", harness.arena.width / 2, 1700);

    shrinkFor(harness, 6, config.startAfterMs);

    assert.ok(squeezed.health < PLAYER.MAX_HEALTH, "the wall hurts whoever it catches");
    assert.equal(safe.health, PLAYER.MAX_HEALTH, "and leaves the middle alone");
  });

  it("does nothing while the match is not running", () => {
    const config = getGameConfig().arenaShrink;
    harness.arenaShrink.onMatchStarted();
    harness.state.matchState = MatchState.FINISHED;

    shrinkFor(harness, 10, config.startAfterMs);

    assert.equal(harness.state.shrinking, false);
    assert.equal(harness.state.shrinkLeft, 0);
  });

  it("can be switched off through configuration", () => {
    const config = cloneDefaultConfig();
    config.arenaShrink = { ...config.arenaShrink, enabled: false };
    loadGameConfig(config);

    try {
      const disabled = createHarness();
      disabled.arenaShrink.onMatchStarted();
      shrinkFor(disabled, 20, config.arenaShrink.startAfterMs);

      assert.equal(disabled.state.shrinking, false);
      assert.equal(disabled.state.shrinkLeft, 0);
      assert.equal(disabled.state.shrinkRight, disabled.arena.width);
    } finally {
      resetGameConfig();
    }
  });

  it("puts the walls back when a match ends", () => {
    const config = getGameConfig().arenaShrink;
    harness.arenaShrink.onMatchStarted();
    shrinkFor(harness, 5, config.startAfterMs);
    assert.ok(harness.state.shrinkLeft > 0);

    harness.arenaShrink.reset();

    assert.equal(harness.state.shrinkLeft, 0);
    assert.equal(harness.state.shrinkRight, harness.arena.width);
    assert.equal(harness.state.shrinking, false);
  });
});
