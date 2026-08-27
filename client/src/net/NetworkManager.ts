import { Client, getStateCallbacks, type Room } from "@colyseus/sdk";
import {
  ClientMessage,
  MATCH,
  NETWORK,
  ServerMessage,
  encodeInputBatch,
  loadGameConfig,
  registerArena,
  type ArenaChangedPayload,
  type ArenaDefinition,
  type ConfigChangedPayload,
  type CrateDestroyedPayload,
  type DamagePayload,
  type DebugAuthRequest,
  type DebugCommandRequest,
  type DebugCommandResult,
  type DebugNpcPayload,
  type DebugStatePayload,
  type ExplosionPayload,
  type InputCommand,
  type JoinOptions,
  type MeleeSwingPayload,
  type KillPayload,
  type MatchResultMessage,
  type MatchStateValue,
  type NoticePayload,
  type PingPayload,
  type PlayerCareer,
  type PongPayload,
  type PowerUpCollectedPayload,
  type AddBotRequest,
  type RemoveBotRequest,
  type SelectArenaRequest,
  type SelectModeRequest,
  type SyncedCrate,
  type SyncedFlag,
  type SyncedGameState,
  type SyncedGrenade,
  type SyncedPlayer,
  type SyncedPowerUp,
  type SyncedProjectile,
  type WelcomePayload,
} from "@deathmatch/shared";
import { clientConfig } from "../config.js";
import { Emitter } from "../core/Emitter.js";

export type GameRoom = Room<unknown, SyncedGameState>;

export interface NetworkEvents {
  connected: WelcomePayload;
  /** Fired once per server patch (~20Hz). Drives snapshot buffering and reconciliation. */
  patch: { state: SyncedGameState; receivedAt: number };
  playerAdded: { player: SyncedPlayer; sessionId: string };
  playerRemoved: { sessionId: string };
  projectileAdded: { projectile: SyncedProjectile };
  projectileRemoved: { projectile: SyncedProjectile };
  crateAdded: { crate: SyncedCrate };
  crateRemoved: { crate: SyncedCrate };
  powerUpAdded: { powerUp: SyncedPowerUp };
  powerUpRemoved: { powerUp: SyncedPowerUp };
  flagAdded: { flag: SyncedFlag };
  flagRemoved: { flag: SyncedFlag };
  grenadeAdded: { grenade: SyncedGrenade };
  grenadeRemoved: { grenade: SyncedGrenade };
  matchStateChanged: { matchState: MatchStateValue };
  countdownChanged: { seconds: number };
  /** Which game mode the next match will run. */
  gameModeChanged: { modeId: string };
  /** Whole seconds left on a timed mode's clock; 0 when no clock is running. */
  matchClockChanged: { seconds: number };
  suddenDeathChanged: { active: boolean };
  kill: KillPayload;
  damage: DamagePayload;
  matchResult: MatchResultMessage;
  notice: NoticePayload;
  powerUpCollected: PowerUpCollectedPayload;
  /** Server's verdict on debug access, plus the catalogue when granted. */
  debugState: DebugStatePayload;
  debugResult: DebugCommandResult;
  /** What the bots are thinking. Only arrives while a console is authorized. */
  debugNpc: DebugNpcPayload;
  crateDestroyed: CrateDestroyedPayload;
  meleeSwing: MeleeSwingPayload;
  explosion: ExplosionPayload;
  /** The room moved to a different arena for the next match. */
  arenaChanged: ArenaDefinition;
  /** This player's own record across matches. */
  career: PlayerCareer;
  /** The room retuned its configuration; anything derived from it must refresh. */
  configChanged: ConfigChangedPayload;
  disconnected: { code: number; reason: string };
  /**
   * The connection dropped, but the seat is being held.
   *
   * Distinct from `disconnected`: the server keeps a dropped player's place for
   * the reconnection window, so the honest thing to show is "hold on", not "you
   * have been thrown out".
   */
  connectionLost: { secondsLeft: number };
  /** The connection came back and the same seat is ours again. */
  reconnected: Record<string, never>;
  error: { message: string };
}

