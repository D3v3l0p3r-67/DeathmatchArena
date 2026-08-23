import { Client, Room } from "colyseus";
import {
  ClientMessage,
  DEFAULT_ARENA_ID,
  FIXED_DELTA,
  FIXED_DELTA_MS,
  MATCH,
  MatchState,
  NETWORK,
  ServerMessage,
  applyKnockback,
  createRandom,
  decodeInputBatch,
  generateFallbackName,
  createGameConfigView,
  getArena,
  getCollisionWorld,
  getGameConfig,
  CollisionWorld,
  isFiniteNumber,
  makeNameUnique,
  validatePlayerName,
  type ArenaDefinition,
  type ConfigChangedPayload,
  type GameConfig,
  type GameConfigView,
  type JoinOptions,
  type NoticePayload,
  type PingPayload,
  type PongPayload,
  type WelcomePayload,
} from "@deathmatch/shared";
import { serverConfig } from "../config.js";
import {
  ConfiguredDebugPolicy,
  DebugAuthorizationService,
} from "../debug/DebugAuthorizationService.js";
import { DebugCommandService } from "../debug/DebugCommandService.js";
import { DebugRegistry, type DebugCommandContext } from "../debug/DebugRegistry.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { ArenaShrinkSystem } from "../systems/ArenaShrinkSystem.js";
import { TrapSystem } from "../systems/TrapSystem.js";
import { NpcSystem } from "../npc/NpcSystem.js";
import { CollisionSystem } from "../systems/CollisionSystem.js";
import { GrenadeSystem } from "../systems/GrenadeSystem.js";
import { MatchManager } from "../systems/MatchManager.js";
import { MovementSystem } from "../systems/MovementSystem.js";
import { PowerUpSystem } from "../systems/PowerUpSystem.js";
import { ProjectileSystem } from "../systems/ProjectileSystem.js";
import { WeaponSystem } from "../systems/WeaponSystem.js";
import { PlayerRuntime } from "./PlayerRuntime.js";
import type { RoomContext } from "./RoomContext.js";
import { GameState } from "./schema/GameState.js";
import { PlayerState } from "./schema/PlayerState.js";

/** Guard against a stalled event loop turning into a burst of catch-up steps. */
const MAX_STEPS_PER_FRAME = 5;

/**
 * One match = one BattleRoom.
 *
 * The room owns the entire simulation. Clients send intent (`input`) and receive
 * state; they never assert position, health, hits, ammunition or the winner.
 *
 * Rooms are created on demand by matchmaking (`joinOrCreate`) and lock themselves
 * when a match starts, so arriving players are routed into a fresh room rather
 * than dropped into a game in progress.
 */
export class BattleRoom extends Room<{ state: GameState }> {
  // Read at construction, which is after the stored configuration has been
  // published -- so a room created after an administrator raises the limit is
  // actually created with the new one.
  override maxClients = getGameConfig().match.maxPlayers;

  override state = new GameState();

  private logger!: Logger;
  private arena!: ArenaDefinition;
  private world!: CollisionWorld;
  private context!: RoomContext;

  private collisionSystem!: CollisionSystem;
  private projectileSystem!: ProjectileSystem;
  private weaponSystem!: WeaponSystem;
  private powerUpSystem!: PowerUpSystem;
  private arenaShrinkSystem!: ArenaShrinkSystem;
  private trapSystem!: TrapSystem;
  private grenadeSystem!: GrenadeSystem;
  private movementSystem!: MovementSystem;
  private matchManager!: MatchManager;
  private npcSystem!: NpcSystem;

  private readonly runtimes = new Map<string, PlayerRuntime>();
  private readonly clientsBySession = new Map<string, Client>();

  /**
   * This room's configuration, and the server values it started from.
   *
   * Held per room so debug tooling can retune one match without touching any
   * other room or the process-wide configuration.
   */
  private configView!: GameConfigView;
  private baselineConfig!: GameConfig;

  private debugAuthorization!: DebugAuthorizationService;
  private debugCommands!: DebugCommandService;

