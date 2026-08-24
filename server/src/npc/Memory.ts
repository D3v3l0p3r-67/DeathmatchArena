import type { PerceivedEnemy } from "./context.js";

/** A sound only updates knowledge older than this, in ms. */
const HEARING_STALENESS_MS = 700;

/** One enemy as this NPC last saw them. */
export interface EnemyMemory {
  enemyId: string;
  name: string;
  lastSeenX: number;
  lastSeenY: number;
  lastSeenVelocityX: number;
  lastSeenVelocityY: number;
  lastSeenHealth: number;
  lastSeenWeaponId: string;
  lastSeenAt: number;
}

/**
 * What an NPC remembers about enemies it can no longer see.
 *
 * This is the difference between an opponent and a turret. Without it a bot
 * loses interest the instant you step behind a wall; with it, it walks to where
 * you went, looks for a couple of seconds, and gives up -- which is roughly what
 * a person does, and reads as intent rather than as a bug.
 *
 * Deliberately forgetful, and how forgetful is a profile setting: a Hunter keeps
 * you in mind for six seconds, a Berserker for one and a half.
 */
export class Memory {
  private readonly entries = new Map<string, EnemyMemory>();

  /**
   * Record a sound: somebody's gunfire, placed where the bullet was heard.
   *
   * Coarser than a sighting on purpose -- the position is the projectile's,
   * not the shooter's, so it is off by however far the bullet has flown -- and
   * it never overwrites a fresher piece of knowledge. What it buys is the
   * thing every bot lacked: a reason to go *somewhere in particular* when
   * nobody is in view. Two bots in one arena used to wander past each other
   * for entire matches in silence; gunfire is loud, and a person turns
   * towards it.
   */
  hear(enemyId: string, name: string, x: number, y: number, now: number): void {
    const known = this.entries.get(enemyId);
    if (known && now - known.lastSeenAt < HEARING_STALENESS_MS) return;

    this.entries.set(enemyId, {
      enemyId,
      name,
      lastSeenX: x,
      lastSeenY: y,
      lastSeenVelocityX: 0,
      lastSeenVelocityY: 0,
      lastSeenHealth: known?.lastSeenHealth ?? 1,
      lastSeenWeaponId: known?.lastSeenWeaponId ?? "",
      lastSeenAt: now,
    });
  }

  /** Record a sighting. Called for every enemy actually in view. */
  see(enemy: PerceivedEnemy, now: number): void {
    this.entries.set(enemy.sessionId, {
      enemyId: enemy.sessionId,
      name: enemy.name,
      lastSeenX: enemy.x,
      lastSeenY: enemy.y,
      lastSeenVelocityX: enemy.velocityX,
      lastSeenVelocityY: enemy.velocityY,
      lastSeenHealth: enemy.health,
      lastSeenWeaponId: enemy.weaponId,
      lastSeenAt: now,
    });
  }

  /** Everything still remembered, oldest sightings dropped. */
  recall(now: number, durationMs: number): EnemyMemory[] {
    const alive: EnemyMemory[] = [];

    for (const [id, entry] of this.entries) {
      if (now - entry.lastSeenAt > durationMs) {
        this.entries.delete(id);
        continue;
      }
      alive.push(entry);
    }

    return alive;
  }

  get(enemyId: string): EnemyMemory | null {
    return this.entries.get(enemyId) ?? null;
  }

  /** Drop one enemy, e.g. once they are dead or gone. */
  forget(enemyId: string): void {
    this.entries.delete(enemyId);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
