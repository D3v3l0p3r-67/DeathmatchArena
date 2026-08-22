/**
 * A room-shaped test harness for the server's gameplay systems.
 *
 * The real `CollisionSystem`, `ProjectileSystem`, `WeaponSystem`, `PowerUpSystem`
 * and `MatchManager` are wired against a stub `RoomContext`, so tests exercise
 * production code paths from exact positions rather than relying on where
 * matchmaking happens to place players.
 *
 * Two things are deliberately deterministic: `random()` is fixed, so weapon
 * spread is exactly zero and spawn choices are reproducible, and `now()` is
 * supplied by the caller rather than read from the clock.
 */
process.env.VERBOSE_LOGGING = "false";

import {
  CollisionWorld,
  FIXED_DELTA,
  MatchState,
  createGameConfigView,
  createInputCommand,
  getArena,
  getGameConfig,
  type ArenaDefinition,
  type GameConfig,
  type GameConfigView,
} from "@deathmatch/shared";

const { PlayerState } = await import("../server/src/rooms/schema/PlayerState.js");
const { GameState } = await import("../server/src/rooms/schema/GameState.js");
const { PlayerRuntime } = await import("../server/src/rooms/PlayerRuntime.js");
const { CollisionSystem } = await import("../server/src/systems/CollisionSystem.js");
const { ProjectileSystem } = await import("../server/src/systems/ProjectileSystem.js");
const { WeaponSystem } = await import("../server/src/systems/WeaponSystem.js");
const { PowerUpSystem } = await import("../server/src/systems/PowerUpSystem.js");
const { MatchManager } = await import("../server/src/systems/MatchManager.js");
const { ArenaShrinkSystem } = await import("../server/src/systems/ArenaShrinkSystem.js");
const { GrenadeSystem } = await import("../server/src/systems/GrenadeSystem.js");
const { TrapSystem } = await import("../server/src/systems/TrapSystem.js");

type RoomContext = import("../server/src/rooms/RoomContext.js").RoomContext;

export interface BroadcastRecord {
  type: string;
  payload: unknown;
}

export interface DamageRecord {
  victimId: string;
  attackerId: string;
  amount: number;
  x: number;
  y: number;
}

export interface Harness {
  context: RoomContext;
  state: InstanceType<typeof GameState>;
  collision: InstanceType<typeof CollisionSystem>;
  projectiles: InstanceType<typeof ProjectileSystem>;
  weapons: InstanceType<typeof WeaponSystem>;
  powerUps: InstanceType<typeof PowerUpSystem>;
  arenaShrink: InstanceType<typeof ArenaShrinkSystem>;
  grenades: InstanceType<typeof GrenadeSystem>;
  traps: InstanceType<typeof TrapSystem>;
  matchManager: InstanceType<typeof MatchManager>;
  runtimes: Map<string, InstanceType<typeof PlayerRuntime>>;
  damage: DamageRecord[];
  broadcasts: BroadcastRecord[];
  addPlayer(sessionId: string, x: number, y: number): InstanceType<typeof PlayerState>;
  /** Advance the projectile simulation by `steps` fixed ticks. */
  step(steps: number, startTime?: number): void;
  /** Advance the power-up system (crate spawning, pickups, effect expiry). */
  stepPowerUps(now: number): void;
  /** Advance the closing walls by `dt` seconds. */
  stepArenaShrink(dt: number, now: number): void;
  /** Advance grenades in flight by `dt` seconds. */
  stepGrenades(dt: number, now: number): void;
  /** Advance the arena's traps by `dt` seconds. */
  stepTraps(dt: number, now: number): void;
  /** Rebuild the trap simulation from an arena, e.g. one built for a test. */
  loadTraps(definition: ArenaDefinition): void;
  arena: ArenaDefinition;
  /** Swap the room's configuration, as a debug command would. */
  replaceConfig(config: GameConfig): void;
}

const arena: ArenaDefinition = getArena("foundry");
const world = new CollisionWorld(arena);

/** Mutable stand-in for the wall clock, so tests control every deadline. */
export const clock = { now: 0 };

export function createHarness(): Harness {
  const state = new GameState();
  state.matchState = MatchState.PLAYING;

  const baseline = getGameConfig();
  let configView: GameConfigView = createGameConfigView(baseline);
  const runtimes = new Map<string, InstanceType<typeof PlayerRuntime>>();
  const damage: DamageRecord[] = [];
  const broadcasts: BroadcastRecord[] = [];

  const context = {
    state,
    arena,
    world,
    logger: { debug() {}, info() {}, warn() {}, error() {}, child: () => context.logger },
    runtimes,
    roomId: "test-room",
    // Room-scoped, exactly as in a real room: a test may retune its own config
    // without leaking into the process-wide values.
    get config() {
      return configView;
    },
    get baselineConfig() {
      return baseline;
    },
    now: () => clock.now,
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
    damageCrate(crateId: string, amount: number, attackerId: string, now: number) {
      powerUps.damageCrate(crateId, amount, attackerId, now);
    },
  } as unknown as RoomContext;

  const collision = new CollisionSystem(world);
  const projectiles = new ProjectileSystem(context, collision);
  const weapons = new WeaponSystem(context, projectiles, collision);
  const arenaShrink = new ArenaShrinkSystem(context);
  const grenadeSystem = new GrenadeSystem(context, () => arenaShrink.bounds);
  const powerUps = new PowerUpSystem(context, weapons, grenadeSystem);
  const trapSystem = new TrapSystem(context);
  const matchManager = new MatchManager(
    context,
    weapons,
    projectiles,
    powerUps,
    arenaShrink,
    grenadeSystem,
    trapSystem,
  );
  arenaShrink.reset();

  return {
    context,
    state,
    collision,
    projectiles,
    weapons,
    powerUps,
    arenaShrink,
    grenades: grenadeSystem,
    traps: trapSystem,
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
      player.health = configView.getPlayerConfig().maxHealth;
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
    stepPowerUps(now) {
      powerUps.update(now);
    },
    stepArenaShrink(dt, now) {
      arenaShrink.update(dt, now);
    },
    stepGrenades(dt, now) {
      grenadeSystem.update(dt, now);
    },
    stepTraps(dt, now) {
      trapSystem.update(dt, now);
    },
    loadTraps(definition) {
      trapSystem.load(definition);
    },
    arena,
    replaceConfig(config) {
      configView = createGameConfigView(config);
    },
  };
}

/** Fire once, bypassing the input plumbing. */
export function fireAt(harness: Harness, shooterId: string, angle: number, now: number): void {
  const player = harness.state.players.get(shooterId)!;
  const runtime = harness.runtimes.get(shooterId)!;
  const input = createInputCommand(1);
  input.fire = true;
  input.aimAngle = angle;
  harness.weapons.processInput(player, runtime, input, now);
}
