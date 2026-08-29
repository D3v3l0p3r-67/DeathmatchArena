/**
 * The campaign's simulation: the multiplayer server's own systems, run
 * locally.
 *
 * This is deliberately not a second engine. Movement, weapons, projectiles,
 * grenades, damage, power-ups, traps and the NPC brains are the exact classes
 * the server rooms run -- imported from `server/src` and wired against a local
 * `RoomContext`, the same way the test harness wires them in Node. Single
 * player differs only in *where* the truth lives: here, in this tab, at 60Hz,
 * with no server in the loop.
 *
 * Nothing per-frame ever leaves the machine. The optional campaign sync layer
 * (see `core/SaveStore.ts`) ships rare, high-level events; this class has no
 * network at all.
 */
import {
  FIXED_DELTA,
  MatchState,
  applyKnockback,
  cloneConfig,
  createGameConfigView,
  createInputCommand,
  createMovementState,
  findFreeSpawnPosition,
  getGameConfig,
  getCampaignDifficulty,
  getPowerUp,
  CollisionWorld,
  MAX_BOT_DIFFICULTY,
  MIN_BOT_DIFFICULTY,
  clamp,
  type ArenaDefinition,
  type CampaignDifficultyId,
  type CampaignEnemyDefinition,
  type GameConfig,
  type GameConfigView,
  type InputCommand,
} from "@deathmatch/shared";
import { GameState } from "../../../../server/src/rooms/schema/GameState.js";
import { PlayerState } from "../../../../server/src/rooms/schema/PlayerState.js";
import { PlayerRuntime } from "../../../../server/src/rooms/PlayerRuntime.js";
import type { RoomContext } from "../../../../server/src/rooms/RoomContext.js";
import { CollisionSystem } from "../../../../server/src/systems/CollisionSystem.js";
import { ProjectileSystem } from "../../../../server/src/systems/ProjectileSystem.js";
import { WeaponSystem } from "../../../../server/src/systems/WeaponSystem.js";
import { PowerUpSystem } from "../../../../server/src/systems/PowerUpSystem.js";
import { MatchManager } from "../../../../server/src/systems/MatchManager.js";
import { ArenaShrinkSystem } from "../../../../server/src/systems/ArenaShrinkSystem.js";
import { GrenadeSystem } from "../../../../server/src/systems/GrenadeSystem.js";
import { TrapSystem } from "../../../../server/src/systems/TrapSystem.js";
import { MovementSystem } from "../../../../server/src/systems/MovementSystem.js";
import { NpcSystem } from "../../../../server/src/npc/NpcSystem.js";
import type { NpcAgent } from "../../../../server/src/npc/NpcAgent.js";
import { Emitter } from "../../core/Emitter.js";

export const LOCAL_PLAYER_ID = "player";

/** Broadcasts the simulation makes, re-emitted verbatim under their wire names. */
export interface LocalMatchEvents {
  [type: string]: unknown;
}

export interface LocalMatchOptions {
  /** Deterministic runs for tests; wall-clock behaviour in the browser. */
  seed?: number;
  now?: () => number;
}

/** Everything a spawned campaign enemy needs beyond what NpcSystem gives it. */
export interface EnemySpawnRequest {
  definition: CampaignEnemyDefinition;
  x: number;
  y: number;
  difficulty: CampaignDifficultyId;
  /** Display name override; the type's name otherwise. */
  name?: string;
  /** Health override, already difficulty-scaled by the caller when set. */
  health?: number;
}

/** Build the configuration a campaign match plays under. */
export function buildCampaignConfig(): GameConfig {
  const config = cloneConfig(getGameConfig());
  // The closing walls are a multiplayer clock; a level has a finish line.
  config.arenaShrink.enabled = false;
  // Crates are level furniture here, placed deliberately -- never on a timer.
  config.powerUpSpawning.intervalMs = 0;
  config.powerUpSpawning.firstSpawnDelayMs = 0;
  // Placed crates should outlive the whole level, not a multiplayer minute.
  config.crate.lifetimeMs = 0;
  // A campaign level holds far more enemies than a lobby holds players.
  config.match.maxPlayers = 64;
  config.npc.enabled = true;
  return config;
}

export class LocalMatch {
  readonly state = new GameState();
  readonly events = new Emitter<LocalMatchEvents>();
  readonly world: CollisionWorld;
  readonly runtimes = new Map<string, PlayerRuntime>();

  readonly movement: MovementSystem;
  readonly weapons: WeaponSystem;
  readonly projectiles: ProjectileSystem;
  readonly powerUps: PowerUpSystem;
  readonly grenades: GrenadeSystem;
  readonly traps: TrapSystem;
  readonly npcs: NpcSystem;
  readonly matchManager: MatchManager;

  /** Debug: the local player shrugs everything off while set. */
  godMode = false;

  private readonly configView: GameConfigView;
  private readonly clock: () => number;
  private accumulatorMs = 0;
  private inputSeq = 0;
  private rngState: number;

