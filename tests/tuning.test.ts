/**
 * The campaign tuning hierarchy, and the generic knobs it turns.
 *
 * Two halves. The resolver is pure arithmetic: five layers multiply, absolutes
 * override, nothing reaches zero. The knobs are per-combatant scalars on the
 * runtime that the weapon, projectile and grenade systems consult -- and the
 * most important assertion here is the multiplayer one: everybody defaults to
 * exactly 1, so nothing in a deathmatch moved because the campaign got slower.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  ASSAULT_RIFLE_ID,
  getFireIntervalMs,
  getWeapon,
  resolveEnemyTuning,
  resolveEnvironmentTuning,
} from "@deathmatch/shared";
import { createHarness, fireAt, type Harness } from "./harness.js";

describe("tuning: the resolver", () => {
  it("multiplies every layer into the final value", () => {
    const resolved = resolveEnemyTuning({
      campaign: { moveSpeed: 0.9, projectileSpeed: 0.8, fireRate: 0.9, reactionTime: 1.2 },
      difficulty: { moveSpeed: 0.95, projectileSpeed: 0.9, fireRate: 0.95, reactionTime: 1.1 },
      level: { moveSpeed: 0.85, projectileSpeed: 0.8, fireRate: 0.9, reactionTime: 1.15 },
      type: { moveSpeed: 0.9 },
      instance: { projectileSpeed: 1.5 },
    });
    assert.ok(Math.abs(resolved.moveSpeedMultiplier - 0.9 * 0.95 * 0.85 * 0.9) < 1e-9);
    assert.ok(Math.abs(resolved.projectileSpeedMultiplier - 0.8 * 0.9 * 0.8 * 1.5) < 1e-9);
    assert.ok(Math.abs(resolved.fireRateMultiplier - 0.9 * 0.95 * 0.9) < 1e-9);
    assert.ok(Math.abs(resolved.reactionTimeMultiplier - 1.2 * 1.1 * 1.15) < 1e-9);
  });

  it("treats a missing layer as x1 and resolves nothing at all to 1", () => {
    const resolved = resolveEnemyTuning({});
    assert.equal(resolved.moveSpeedMultiplier, 1);
    assert.equal(resolved.projectileSpeedMultiplier, 1);
    assert.equal(resolved.fireRateMultiplier, 1);
    assert.equal(resolved.reactionTimeMultiplier, 1);
    assert.equal(resolved.detectionRange, null);
  });

  it("never lets a multiplier reach zero", () => {
    const resolved = resolveEnemyTuning({ level: { moveSpeed: 0 }, type: { fireRate: -3 } });
    assert.ok(resolved.moveSpeedMultiplier > 0, "a frozen enemy is a content bug, not a value");
    assert.ok(resolved.fireRateMultiplier > 0);
  });

  it("detection range: the instance overrides the type, absolutely", () => {
    assert.equal(resolveEnemyTuning({ type: { detectionRange: 1600 } }).detectionRange, 1600);
    assert.equal(
      resolveEnemyTuning({ type: { detectionRange: 1600 }, instance: { detectionRange: 400 } }).detectionRange,
      400,
    );
  });

  it("the environment product carries no type layer, for boss phases", () => {
    const environment = resolveEnvironmentTuning({
      campaign: { moveSpeed: 0.9 },
      level: { moveSpeed: 0.85 },
    });
    assert.ok(Math.abs(environment.moveSpeedMultiplier - 0.9 * 0.85) < 1e-9);
  });
});

describe("tuning: the generic per-combatant knobs", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("multiplayer combatants default to exactly 1 on every knob", () => {
    harness.addPlayer("someone", 200, 1700);
    const runtime = harness.runtimes.get("someone")!;
    assert.equal(runtime.fireRateMultiplier, 1);
    assert.equal(runtime.projectileSpeedMultiplier, 1);
    assert.equal(runtime.baseSpeedMultiplier, 1);
  });

  it("a lowered fire-rate multiplier stretches the interval between shots", () => {
    harness.addPlayer("shooter", 200, 1700);
    const runtime = harness.runtimes.get("shooter")!;
    runtime.fireRateMultiplier = 0.5;

    const weapon = getWeapon(ASSAULT_RIFLE_ID);
    const interval = getFireIntervalMs(weapon);

    fireAt(harness, "shooter", 0, 1000);
    assert.equal(harness.state.projectiles.size, 1, "the first shot fires");

    // One base interval later: too soon at half rate.
    fireAt(harness, "shooter", 0, 1000 + interval + 1);
    assert.equal(harness.state.projectiles.size, 1, "half rate refuses the old cadence");

    // Two base intervals later: due.
    fireAt(harness, "shooter", 0, 1000 + interval * 2 + 1);
    assert.equal(harness.state.projectiles.size, 2, "the doubled interval fires");
  });

  it("a lowered projectile-speed multiplier slows the bullet but not its reach", () => {
    harness.addPlayer("slow", 200, 1700);
    harness.addPlayer("plain", 200, 1900);
    harness.runtimes.get("slow")!.projectileSpeedMultiplier = 0.5;

    fireAt(harness, "slow", 0, 0);
    fireAt(harness, "plain", 0, 0);

    const speeds = new Map<string, number>();
    for (const projectile of harness.state.projectiles.values()) {
      speeds.set(projectile.ownerId, Math.hypot(projectile.velocityX, projectile.velocityY));
    }
    const weapon = getWeapon(ASSAULT_RIFLE_ID);
    const base = weapon.ranged!.bulletSpeed;
    assert.ok(Math.abs(speeds.get("plain")! - base) < 1e-6, "an untouched shooter fires at the listed speed");
    assert.ok(Math.abs(speeds.get("slow")! - base * 0.5) < 1e-6, "the slowed shooter fires at half of it");
  });

  it("a slowed bullet arrives late, but arrives", () => {
    // The same open 400px corridor the combat suite shoots along.
    harness.addPlayer("slow", 200, 1700);
    harness.addPlayer("target", 600, 1700);
    harness.runtimes.get("slow")!.projectileSpeedMultiplier = 0.5;

    fireAt(harness, "slow", 0, 0);
    // A full-speed round crosses this corridor in under 300ms; at half speed
    // it must NOT have landed yet by then...
    harness.step(18);
    assert.equal(harness.damage.length, 0, "half speed has not crossed yet");
    // ...and must still land, because the lifetime stretches with the speed.
    harness.step(42);
    assert.equal(harness.damage.length, 1, "the slowed shot still lands");
  });
});
