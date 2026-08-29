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
  /**
   * Whether the boss holds its ground in this phase.
   *
   * An emplacement that tears loose halfway through is a different fight in
   * the same body -- the phase table can say so without a second boss type.
   */
  stationary?: boolean;
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

/**
 * How a run went, whether or not it reached the end.
 *
 * A level that ends in a game over is still a run somebody played: they killed
 * things, found secrets and spent time doing it, and a results screen showing
 * six dashes throws all of that away. So the numbers are their own shape, and
 * only a *finished* level adds the two things a failure cannot have -- the
 * end-of-level bonuses, and a rank.
 */
export interface CampaignRunSummary {
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
}

export interface CampaignLevelResult extends CampaignRunSummary {
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
// Between levels
// ---------------------------------------------------------------------------

/**
 * What the player keeps when the next level begins.
 *
 * A campaign that hands everything back at every door is a series of
 * unrelated levels; one that carries a hard-won rocket launcher forward is a
 * run. Each level states what *arriving* at it preserves, so the rule belongs
 * to the level being entered rather than to the one being left -- a level can
 * always guarantee the loadout it was designed around.
 */
export interface CampaignCarryOver {
  /** Keep the weapon finished with, instead of the level's starting weapon. */
  weapon?: boolean;
  /** Keep grenades in hand, topped up to at least the level's own count. */
  grenades?: boolean;
}

/**
 * The card shown between levels.
 *
 * Deliberately a discriminated union rather than a fixed shape: `briefing` is
 * the only kind today, and a later `cutscene`, `map` or `shop` is a new member
 * plus one branch where interludes are presented -- no change to levels that
 * do not use it, and none to the engine that runs them.
 */
export type CampaignInterlude = {
  kind: "briefing";
  /** Small line above the title, e.g. "Sector 2". */
  eyebrow?: string;
  title: string;
  /** A few lines of situation. Rendered in order. */
  lines: string[];
  /** Skips itself after this long; 0 waits for the player. */
  autoAdvanceMs?: number;
};

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

  /**
   * The level this one leads to. Absent means the campaign ends here.
   *
   * The chain lives in the content, not in an index: reordering the campaign,
   * branching it, or dropping a level in the middle is an edit to these
   * fields, and `CAMPAIGN_LEVELS` stays the mere catalogue of what exists.
   */
  nextLevelId?: string;
  /** Shown on the way *in* to this level. */
  interlude?: CampaignInterlude;

  /**
   * The score this level plays, and the one its boss brings with it.
   *
   * Ids from the client's music catalogue. Omitted, a level gets the
   * campaign's default track -- so naming one is how a level sounds different,
   * not a thing every level must remember to do.
   */
  musicTrackId?: string;
  bossMusicTrackId?: string;
  /** What survives the door into this level. Nothing, by default. */
  carryOver?: CampaignCarryOver;
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
  /** The best complete run through the chain, if one has been finished. */
  bestRunScore?: number;
}

/**
 * A playthrough in progress: what has been carried and scored since the run
 * began, as distinct from the per-level records above.
 */
export interface CampaignRun {
  /** Where the run started, so a finished chain can be recognised. */
  startedLevelId: string;
  difficulty: CampaignDifficultyId;
  /** Levels cleared so far this run, in order. */
  clearedLevelIds: string[];
  /** Sum of their scores. */
  totalScore: number;
  /** Carried forward into the next level, when it asks for it. */
  weaponId: string;
  grenades: number;
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
