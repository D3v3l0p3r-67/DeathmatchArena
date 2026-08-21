import { MapSchema, Schema, type } from "@colyseus/schema";
import {
  DEFAULT_ARENA_ID,
  MATCH,
  MatchState,
  type MatchStateValue,
  type SyncedGameState,
} from "@deathmatch/shared";
import { CrateState } from "./CrateState.js";
import { PlayerState } from "./PlayerState.js";
import { PowerUpState } from "./PowerUpState.js";
import { ProjectileState } from "./ProjectileState.js";

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

  /** Power-ups revealed by broken crates, waiting to be collected. */
  @type({ map: PowerUpState }) powerUps = new MapSchema<PowerUpState>();

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
  @type("uint8") minPlayersToStart: number = MATCH.MIN_PLAYERS_TO_START;
  @type("uint8") maxPlayers: number = MATCH.MAX_PLAYERS;
}
