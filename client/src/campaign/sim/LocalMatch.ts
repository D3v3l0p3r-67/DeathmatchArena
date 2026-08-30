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
  PLAYER_HALF_HEIGHT,
  PLAYER_HALF_WIDTH,
  resolveEnemyTuning,
  resolveEnvironmentTuning,
  type CampaignEnemyInstanceTuning,
  type CampaignEnemyTuning,
  type EncounterBoundary,
  type ResolvedEnemyTuning,
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
import type { ProjectileSystem } from "../../../../server/src/systems/ProjectileSystem.js";
import type { WeaponSystem } from "../../../../server/src/systems/WeaponSystem.js";
import type { PowerUpSystem } from "../../../../server/src/systems/PowerUpSystem.js";
import type { MatchManager } from "../../../../server/src/systems/MatchManager.js";
import type { GrenadeSystem } from "../../../../server/src/systems/GrenadeSystem.js";
import type { TrapSystem } from "../../../../server/src/systems/TrapSystem.js";
import type { MovementSystem } from "../../../../server/src/systems/MovementSystem.js";
import type { NpcSystem } from "../../../../server/src/npc/NpcSystem.js";
import { createSimulation } from "../../../../server/src/systems/createSimulation.js";
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
  /** Instance-layer tuning from the placed spawn; the last word in the hierarchy. */
  tuning?: CampaignEnemyInstanceTuning;
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

  /** The level layer of the enemy-tuning hierarchy; the director sets it. */
  private levelEnemyTuning: CampaignEnemyTuning | null = null;

  /**
   * Walls raised around a locked encounter; null when nothing is locked.
   * Enforced after every physics step, so it is a fact of the world rather
   * than a filter on the input -- knockback cannot shove anyone through it
   * either.
   */
  private boundary: EncounterBoundary | null = null;

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
    const simulation = createSimulation(context, { seed: this.rngState });
    this.projectiles = simulation.projectiles;
    this.weapons = simulation.weapons;
    this.grenades = simulation.grenades;
    this.powerUps = simulation.powerUps;
    this.traps = simulation.traps;
    this.matchManager = simulation.matchManager;
    this.movement = simulation.movement;
    this.npcs = simulation.npcs;
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
    // Full health, for this enemy: what its bar divides by and what its own
    // brain measures itself against.
    player.maxHealth = Math.round(definition.health * healthScale);
    player.grenades = definition.grenades;

    /*
     * The whole tuning hierarchy, resolved once and applied to the generic
     * per-combatant knobs. The systems that read these knobs know nothing of
     * campaigns, levels or difficulties -- they see a combatant with a pace.
     */
    const tuning = this.resolveTuning(request.difficulty, definition, request.tuning);
    runtime.baseSpeedMultiplier = tuning.moveSpeedMultiplier;
    runtime.movement.speedMultiplier = runtime.baseSpeedMultiplier;
    player.speedMultiplier = runtime.baseSpeedMultiplier;
    runtime.fireRateMultiplier = tuning.fireRateMultiplier;
    runtime.projectileSpeedMultiplier = tuning.projectileSpeedMultiplier;
    agent.reactionTimeScale = tuning.reactionTimeMultiplier;
    agent.sightRangeOverride = tuning.detectionRange;

    // The figure's size is simulation state, not a drawing detail: it decides
    // what a shot can hit as well as what the scene draws.
    player.bodyScale = definition.bodyScale ?? 1;

    agent.stationary = definition.stationary === true;
    return agent;
  }

  /** The director hands over the level's tuning layer when a level starts. */
  setLevelEnemyTuning(tuning: CampaignEnemyTuning | null): void {
    this.levelEnemyTuning = tuning;
  }

  /** Every layer of the hierarchy, for one enemy. */
  private resolveTuning(
    difficulty: CampaignDifficultyId,
    definition: CampaignEnemyDefinition,
    instance?: CampaignEnemyInstanceTuning,
  ): ResolvedEnemyTuning {
    return resolveEnemyTuning({
      campaign: this.campaignModeTuning(),
      difficulty: getCampaignDifficulty(difficulty).enemyTuning,
      level: this.levelEnemyTuning ?? undefined,
      type: {
        moveSpeed: definition.speed,
        projectileSpeed: definition.projectileSpeed,
        fireRate: definition.fireRate,
        reactionTime: definition.reactionTime,
        detectionRange: definition.detectionRange,
      },
      instance,
    });
  }

  /**
   * The layers above the enemy type, for a caller that supplies its own type
   * value -- a boss phase writes its own speed, but must still respect the
   * campaign, difficulty and level layers or a slowed tutorial would hold a
   * full-speed boss.
   */
  environmentTuning(difficulty: CampaignDifficultyId): ResolvedEnemyTuning {
    return resolveEnvironmentTuning({
      campaign: this.campaignModeTuning(),
      difficulty: getCampaignDifficulty(difficulty).enemyTuning,
      level: this.levelEnemyTuning ?? undefined,
    });
  }

  private campaignModeTuning(): CampaignEnemyTuning {
    const config = this.configView.getCampaignModeConfig();
    return {
      moveSpeed: config.enemyMoveSpeedMultiplier,
      projectileSpeed: config.enemyProjectileSpeedMultiplier,
      fireRate: config.enemyFireRateMultiplier,
      reactionTime: config.enemyReactionTimeMultiplier,
    };
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
      this.enforceBoundary();
      this.projectiles.update(FIXED_DELTA, now);
      this.powerUps.update(now);
      this.traps.update(FIXED_DELTA, now);
      this.grenades.update(FIXED_DELTA, now);
    }
    if (steps === maxSteps) this.accumulatorMs = 0;
  }

  /** Raise or drop the walls around a locked encounter. */
  setBoundary(boundary: EncounterBoundary | null): void {
    this.boundary = boundary;
  }

  get activeBoundary(): EncounterBoundary | null {
    return this.boundary;
  }

  /**
   * Hold every restricted combatant inside the active boundary.
   *
   * A clamp on position after the physics step, not a filter on input: walking,
   * jumping, knockback and explosions all resolve first, and whatever ended up
   * past a blocking edge is placed back on it with the velocity into the wall
   * zeroed -- exactly how the arena's own edges behave. Movement inside the
   * area is untouched.
   */
  private enforceBoundary(): void {
    const boundary = this.boundary;
    if (!boundary) return;

    for (const player of this.state.players.values()) {
      if (!player.alive) continue;
      const isLocal = player.sessionId === LOCAL_PLAYER_ID;
      if (isLocal ? !boundary.restrictPlayer : !boundary.restrictEnemies) continue;

      const runtime = this.runtimes.get(player.sessionId);
      const minX = boundary.minX + PLAYER_HALF_WIDTH;
      const maxX = boundary.maxX - PLAYER_HALF_WIDTH;
      const minY = boundary.minY + PLAYER_HALF_HEIGHT;
      const maxY = boundary.maxY - PLAYER_HALF_HEIGHT;

      if (boundary.sides.left && player.x < minX) {
        player.x = minX;
        if (player.velocityX < 0) player.velocityX = 0;
        if (runtime && runtime.movement.velocityX < 0) runtime.movement.velocityX = 0;
        if (runtime) runtime.movement.x = player.x;
      }
      if (boundary.sides.right && player.x > maxX) {
        player.x = maxX;
        if (player.velocityX > 0) player.velocityX = 0;
        if (runtime && runtime.movement.velocityX > 0) runtime.movement.velocityX = 0;
        if (runtime) runtime.movement.x = player.x;
      }
      if (boundary.sides.top && player.y < minY) {
        player.y = minY;
        if (player.velocityY < 0) player.velocityY = 0;
        if (runtime && runtime.movement.velocityY < 0) runtime.movement.velocityY = 0;
        if (runtime) runtime.movement.y = player.y;
      }
      if (boundary.sides.bottom && player.y > maxY) {
        player.y = maxY;
        if (player.velocityY > 0) player.velocityY = 0;
        if (runtime && runtime.movement.velocityY > 0) runtime.movement.velocityY = 0;
        if (runtime) runtime.movement.y = player.y;
      }
    }
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
    player.maxHealth = playerConfig.maxHealth;
    player.health = player.maxHealth;
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
