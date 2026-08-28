/**
 * Who is on the field, and in whose name.
 *
 * Every campaign enemy belongs to a named group -- a patrol, an encounter
 * wave, the boss's adds -- and the roster is the one place that knows when a
 * group has no one left, which is what half the level's triggers are waiting
 * to hear. It also sweeps corpses: a body that has finished its death
 * animation stops costing anything.
 */
import {
  getCampaignEnemy,
  type CampaignDifficultyId,
  type CampaignEnemySpawn,
} from "@deathmatch/shared";
import type { LocalMatch } from "../sim/LocalMatch.js";

export interface RosterEntry {
  group: string;
  typeId: string;
  points: number;
  diedAt: number;
}

/** How long a body lies where it fell before it is swept. */
const CORPSE_MS = 5000;

export class EnemyRoster {
  /** Alive members per group. */
  private readonly alive = new Map<string, Set<string>>();
  private readonly entries = new Map<string, RosterEntry>();

  constructor(
    private readonly match: LocalMatch,
    private readonly difficulty: CampaignDifficultyId,
    private readonly onGroupCleared: (group: string) => void,
  ) {}

  /**
   * Spawn a group's members, honouring per-spawn difficulty gates.
   * Returns how many actually appeared -- zero means the group is trivially
   * clear and the caller should treat it as already done.
   */
  spawnGroup(group: string, spawns: readonly CampaignEnemySpawn[]): number {
    let spawned = 0;
    for (const spawn of spawns) {
      if (spawn.difficulties && !spawn.difficulties.includes(this.difficulty)) continue;
      const definition = getCampaignEnemy(spawn.type);
      if (!definition) continue;

      const agent = this.match.spawnEnemy({
        definition,
        x: spawn.x,
        y: spawn.y,
        difficulty: this.difficulty,
      });
      if (!agent) continue;

      spawned++;
      this.entries.set(agent.sessionId, { group, typeId: definition.id, points: definition.points, diedAt: 0 });
      let members = this.alive.get(group);
      if (!members) this.alive.set(group, (members = new Set()));
      members.add(agent.sessionId);
    }
    return spawned;
  }

  /** Route a death. Returns the entry when it was one of ours. */
  handleKill(victimId: string, now: number): RosterEntry | null {
    const entry = this.entries.get(victimId);
    if (!entry || entry.diedAt !== 0) return null;
    entry.diedAt = now;

    const members = this.alive.get(entry.group);
    members?.delete(victimId);
    if (members && members.size === 0) {
      this.alive.delete(entry.group);
      this.onGroupCleared(entry.group);
    }
    return entry;
  }

  aliveInGroup(group: string): number {
    return this.alive.get(group)?.size ?? 0;
  }

  aliveTotal(): number {
    let total = 0;
    for (const members of this.alive.values()) total += members.size;
    return total;
  }

  /**
   * Remove a whole group from the world, dead or alive. No events fire.
   *
   * Returns the points and kills already earned from the group, so a reset
   * (an encounter or boss re-arming after a death) can refund them -- the
   * enemies come back, and so must the chance to earn them, exactly once.
   */
  despawnGroup(group: string): { killedPoints: number; killedCount: number } {
    let killedPoints = 0;
    let killedCount = 0;
    for (const [sessionId, entry] of Array.from(this.entries)) {
      if (entry.group !== group) continue;
      if (entry.diedAt !== 0) {
        killedPoints += entry.points;
        killedCount++;
      }
      this.match.removeEnemy(sessionId);
      this.entries.delete(sessionId);
    }
    this.alive.delete(group);
    return { killedPoints, killedCount };
  }

  despawnAll(): void {
    for (const sessionId of Array.from(this.entries.keys())) {
      this.match.removeEnemy(sessionId);
    }
    this.entries.clear();
    this.alive.clear();
  }

  /** Sweep bodies whose death animation has long finished. */
  sweep(now: number): void {
    for (const [sessionId, entry] of Array.from(this.entries)) {
      if (entry.diedAt !== 0 && now - entry.diedAt > CORPSE_MS) {
        this.match.removeEnemy(sessionId);
        this.entries.delete(sessionId);
      }
    }
  }

  entryFor(sessionId: string): RosterEntry | null {
    return this.entries.get(sessionId) ?? null;
  }
}