/**
 * Owns the Colyseus connection.
 *
 * Responsibilities: matchmaking, translating schema callbacks into plain events,
 * batching outbound input, and measuring round-trip time. It contains no gameplay
 * logic -- everything it emits is server truth.
 */
/**
 * Is this close code one the server might still be holding a seat for?
 *
 * Colyseus uses 4000-and-up for deliberate closes -- a consented leave, a room
 * disposing, a kick. Everything else is the network failing, which is exactly
 * the case the reconnection window exists for.
 */
function isRecoverable(code: number): boolean {
  return code < 4000;
}

export class NetworkManager {
  readonly events = new Emitter<NetworkEvents>();

  private readonly client = new Client(clientConfig.serverUrl);
  private room: GameRoom | null = null;
  private welcome: WelcomePayload | null = null;
  /**
   * What the server will accept in place of a fresh join.
   *
   * Kept for the length of a session and cleared the moment a leave is final, so
   * a reconnection is only ever attempted for a seat that still exists.
   */
  private reconnectionToken = "";

  /**
   * True once the welcome message AND the first state patch have both arrived.
   *
   * The server sends `welcome` from `onJoin`, which happens before the first patch
   * is encoded, so for a brief moment `room.state` exists but its collections have
   * not been decoded yet. Gating on this flag means no consumer can ever observe a
   * half-built state.
   */
  private handshakeComplete = false;

  /** Inputs produced by prediction but not yet flushed to the server. */
  private readonly outbox: InputCommand[] = [];
  private lastFlushAt = 0;

  private pingTimer: number | null = null;
  private roundTripMs = 0;
  /** serverTime - clientTime at the moment of the last pong. */
  private clockOffsetMs = 0;

  get currentRoom(): GameRoom | null {
    return this.room;
  }

  get sessionId(): string {
    return this.room?.sessionId ?? "";
  }

  get roomId(): string {
    return this.room?.roomId ?? "";
  }

  get ping(): number {
    return this.roundTripMs;
  }

  get state(): SyncedGameState | null {
    if (!this.handshakeComplete || !this.room) return null;
    return this.room.state ?? null;
  }

  /**
   * The arena this room is playing, exactly as the server has it.
   *
   * Null before the handshake. Read from the welcome rather than from the
   * client's own catalogue, because an administrator can create an arena this
   * build has never heard of.
   */
  get arena(): ArenaDefinition | null {
    return this.currentArena ?? this.welcome?.arena ?? null;
  }

  /**
   * The arena being played now.
   *
   * Set when a room rotates maps; until then the welcome's is the current one.
   */
  private currentArena: ArenaDefinition | null = null;

  get isConnected(): boolean {
    return this.room !== null;
  }

  /**
   * Take on the server's arena and configuration.
   *
   * Both are published into the shared registries, which is what everything else
   * -- prediction, the HUD, the renderer -- already reads from. So one call here
   * puts the whole client on the server's numbers, and nothing downstream has to
   * be told about it.
   */
  private adoptServerWorld(arena: ArenaDefinition | undefined, config: WelcomePayload["config"] | undefined): void {
    if (config) loadGameConfig(config);
    if (arena) registerArena(arena);
  }

  /**
   * Ask to begin, with whoever is in the room.
   *
   * A request, not an instruction: the server checks that this session is the
   * room's host and that a match could start at all, so sending it at any other
   * moment achieves nothing.
   */
  requestStart(): void {
    this.room?.send(ClientMessage.START_MATCH, {});
  }

  /**
   * Ask for another bot at this difficulty.
   *
   * A request like every other: only the host's asking counts, only between
   * matches, and only while the room has a place free.
   */
  addBot(difficulty: number): void {
    const payload: AddBotRequest = { difficulty };
    this.room?.send(ClientMessage.ADD_BOT, payload);
  }

  /** Ask for a bot to be removed. Only the host's asking means anything. */
  removeBot(sessionId: string): void {
    const payload: RemoveBotRequest = { sessionId };
    this.room?.send(ClientMessage.REMOVE_BOT, payload);
  }

