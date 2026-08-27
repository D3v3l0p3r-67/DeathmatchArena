import { GameMode as GameModeId, type MatchStanding } from "@deathmatch/shared";
import type { PlayerState } from "../rooms/schema/PlayerState.js";
import type { GameMode, GameModeServices } from "./GameMode.js";

/**
 * Last player standing.
 *
 * The original rules, extracted verbatim from `MatchManager` when the mode
 * seam was cut: no respawns, a kill that leaves one survivor ends the match,
 * and placement counts down as players drop out -- the last of N out finishes
 * Nth. This file changing behaviour would be a bug, not a feature.
 */
export class DeathmatchMode implements GameMode {
  readonly id = GameModeId.DEATHMATCH;

  constructor(private readonly services: GameModeServices) {}

  onMatchStarted(): void {}

  update(now: number): void {
    const state = this.services.context.state;
    if (state.aliveCount <= 1) {
      const survivor = this.alivePlayers()[0] ?? null;
      this.services.finish(survivor, now);
    }
  }

  onEliminated(): void {}

  killEndsMatch(survivors: number): boolean {
    return survivors <= 1;
  }

  placementOnDeath(survivors: number): number {
    return survivors + 1;
  }

  buildStandings(): MatchStanding[] {
    const players = Array.from(this.services.context.state.players.values()).filter(
      (player) => player.placement > 0 || player.inMatch,
    );

    return players
      .map<MatchStanding>((player) => ({
        sessionId: player.sessionId,
        name: player.name,
        kills: player.kills,
        placement: player.placement > 0 ? player.placement : 1,
      }))
      .sort((a, b) => a.placement - b.placement || b.kills - a.kills);
  }

  /** Fallback "winner" when a match times out: most kills, then most health. */
  pickTimeoutWinner(): PlayerState | null {
    const alive = this.alivePlayers();
    if (alive.length === 0) return null;
    return alive.reduce((best, player) => {
      if (player.kills !== best.kills) return player.kills > best.kills ? player : best;
      return player.health > best.health ? player : best;
    });
  }

  onMatchEnded(): void {}

  private alivePlayers(): PlayerState[] {
    return Array.from(this.services.context.state.players.values()).filter(
      (player) => player.alive && player.inMatch,
    );
  }
}
