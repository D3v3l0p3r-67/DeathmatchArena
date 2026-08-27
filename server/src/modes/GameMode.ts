import type { GameModeValue, MatchStanding } from "@deathmatch/shared";
import type { RoomContext } from "../rooms/RoomContext.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";

/**
 * The rule set a match is played under.
 *
 * `MatchManager` owns the shared lifecycle -- waiting, countdown, spawning,
 * results, careers -- and asks the mode every question whose answer depends on
 * the rules: does this kill end the match, does the victim come back, who is
 * winning, what do the standings say. Movement, weapons, damage, power-ups and
 * networking never change between modes, which is the whole point of the seam:
 * a new mode (capture the flag, king of the hill, teams) is a new file here,
 * not edits to the systems.
 *
 * A mode instance lives for exactly one match. `MatchManager` builds a fresh
 * one at the countdown's end from the room's `gameModeId`, so a mode may keep
 * per-match state in plain fields without ever cleaning up after itself.
 */
/**
 * Facts about a mode the rest of the room consults, rather than questions it
 * asks per event.
 *
 * Shared mechanics that a mode can veto belong here -- the closing walls being
 * the first -- so a system checks one flag instead of knowing mode ids, and the
 * client learns everything it needs from the state the server publishes.
 * Read live (a method, not a constant) so a value backed by configuration can
 * be retuned mid-match through the debug console like any other setting.
 */
export interface GameModeTraits {
  /** Whether this mode's matches run on a published clock. */
  timedMatch: boolean;
  /** Whether the closing-walls mechanic runs during this mode's matches. */
  arenaShrinking: boolean;
}

export interface GameMode {
  readonly id: GameModeValue;

  /** What this mode is like. See `GameModeTraits`. */
  traits(): GameModeTraits;

  /** The match has just started: every participant is spawned and playing. */
  onMatchStarted(now: number): void;

  /** One tick while the match is PLAYING. Ends the match via `services.finish`. */
  update(now: number): void;

  /** After the shared elimination bookkeeping, before anything else reacts. */
  onEliminated(victim: PlayerState, killer: PlayerState | null, now: number): void;

  /** Whether a kill leaving `survivors` alive decides the match. */
  killEndsMatch(survivors: number): boolean;

  /**
   * Placement stamped on a victim at the moment of death, or null to leave it
   * for the end of the match. Last-player-standing counts down as players drop
   * out; a timed mode ranks everybody only once the clock says so.
   */
  placementOnDeath(survivors: number): number | null;

  /**
   * The final table. May stamp `placement` onto the players as a side effect --
   * it runs before careers are recorded, and is the one place a timed mode
   * knows the order.
   */
  buildStandings(): MatchStanding[];

  /** Winner when the match is cut short from outside (the duration valve). */
  pickTimeoutWinner(): PlayerState | null;

  /** The match is over, whoever ended it. Clear anything the mode spawned. */
  onMatchEnded(now: number): void;
}

/**
 * What a mode may do to the match.
 *
 * A deliberately narrow slice of `MatchManager`: modes decide *when* somebody
 * respawns or the match ends, the manager still owns *how* -- spawn points,
 * result broadcasting, careers, the room reset.
 */
export interface GameModeServices {
  readonly context: RoomContext;
  /** Bring a dead player back into the running match at a fresh spawn. */
  respawn(player: PlayerState, now: number): void;
  /** End the match with this winner (null: nobody won). */
  finish(winner: PlayerState | null, now: number): void;
}
