import { GameMode as GameModeId, type FlagHuntConfig, type MatchStanding } from "@deathmatch/shared";
import type { PlayerState } from "../rooms/schema/PlayerState.js";
import { FlagSystem } from "./FlagSystem.js";
import type { GameMode, GameModeServices } from "./GameMode.js";

/**
 * Flag Hunt: hold the most flags when the clock runs out.
 *
 * Kills move flags around -- a death drops a share of them where the victim
 * fell -- but never decide the winner, and never end the match: the dead come
 * back after a short delay. The score is `flagCount`, the clock is the mode,
 * and a tie at full time goes to sudden death: the clock stops, one extra flag
 * appears, and the first of the tied players to gain any flag takes the match.
 *
 * The tie-break lives in its own pair of methods (`enterSuddenDeath`,
 * `resolveCollection`) precisely so a different policy -- overtime, shared
 * win, golden kill -- is a local edit rather than surgery.
 */
export class FlagHuntMode implements GameMode {
  readonly id = GameModeId.FLAG_HUNT;

  private readonly flags: FlagSystem;
  private endsAt = 0;
  /** Dead players and when they come back. */
  private readonly respawnsAt = new Map<string, number>();
  /** The players a sudden death is between, empty outside one. */
  private readonly contenders = new Set<string>();

  constructor(private readonly services: GameModeServices) {
    this.flags = new FlagSystem(services.context);
  }

  private get config(): FlagHuntConfig {
    return this.services.context.config.getFlagHuntConfig();
  }

  onMatchStarted(now: number): void {
    this.endsAt = now + this.config.matchDurationMs;
    this.flags.start(now);
    this.publishClock(now);
  }

  update(now: number): void {
    const state = this.services.context.state;

    // A walkover ends the match at once: with one participant left connected
    // there is nobody to take flags from, and a clock running for a solo
    // player is a room being held hostage.
    const participants = Array.from(state.players.values()).filter(
      (player) => player.connected && player.inMatch,
    );
    if (participants.length <= 1) {
      this.services.finish(participants[0] ?? null, now);
      return;
    }

    for (const collector of this.flags.update(now)) {
      this.resolveCollection(collector, now);
    }

    this.updateRespawns(now);

    if (!state.suddenDeath) {
      this.publishClock(now);
      if (now >= this.endsAt) this.resolveFullTime(now);
    }
  }

  onEliminated(victim: PlayerState, _killer: PlayerState | null, now: number): void {
    this.flags.dropFrom(victim, now);
    // The dead come back; the delay is what a death costs beside the flags.
    this.respawnsAt.set(victim.sessionId, now + this.config.respawnDelayMs);
  }

  killEndsMatch(): boolean {
    return false;
  }

  /** Nobody places by dying here: the table is ranked when the clock says so. */
  placementOnDeath(): null {
    return null;
  }

  buildStandings(): MatchStanding[] {
    const players = Array.from(this.services.context.state.players.values()).filter(
      (player) => player.inMatch || player.placement > 0,
    );

    const ranked = players.sort(
      (a, b) => b.flagCount - a.flagCount || b.kills - a.kills || a.name.localeCompare(b.name),
    );

    // Stamped here, the one place the final order exists, so careers record
    // the same table the players are shown. The winner's placement may already
    // be 1 from `finish`; the ranking reproduces it.
    return ranked.map<MatchStanding>((player, index) => {
      player.placement = index + 1;
      return {
        sessionId: player.sessionId,
        name: player.name,
        kills: player.kills,
        flags: player.flagCount,
        placement: index + 1,
      };
    });
  }

  pickTimeoutWinner(): PlayerState | null {
    return this.leaders()[0] ?? null;
  }

  onMatchEnded(): void {
    this.flags.clear();
    this.respawnsAt.clear();
    this.contenders.clear();
    const state = this.services.context.state;
    state.suddenDeath = false;
    state.matchTimeRemainingSeconds = 0;
  }

  // -------------------------------------------------------------------------
  // The clock, and what happens when it runs out
  // -------------------------------------------------------------------------

  private publishClock(now: number): void {
    const state = this.services.context.state;
    const seconds = Math.max(0, Math.ceil((this.endsAt - now) / 1000));
    if (seconds !== state.matchTimeRemainingSeconds) state.matchTimeRemainingSeconds = seconds;
  }

  private resolveFullTime(now: number): void {
    const leaders = this.leaders();

    if (leaders.length <= 1 || !this.config.suddenDeathEnabled) {
      // With sudden death off a tie stands, and the ranking's own secondary
      // order (kills, then name) picks the winner -- deliberately deterministic
      // rather than a coin toss nobody can inspect.
      this.services.finish(leaders[0] ?? null, now);
      return;
    }

    this.enterSuddenDeath(leaders, now);
  }

  /**
   * The clock stops, one extra flag appears, and the match belongs to the
   * first of the tied players to gain any flag -- this one, a scheduled one,
   * or one shaken out of an opponent.
   */
  private enterSuddenDeath(leaders: PlayerState[], now: number): void {
    const state = this.services.context.state;
    state.suddenDeath = true;
    state.matchTimeRemainingSeconds = 0;

    this.contenders.clear();
    for (const leader of leaders) this.contenders.add(leader.sessionId);

    this.flags.spawnExtraFlag(now);
    this.services.context.logger.info("Sudden death", { contenders: leaders.map((p) => p.name) });
  }

  /** Every flag collection lands here; in sudden death it can end the match. */
  private resolveCollection(collector: PlayerState, now: number): void {
    if (!this.services.context.state.suddenDeath) return;
    if (!this.contenders.has(collector.sessionId)) return;
    this.services.finish(collector, now);
  }

  // -------------------------------------------------------------------------
  // Respawns
  // -------------------------------------------------------------------------

  private updateRespawns(now: number): void {
    if (this.respawnsAt.size === 0) return;

    for (const [sessionId, dueAt] of Array.from(this.respawnsAt)) {
      if (now < dueAt) continue;
      this.respawnsAt.delete(sessionId);

      const player = this.services.context.state.players.get(sessionId);
      // Somebody who left while dead stays gone; their flags already dropped.
      if (!player || !player.connected || !player.inMatch || player.alive) continue;
      this.services.respawn(player, now);
    }
  }

  /** Everybody tied on the current maximum flag count. */
  private leaders(): PlayerState[] {
    const players = Array.from(this.services.context.state.players.values()).filter(
      (player) => player.inMatch && player.connected,
    );
    if (players.length === 0) return [];

    const max = players.reduce((best, player) => Math.max(best, player.flagCount), 0);
    return players
      .filter((player) => player.flagCount === max)
      .sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name));
  }
}
