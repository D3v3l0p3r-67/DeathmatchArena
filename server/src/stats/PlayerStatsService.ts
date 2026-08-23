/**
 * A player's record across matches.
 *
 * Deliberately small: matches played, matches won, kills, deaths, and the best
 * placement ever reached. Enough to answer "am I getting better?", which is the
 * only question this feature exists to answer.
 *
 * Everything is held in memory and written through to the repository, because a
 * match ending must never wait on a disk write -- the results screen is already
 * on its way to the clients by then. A failed write is logged and dropped: losing
 * a kill count is not worth interrupting a game for.
 */
import type { CareerUpdate, PlayerCareer } from "@deathmatch/shared";
import type { Logger } from "../utils/logger.js";
import type { CareerTable, PlayerStatsRepository } from "./PlayerStatsRepository.js";

/** A career with nothing in it yet. */
export function emptyCareer(): PlayerCareer {
  return { matches: 0, wins: 0, kills: 0, deaths: 0, bestPlacement: 0 };
}

export class PlayerStatsService {
  private table: CareerTable = {};
  private loaded = false;
  /** Set while a write is queued, so a busy room writes once rather than per match. */
  private writing: Promise<void> | null = null;

  constructor(
    private readonly repository: PlayerStatsRepository,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.table = await this.repository.read();
    this.loaded = true;
  }

  /**
   * What this player has done so far.
   *
   * Never null: somebody's first match is a career of zeroes rather than an
   * absence the caller has to think about.
   */
  get(playerId: string): PlayerCareer {
    return { ...(this.table[playerId] ?? emptyCareer()) };
  }

  /**
   * Fold one match into everybody's record.
   *
   * Returns the updated careers, keyed by player id, so the room can tell each
   * player their own without reading them back one at a time.
   */
  record(updates: readonly CareerUpdate[]): Map<string, PlayerCareer> {
    const results = new Map<string, PlayerCareer>();

    for (const update of updates) {
      if (!update.playerId) continue;

      const career = this.table[update.playerId] ?? emptyCareer();
      const placement = update.placement > 0 ? update.placement : 0;

      const next: PlayerCareer = {
        matches: career.matches + 1,
        wins: career.wins + (placement === 1 ? 1 : 0),
        kills: career.kills + Math.max(0, update.kills),
        deaths: career.deaths + Math.max(0, update.deaths),
        // Lower is better, and zero means "never finished one", so the first
        // real placement always wins against it.
        bestPlacement:
          placement > 0 && (career.bestPlacement === 0 || placement < career.bestPlacement)
            ? placement
            : career.bestPlacement,
      };

      this.table[update.playerId] = next;
      results.set(update.playerId, { ...next });
    }

    if (results.size > 0) this.scheduleWrite();
    return results;
  }

  /**
   * Persist, eventually.
   *
   * Coalesced on purpose: several rooms finishing at once should produce one
   * write, and none of them should be waiting for it.
   */
  private scheduleWrite(): void {
    if (this.writing) return;

    this.writing = Promise.resolve().then(async () => {
      this.writing = null;
      try {
        await this.repository.write(this.table);
      } catch (error) {
        this.logger.warn("Could not store player statistics", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }
}
