/**
 * The boss, phase by phase -- generically.
 *
 * Nothing in here knows any particular boss: the level's definition names an
 * enemy type and a table of phases, and this director watches the health bar
 * and applies whichever row the fraction has fallen into. New attacks, adds,
 * speed-ups and messages are all rows in that table.
 */
import {
  getCampaignDifficulty,
  getCampaignEnemy,
  clamp,
  MAX_BOT_DIFFICULTY,
  MIN_BOT_DIFFICULTY,
  type CampaignBossDefinition,
  type CampaignDifficultyId,
} from "@deathmatch/shared";
import type { LocalMatch } from "../sim/LocalMatch.js";
import type { EnemyRoster } from "./EnemyRoster.js";

export const BOSS_GROUP = "boss";
export const BOSS_ADDS_GROUP = "boss-adds";

export interface BossHost {
  message(text: string, durationMs?: number): void;
  bossPhaseStarted(phase: number): void;
  bossDefeated(): void;
}

export interface BossStatus {
  name: string;
  health: number;
  maxHealth: number;
  phase: number;
}

export class BossDirector {
  private sessionId: string | null = null;
  private maxHealth = 0;
  private phaseIndex = -1;
  private defeated = false;
  /** The trigger that started the fight, so a reset can re-arm it. */
  private startedBy: string | null = null;

  constructor(
    private readonly definition: CampaignBossDefinition,
    private readonly match: LocalMatch,
    private readonly roster: EnemyRoster,
    private readonly difficulty: CampaignDifficultyId,
    private readonly host: BossHost,
  ) {}

  isActive(): boolean {
    return this.sessionId !== null && !this.defeated;
  }

  isDefeated(): boolean {
    return this.defeated;
  }

  status(): BossStatus | null {
    if (!this.sessionId || this.defeated) return null;
    const player = this.match.state.players.get(this.sessionId);
    if (!player) return null;
    return {
      name: this.definition.name,
      health: Math.max(0, player.health),
      maxHealth: this.maxHealth,
      phase: this.phaseIndex + 1,
    };
  }

  start(startedBy: string): void {
    if (this.sessionId || this.defeated) return;
    const type = getCampaignEnemy(this.definition.enemyType);
    if (!type) return;

    const scale = getCampaignDifficulty(this.difficulty).enemyHealthScale;
    this.maxHealth = Math.round(type.health * scale);
    this.startedBy = startedBy;

    const spawned = this.roster.spawnGroup(BOSS_GROUP, [
      { type: type.id, x: this.definition.x, y: this.definition.y },
    ]);
    if (spawned === 0) return;

    // The roster spawned exactly one; find it.
    for (const agent of this.match.npcs.list()) {
      if (this.roster.entryFor(agent.sessionId)?.group === BOSS_GROUP) {
        this.sessionId = agent.sessionId;
        const player = this.match.state.players.get(agent.sessionId);
        if (player) {
          player.name = this.definition.name;
          player.health = this.maxHealth;
        }
        break;
      }
    }

    this.phaseIndex = -1;
    this.update();
  }

  /** Watch the bar; apply the phase the fraction has fallen into. */
  update(): void {
    if (!this.sessionId || this.defeated) return;
    const player = this.match.state.players.get(this.sessionId);
    if (!player || this.maxHealth <= 0) return;

    const percent = (Math.max(0, player.health) / this.maxHealth) * 100;
    while (
      this.phaseIndex + 1 < this.definition.phases.length &&
      percent < this.definition.phases[this.phaseIndex + 1]!.belowHealthPercent + 1e-6
    ) {
      this.phaseIndex++;
      this.applyPhase(this.phaseIndex);
    }
  }

  /** The roster reports the boss group emptied. */
  onGroupCleared(group: string): void {
    if (group !== BOSS_GROUP || !this.sessionId || this.defeated) return;
    this.defeated = true;
    this.host.bossDefeated();
  }

  /** Death mid-fight: the boss resets to full and waits behind its trigger. */
  reset(): { startedBy: string | null; killedPoints: number; killedCount: number } | null {
    if (!this.sessionId || this.defeated) return null;
    const boss = this.roster.despawnGroup(BOSS_GROUP);
    const adds = this.roster.despawnGroup(BOSS_ADDS_GROUP);
    this.sessionId = null;
    this.phaseIndex = -1;
    const startedBy = this.startedBy;
    this.startedBy = null;
    return {
      startedBy,
      killedPoints: boss.killedPoints + adds.killedPoints,
      killedCount: boss.killedCount + adds.killedCount,
    };
  }

  private applyPhase(index: number): void {
    const phase = this.definition.phases[index]!;
    const player = this.sessionId ? this.match.state.players.get(this.sessionId) : null;
    const runtime = this.sessionId ? this.match.runtimes.get(this.sessionId) : null;
    const agent = this.sessionId ? this.match.npcs.get(this.sessionId) : null;
    if (!player || !runtime || !agent) return;

    if (phase.weapon) this.match.weapons.equip(player, runtime, phase.weapon);
    if (phase.speed !== undefined) {
      // The phase replaces the *type's* pace, not the whole hierarchy: the
      // campaign, difficulty and level layers still apply, or a slowed-down
      // tutorial would hold a full-speed boss.
      const environment = this.match.environmentTuning(this.difficulty).moveSpeedMultiplier;
      runtime.baseSpeedMultiplier = Math.max(0, phase.speed) * environment;
      runtime.movement.speedMultiplier = runtime.baseSpeedMultiplier;
      player.speedMultiplier = runtime.baseSpeedMultiplier;
    }
    if (phase.skill !== undefined) {
      agent.setDifficulty(clamp(phase.skill, MIN_BOT_DIFFICULTY, MAX_BOT_DIFFICULTY));
    }
    if (phase.stationary !== undefined) agent.stationary = phase.stationary;
    if (phase.spawnAdds && phase.spawnAdds.length > 0) {
      this.roster.spawnGroup(BOSS_ADDS_GROUP, phase.spawnAdds);
    }
    if (phase.message) this.host.message(phase.message, 3000);
    this.host.bossPhaseStarted(index + 1);
  }
}