  private accumulatorMs = 0;
  private random!: () => number;
  /** Next time the bots' thinking is pushed to whoever is watching it. */
  private nextNpcDebugAt = 0;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  override onCreate(options: Record<string, unknown> = {}): void {
    const arenaId = pickArenaId(options);
    this.arena = getArena(arenaId);
    this.world = getCollisionWorld(this.arena);
    this.logger = createLogger(`room:${this.roomId}`);
    this.random = createRandom(hashString(this.roomId) ^ Date.now());

    this.baselineConfig = getGameConfig();
    this.configView = createGameConfigView(this.baselineConfig);

    this.state.arenaId = this.arena.id;
    this.state.minPlayersToStart = this.configView.getMatchConfig().minPlayers;
    this.state.maxPlayers = this.configView.getMatchConfig().maxPlayers;

    this.context = this.createContext();
    this.collisionSystem = new CollisionSystem(this.world);
    this.projectileSystem = new ProjectileSystem(this.context, this.collisionSystem);
    this.weaponSystem = new WeaponSystem(this.context, this.projectileSystem, this.collisionSystem);
    this.arenaShrinkSystem = new ArenaShrinkSystem(this.context);
    this.trapSystem = new TrapSystem(this.context);
    this.grenadeSystem = new GrenadeSystem(this.context, () => this.arenaShrinkSystem.bounds);
    this.powerUpSystem = new PowerUpSystem(this.context, this.weaponSystem, this.grenadeSystem);
    this.movementSystem = new MovementSystem(
      this.context,
      this.world,
      this.weaponSystem,
      this.grenadeSystem,
      () => this.arenaShrinkSystem.bounds,
    );
    this.matchManager = new MatchManager(
      this.context,
      this.weaponSystem,
      this.projectileSystem,
      this.powerUpSystem,
      this.arenaShrinkSystem,
      this.grenadeSystem,
      this.trapSystem,
    );

    // Bots feed the movement system the same input commands a browser sends, so
    // they are created after it and go through no other door.
    this.npcSystem = new NpcSystem(this.context, this.movementSystem, hashString(this.roomId), () =>
      this.debugCommands?.refreshAll(),
    );
    this.matchManager.setNpcSystem(this.npcSystem);

    // Build the hazards this arena defines. An arena is data, so a room simply
    // constructs whatever it was handed rather than knowing about any trap.
    this.trapSystem.load(this.arena);

    // The walls start at the arena's own edges, so clients have sane limits
    // before a match ever begins.
    this.arenaShrinkSystem.reset();

    this.debugAuthorization = new DebugAuthorizationService(
      new ConfiguredDebugPolicy(serverConfig.debug),
      this.logger,
    );
    this.debugCommands = new DebugCommandService(
      this.context,
      this.debugAuthorization,
      new DebugRegistry(),
      (callerId) => this.createDebugContext(callerId),
      () => this.baselineConfig,
    );

    // Simulate at 60Hz, but only broadcast deltas at 20Hz: physics stays crisp
    // while bandwidth stays modest.
    this.setPatchRate(1000 / NETWORK.PATCH_RATE_HZ);
    this.setSimulationInterval((deltaMs) => this.update(deltaMs), FIXED_DELTA_MS);

    this.registerMessageHandlers();

    this.logger.info("Room created", { arena: this.arena.id, maxClients: this.maxClients });
  }

