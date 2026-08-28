/**
 * The campaign's data model.
 *
 * Everything a single-player level *is* lives in these shapes: enemies,
 * triggers, encounters, checkpoints, camera zones, the boss, the scoring. The
 * campaign engine on the client interprets them; nothing in here executes.
 * That split is the whole point -- a new level, enemy type or boss is a new
 * value of these types, never an edit to the engine.
 *
 * Kept in the shared package even though only the client simulates, so a
 * future server-side verification of a claimed result can replay or sanity-
 * check against the very same definitions the client played.
 */

/** An axis-aligned area of the level, in world px. */
export interface CampaignZone {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

export type CampaignDifficultyId = "easy" | "normal" | "hard" | "extreme";

export interface CampaignDifficultyDefinition {
  id: CampaignDifficultyId;
  name: string;
  /**
   * How many rungs of the shared bot-difficulty ladder every enemy shifts.
   *
   * The ladder already changes *behaviour* -- reaction time, aim, prediction,
   * decision quality, damage dealt and taken -- so difficulty here is mostly
   * "the same enemies play better", not "the same enemies are spongier".
   */
  skillShift: number;
  /** Multiplier on each enemy type's configured health. */
  enemyHealthScale: number;
  /** Multiplier on the final score, so harder runs are worth more. */
  scoreScale: number;
}

// ---------------------------------------------------------------------------
// Enemies
// ---------------------------------------------------------------------------

/**
 * One kind of opponent.
 *
 * Behaviour comes from the shared brain-profile catalogue (the same
 * personalities multiplayer bots use) plus a rung on the bot ladder; the rest
 * is presentation and loadout. Variants are new entries here, never new code.
 */
export interface CampaignEnemyDefinition {
  id: string;
  name: string;
  /** Brain personality id from `npc.profiles`. */
  profile: string;
  /** Bot-ladder rung this enemy plays at on Normal, before difficulty shifts. */
  skill: number;
  weapon: string;
  health: number;
  /** Multiplier on the configured move speed; 1 walks like a player. */
  speed: number;
  /** Grenades carried; the profile decides how eagerly they are thrown. */
  grenades: number;
  /** An emplacement: aims and fires, never walks. */
  stationary?: boolean;
  /** Sight override in px; the global NPC sight range when omitted. */
  detectionRange?: number;
  /** Score for a kill. */
  points: number;
  /** Body tint, so the type reads at a glance. */
  color: number;
  /** Drawn scale; hitbox stays a player's. Bosses loom. */
  bodyScale?: number;
}

/** One enemy to place, with an optional difficulty gate. */
export interface CampaignEnemySpawn {
  type: string;
  x: number;
  y: number;
  /** Spawn only on these campaign difficulties; every difficulty when omitted. */
  difficulties?: CampaignDifficultyId[];
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export type CampaignTriggerWhen =
  | { kind: "levelStarted" }
  | { kind: "enterZone"; zone: CampaignZone }
  | { kind: "enemiesKilled"; group: string }
  | { kind: "encounterCompleted"; encounterId: string }
  | { kind: "objectsDestroyed"; group: string }
  | { kind: "checkpointReached"; checkpointId: string }
  | { kind: "timerElapsed"; afterMs: number; sinceTriggerId?: string }
  | { kind: "bossPhase"; phase: number }
  | { kind: "bossDefeated" }
  | { kind: "playerHealthBelow"; percent: number };

export type CampaignTriggerAction =
  | { kind: "spawnEnemies"; group: string; enemies: CampaignEnemySpawn[] }
  | { kind: "startEncounter"; encounterId: string }
  | { kind: "destroyObjects"; group: string }
  | { kind: "spawnCrate"; spawnPointId: string; powerUpId?: string; group?: string }
  | { kind: "lockCamera"; zoneId: string }
  | { kind: "unlockCamera" }
  | { kind: "shake"; intensity?: number }
  | { kind: "message"; text: string; durationMs?: number }
  | { kind: "objective"; text: string }
  | { kind: "checkpoint"; checkpointId: string }
  | { kind: "revealSecret"; secretId: string }
  | { kind: "startBoss" }
  | { kind: "completeLevel" };

/**
 * When X happens, do Y -- the level's whole scripting vocabulary.
 *
 * `requires` sequences triggers without code: a finish line that only counts
 * after the boss trigger has fired is `requires: ["boss-down"]`, never
 * `if (levelId === ... && player.x > ...)` anywhere.
 */
export interface CampaignTriggerDefinition {
  id: string;
  when: CampaignTriggerWhen;
  actions: CampaignTriggerAction[];
  /** Trigger ids that must have fired before this one may. */
  requires?: string[];
  /** Fire once (the default) or every time the condition holds again. */
  repeat?: boolean;
}

// ---------------------------------------------------------------------------
// Encounters
// ---------------------------------------------------------------------------

export interface CampaignEncounterWave {
  enemies: CampaignEnemySpawn[];
}

/**
 * A held fight: camera locks, waves come, the last body unlocks the way on.
 * Started via a `startEncounter` trigger action; completing it emits
 * `encounterCompleted` back into the trigger engine.
 */
export interface CampaignEncounterDefinition {
  id: string;
  /** Camera zone to lock to while the fight runs; none locks nothing. */
  lockCameraZone?: string;
  waves: CampaignEncounterWave[];
}

// ---------------------------------------------------------------------------
// Level furniture
// ---------------------------------------------------------------------------

export interface CampaignCheckpointDefinition {
  id: string;
  /** Where the player respawns. */
  x: number;
  y: number;
  /** Walking into this claims the checkpoint. */
  zone: CampaignZone;
}

export interface CampaignCameraZoneDefinition {
  id: string;
  /** The camera's world bounds while the player is inside (or locked to) it. */
  zone: CampaignZone;
}

/**
 * A crate placed by the level: pickup and destructible scenery in one, because
 * a campaign crate *is* the multiplayer crate -- same physics, same health,
 * same drop-on-break. `group` lets triggers watch for its destruction or blow
 * it up as a scripted event.
 */
export interface CampaignCrateDefinition {
  spawnPointId: string;
  /** Power-up inside; a weighted random one when omitted. */
  powerUpId?: string;
  group?: string;
}

export interface CampaignSecretDefinition {
  id: string;
  zone: CampaignZone;
  points?: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// Boss
// ---------------------------------------------------------------------------

export interface CampaignBossPhaseDefinition {
  /** The phase begins when the boss drops below this fraction of full health. */
  belowHealthPercent: number;
  /** Loadout and temperament changes; anything omitted carries over. */
  weapon?: string;
  speed?: number;
  skill?: number;
  profile?: string;
  message?: string;
  /** Reinforcements announced by the phase. */
  spawnAdds?: CampaignEnemySpawn[];
}

export interface CampaignBossDefinition {
  /** Enemy type the boss is built from; phases then reshape it. */
  enemyType: string;
  name: string;
  x: number;
  y: number;
  points: number;
  phases: CampaignBossPhaseDefinition[];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface CampaignScoringConfig {
  /** Kills this close together chain into a combo. */
  comboWindowMs: number;
  /** Each chained kill adds this share of its base points again... */
  comboStepPercent: number;
  /** ...up to this cap. */
  comboCapPercent: number;
  /** Points lost per death. */
  deathPenalty: number;
  /** Full when finishing at or under par, fading to zero at twice par. */
  timeBonusMaxPoints: number;
  /** Scaled linearly by hit ratio. */
  accuracyBonusMaxPoints: number;
  defaultSecretPoints: number;
  /**
   * Rank cutoffs as a fraction of the level's achievable score on the played
   * difficulty -- relative, so one table serves every level.
   */
  rankThresholds: { S: number; A: number; B: number; C: number };
}

export type CampaignRank = "S" | "A" | "B" | "C" | "D";

export interface CampaignLevelResult {
  levelId: string;
  difficulty: CampaignDifficultyId;
  score: number;
  kills: number;
  deaths: number;
  secretsFound: number;
  secretsTotal: number;
  timeMs: number;
  /** 0..1 hit ratio. */
  accuracy: number;
  rank: CampaignRank;
}

// ---------------------------------------------------------------------------
// Lives
// ---------------------------------------------------------------------------

export type CampaignRespawnRule =
  | { kind: "checkpoint" }
  | { kind: "lives"; lives: number }
  | { kind: "oneLife" };

// ---------------------------------------------------------------------------
// The level
// ---------------------------------------------------------------------------

export interface CampaignLevelDefinition {
  id: string;
  name: string;
  /** The registered arena carrying geometry, spawn points and traps. */
  arenaId: string;

