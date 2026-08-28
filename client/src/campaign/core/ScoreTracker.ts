/**
 * Single-player scoring: kills, combos, secrets, deaths, time, accuracy.
 *
 * Every formula reads `CampaignScoringConfig` -- there is not a magic number
 * in the arithmetic. Ranks are relative to what the played difficulty made
 * achievable, so one threshold table serves every level.
 */
import type {
  CampaignDifficultyId,
  CampaignLevelResult,
  CampaignRank,
  CampaignScoringConfig,
} from "@deathmatch/shared";
import { getCampaignDifficulty } from "@deathmatch/shared";

export interface ScoreSnapshot {
  points: number;
  kills: number;
  secretsFound: number;
  shots: number;
  hits: number;
  comboUntil: number;
  comboStacks: number;
}

export class ScoreTracker {
  private points = 0;
  private kills = 0;
  private deaths = 0;
  private secretsFound = 0;
  private shots = 0;
  private hits = 0;
  // Starts in the past, so the first kill of a level opens a chain rather
  // than joining one.
  private comboUntil = Number.NEGATIVE_INFINITY;
  private comboStacks = 0;

  constructor(private readonly config: CampaignScoringConfig) {}

  recordKill(basePoints: number, now: number): number {
    this.kills++;
    // Kills inside the window chain: each adds a growing share on top,
    // up to the configured cap.
    if (now <= this.comboUntil) this.comboStacks++;
    else this.comboStacks = 0;
    this.comboUntil = now + this.config.comboWindowMs;

    const bonusPercent = Math.min(
      this.comboStacks * this.config.comboStepPercent,
      this.config.comboCapPercent,
    );
    const earned = Math.round(basePoints * (1 + bonusPercent / 100));
    this.points += earned;
    return earned;
  }

  /** Take back points and kills a reset gave the world back. */
  deduct(points: number, kills: number): void {
    this.points = Math.max(0, this.points - points);
    this.kills = Math.max(0, this.kills - kills);
  }

  recordDeath(): void {
    this.deaths++;
    this.points = Math.max(0, this.points - this.config.deathPenalty);
  }

  recordSecret(points?: number): void {
    this.secretsFound++;
    this.points += points ?? this.config.defaultSecretPoints;
  }

  recordShot(): void {
    this.shots++;
  }

  recordHit(): void {
    this.hits++;
  }

  get currentPoints(): number {
    return this.points;
  }

  get currentKills(): number {
    return this.kills;
  }

  /** Everything a checkpoint needs to put back. Deaths deliberately stay. */
  snapshot(): ScoreSnapshot {
    return {
      points: this.points,
      kills: this.kills,
      secretsFound: this.secretsFound,
      shots: this.shots,
      hits: this.hits,
      comboUntil: this.comboUntil,
      comboStacks: this.comboStacks,
    };
  }

  restore(snapshot: ScoreSnapshot): void {
    this.points = snapshot.points;
    this.kills = snapshot.kills;
    this.secretsFound = snapshot.secretsFound;
    this.shots = snapshot.shots;
    this.hits = snapshot.hits;
    this.comboUntil = snapshot.comboUntil;
    this.comboStacks = snapshot.comboStacks;
  }

  accuracy(): number {
    return this.shots > 0 ? Math.min(1, this.hits / this.shots) : 0;
  }

  finalize(
    levelId: string,
    difficulty: CampaignDifficultyId,
    timeMs: number,
    parTimeMs: number,
    secretsTotal: number,
    achievableKillPoints: number,
    secretPointsTotal: number,
  ): CampaignLevelResult {
    const config = this.config;

    // Full at or under par, fading to nothing at twice par.
    const overPar = Math.max(0, timeMs - parTimeMs);
    const timeBonus = Math.round(config.timeBonusMaxPoints * Math.max(0, 1 - overPar / Math.max(1, parTimeMs)));
    const accuracyBonus = Math.round(config.accuracyBonusMaxPoints * this.accuracy());

    const difficultyScale = getCampaignDifficulty(difficulty).scoreScale;
    const score = Math.round((this.points + timeBonus + accuracyBonus) * difficultyScale);

    const achievable =
      (achievableKillPoints + secretPointsTotal + config.timeBonusMaxPoints + config.accuracyBonusMaxPoints) *
      difficultyScale;
    const fraction = achievable > 0 ? score / achievable : 0;

    const thresholds = config.rankThresholds;
    const rank: CampaignRank =
      fraction >= thresholds.S ? "S" : fraction >= thresholds.A ? "A" : fraction >= thresholds.B ? "B" : fraction >= thresholds.C ? "C" : "D";

    return {
      levelId,
      difficulty,
      score,
      kills: this.kills,
      deaths: this.deaths,
      secretsFound: this.secretsFound,
      secretsTotal,
      timeMs,
      accuracy: this.accuracy(),
      rank,
    };
  }
}
