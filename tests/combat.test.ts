/**
 * Deterministic coverage of the server-authoritative combat path:
 * weapon validation -> projectile spawn -> swept collision -> damage.
 *
 * These drive the real systems against a stub room context, so hits are exercised
 * from exact positions instead of relying on where matchmaking happens to spawn
 * players.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

process.env.VERBOSE_LOGGING = "false";

import {
  CollisionWorld,
  FIXED_DELTA,
  MatchState,
  PLAYER,
  ServerMessage,
  createInputCommand,
  getArena,
  getFireIntervalMs,
  getWeapon,
  type ArenaDefinition,
  type KillPayload,
} from "@deathmatch/shared";

const { PlayerState } = await import("../server/src/rooms/schema/PlayerState.js");
const { GameState } = await import("../server/src/rooms/schema/GameState.js");
const { PlayerRuntime } = await import("../server/src/rooms/PlayerRuntime.js");
const { CollisionSystem } = await import("../server/src/systems/CollisionSystem.js");
const { ProjectileSystem } = await import("../server/src/systems/ProjectileSystem.js");
const { WeaponSystem } = await import("../server/src/systems/WeaponSystem.js");
const { MatchManager } = await import("../server/src/systems/MatchManager.js");

type RoomContext = import("../server/src/rooms/RoomContext.js").RoomContext;

interface BroadcastRecord {
  type: string;
  payload: unknown;
}

interface DamageRecord {
  victimId: string;
  attackerId: string;
  amount: number;
  x: number;
  y: number;
}

interface Harness {
  context: RoomContext;
  state: InstanceType<typeof GameState>;
  collision: InstanceType<typeof CollisionSystem>;
  projectiles: InstanceType<typeof ProjectileSystem>;
  weapons: InstanceType<typeof WeaponSystem>;
  matchManager: InstanceType<typeof MatchManager>;
  runtimes: Map<string, InstanceType<typeof PlayerRuntime>>;
  damage: DamageRecord[];
  broadcasts: BroadcastRecord[];
  addPlayer(sessionId: string, x: number, y: number): InstanceType<typeof PlayerState>;
  /** Advance the projectile simulation by `steps` fixed ticks. */
  step(steps: number, startTime?: number): void;
}

const arena: ArenaDefinition = getArena("foundry");
const world = new CollisionWorld(arena);

function createHarness(): Harness {
  const state = new GameState();
  state.matchState = MatchState.PLAYING;
  const runtimes = new Map<string, InstanceType<typeof PlayerRuntime>>();
  const damage: DamageRecord[] = [];
  const broadcasts: BroadcastRecord[] = [];

  const context = {
    state,
    arena,
    world,
    logger: { debug() {}, info() {}, warn() {}, error() {}, child: () => context.logger },
    runtimes,
    now: () => 0,
    // Fixed 0.5 keeps weapon spread at exactly zero deviation, so aim is exact.
    random: () => 0.5,
    broadcast(type: string, payload: unknown) {
      broadcasts.push({ type, payload });
    },
    sendTo() {},
    setLocked() {},
    // Damage resolution is the real thing, so a lethal hit runs the actual
    // elimination path rather than a stub that only subtracts health.
    applyDamage(victimId: string, attackerId: string, amount: number, x: number, y: number, weaponId: string) {
      damage.push({ victimId, attackerId, amount, x, y });
      matchManager.applyDamage(victimId, attackerId, amount, x, y, weaponId);
    },
  } as unknown as RoomContext;

  const collision = new CollisionSystem(world);
  const projectiles = new ProjectileSystem(context, collision);
  const weapons = new WeaponSystem(context, projectiles);
  const matchManager = new MatchManager(context, weapons, projectiles);

  return {
    context,
    state,
    collision,
    projectiles,
    weapons,
    matchManager,
    runtimes,
    damage,
    broadcasts,
    addPlayer(sessionId, x, y) {
      const player = new PlayerState();
      player.sessionId = sessionId;
      player.name = sessionId;
      player.x = x;
      player.y = y;
      player.alive = true;
      player.inMatch = true;
      player.health = PLAYER.MAX_HEALTH;
      state.players.set(sessionId, player);

      const runtime = new PlayerRuntime(0);
      runtimes.set(sessionId, runtime);
      weapons.equip(player, runtime);
      return player;
    },
    step(steps, startTime = 0) {
      for (let i = 0; i < steps; i++) {
        projectiles.update(FIXED_DELTA, startTime + i * FIXED_DELTA * 1000);
      }
    },
  };
}

/** Fire once, bypassing the input plumbing. */
function fireAt(harness: Harness, shooterId: string, angle: number, now: number): void {
  const player = harness.state.players.get(shooterId)!;
  const runtime = harness.runtimes.get(shooterId)!;
  const input = createInputCommand(1);
  input.fire = true;
  input.aimAngle = angle;
  harness.weapons.processInput(player, runtime, input, now);
}

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
    const hypersonic = { ...getWeapon("assault_rifle"), id: "test_railgun", bulletSpeed: 20000 };
    const perTick = hypersonic.bulletSpeed * FIXED_DELTA;
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
