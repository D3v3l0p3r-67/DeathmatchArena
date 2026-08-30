/**
 * Held fights: the camera locks, waves come, the last body opens the way.
 *
 * One instance runs a level's worth of encounters, one active at a time --
 * campaign levels are linear, and two simultaneous locked fights would be
 * fighting over one camera anyway. Completion is reported back through the
 * trigger engine, so what happens next is the level's business.
 */
import type { CampaignBoundaryOptions, CampaignEncounterDefinition } from "@deathmatch/shared";
import type { EnemyRoster } from "./EnemyRoster.js";

export interface EncounterHost {
  lockCamera(zoneId: string, boundary?: CampaignBoundaryOptions): void;
  unlockCamera(): void;
  encounterCompleted(encounterId: string): void;
}

interface ActiveEncounter {
  definition: CampaignEncounterDefinition;
  waveIndex: number;
  /** The trigger that started it, so a reset can re-arm it. */
  startedBy: string;
}

export class EncounterDirector {
  private active: ActiveEncounter | null = null;
  private readonly completed = new Set<string>();

  constructor(
    private readonly encounters: readonly CampaignEncounterDefinition[],
    private readonly roster: EnemyRoster,
    private readonly host: EncounterHost,
  ) {}

  isActive(): boolean {
    return this.active !== null;
  }

  isCompleted(id: string): boolean {
    return this.completed.has(id);
  }

  completedIds(): string[] {
    return Array.from(this.completed);
  }

  restoreCompleted(ids: readonly string[]): void {
    this.completed.clear();
    for (const id of ids) this.completed.add(id);
  }

  start(encounterId: string, startedBy: string): void {
    if (this.active || this.completed.has(encounterId)) return;
    const definition = this.encounters.find((encounter) => encounter.id === encounterId);
    if (!definition) return;

    this.active = { definition, waveIndex: -1, startedBy };
    if (definition.lockCameraZone) this.host.lockCamera(definition.lockCameraZone, definition.boundary);
    this.advance();
  }

  /** The roster reports a group emptied; ours means the wave fell. */
  onGroupCleared(group: string): void {
    if (!this.active) return;
    if (group !== this.waveGroup(this.active.definition.id, this.active.waveIndex)) return;
    this.advance();
  }

  /**
   * Death mid-encounter: the fight resets. Its enemies leave, the trigger that
   * started it re-arms (the director handles that via `startedBy`), and the
   * player walks back into a fresh wave one.
   */
  reset(): { startedBy: string; killedPoints: number; killedCount: number } | null {
    if (!this.active) return null;
    const { definition, waveIndex, startedBy } = this.active;
    let killedPoints = 0;
    let killedCount = 0;
    for (let wave = 0; wave <= waveIndex; wave++) {
      const refund = this.roster.despawnGroup(this.waveGroup(definition.id, wave));
      killedPoints += refund.killedPoints;
      killedCount += refund.killedCount;
    }
    if (definition.lockCameraZone) this.host.unlockCamera();
    this.active = null;
    return { startedBy, killedPoints, killedCount };
  }

  private advance(): void {
    const active = this.active;
    if (!active) return;

    // Skip waves the difficulty filter left empty rather than stalling on them.
    while (active.waveIndex + 1 < active.definition.waves.length) {
      active.waveIndex++;
      const wave = active.definition.waves[active.waveIndex]!;
      const spawned = this.roster.spawnGroup(
        this.waveGroup(active.definition.id, active.waveIndex),
        wave.enemies,
      );
      if (spawned > 0) return;
    }

    // Every wave down: the fight is over.
    this.completed.add(active.definition.id);
    if (active.definition.lockCameraZone) this.host.unlockCamera();
    const id = active.definition.id;
    this.active = null;
    this.host.encounterCompleted(id);
  }

  private waveGroup(encounterId: string, waveIndex: number): string {
    return `encounter:${encounterId}:${waveIndex}`;
  }
}
