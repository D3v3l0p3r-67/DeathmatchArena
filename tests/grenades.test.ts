/**
 * Server-authoritative grenades: charge, throw, flight and blast.
 *
 * The property that matters throughout: a client contributes a held button and
 * an aim angle, nothing else. Throw strength is measured against the server
 * clock, the flight is simulated server-side, and the blast decides its own
 * victims and damage.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  DEFAULT_GAME_CONFIG,
  FIXED_DELTA,
  MatchState,
  PowerUpType,
  ServerMessage,
  createInputCommand,
  getGameConfig,
  getGrenadeConfig,
  loadGameConfig,
  resetGameConfig,
  type GameConfig,
  type GrenadeExplodedPayload,
  type InputCommand,
} from "@deathmatch/shared";
import { clock, createHarness, type Harness } from "./harness.js";
import { MAX_HEALTH } from "./helpers.js";

const { explosionDamageAt } = await import("../server/src/systems/GrenadeSystem.js");

function cloneConfig(): GameConfig {
  return structuredClone(DEFAULT_GAME_CONFIG);
}

/** Feed one input command through the grenade system, as the movement loop does. */
function send(harness: Harness, sessionId: string, now: number, mutate: (input: InputCommand) => void): void {
  const player = harness.state.players.get(sessionId)!;
  const runtime = harness.runtimes.get(sessionId)!;
  const input = createInputCommand(runtime.lastInput.seq + 1);
  input.aimAngle = 0;
  mutate(input);

  harness.grenades.processInput(player, runtime, input, now);

  // The real loop copies the command into `lastInput` after processing it; the
  // press/release edges depend on that.
  runtime.lastInput.seq = input.seq;
  runtime.lastInput.chargeGrenade = input.chargeGrenade;
  runtime.lastInput.aimAngle = input.aimAngle;
}

/** Hold the throw button for `holdMs`, then release, and return the grenade. */
function throwGrenade(harness: Harness, sessionId: string, holdMs: number, aimAngle = 0) {
  send(harness, sessionId, 0, (input) => {
    input.chargeGrenade = true;
    input.aimAngle = aimAngle;
  });
  send(harness, sessionId, holdMs, (input) => {
    input.chargeGrenade = false;
    input.aimAngle = aimAngle;
  });
  return Array.from(harness.state.grenades.values()).at(-1);
}

describe("grenade loadout", () => {
  let harness: Harness;

  beforeEach(() => {
    clock.now = 0;
    harness = createHarness();
  });

  it("issues the configured starting count at spawn", () => {
    const player = harness.addPlayer("p1", 600, 1700);
    harness.grenades.resupply(player);

    assert.equal(player.grenades, getGrenadeConfig().startingCount);
    assert.equal(getGrenadeConfig().startingCount, 3, "the default loadout is three grenades");
  });

  it("spends one per throw and refuses to throw with none left", () => {
    const player = harness.addPlayer("p1", 600, 1700);
    harness.grenades.resupply(player);

    const carried = player.grenades;
    assert.ok(carried > 0, "the loadout should issue something to throw");

    assert.ok(throwGrenade(harness, "p1", 200), "the first throw happens");
    assert.equal(player.grenades, carried - 1, "one throw costs exactly one grenade");
    assert.equal(harness.state.grenades.size, 1);

    // With none left, holding and releasing produces nothing at all.
    player.grenades = 0;
    throwGrenade(harness, "p1", 200);
    assert.equal(harness.state.grenades.size, 1, "an empty player cannot throw");
    assert.equal(player.grenades, 0);
  });

  it("tops up from a pickup, never past the carrying limit", () => {
    const player = harness.addPlayer("p1", 600, 1700);
    const runtime = harness.runtimes.get("p1")!;
    player.grenades = 0;

    const pack = getGameConfig().powerUps.find((powerUp) => powerUp.type === PowerUpType.GRENADE)!;
    assert.ok(pack, "the catalogue offers a grenade power-up");

    assert.equal(harness.powerUps.applyPowerUp(pack, player, runtime, 0), true);
    assert.ok(player.grenades > 0, "the pickup hands over grenades");

    // Fill to the limit, then the pickup has nothing to give and is declined.
    player.grenades = getGrenadeConfig().maxCount;
    assert.equal(
      harness.powerUps.applyPowerUp(pack, player, runtime, 0),
      false,
      "a full player leaves the pickup on the ground",
    );
    assert.equal(player.grenades, getGrenadeConfig().maxCount);
  });

  it("cancels a wind-up when its owner dies", () => {
    const player = harness.addPlayer("p1", 600, 1700);
    const runtime = harness.runtimes.get("p1")!;
    harness.grenades.resupply(player);

    send(harness, "p1", 0, (input) => void (input.chargeGrenade = true));
    assert.equal(player.chargingGrenade, true);

    harness.matchManager.eliminate(player, null, player.weaponId);

    assert.equal(player.chargingGrenade, false, "a wind-up dies with its owner");
    assert.equal(runtime.grenadeChargeStartedAt, 0);
  });
});