  /** Ask to play a different map. Only the host's asking means anything. */
  selectArena(arenaId: string): void {
    const payload: SelectArenaRequest = { arenaId };
    this.room?.send(ClientMessage.SELECT_ARENA, payload);
  }

  /** Ask for a different game mode for the next match. Host only, like the arena. */
  selectMode(modeId: string): void {
    const payload: SelectModeRequest = { modeId };
    this.room?.send(ClientMessage.SELECT_MODE, payload);
  }

  /** What can be played, as the server listed it at join. For the map picker. */
  get arenaChoices(): readonly { id: string; name: string }[] {
    return this.welcome?.arenas ?? [];
  }

  /** Approximate server clock, used only for debug output and trail fading. */
  serverNow(): number {
    return Date.now() + this.clockOffsetMs;
  }

  /**
   * Join an available match, creating one if every existing room is full or
   * already playing. Colyseus handles the room selection; the server locks rooms
   * once a match starts so nobody drops into a fight in progress.
   */
  async join(name: string): Promise<WelcomePayload> {
    const options: JoinOptions = { name, playerId: clientConfig.playerId };
    const room = (await this.client.joinOrCreate(clientConfig.roomName, options)) as GameRoom;
    this.room = room;
    this.handshakeComplete = false;

    // Attach before awaiting, so no early patch or message is missed.
    this.attachRoomHandlers(room);

    const welcome = await this.waitForHandshake(room);
    this.welcome = welcome;
    this.handshakeComplete = true;

    this.reconnectionToken = room.reconnectionToken;
    this.startPingLoop();
    this.events.emit("connected", welcome);

    // Always ask; the server decides. Asking without a token is normal and is
    // simply refused, which is what keeps the console shut for ordinary players.
    this.requestDebugAccess(clientConfig.debugToken);
    return welcome;
  }

  /**
   * The connection went away while we were playing.
   *
   * Idempotent: a dying socket can produce both an error and a leave, and the
   * player should be told once.
   */
  private handleConnectionLost(): void {
    if (!this.room && !this.handshakeComplete) return;

    this.stopPingLoop();
    this.room = null;
    this.handshakeComplete = false;

    if (!this.reconnectionToken) {
      this.events.emit("disconnected", { code: 0, reason: "" });
      return;
    }

    this.events.emit("connectionLost", { secondsLeft: MATCH.RECONNECTION_WINDOW_SEC });
  }

  /**
   * Ask for the seat back.
   *
   * Returns false when the attempt fails, which is not an error worth reporting
   * on its own: the caller retries until the server's window closes, and only
   * then is it a disconnection.
   */
  async attemptReconnect(): Promise<boolean> {
    if (!this.reconnectionToken) return false;

    try {
      const room = (await this.client.reconnect(this.reconnectionToken)) as GameRoom;
      this.room = room;
      this.handshakeComplete = false;
      this.attachRoomHandlers(room);

      const welcome = await this.waitForHandshake(room);
      this.welcome = welcome;
      this.handshakeComplete = true;
      this.reconnectionToken = room.reconnectionToken;

      this.startPingLoop();
      this.requestDebugAccess(clientConfig.debugToken);
      this.events.emit("reconnected", {});
      return true;
    } catch {
      // The window may simply not have expired yet, or the server may be gone.
      // Either way the caller decides how long to keep trying.
      this.room = null;
      return false;
    }
  }

  /** Give up on the held seat; the next connection will be a fresh join. */
  abandonReconnection(): void {
    this.reconnectionToken = "";
  }

