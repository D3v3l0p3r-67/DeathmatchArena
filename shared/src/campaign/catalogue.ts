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
    // Closes to burning range and stays there: the answer is distance, and
    // never letting it choose the distance.
    id: "enforcer",
    name: "Enforcer",
    profile: "berserker",
    skill: 3,
    weapon: FLAMETHROWER_ID,
    health: 130,
    speed: 1.05,
    grenades: 0,
    points: 250,
    color: 0xff8a3d,
  },
  {
    // A rifle on a tripod: never moves, sees most of a hall, and makes a long
    // straight run across one a bad idea.
    id: "marksman",
    name: "Marksman",
    profile: "camper",
    skill: 4,
    weapon: SNIPER_ID,
    health: 90,
    speed: 0,
    grenades: 0,
    stationary: true,
    detectionRange: 2000,
    points: 300,
    color: 0x7fd4ff,
  },
  {
    // Area denial: hangs back and puts rockets where you were going.
    id: "zealot",
    name: "Zealot",
    profile: "defensive",
    skill: 3,
    weapon: ROCKET_LAUNCHER_ID,
    health: 140,
    speed: 0.8,
    grenades: 2,
    detectionRange: 1500,
    points: 350,
    color: 0xd08bff,
  },
  {
    // The boss chassis; the level's phase table does the rest.
    id: "warden",
    name: "Warden",
    profile: "aggressive",
    // Skill 3, down from 4: the first boss should telegraph, not snipe. Its
    // menace is the phase table, not its aim.
    skill: 3,
    weapon: SHOTGUN_ID,
    // 750, down from 900. Measured with a plainly competent test player: at
    // 900 the fight outlasted the player's margin for error; at 750 the boss
    // still takes the better part of a magazine-cycle to fall.
    health: 750,
    speed: 0.6,
    grenades: 2,
    detectionRange: 1400,
    // The type layer of the tuning hierarchy: an opening boss shoots a shade
    // slower and notices a shade later than its profile would.
    projectileSpeed: 0.9,
    fireRate: 0.9,
    reactionTime: 1.1,
    points: 1500,
    color: 0xff5f6d,
    bodyScale: 1.35,
  },
  {
    // The refinery's boss: an emplaced gun that eventually tears loose.
    id: "foreman",
    name: "Foreman",
    profile: "camper",
    skill: 4,
    weapon: ROCKET_LAUNCHER_ID,
    health: 1100,
    speed: 0.5,
    grenades: 0,
    stationary: true,
    detectionRange: 2200,
    points: 1800,
    color: 0xffb347,
    bodyScale: 1.4,
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
/*
 * The difficulty layer of the tuning hierarchy (see `tuning.ts`). `skillShift`
 * already makes enemies play *better* up the ladder; these make them faster.
 * Hard is the reference point -- multipliers of 1 -- with the easier rungs
 * slowed and Extreme pushed slightly past authored speed.
 */
export const CAMPAIGN_DIFFICULTIES: readonly CampaignDifficultyDefinition[] = [
  {
    id: "easy",
    name: "Easy",
    skillShift: -1,
    enemyHealthScale: 0.75,
    scoreScale: 0.8,
    enemyTuning: { moveSpeed: 0.85, projectileSpeed: 0.8, fireRate: 0.85, reactionTime: 1.3 },
  },
  {
    id: "normal",
    name: "Normal",
    skillShift: 0,
    enemyHealthScale: 1,
    scoreScale: 1,
    enemyTuning: { moveSpeed: 0.95, projectileSpeed: 0.9, fireRate: 0.95, reactionTime: 1.1 },
  },
  { id: "hard", name: "Hard", skillShift: 1, enemyHealthScale: 1.2, scoreScale: 1.15 },
  {
    id: "extreme",
    name: "Extreme",
    skillShift: 2,
    enemyHealthScale: 1.45,
    scoreScale: 1.3,
    enemyTuning: { moveSpeed: 1.05, projectileSpeed: 1.1, fireRate: 1.05, reactionTime: 0.85 },
  },
] as const;

export function getCampaignDifficulty(id: CampaignDifficultyId): CampaignDifficultyDefinition {
  return CAMPAIGN_DIFFICULTIES.find((difficulty) => difficulty.id === id) ?? CAMPAIGN_DIFFICULTIES[1]!;
}

/**
 * How many attempts a level allows before the run is over.
 *
 * Checkpoints decide *where* a death puts the player back; this decides how
 * many times. Unlimited retries make a level a formality -- you eventually walk
 * through anything one metre at a time -- so a level is worth two attempts, and
 * the second failure ends the run rather than the level.
 *
 * One number, here, because it is a rule about the campaign rather than about
 * any one level. A level that wants something else still says so in its own
 * `respawnRule`: a boss rush could ask for `oneLife`, a tutorial for
 * `checkpoint`.
 */
export const CAMPAIGN_LIVES = 2;

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
