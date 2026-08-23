import type { PerceivedEnemy } from "./context.js";

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