describe("grenade throw strength", () => {
  let harness: Harness;

  beforeEach(() => {
    clock.now = 0;
    harness = createHarness();
  });

  it("derives speed from how long the button was held", () => {
    const config = getGrenadeConfig();

    const quick = createHarness();
    const quickPlayer = quick.addPlayer("p1", 600, 1700);
    quick.grenades.grant(quickPlayer, 5);
    const lobbed = throwGrenade(quick, "p1", 0)!;

    const charged = createHarness();
    const chargedPlayer = charged.addPlayer("p1", 600, 1700);
    charged.grenades.grant(chargedPlayer, 5);
    const hurled = throwGrenade(charged, "p1", config.maxChargeMs)!;

    const lobbedSpeed = Math.hypot(lobbed.velocityX, lobbed.velocityY);
    const hurledSpeed = Math.hypot(hurled.velocityX, hurled.velocityY);

    assert.ok(
      Math.abs(lobbedSpeed - config.minThrowSpeed) < 1,
      `no charge should throw at the minimum speed, got ${lobbedSpeed}`,
    );
    assert.ok(
      Math.abs(hurledSpeed - config.maxThrowSpeed) < 1,
      `a full charge should throw at the maximum speed, got ${hurledSpeed}`,
    );
    assert.ok(hurledSpeed > lobbedSpeed * 2, "charging must matter");

    void harness;
  });

  it("caps an absurdly long hold at the configured maximum", () => {
    const config = getGrenadeConfig();
    const player = harness.addPlayer("p1", 600, 1700);
    harness.grenades.grant(player, 5);

    // A client that holds for an hour still gets a full-power throw, not more.
    const grenade = throwGrenade(harness, "p1", 60 * 60 * 1000)!;
    const speed = Math.hypot(grenade.velocityX, grenade.velocityY);

    assert.ok(
      speed <= config.maxThrowSpeed + 1,
      `charge must be clamped, got ${speed} vs max ${config.maxThrowSpeed}`,
    );
  });

  it("throws along the aim direction", () => {
    const player = harness.addPlayer("p1", 600, 1700);
    harness.grenades.grant(player, 5);

    const grenade = throwGrenade(harness, "p1", 300, Math.PI)!;
    assert.ok(grenade.velocityX < 0, "aiming left throws left");
  });
});

describe("grenade flight", () => {
  let harness: Harness;

  beforeEach(() => {
    clock.now = 0;
    harness = createHarness();
  });

  /** Advance grenade physics for `seconds`. */
  function fly(harness: Harness, seconds: number): void {
    const ticks = Math.round(seconds / FIXED_DELTA);
    for (let i = 0; i < ticks; i++) {
      clock.now = i * FIXED_DELTA * 1000;
      harness.stepGrenades(FIXED_DELTA, clock.now);
    }
  }

  it("falls under gravity and comes to rest on the floor", () => {
    const player = harness.addPlayer("p1", 600, 1600);
    harness.grenades.grant(player, 5);

    const grenade = throwGrenade(harness, "p1", 200)!;
    const startY = grenade.y;

    fly(harness, 1);

    assert.ok(grenade.y > startY, "gravity pulls it down");
    // The open stretch of floor is at y=1740; it must not pass through.
    assert.ok(grenade.y < 1740, "it must not fall through the floor");
  });

  it("bounces off geometry instead of passing through it", () => {
    const player = harness.addPlayer("p1", 600, 1700);
    harness.grenades.grant(player, 5);

    // Thrown hard at the wall standing at x=820.
    const grenade = throwGrenade(harness, "p1", getGrenadeConfig().maxChargeMs)!;
    fly(harness, 0.6);

    assert.ok(grenade.x < 830, `the wall must stop it, got x=${grenade.x}`);
    assert.ok(grenade.velocityX < 0, "and send it back the way it came");
  });

  it("detonates when the fuse runs out, and only once", () => {
    const player = harness.addPlayer("p1", 600, 1700);
    harness.grenades.grant(player, 5);
    throwGrenade(harness, "p1", 100);

    assert.equal(harness.state.grenades.size, 1);

    fly(harness, getGrenadeConfig().fuseMs / 1000 + 0.2);

    assert.equal(harness.state.grenades.size, 0, "the grenade is gone once it explodes");
    const blasts = harness.broadcasts.filter((entry) => entry.type === ServerMessage.GRENADE_EXPLODED);
    assert.equal(blasts.length, 1, "exactly one explosion");
  });
});