  playerSpawn: { x: number; y: number };
  startingWeapon: string;
  startingGrenades: number;

  /** The clock the time bonus measures against. */
  parTimeMs: number;
  respawnRule: CampaignRespawnRule;

  checkpoints: CampaignCheckpointDefinition[];
  cameraZones: CampaignCameraZoneDefinition[];
  crates: CampaignCrateDefinition[];
  encounters: CampaignEncounterDefinition[];
  triggers: CampaignTriggerDefinition[];
  secrets: CampaignSecretDefinition[];
  boss?: CampaignBossDefinition;
}

// ---------------------------------------------------------------------------
// Progress (local save; the optional cloud sync ships these same shapes)
// ---------------------------------------------------------------------------

export interface CampaignLevelProgress {
  completed: boolean;
  bestScore: number;
  bestRank: CampaignRank | null;
  /** Difficulties this level has been beaten on. */
  completedDifficulties: CampaignDifficultyId[];
  secretsFound: number;
}

export interface CampaignProgress {
  levels: Record<string, CampaignLevelProgress>;
}

/**
 * The rare, high-level events worth telling a server about -- never gameplay.
 * The client fires them and moves on; nothing awaits a reply.
 */
export type CampaignSyncEvent =
  | { kind: "levelStarted"; levelId: string; difficulty: CampaignDifficultyId }
  | { kind: "checkpointReached"; levelId: string; checkpointId: string }
  | { kind: "levelCompleted"; levelId: string; result: CampaignLevelResult }
  | { kind: "progressChanged"; progress: CampaignProgress };
