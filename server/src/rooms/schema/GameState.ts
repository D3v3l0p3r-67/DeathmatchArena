import { MapSchema, Schema, type } from "@colyseus/schema";
import {
  DEFAULT_ARENA_ID,
  MatchState,
  getMatchConfig,
  type MatchStateValue,
  type SyncedGameState,
} from "@deathmatch/shared";
import { CrateState } from "./CrateState.js";
import { GrenadeState } from "./GrenadeState.js";
import { PlayerState } from "./PlayerState.js";
import { PendingCrateState } from "./PendingCrateState.js";
import { PowerUpState } from "./PowerUpState.js";
import { ProjectileState } from "./ProjectileState.js";
import { TrapState } from "./TrapState.js";

/**
 * The synchronised room state.
 *
 * Kill-feed entries and match results are broadcast as one-off messages instead of
 * living here: they are ephemeral, so putting them in the state would mean paying
 * for them in every subsequent patch.
 */
export class GameState extends Schema implements SyncedGameState {
  /** One of MatchState. Stored as a string for readability in the Colyseus monitor. */
  @type("string") matchState: MatchStateValue = MatchState.WAITING;

  @type("string") arenaId = DEFAULT_ARENA_ID;

  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: ProjectileState }) projectiles = new MapSchema<ProjectileState>();

  /** Unopened power-up crates. What is inside each one stays server-side. */
  @type({ map: CrateState }) crates = new MapSchema<CrateState>();

  /**
   * Crates that have been announced but have not landed yet.
   *
   * A warning, nothing more: no collision, no contents, and the client draws a
   * marker that builds towards the arrival.
   */
  @type({ map: PendingCrateState }) pendingCrates = new MapSchema<PendingCrateState>();

  /** Power-ups revealed by broken crates, waiting to be collected. */
  @type({ map: PowerUpState }) powerUps = new MapSchema<PowerUpState>();

  /** Grenades in flight. The blast itself is resolved server-side. */
  @type({ map: GrenadeState }) grenades = new MapSchema<GrenadeState>();

  /**
   * The arena's traps.
   *
   * Position and phase only: activation, overlap and damage are the server's,
   * and a client that fabricated any of this would change nothing.
   */
  @type({ map: TrapState }) traps = new MapSchema<TrapState>();

  /** Whole seconds left in the countdown; only changes once per second. */
  @type("uint8") countdownSeconds = 0;

  @type("uint8") playerCount = 0;
  @type("uint8") aliveCount = 0;

  /** Number of players that were spawned when the match began (denominator for "Alive: x / y"). */
  @type("uint8") startingPlayerCount = 0;

  @type("string") winnerId = "";
  @type("string") winnerName = "";

  /** Server timestamp of the match start, for the HUD clock. */
  @type("number") matchStartedAt = 0;

  /** Advertised lobby thresholds so the client never hard-codes them. */
  @type("uint8") minPlayersToStart: number = getMatchConfig().minPlayers;
  @type("uint8") maxPlayers: number = getMatchConfig().maxPlayers;

  /**
   * Whole seconds until bots take the lobby's free places; 0 when nothing is
   * waiting. The client shows it and offers to skip it -- but only the server
   * decides when bots actually arrive.
   */
  @type("uint16") botFillSeconds = 0;
  /** True while the wait could be skipped. Purely so the client knows to offer. */
  @type("boolean") canStartNow = false;

  /**
   * The playable width, narrowed by the closing walls.
   *
   * Starts at the arena's own edges. Clients draw the walls from these and
   * predict movement against them, so both sides clamp to the same limits.
   */
  @type("float32") shrinkLeft = 0;
  @type("float32") shrinkRight = 0;
  @type("boolean") shrinking = false;

  /** Whole seconds until the walls start moving; 0 once they have. */
  @type("uint16") shrinkCountdownSeconds = 0;
}
