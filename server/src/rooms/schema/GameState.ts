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
import { FlagState } from "./FlagState.js";

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

  /** Flags on the ground, in modes that have them. Empty otherwise. */
  @type({ map: FlagState }) flags = new MapSchema<FlagState>();

  /** Whole seconds left in the countdown; only changes once per second. */
  @type("uint8") countdownSeconds = 0;

  /**
   * The rule set this room plays under. Set from configuration when the room
   * opens; the host may switch it in the lobby. Matches start under whatever
   * this holds at the countdown.
   */
  @type("string") gameModeId = "";

  /** Whole seconds left on a timed mode's clock; 0 outside one. */
  @type("uint16") matchTimeRemainingSeconds = 0;
  /** True while a tie-break is deciding a timed match. */
  @type("boolean") suddenDeath = false;

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
   * Whose room this is.
   *
   * The host adds and removes bots and decides when the match begins -- the room
   * waits for a person rather than for a number. It is whoever has been here
   * longest, and it passes on when they leave.
   */
  @type("string") hostId = "";
  /** "Ada's Room". Rebuilt whenever the host changes. */
  @type("string") roomName = "";
  /**
   * Whether a match could begin right now.
   *
   * Computed here rather than in the client so the button and the server can
   * never disagree about what pressing it would do.
   */
  @type("boolean") canStart = false;

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