  override onJoin(client: Client, options: Partial<JoinOptions> = {}): void {
    const now = Date.now();
    const runtime = new PlayerRuntime(now);
    this.runtimes.set(client.sessionId, runtime);
    this.clientsBySession.set(client.sessionId, client);

    const validation = validatePlayerName(options?.name, client.sessionId);
    const takenNames = Array.from(this.state.players.values()).map((player) => player.name);
    const name = makeNameUnique(
      validation.valid ? validation.name : generateFallbackName(client.sessionId),
      takenNames,
    );

    const player = new PlayerState();
    player.sessionId = client.sessionId;
    player.name = name;
    player.connected = true;
    player.alive = false;
    player.inMatch = false;
    player.health = this.configView.getPlayerConfig().maxHealth;
    this.state.players.set(client.sessionId, player);

    if (!validation.valid) {
      this.sendNotice(client.sessionId, "NAME_REJECTED", `${validation.reason} Using "${name}".`);
    }

    // The arena and the configuration travel with the welcome rather than being
    // looked up in the client's bundle. They have to: an administrator can create
    // an arena and retune the game after the client was built, and prediction is
    // only exact while the client steps the same numbers the server does.
    const welcome: WelcomePayload = {
      sessionId: client.sessionId,
      roomId: this.roomId,
      arenaId: this.arena.id,
      arena: this.arena,
      config: this.configView.config,
      serverTime: now,
      name,
    };
    client.send(ServerMessage.WELCOME, welcome);

    // Joining while a match runs (reconnection edge case) means spectating it.
    if (this.state.matchState === MatchState.PLAYING) {
      this.sendNotice(client.sessionId, "MATCH_IN_PROGRESS", "Match in progress - you are spectating.");
    }

    this.matchManager.onPlayerJoined();
    this.logger.info("Player joined", { sessionId: client.sessionId, name, players: this.state.playerCount });
  }

  /**
   * Called when a client drops without consent. This is where we hold the seat open
   * for a reconnection; if it never comes, Colyseus follows up with `onLeave`.
   */
  override async onDrop(client: Client): Promise<void> {
    const runtime = this.runtimes.get(client.sessionId);
    if (!runtime) return;

    this.handleDisconnect(client.sessionId);
    runtime.awaitingReconnection = true;
    this.logger.info("Player dropped, holding seat", { sessionId: client.sessionId });

    try {
      await this.allowReconnection(client, MATCH.RECONNECTION_WINDOW_SEC);
    } catch {
      // Window expired -- `onLeave` runs next and performs the actual removal.
    } finally {
      runtime.awaitingReconnection = false;
    }
  }

  /** The dropped client came back within the reconnection window. */
  override onReconnect(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    this.clientsBySession.set(client.sessionId, client);
    player.connected = true;
    this.matchManager.refreshCounters();
    this.logger.info("Player reconnected", { sessionId: client.sessionId, name: player.name });
  }

  /** Final departure: either a consented leave or an expired reconnection window. */
  override onLeave(client: Client): void {
    this.handleDisconnect(client.sessionId);
    this.removePlayer(client.sessionId);
    this.logger.info("Player left", { sessionId: client.sessionId, players: this.state.playerCount });
  }