describe("grenade explosion", () => {
  let harness: Harness;

  beforeEach(() => {
    clock.now = 0;
    harness = createHarness();
  });

  it("deals full damage at the centre and falls off to the configured edge", () => {
    const config = getGrenadeConfig();

    const centre = explosionDamageAt(0, config);
    const edge = explosionDamageAt(config.explosionRadius, config);
    const beyond = explosionDamageAt(config.explosionRadius * 1.5, config);

    assert.equal(centre, config.maxDamage, "a direct hit deals full damage");
    assert.equal(
      edge,
      Math.round(config.maxDamage * config.minDamageMultiplier),
      "the edge deals the configured floor",
    );
    assert.ok(edge < centre / 2, "falloff must be significant");
    assert.equal(beyond, 0, "nothing outside the radius is touched");

    // Monotonically decreasing across the radius.
    let previous = centre;
    for (let d = 10; d <= config.explosionRadius; d += 10) {
      const damage = explosionDamageAt(d, config);
      assert.ok(damage <= previous, `damage must not rise with distance at ${d}px`);
      previous = damage;
    }
  });

  it("damages everyone in range, including the thrower", () => {
    const config = getGrenadeConfig();
    const thrower = harness.addPlayer("thrower", 600, 1700);
    const victim = harness.addPlayer("victim", 640, 1700);
    const distant = harness.addPlayer("distant", 600 + config.explosionRadius * 4, 1700);
    harness.grenades.grant(thrower, 5);

    // Straight down, so it lands at the thrower's feet.
    throwGrenade(harness, "thrower", 0, Math.PI / 2);

    const ticks = Math.round((config.fuseMs / 1000 + 0.2) / FIXED_DELTA);
    for (let i = 0; i < ticks; i++) {
      clock.now = i * FIXED_DELTA * 1000;
      harness.stepGrenades(FIXED_DELTA, clock.now);
    }

    assert.ok(thrower.health < MAX_HEALTH, "your own grenade hurts you");
    assert.ok(victim.health < MAX_HEALTH, "and anyone nearby");
    assert.equal(distant.health, MAX_HEALTH, "but nobody out of range");
  });

  it("hurts less the further away you are", () => {
    const config = getGrenadeConfig();
    const near = explosionDamageAt(config.explosionRadius * 0.1, config);
    const far = explosionDamageAt(config.explosionRadius * 0.9, config);

    assert.ok(near > far, `${near} at the centre should beat ${far} at the edge`);
  });

  it("announces the blast with the radius that was actually applied", () => {
    const player = harness.addPlayer("p1", 600, 1700);
    harness.grenades.grant(player, 5);
    throwGrenade(harness, "p1", 100);

    const ticks = Math.round((getGrenadeConfig().fuseMs / 1000 + 0.2) / FIXED_DELTA);
    for (let i = 0; i < ticks; i++) {
      clock.now = i * FIXED_DELTA * 1000;
      harness.stepGrenades(FIXED_DELTA, clock.now);
    }

    const blast = harness.broadcasts.find((entry) => entry.type === ServerMessage.GRENADE_EXPLODED);
    assert.ok(blast, "the explosion is broadcast");
    const payload = blast.payload as GrenadeExplodedPayload;
    assert.equal(payload.ownerId, "p1");
    assert.equal(payload.radius, getGrenadeConfig().explosionRadius);
  });

  it("does not damage anyone outside a running match", () => {
    const player = harness.addPlayer("p1", 600, 1700);
    const bystander = harness.addPlayer("p2", 620, 1700);
    harness.grenades.grant(player, 5);
    throwGrenade(harness, "p1", 0, Math.PI / 2);

    harness.state.matchState = MatchState.FINISHED;

    const ticks = Math.round((getGrenadeConfig().fuseMs / 1000 + 0.2) / FIXED_DELTA);
    for (let i = 0; i < ticks; i++) {
      clock.now = i * FIXED_DELTA * 1000;
      harness.stepGrenades(FIXED_DELTA, clock.now);
    }

    assert.equal(bystander.health, MAX_HEALTH, "a blast after the match hurts nobody");
  });
});

describe("grenade configuration", () => {
  it("can be switched off entirely", () => {
    const config = cloneConfig();
    config.grenades = { ...config.grenades, enabled: false };
    loadGameConfig(config);

    try {
      const harness = createHarness();
      const player = harness.addPlayer("p1", 600, 1700);
      harness.grenades.resupply(player);

      assert.equal(player.grenades, 0, "no grenades are issued");

      player.grenades = 3;
      throwGrenade(harness, "p1", 500);
      assert.equal(harness.state.grenades.size, 0, "and none can be thrown");
    } finally {
      resetGameConfig();
    }
  });

  it("honours a retuned throw curve", () => {
    const config = cloneConfig();
    config.grenades = {
      ...config.grenades,
      minThrowSpeed: 100,
      maxThrowSpeed: 200,
      maxChargeMs: 1000,
    };
    loadGameConfig(config);

    try {
      const harness = createHarness();
      const player = harness.addPlayer("p1", 600, 1700);
      harness.grenades.grant(player, 5);

      const half = throwGrenade(harness, "p1", 500)!;
      const speed = Math.hypot(half.velocityX, half.velocityY);

      assert.ok(Math.abs(speed - 150) < 1, `half charge should be halfway, got ${speed}`);
    } finally {
      resetGameConfig();
    }
  });
});