  /** Resolve once the server has both greeted us and sent a decodable state. */
  private waitForHandshake(room: GameRoom): Promise<WelcomePayload> {
    return new Promise<WelcomePayload>((resolve, reject) => {
      let welcome: WelcomePayload | null = null;
      let stateReceived = false;

      const timeout = window.setTimeout(() => {
        reject(new Error("The server did not complete the handshake in time."));
      }, 10000);

      const settleIfReady = () => {
        if (!welcome || !stateReceived) return;
        window.clearTimeout(timeout);
        resolve(welcome);
      };

      room.onMessage(ServerMessage.WELCOME, (payload: WelcomePayload) => {
        welcome = payload;
        // Adopt the server's world before anything reads it. The arena may not
        // exist in this build at all (an administrator created it after the
        // client shipped), and prediction has to step the room's own physics
        // rather than the values this bundle happens to carry.
        this.adoptServerWorld(payload.arena, payload.config);
        settleIfReady();
      });

      room.onStateChange(() => {
        stateReceived = true;
        settleIfReady();
      });

      room.onError((code, message) => {
        window.clearTimeout(timeout);
        // `code` is often undefined for a transport failure, and "Connection
        // error (undefined)" is not something to show a player.
        const error = new Error(message || (code ? `Connection error (${code})` : "Connection error."));
        this.events.emit("error", { message: error.message });
        reject(error);
      });
    });
  }

  async leave(): Promise<void> {
    this.stopPingLoop();
    const room = this.room;
    this.room = null;
    this.handshakeComplete = false;
    this.welcome = null;
    this.outbox.length = 0;
    if (room) {
      try {
        await room.leave(true);
      } catch {
        // Already gone; nothing to clean up.
      }
    }
  }

  /** Queue one predicted input for delivery. */
  queueInput(input: InputCommand): void {
    this.outbox.push(input);
    // Never let the outbox grow without bound if the socket stalls.
    if (this.outbox.length > NETWORK.MAX_QUEUED_INPUTS) {
      this.outbox.splice(0, this.outbox.length - NETWORK.MAX_QUEUED_INPUTS);
    }
  }

  /**
   * Flush queued input at ~30Hz rather than every simulated tick.
   *
   * Commands are packed into compact tuples, so one flush is a handful of bytes.
   * Unacknowledged inputs stay in the client's prediction buffer, not here.
   */
  flushInput(now: number): void {
    if (!this.room || this.outbox.length === 0) return;
    if (now - this.lastFlushAt < 1000 / NETWORK.INPUT_SEND_RATE_HZ) return;

    this.lastFlushAt = now;
    const batch = encodeInputBatch(this.outbox);
    this.outbox.length = 0;
    this.room.send(ClientMessage.INPUT, batch as never);
  }

  /** Ask the server to shorten the results screen. */
  requestRequeue(): void {
    this.room?.send(ClientMessage.REQUEUE, {} as never);
  }

  /**
   * Ask the server for debug access.
   *
   * Sending this is not a claim to anything: the server evaluates the token
   * against its own configuration and replies with a `debugState` either way.
   */
  requestDebugAccess(token: string): void {
    const request: DebugAuthRequest = token ? { token } : {};
    this.room?.send(ClientMessage.DEBUG_AUTH, request as never);
  }

  /**
   * Ask the server to run a debug command.
   *
   * Refused server-side unless this session already holds a grant, so there is
   * nothing to gain by calling it from the console of a browser.
   */
  sendDebugCommand(commandId: string, params: Record<string, unknown> = {}): void {
    const request: DebugCommandRequest = { commandId, params };
    this.room?.send(ClientMessage.DEBUG_COMMAND, request as never);
  }

  // ---------------------------------------------------------------------------

