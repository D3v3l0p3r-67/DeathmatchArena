import { Client, getStateCallbacks, type Room } from "@colyseus/sdk";
import {
  ClientMessage,
  NETWORK,
  ServerMessage,
  encodeInputBatch,
  type DamagePayload,
  type InputCommand,
  type KillPayload,
  type MatchResultMessage,
  type MatchStateValue,
  type NoticePayload,
  type PingPayload,
  type PongPayload,
  type SyncedGameState,
  type SyncedPlayer,
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
  matchStateChanged: { matchState: MatchStateValue };
  countdownChanged: { seconds: number };
  kill: KillPayload;
  damage: DamagePayload;
  matchResult: MatchResultMessage;
  notice: NoticePayload;
  disconnected: { code: number; reason: string };
  error: { message: string };
}

/**
 * Owns the Colyseus connection.
 *
 * Responsibilities: matchmaking, translating schema callbacks into plain events,
 * batching outbound input, and measuring round-trip time. It contains no gameplay
 * logic -- everything it emits is server truth.
 */
export class NetworkManager {
  readonly events = new Emitter<NetworkEvents>();

  private readonly client = new Client(clientConfig.serverUrl);
  private room: GameRoom | null = null;
  private welcome: WelcomePayload | null = null;

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

  get isConnected(): boolean {
    return this.room !== null;
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
    const room = (await this.client.joinOrCreate(clientConfig.roomName, { name })) as GameRoom;
    this.room = room;
    this.handshakeComplete = false;

    // Attach before awaiting, so no early patch or message is missed.
    this.attachRoomHandlers(room);

    const welcome = await this.waitForHandshake(room);
    this.welcome = welcome;
    this.handshakeComplete = true;

    this.startPingLoop();
    this.events.emit("connected", welcome);
    return welcome;
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
        settleIfReady();
      });

      room.onStateChange(() => {
        stateReceived = true;
        settleIfReady();
      });

      room.onError((code, message) => {
        window.clearTimeout(timeout);
        const error = new Error(message ?? `Connection error (${code})`);
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

    $(room.state).listen("matchState", (matchState: MatchStateValue) => {
      this.events.emit("matchStateChanged", { matchState });
    });
    $(room.state).listen("countdownSeconds", (seconds: number) => {
      this.events.emit("countdownChanged", { seconds });
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
    room.onMessage(ServerMessage.PONG, (payload: PongPayload) => this.handlePong(payload));

    room.onLeave((code, reason) => {
      this.stopPingLoop();
      this.room = null;
      this.handshakeComplete = false;
      this.events.emit("disconnected", { code, reason: reason ?? "" });
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
  listen<K extends keyof SyncedGameState>(
    field: K,
    callback: (value: SyncedGameState[K]) => void,
  ): void;
};