  /**
   * Shared disconnect handling. Idempotent, because a non-consented drop reaches it
   * twice: once from `onDrop` and again from `onLeave`.
   *
   * A disconnect must never stall a match, so a disconnected player still in the
   * fight is eliminated immediately and the survivor count recomputed.
   */
  private handleDisconnect(sessionId: string): void {
    const player = this.state.players.get(sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (!player || !runtime) return;

    player.connected = false;
    runtime.clearInputs();
    this.clientsBySession.delete(sessionId);

    if (this.state.matchState === MatchState.PLAYING && player.alive) {
      this.matchManager.eliminate(player, null, player.weaponId);
    }
    this.matchManager.refreshCounters();
  }

  override onDispose(): void {
    this.npcSystem.removeAll();
    this.runtimes.clear();
    this.clientsBySession.clear();
    this.logger.info("Room disposed");
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------

  /**
   * Fixed-timestep loop.
   *
   * Gameplay never advances by a variable delta: leftover time is carried in an
   * accumulator so the simulation is reproducible and independent of how often
   * the host actually calls us.
   */
  private update(deltaMs: number): void {
    this.accumulatorMs += Math.min(deltaMs, FIXED_DELTA_MS * MAX_STEPS_PER_FRAME);

    let steps = 0;
    while (this.accumulatorMs >= FIXED_DELTA_MS && steps < MAX_STEPS_PER_FRAME) {
      this.accumulatorMs -= FIXED_DELTA_MS;
      steps++;

      const now = Date.now();
      // Before movement: a bot's decisions become queued input, and the
      // movement system then consumes that queue exactly as it does a human's.
      this.npcSystem.update(FIXED_DELTA, now);
      this.movementSystem.update(FIXED_DELTA, now);
      this.projectileSystem.update(FIXED_DELTA, now);
      this.powerUpSystem.update(now);
      this.arenaShrinkSystem.update(FIXED_DELTA, now);
      this.trapSystem.update(FIXED_DELTA, now);
      this.grenadeSystem.update(FIXED_DELTA, now);
      this.matchManager.update(now);
    }

    this.streamNpcDebug(Date.now());

    if (steps === MAX_STEPS_PER_FRAME) this.accumulatorMs = 0;
  }

  // ---------------------------------------------------------------------------
  // Client messages -- all untrusted
  // ---------------------------------------------------------------------------

  private registerMessageHandlers(): void {
    this.onMessage(ClientMessage.INPUT, (client, payload) => {
      const runtime = this.runtimes.get(client.sessionId);
      if (!runtime) return;

      const now = Date.now();
      if (!runtime.rateLimiters.allow("input", now)) return;

      const commands = decodeInputBatch(payload);
      if (!commands) return;

      for (const command of commands) {
        this.movementSystem.enqueue(runtime, command);
      }
    });

    this.onMessage(ClientMessage.PING, (client, payload: PingPayload) => {
      const runtime = this.runtimes.get(client.sessionId);
      const now = Date.now();
      if (runtime && !runtime.rateLimiters.allow("ping", now)) return;
      if (!payload || !isFiniteNumber(payload.clientTime)) return;

      const pong: PongPayload = { clientTime: payload.clientTime, serverTime: now };
      client.send(ServerMessage.PONG, pong);
    });

    this.onMessage(ClientMessage.REQUEUE, (client) => {
      const runtime = this.runtimes.get(client.sessionId);
      const now = Date.now();
      if (runtime && !runtime.rateLimiters.allow("chatOrMisc", now)) return;
      this.matchManager.requestRequeue(client.sessionId, now);
    });

    /**
     * "Do not wait for anyone else."
     *
     * The client only asks; the NPC system decides whether the lobby is in a
     * state where that means anything, so a fabricated message achieves nothing
     * beyond spending this connection's rate budget.
     */
    this.onMessage(ClientMessage.START_NOW, (client) => {
      const runtime = this.runtimes.get(client.sessionId);
      const now = Date.now();
      if (runtime && !runtime.rateLimiters.allow("chatOrMisc", now)) return;
      this.npcSystem.requestImmediateStart(client.sessionId);
    });

    /**
     * Debug access request. Authorization is decided entirely server-side --
     * this handler only forwards the attempt.
     */
    this.onMessage(ClientMessage.DEBUG_AUTH, (client, payload) => {
      const runtime = this.runtimes.get(client.sessionId);
      const now = Date.now();
      if (runtime && !runtime.rateLimiters.allow("debug", now)) return;

      const player = this.state.players.get(client.sessionId);
      this.debugCommands.handleAuthRequest(client.sessionId, player?.name ?? "", payload);
    });

    /**
     * Debug command. `DebugCommandService` refuses this outright unless the
     * session already holds a grant, so hand-crafting this message achieves
     * nothing.
     */
    this.onMessage(ClientMessage.DEBUG_COMMAND, (client, payload) => {
      const runtime = this.runtimes.get(client.sessionId);
      const now = Date.now();
      if (runtime && !runtime.rateLimiters.allow("debug", now)) return;

      this.debugCommands.handleCommand(client.sessionId, payload);
    });

    // Anything not explicitly handled above is ignored rather than trusted.
    this.onMessage("*", (client, type) => {
      this.logger.debug("Ignoring unknown message", { sessionId: client.sessionId, type });
    });
  }

  // ---------------------------------------------------------------------------
  // Combat
  // ---------------------------------------------------------------------------

  /** The single place where health changes. Called only from server-side collision. */
  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private createContext(): RoomContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      state: this.state,
      arena: this.arena,
      world: this.world,
      logger: this.logger,
      runtimes: this.runtimes,
      roomId: this.roomId,
      // Getters, because debug tooling swaps the room's configuration wholesale.
      get config() {
        return self.configView;
      },
      get baselineConfig() {
        return self.baselineConfig;
      },
      now: () => Date.now(),
      random: () => this.random(),
      broadcast: (type, payload, options) => {
        if (options?.except) {
          const client = this.clientsBySession.get(options.except);
          this.broadcast(type, payload, client ? { except: client } : undefined);
        } else {
          this.broadcast(type, payload);
        }
      },
      sendTo: (sessionId, type, payload) => this.sendTo(sessionId, type, payload),
      setLocked: (locked) => {
        if (locked) void this.lock();
        else void this.unlock();
      },
      applyDamage: (victimId, attackerId, amount, x, y, weaponId) =>
        this.matchManager.applyDamage(victimId, attackerId, amount, x, y, weaponId),
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
        // Mirrored immediately so the change is in the next patch rather than a
        // tick later; the client reconciles its prediction against these.
        player.velocityX = runtime.movement.velocityX;
        player.velocityY = runtime.movement.velocityY;
        player.onGround = runtime.movement.onGround;
        player.knockbackTimer = runtime.movement.knockbackTimer;
      },
      damageCrate: (crateId, amount, attackerId, now) =>
        this.powerUpSystem.damageCrate(crateId, amount, attackerId, now),
    };
  }

  /** Assemble what a debug command is allowed to reach. */
  private createDebugContext(callerId: string): DebugCommandContext {
    return {
      room: this.context,
      weapons: this.weaponSystem,
      powerUps: this.powerUpSystem,
      grenades: this.grenadeSystem,
      traps: this.trapSystem,
      npcs: this.npcSystem,
      matchManager: this.matchManager,
      config: this.configView,
      replaceConfig: (config) => {
        // Room-scoped by construction: only this room's view is replaced, and
        // nothing is written to storage -- a debug change dies with the room.
        this.configView = createGameConfigView(config);
        // Traps read their inherited values at load, so a retuned trap default
        // has to be rebuilt to take effect.
        this.trapSystem.load(this.arena);
        this.broadcastConfig();
        this.logger.info("Room configuration overridden by debug command");
      },
      callerId,
    };
  }

  /**
   * Push what the bots are thinking to any open console.
   *
   * Four times a second, and only when somebody is authorized -- a room with no
   * console open does none of this work, which is why the check comes before the
   * snapshot is built.
   */
  private streamNpcDebug(now: number): void {
    if (now < this.nextNpcDebugAt) return;
    this.nextNpcDebugAt = now + 250;

    if (this.npcSystem.count === 0) return;
    if (!this.debugCommands.hasAudience) return;

    this.debugCommands.sendNpcState(() => this.npcSystem.describe());
  }

  /**
   * Tell every client the room's configuration changed.
   *
   * Only debug commands can cause this mid-match, and clients need it because
   * they predict movement with these numbers: a client still stepping the old
   * gravity would fight a correction on every patch.
   */
  private broadcastConfig(): void {
    const payload: ConfigChangedPayload = { config: this.configView.config };
    this.broadcast(ServerMessage.CONFIG_CHANGED, payload);
  }

  private sendTo(sessionId: string, type: string, payload: unknown): void {
    this.clientsBySession.get(sessionId)?.send(type, payload);
  }

  private sendNotice(sessionId: string, code: NoticePayload["code"], message: string): void {
    const payload: NoticePayload = { code, message };
    this.sendTo(sessionId, ServerMessage.NOTICE, payload);
  }

  private removePlayer(sessionId: string): void {
    this.projectileSystem.destroyOwnedBy(sessionId);
    this.grenadeSystem.destroyOwnedBy(sessionId);
    this.state.players.delete(sessionId);
    this.runtimes.delete(sessionId);
    this.clientsBySession.delete(sessionId);
    this.matchManager.onPlayerRemoved(sessionId);
    this.arenaShrinkSystem.onPlayerRemoved(sessionId);
    this.trapSystem.onPlayerRemoved(sessionId);
    // A grant belongs to a session, so it dies with it.
    this.debugAuthorization.revoke(sessionId);
  }
}

function pickArenaId(options: Record<string, unknown>): string {
  const requested = typeof options.arenaId === "string" ? options.arenaId : serverConfig.match.arenaId;
  return requested || DEFAULT_ARENA_ID;
}

/** Stable 32-bit hash, used to seed the room's RNG from its id. */
function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