  constructor(
    readonly arena: ArenaDefinition,
    options: LocalMatchOptions = {},
  ) {
    this.clock = options.now ?? (() => performance.now());
    this.rngState = (options.seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0;
    this.configView = createGameConfigView(buildCampaignConfig());
    this.world = new CollisionWorld(arena);
    this.state.matchState = MatchState.PLAYING;
    this.state.shrinkLeft = 0;
    this.state.shrinkRight = arena.width;

    const context = this.buildContext();
    const collision = new CollisionSystem(this.world);
    this.projectiles = new ProjectileSystem(context, collision);
    this.weapons = new WeaponSystem(context, this.projectiles, collision);
    const arenaShrink = new ArenaShrinkSystem(context);
    this.grenades = new GrenadeSystem(context, () => arenaShrink.bounds);
    this.powerUps = new PowerUpSystem(context, this.weapons, this.grenades);
    this.traps = new TrapSystem(context);
    this.matchManager = new MatchManager(
      context,
      this.weapons,
      this.projectiles,
      this.powerUps,
      arenaShrink,
      this.grenades,
      this.traps,
    );
    this.movement = new MovementSystem(context, this.world, this.weapons, this.grenades, () => arenaShrink.bounds);
    this.npcs = new NpcSystem(context, this.movement, this.rngState);
    this.matchManager.setNpcSystem(this.npcs);
    arenaShrink.reset();
    this.traps.load(arena);
  }

  get config(): GameConfigView {
    return this.configView;
  }

  now(): number {
    return this.clock();
  }

  // -------------------------------------------------------------------------
  // Population
  // -------------------------------------------------------------------------

  /** Put the one human into the world. */
  addLocalPlayer(name: string, x: number, y: number, weaponId: string, grenadeCount: number): PlayerState {
    const player = new PlayerState();
    player.sessionId = LOCAL_PLAYER_ID;
    player.name = name;
    player.connected = true;
    this.state.players.set(LOCAL_PLAYER_ID, player);
    this.runtimes.set(LOCAL_PLAYER_ID, new PlayerRuntime(this.now()));
    this.placeIntoWorld(player, x, y, weaponId);
    player.grenades = grenadeCount;
    this.state.hostId = LOCAL_PLAYER_ID;
    return player;
  }

  /**
   * Bring the player back at a checkpoint: alive, healed, re-armed, and with
   * the physics state reset so the respawn is a placement, not a journey.
   */
  respawnLocalPlayer(x: number, y: number, weaponId: string, grenadeCount: number): void {
    const player = this.state.players.get(LOCAL_PLAYER_ID);
    const runtime = this.runtimes.get(LOCAL_PLAYER_ID);
    if (!player || !runtime) return;
    this.placeIntoWorld(player, x, y, weaponId);
    player.grenades = grenadeCount;
  }

  /**
   * Spawn one campaign enemy: an ordinary NPC from the shared brain, then
   * shaped by its type -- loadout, health, pace, stance, sight, name and rank.
   */
  spawnEnemy(request: EnemySpawnRequest): NpcAgent | null {
    const { definition } = request;
    const shift = getCampaignDifficulty(request.difficulty).skillShift;
    const skill = clamp(definition.skill + shift, MIN_BOT_DIFFICULTY, MAX_BOT_DIFFICULTY);

    const agent = this.npcs.spawn(definition.profile, skill);
    if (!agent) return null;

    const player = this.state.players.get(agent.sessionId);
    const runtime = this.runtimes.get(agent.sessionId);
    if (!player || !runtime) return null;

    player.name = request.name ?? definition.name;
    this.placeIntoWorld(player, request.x, request.y, definition.weapon);

    const healthScale = getCampaignDifficulty(request.difficulty).enemyHealthScale;
    player.health = request.health ?? Math.round(definition.health * healthScale);
    player.grenades = definition.grenades;

    runtime.baseSpeedMultiplier = Math.max(0, definition.speed);
    runtime.movement.speedMultiplier = runtime.baseSpeedMultiplier;
    player.speedMultiplier = runtime.baseSpeedMultiplier;

    // The figure's size is simulation state, not a drawing detail: it decides
    // what a shot can hit as well as what the scene draws.
    player.bodyScale = definition.bodyScale ?? 1;

    agent.stationary = definition.stationary === true;
    agent.sightRangeOverride = definition.detectionRange ?? null;
    return agent;
  }

  /** Remove one enemy outright -- despawned corpses, debug clears, resets. */
  removeEnemy(sessionId: string): void {
    this.npcs.remove(sessionId);
  }

  /** Every live enemy, for sweeps and resets. */
  aliveEnemies(): PlayerState[] {
    const players: PlayerState[] = [];
    for (const agent of this.npcs.list()) {
      const player = this.state.players.get(agent.sessionId);
      if (player?.alive) players.push(player);
    }
    return players;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /** Queue one tick of the local player's buttons. */
  applyInput(input: Omit<InputCommand, "seq">): void {
    const runtime = this.runtimes.get(LOCAL_PLAYER_ID);
    if (!runtime) return;
    const command = createInputCommand();
    Object.assign(command, input);
    command.seq = ++this.inputSeq;
    this.movement.enqueue(runtime, command);
  }

  /**
   * Advance the world by real elapsed time, in fixed 60Hz steps -- the same
   * accumulator loop, in the same system order, as the server room's tick.
   *
   * `onStep` runs once per fixed step, before the systems: the scene queues
   * the player's buttons there, so a slow frame that simulates several ticks
   * still walks at full speed instead of starving the input queue.
   */
  step(deltaMs: number, onStep?: () => void): void {
    const maxSteps = 8;
    this.accumulatorMs += Math.min(deltaMs, (1000 / 60) * maxSteps);
    let steps = 0;
    while (this.accumulatorMs >= 1000 / 60 && steps < maxSteps) {
      this.accumulatorMs -= 1000 / 60;
      steps++;
      onStep?.();
      const now = this.now();
      this.npcs.update(FIXED_DELTA, now);
      this.movement.update(FIXED_DELTA, now);
      this.projectiles.update(FIXED_DELTA, now);
      this.powerUps.update(now);
      this.traps.update(FIXED_DELTA, now);
      this.grenades.update(FIXED_DELTA, now);
    }
    if (steps === maxSteps) this.accumulatorMs = 0;
  }

  /** Place a level crate on a named arena spawn point. */
  spawnCrateAt(spawnPointId: string, powerUpId: string | null): string | null {
    const index = this.arena.powerUpSpawns.filter((point) => point.enabled).findIndex((point) => point.id === spawnPointId);
    if (index === -1) return null;
    const contents = powerUpId ? getPowerUp(powerUpId) : null;
    return this.powerUps.spawnCrateAt(index, contents ?? null, this.now());
  }

  /** Destroy a crate outright, as a scripted breach does. */
  destroyCrate(crateId: string): void {
    const crate = this.state.crates.get(crateId);
    if (!crate) return;
    this.powerUps.damageCrate(crateId, crate.health + 1000, "", this.now(), 0);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** The shared spawn recipe: position, physics reset, loadout. */
  private placeIntoWorld(player: PlayerState, x: number, y: number, weaponId: string): void {
    const runtime = this.runtimes.get(player.sessionId);
    if (!runtime) return;
    const playerConfig = this.configView.getPlayerConfig();
    const position = findFreeSpawnPosition(this.world, x, y);

    runtime.resetForMatch(this.now());
    Object.assign(runtime.movement, createMovementState(position.x, position.y, playerConfig.maxJumps));
    runtime.movement.speedMultiplier = runtime.baseSpeedMultiplier;

    player.x = position.x;
    player.y = position.y;
    player.spawnX = Math.round(position.x);
    player.spawnY = Math.round(position.y);
    player.velocityX = 0;
    player.velocityY = 0;
    player.onGround = false;
    player.facing = 1;
    player.aimAngle = 0;
    player.health = playerConfig.maxHealth;
    player.alive = true;
    player.inMatch = true;
    player.lastProcessedInput = 0;
    this.weapons.equip(player, runtime, weaponId);
    this.grenades.resupply(player);
  }

  private random(): number {
    // Mulberry32: deterministic under a seed, cheap, good enough for spread.
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private buildContext(): RoomContext {
    const silent = { debug() {}, info() {}, warn() {}, error() {} };
    const logger = { ...silent, child: () => logger } as RoomContext["logger"];
    // Arrow functions close over `this` lexically, so the two live getters
    // below need no alias of it -- they read the field at call time either way.
    const configView = () => this.configView;

    return {
      state: this.state,
      arena: this.arena,
      world: this.world,
      logger,
      runtimes: this.runtimes,
      roomId: "campaign",
      get config() {
        return configView();
      },
      get baselineConfig() {
        return configView().config;
      },
      now: () => this.now(),
      random: () => this.random(),
      broadcast: (type, payload) => this.events.emit(type, payload),
      sendTo: () => {},
      setLocked: () => {},
      applyDamage: (victimId, attackerId, amount, x, y, weaponId, source) => {
        if (this.godMode && victimId === LOCAL_PLAYER_ID) return;
        this.matchManager.applyDamage(victimId, attackerId, amount, x, y, weaponId, source);
      },
      applyKnockback: (sessionId, directionX, directionY, force, lift = true) => {
        const runtime = this.runtimes.get(sessionId);
        const player = this.state.players.get(sessionId);
        if (!runtime || !player?.alive || !player.inMatch) return;
        const playerConfig = this.configView.getPlayerConfig();
        applyKnockback(
          runtime.movement,
          directionX,
          directionY,
          force,
          playerConfig,
          lift ? playerConfig.knockbackLift : 0,
        );
        player.velocityX = runtime.movement.velocityX;
        player.velocityY = runtime.movement.velocityY;
        player.onGround = runtime.movement.onGround;
        player.knockbackTimer = runtime.movement.knockbackTimer;
      },
      damageCrate: (crateId, amount, attackerId, now, impulseX) => {
        this.powerUps.damageCrate(crateId, amount, attackerId, now, impulseX);
      },
      rotateArena: () => {},
      recordCareers: () => {},
      careerUpdateFor: () => "",
    } as RoomContext;
  }
}
