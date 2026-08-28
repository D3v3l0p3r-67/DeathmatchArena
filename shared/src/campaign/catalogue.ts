/**
 * The campaign's stock content: enemy types, difficulties, scoring.
 *
 * All of it is data. An enemy variant is a new entry; a rebalanced difficulty
 * is an edited number. The engine never mentions any id in here.
 */
import {
  ASSAULT_RIFLE_ID,
  CHAINSAW_ID,
  FLAMETHROWER_ID,
  ROCKET_LAUNCHER_ID,
  SHOTGUN_ID,
  SMG_ID,
  SNIPER_ID,
} from "../config/defaults.js";
import type {
  CampaignDifficultyDefinition,
  CampaignDifficultyId,
  CampaignEnemyDefinition,
  CampaignScoringConfig,
} from "./types.js";

/**
 * Enemy types differ in behaviour first: each rides a different brain profile
 * from the shared personality catalogue, so a Runner *plays* differently from
 * a Sniper, not merely with different numbers.
 */
export const CAMPAIGN_ENEMIES: readonly CampaignEnemyDefinition[] = [
  {
    // Walks a beat, engages on sight; the rank and file.
    id: "soldier",
    name: "Soldier",
    profile: "balanced",
    skill: 2,
    weapon: ASSAULT_RIFLE_ID,
    health: 70,
    speed: 0.9,
    grenades: 0,
    points: 100,
    color: 0x8fa8c8,
  },
  {
    // Closes distance and does not stop; dangerous only up close.
    id: "runner",
    name: "Runner",
    profile: "rusher",
    skill: 3,
    weapon: CHAINSAW_ID,
    health: 55,
    speed: 1.25,
    grenades: 0,
    points: 150,
    color: 0xffa94d,
  },
  {
    // Sits far back, watches a long way, punishes standing still.
    id: "sniper",
    name: "Sniper",
    profile: "camper",
    skill: 3,
    weapon: SNIPER_ID,
    health: 60,
    speed: 0.8,
    grenades: 0,
    detectionRange: 1600,
    points: 200,
    color: 0xb39ddb,
  },
  {
    // Lobs grenades over whatever the player is hiding behind.
    id: "grenadier",
    name: "Grenadier",
    profile: "grenadier",
    skill: 3,
    weapon: SMG_ID,
    health: 80,
    speed: 0.85,
    grenades: 6,
    points: 200,
    color: 0x9ccc65,
  },
  {
    // Slow, hard to bring down, devastating in the open.
    id: "heavy",
    name: "Heavy",
    profile: "aggressive",
    skill: 3,
    weapon: SHOTGUN_ID,
    health: 220,
    speed: 0.55,
    grenades: 0,
    points: 300,
    color: 0xef5350,
  },
  {
    // An emplacement: never moves, never stops watching its arc.
    id: "turret",
    name: "Turret",
    profile: "camper",
    skill: 3,
    weapon: SMG_ID,
    health: 120,
    speed: 0,
    grenades: 0,
    stationary: true,
    detectionRange: 1100,
    points: 250,
    color: 0x90a4ae,
  },
  {
    // The boss chassis; the level's phase table does the rest.
    id: "warden",
    name: "Warden",
    profile: "aggressive",
    skill: 4,
    weapon: SHOTGUN_ID,
    health: 900,
    speed: 0.6,
    grenades: 4,
    detectionRange: 1400,
    points: 1500,
    color: 0xff5f6d,
    bodyScale: 1.35,
  },
] as const;

export function getCampaignEnemy(id: string): CampaignEnemyDefinition | null {
  return CAMPAIGN_ENEMIES.find((enemy) => enemy.id === id) ?? null;
}

/**
 * Difficulty reshapes the fight, not just the numbers: the skill shift moves
 * every enemy along the same bot ladder multiplayer uses (reactions, aim,
 * prediction, decision quality, damage dealt and taken), and level content can
 * gate extra spawns per difficulty on top.
 */
export const CAMPAIGN_DIFFICULTIES: readonly CampaignDifficultyDefinition[] = [
  { id: "easy", name: "Easy", skillShift: -1, enemyHealthScale: 0.75, scoreScale: 0.8 },
  { id: "normal", name: "Normal", skillShift: 0, enemyHealthScale: 1, scoreScale: 1 },
  { id: "hard", name: "Hard", skillShift: 1, enemyHealthScale: 1.2, scoreScale: 1.15 },
  { id: "extreme", name: "Extreme", skillShift: 2, enemyHealthScale: 1.45, scoreScale: 1.3 },
] as const;

export function getCampaignDifficulty(id: CampaignDifficultyId): CampaignDifficultyDefinition {
  return CAMPAIGN_DIFFICULTIES.find((difficulty) => difficulty.id === id) ?? CAMPAIGN_DIFFICULTIES[1]!;
}

export const CAMPAIGN_SCORING: CampaignScoringConfig = {
  comboWindowMs: 4000,
  comboStepPercent: 25,
  comboCapPercent: 100,
  deathPenalty: 400,
  timeBonusMaxPoints: 3000,
  accuracyBonusMaxPoints: 2000,
  defaultSecretPoints: 500,
  rankThresholds: { S: 0.9, A: 0.75, B: 0.55, C: 0.35 },
};

/** Weapons an unused import guard would otherwise flag; re-exported for level authors. */
export const CAMPAIGN_WEAPONS = {
  ASSAULT_RIFLE_ID,
  SHOTGUN_ID,
  SMG_ID,
  SNIPER_ID,
  ROCKET_LAUNCHER_ID,
  FLAMETHROWER_ID,
  CHAINSAW_ID,
} as const;