  private attachRoomHandlers(room: GameRoom): void {
    const $ = getStateCallbacks(room as never) as never as StateCallbackProxy;

    $(room.state).players.onAdd((player: SyncedPlayer, sessionId: string) => {
      this.events.emit("playerAdded", { player, sessionId });
    });
    $(room.state).players.onRemove((_player: SyncedPlayer, sessionId: string) => {
      this.events.emit("playerRemoved", { sessionId });
    });

    $(room.state).projectiles.onAdd((projectile: SyncedProjectile) => {
      this.events.emit("projectileAdded", { projectile });
    });
    $(room.state).projectiles.onRemove((projectile: SyncedProjectile) => {
      this.events.emit("projectileRemoved", { projectile });
    });

    $(room.state).crates.onAdd((crate: SyncedCrate) => {
      this.events.emit("crateAdded", { crate });
    });
    $(room.state).crates.onRemove((crate: SyncedCrate) => {
      this.events.emit("crateRemoved", { crate });
    });

    $(room.state).powerUps.onAdd((powerUp: SyncedPowerUp) => {
      this.events.emit("powerUpAdded", { powerUp });
    });
    $(room.state).powerUps.onRemove((powerUp: SyncedPowerUp) => {
      this.events.emit("powerUpRemoved", { powerUp });
    });

    $(room.state).flags.onAdd((flag: SyncedFlag) => {
      this.events.emit("flagAdded", { flag });
    });
    $(room.state).flags.onRemove((flag: SyncedFlag) => {
      this.events.emit("flagRemoved", { flag });
    });

    $(room.state).grenades.onAdd((grenade: SyncedGrenade) => {
      this.events.emit("grenadeAdded", { grenade });
    });
    $(room.state).grenades.onRemove((grenade: SyncedGrenade) => {
      this.events.emit("grenadeRemoved", { grenade });
    });

    $(room.state).listen("matchState", (matchState: MatchStateValue) => {
      this.events.emit("matchStateChanged", { matchState });
    });
    $(room.state).listen("countdownSeconds", (seconds: number) => {
      this.events.emit("countdownChanged", { seconds });
    });
    $(room.state).listen("gameModeId", (modeId: string) => {
      this.events.emit("gameModeChanged", { modeId });
    });
    $(room.state).listen("matchTimeRemainingSeconds", (seconds: number) => {
      this.events.emit("matchClockChanged", { seconds });
    });
    $(room.state).listen("suddenDeath", (active: boolean) => {
      this.events.emit("suddenDeathChanged", { active });
    });

    // One event per patch. Everything time-sensitive (interpolation buffers,
    // reconciliation) hangs off this rather than off the render loop.
    room.onStateChange((state) => {
      this.events.emit("patch", { state: state as SyncedGameState, receivedAt: performance.now() });
    });

    room.onMessage(ServerMessage.KILL, (payload: KillPayload) => this.events.emit("kill", payload));
    room.onMessage(ServerMessage.DAMAGE, (payload: DamagePayload) => this.events.emit("damage", payload));
    room.onMessage(ServerMessage.MATCH_RESULT, (payload: MatchResultMessage) =>
      this.events.emit("matchResult", payload),
    );
    room.onMessage(ServerMessage.NOTICE, (payload: NoticePayload) => this.events.emit("notice", payload));

    /**
     * The room's configuration changed under us (a debug command did it).
     *
     * Adopting it immediately matters more than it looks: prediction steps these
     * numbers, so a client still using the old gravity would be corrected by the
     * server on every single patch.
     */
    room.onMessage(ServerMessage.CONFIG_CHANGED, (payload: ConfigChangedPayload) => {
      if (!payload?.config) return;
      loadGameConfig(payload.config);
      if (this.welcome) this.welcome = { ...this.welcome, config: payload.config };
      this.events.emit("configChanged", payload);
    });
    room.onMessage(ServerMessage.POWERUP_COLLECTED, (payload: PowerUpCollectedPayload) =>
      this.events.emit("powerUpCollected", payload),
    );
    room.onMessage(ServerMessage.CRATE_DESTROYED, (payload: CrateDestroyedPayload) =>
      this.events.emit("crateDestroyed", payload),
    );
    room.onMessage(ServerMessage.MELEE_SWING, (payload: MeleeSwingPayload) =>
      this.events.emit("meleeSwing", payload),
    );
    room.onMessage(ServerMessage.CAREER, (payload: PlayerCareer) =>
      this.events.emit("career", payload),
    );

    room.onMessage(ServerMessage.ARENA_CHANGED, (payload: ArenaChangedPayload) => {
      if (!payload?.arena) return;
      // Adopted the same way the welcome's arena is, so prediction and rendering
      // are both looking at the map that is about to be played.
      this.adoptServerWorld(payload.arena, undefined);
      this.currentArena = payload.arena;
      this.events.emit("arenaChanged", payload.arena);
    });

    room.onMessage(ServerMessage.EXPLOSION, (payload: ExplosionPayload) =>
      this.events.emit("explosion", payload),
    );
    room.onMessage(ServerMessage.DEBUG_STATE, (payload: DebugStatePayload) =>
      this.events.emit("debugState", payload),
    );
    room.onMessage(ServerMessage.DEBUG_RESULT, (payload: DebugCommandResult) =>
      this.events.emit("debugResult", payload),
    );
    room.onMessage(ServerMessage.DEBUG_NPC, (payload: DebugNpcPayload) =>
      this.events.emit("debugNpc", payload),
    );
    room.onMessage(ServerMessage.PONG, (payload: PongPayload) => this.handlePong(payload));

    room.onLeave((code, reason) => {
      // A consented leave -- pressing Leave, or the room disposing -- is final.
      // Anything else is the network failing, and the server holds the seat for
      // a few seconds either way, so it is worth asking for it back.
      if (this.reconnectionToken && isRecoverable(code)) {
        this.handleConnectionLost();
        return;
      }

      this.stopPingLoop();
      this.room = null;
      this.handshakeComplete = false;
      this.reconnectionToken = "";
      this.events.emit("disconnected", { code, reason: reason ?? "" });
    });

    /*
     * The other way a connection ends.
     *
     * A socket that dies mid-match -- the server restarting, a tunnel closing,
     * a laptop lid -- surfaces here rather than through `onLeave`, which only
     * fires for a close the two ends agreed on. Treating it as a bare error
     * message was the client giving up while the server was still holding the
     * player's place.
     */
    room.onError(() => {
      if (!this.handshakeComplete) return;
      this.handleConnectionLost();
    });
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    const send = () => {
      const payload: PingPayload = { clientTime: Date.now() };
      this.room?.send(ClientMessage.PING, payload as never);
    };
    send();
    this.pingTimer = window.setInterval(send, NETWORK.PING_INTERVAL_MS);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private handlePong(payload: PongPayload): void {
    const now = Date.now();
    this.roundTripMs = Math.max(0, now - payload.clientTime);
    // Assume a symmetric route: the server's clock sat half an RTT in the past.
    this.clockOffsetMs = payload.serverTime + this.roundTripMs / 2 - now;
  }

  getWelcome(): WelcomePayload | null {
    return this.welcome;
  }
}

/**
 * Structural type for the SDK's callback proxy.
 *
 * The SDK infers callbacks from concrete `Schema` subclasses; we deliberately type
 * our state with the plain interfaces from `@deathmatch/shared` so the client never
 * imports server code. This describes the handful of proxy methods we use.
 */
type StateCallbackProxy = (state: SyncedGameState) => {
  players: {
    onAdd(callback: (player: SyncedPlayer, sessionId: string) => void): void;
    onRemove(callback: (player: SyncedPlayer, sessionId: string) => void): void;
  };
  projectiles: {
    onAdd(callback: (projectile: SyncedProjectile, id: string) => void): void;
    onRemove(callback: (projectile: SyncedProjectile, id: string) => void): void;
  };
  crates: {
    onAdd(callback: (crate: SyncedCrate, id: string) => void): void;
    onRemove(callback: (crate: SyncedCrate, id: string) => void): void;
  };
  powerUps: {
    onAdd(callback: (powerUp: SyncedPowerUp, id: string) => void): void;
    onRemove(callback: (powerUp: SyncedPowerUp, id: string) => void): void;
  };
  flags: {
    onAdd(callback: (flag: SyncedFlag, id: string) => void): void;
    onRemove(callback: (flag: SyncedFlag, id: string) => void): void;
  };
  grenades: {
    onAdd(callback: (grenade: SyncedGrenade, id: string) => void): void;
    onRemove(callback: (grenade: SyncedGrenade, id: string) => void): void;
  };
  listen<K extends keyof SyncedGameState>(
    field: K,
    callback: (value: SyncedGameState[K]) => void,
  ): void;
};
