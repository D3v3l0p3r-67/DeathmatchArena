/**
 * The level's whole scripting engine: when X happens, do Y.
 *
 * Everything a level makes happen -- spawns, encounters, breaches, messages,
 * checkpoints, the boss, the finish line -- goes through here as data. There
 * is deliberately no way to write `if (levelId === "..." && player.x > ...)`
 * anywhere else: a level that wants a special moment declares a trigger.
 *
 * Two evaluation styles, matching the two kinds of condition:
 * - polled (`enterZone`, `playerHealthBelow`, `timerElapsed`) are checked
 *   every update, so a `requires` gate that is not yet met simply waits;
 * - event-driven (`enemiesKilled`, `encounterCompleted`, ...) fire the moment
 *   the campaign reports the event.
 */
import type {
  CampaignTriggerAction,
  CampaignTriggerDefinition,
  CampaignZone,
} from "@deathmatch/shared";

export interface TriggerHost {
  playerX(): number;
  playerY(): number;
  /** 0..1 of maximum. */
  playerHealthPercent(): number;
  /** Carry one action out. The host owns every side effect. */
  execute(action: CampaignTriggerAction, triggerId: string): void;
}

function inside(zone: CampaignZone, x: number, y: number): boolean {
  return x >= zone.x && x <= zone.x + zone.width && y >= zone.y && y <= zone.y + zone.height;
}

export class TriggerEngine {
  /** Ids that have fired, and when -- `timerElapsed` counts from these. */
  private readonly firedAt = new Map<string, number>();
  private levelStartedAt = 0;

  constructor(
    private readonly triggers: readonly CampaignTriggerDefinition[],
    private readonly host: TriggerHost,
  ) {}

  /** Which triggers have fired, for checkpoint snapshots. */
  firedIds(): string[] {
    return Array.from(this.firedAt.keys());
  }

  hasFired(id: string): boolean {
    return this.firedAt.has(id);
  }

  /** Put the fired set back to a snapshot, re-arming everything after it. */
  restoreFired(ids: readonly string[], now: number): void {
    const keep = new Set(ids);
    for (const id of Array.from(this.firedAt.keys())) {
      if (!keep.has(id)) this.firedAt.delete(id);
    }
    for (const id of keep) {
      if (!this.firedAt.has(id)) this.firedAt.set(id, now);
    }
  }

  /** Re-arm one trigger so it can fire again (encounter and boss resets). */
  rearm(id: string): void {
    this.firedAt.delete(id);
  }

  start(now: number): void {
    this.levelStartedAt = now;
    for (const trigger of this.triggers) {
      if (trigger.when.kind === "levelStarted") this.tryFire(trigger, now);
    }
  }

  /** Poll the position-, health- and clock-shaped conditions. */
  update(now: number): void {
    const x = this.host.playerX();
    const y = this.host.playerY();

    for (const trigger of this.triggers) {
      const when = trigger.when;
      if (when.kind === "enterZone") {
        if (inside(when.zone, x, y)) this.tryFire(trigger, now);
      } else if (when.kind === "playerHealthBelow") {
        if (this.host.playerHealthPercent() * 100 < when.percent) this.tryFire(trigger, now);
      } else if (when.kind === "timerElapsed") {
        const since = when.sinceTriggerId ? this.firedAt.get(when.sinceTriggerId) : this.levelStartedAt;
        if (since !== undefined && now - since >= when.afterMs) this.tryFire(trigger, now);
      }
    }
  }

  // -- The campaign reports; matching triggers fire. --------------------------

  notifyEnemiesKilled(group: string, now: number): void {
    this.fireEvent((when) => when.kind === "enemiesKilled" && when.group === group, now);
  }

  notifyEncounterCompleted(encounterId: string, now: number): void {
    this.fireEvent((when) => when.kind === "encounterCompleted" && when.encounterId === encounterId, now);
  }

  notifyObjectsDestroyed(group: string, now: number): void {
    this.fireEvent((when) => when.kind === "objectsDestroyed" && when.group === group, now);
  }

  notifyCheckpointReached(checkpointId: string, now: number): void {
    this.fireEvent((when) => when.kind === "checkpointReached" && when.checkpointId === checkpointId, now);
  }

  notifyBossPhase(phase: number, now: number): void {
    this.fireEvent((when) => when.kind === "bossPhase" && when.phase === phase, now);
  }

  notifyBossDefeated(now: number): void {
    this.fireEvent((when) => when.kind === "bossDefeated", now);
  }

  // ---------------------------------------------------------------------------

  private fireEvent(matches: (when: CampaignTriggerDefinition["when"]) => boolean, now: number): void {
    for (const trigger of this.triggers) {
      if (matches(trigger.when)) this.tryFire(trigger, now);
    }
  }

  private tryFire(trigger: CampaignTriggerDefinition, now: number): void {
    if (this.firedAt.has(trigger.id) && trigger.repeat !== true) return;
    for (const required of trigger.requires ?? []) {
      if (!this.firedAt.has(required)) return;
    }

    this.firedAt.set(trigger.id, now);
    for (const action of trigger.actions) {
      this.host.execute(action, trigger.id);
    }
  }
}
