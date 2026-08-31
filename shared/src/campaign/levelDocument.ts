/**
 * Untrusted JSON in, a campaign level out -- or a list of reasons why not.
 *
 * The level editor stores whole `CampaignLevelDefinition` documents on the
 * server, and a stored document is exactly as untrusted as a stored arena:
 * it arrives as JSON from whoever holds an admin token, sits in a file a
 * hand can edit, and is then handed to the engine as if it were shipped
 * content. This normalizer is the boundary. Every field is checked for shape,
 * every number for finiteness, every union tag against its members; unknown
 * fields are dropped, malformed entries are dropped *with a named issue*, and
 * a document whose skeleton is wrong is refused outright.
 *
 * Shape only -- whether the level makes *sense* (crates on real spawn points,
 * a reachable next level) stays `validateCampaignLevel`'s job, run after this.
 */
import type {
  CampaignBossDefinition,
  CampaignBossPhaseDefinition,
  CampaignBoundaryOptions,
  CampaignCameraZoneDefinition,
  CampaignCheckpointDefinition,
  CampaignCrateDefinition,
  CampaignDifficultyId,
  CampaignEncounterDefinition,
  CampaignEnemySpawn,
  CampaignInterlude,
  CampaignLevelDefinition,
  CampaignRespawnRule,
  CampaignSecretDefinition,
  CampaignTriggerAction,
  CampaignTriggerDefinition,
  CampaignTriggerWhen,
  CampaignZone,
} from "./types.js";
import type { CampaignEnemyInstanceTuning, CampaignEnemyTuning } from "./tuning.js";

export interface NormalizedLevel {
  /** Null when the document's skeleton is beyond repair. */
  level: CampaignLevelDefinition | null;
  /** Everything dropped or refused, named. Empty means the document was clean. */
  issues: string[];
}

const DIFFICULTIES: readonly CampaignDifficultyId[] = ["easy", "normal", "hard", "extreme"];

/** World coordinates and sizes live within this; a typo cannot place anything a light-year out. */
const WORLD_LIMIT = 100_000;

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
}

function num(value: unknown, min = -WORLD_LIMIT, max = WORLD_LIMIT): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

function zone(value: unknown): CampaignZone | undefined {
  if (!isRecord(value)) return undefined;
  const x = num(value.x);
  const y = num(value.y);
  const width = num(value.width, 1);
  const height = num(value.height, 1);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  return { x, y, width, height };
}

function tuning(value: unknown): CampaignEnemyTuning | undefined {
  if (!isRecord(value)) return undefined;
  const result: CampaignEnemyTuning = {};
  for (const key of ["moveSpeed", "projectileSpeed", "fireRate", "reactionTime"] as const) {
    const multiplier = num(value[key], 0.05, 5);
    if (multiplier !== undefined) result[key] = multiplier;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function instanceTuning(value: unknown): CampaignEnemyInstanceTuning | undefined {
  if (!isRecord(value)) return undefined;
  const base: CampaignEnemyInstanceTuning = { ...tuning(value) };
  const detectionRange = num(value.detectionRange, 1, 10_000);
  if (detectionRange !== undefined) base.detectionRange = detectionRange;
  return Object.keys(base).length > 0 ? base : undefined;
}

function difficulties(value: unknown): CampaignDifficultyId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept = value.filter((entry): entry is CampaignDifficultyId =>
    DIFFICULTIES.includes(entry as CampaignDifficultyId),
  );
  return kept.length > 0 ? kept : undefined;
}

function enemySpawn(value: unknown): CampaignEnemySpawn | undefined {
  if (!isRecord(value)) return undefined;
  const type = str(value.type);
  const x = num(value.x);
  const y = num(value.y);
  if (!type || x === undefined || y === undefined) return undefined;
  const spawn: CampaignEnemySpawn = { type, x, y };
  const gate = difficulties(value.difficulties);
  if (gate) spawn.difficulties = gate;
  const instance = instanceTuning(value.tuning);
  if (instance) spawn.tuning = instance;
  return spawn;
}

function enemySpawns(value: unknown, where: string, issues: string[]): CampaignEnemySpawn[] {
  if (!Array.isArray(value)) return [];
  const kept: CampaignEnemySpawn[] = [];
  for (const [index, entry] of value.entries()) {
    const spawn = enemySpawn(entry);
    if (spawn) kept.push(spawn);
    else issues.push(`${where}: enemy spawn #${index + 1} is malformed and was dropped`);
  }
  return kept;
}

function boundary(value: unknown): CampaignBoundaryOptions | undefined {
  if (!isRecord(value)) return undefined;
  const options: CampaignBoundaryOptions = {};
  if (typeof value.restrictPlayer === "boolean") options.restrictPlayer = value.restrictPlayer;
  if (typeof value.restrictEnemies === "boolean") options.restrictEnemies = value.restrictEnemies;
  if (isRecord(value.sides)) {
    const sides: CampaignBoundaryOptions["sides"] = {};
    for (const side of ["left", "right", "top", "bottom"] as const) {
      if (typeof value.sides[side] === "boolean") sides[side] = value.sides[side] as boolean;
    }
    if (Object.keys(sides).length > 0) options.sides = sides;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

function when(value: unknown): CampaignTriggerWhen | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.kind) {
    case "levelStarted":
      return { kind: "levelStarted" };
    case "enterZone": {
      const area = zone(value.zone);
      return area ? { kind: "enterZone", zone: area } : undefined;
    }
    case "enemiesKilled": {
      const group = str(value.group);
      return group ? { kind: "enemiesKilled", group } : undefined;
    }
    case "encounterCompleted": {
      const encounterId = str(value.encounterId);
      return encounterId ? { kind: "encounterCompleted", encounterId } : undefined;
    }
    case "objectsDestroyed": {
      const group = str(value.group);
      return group ? { kind: "objectsDestroyed", group } : undefined;
    }
    case "checkpointReached": {
      const checkpointId = str(value.checkpointId);
      return checkpointId ? { kind: "checkpointReached", checkpointId } : undefined;
    }
    case "timerElapsed": {
      const afterMs = num(value.afterMs, 0, 3_600_000);
      if (afterMs === undefined) return undefined;
      const since = str(value.sinceTriggerId);
      return since ? { kind: "timerElapsed", afterMs, sinceTriggerId: since } : { kind: "timerElapsed", afterMs };
    }
    case "bossPhase": {
      const phase = num(value.phase, 1, 20);
      return phase === undefined ? undefined : { kind: "bossPhase", phase: Math.round(phase) };
    }
    case "bossDefeated":
      return { kind: "bossDefeated" };
    case "playerHealthBelow": {
      const percent = num(value.percent, 1, 100);
      return percent === undefined ? undefined : { kind: "playerHealthBelow", percent };
    }
    default:
      return undefined;
  }
}

function action(value: unknown, where: string, issues: string[]): CampaignTriggerAction | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.kind) {
    case "spawnEnemies": {
      const group = str(value.group);
      if (!group) return undefined;
      return { kind: "spawnEnemies", group, enemies: enemySpawns(value.enemies, where, issues) };
    }
    case "startEncounter": {
      const encounterId = str(value.encounterId);
      return encounterId ? { kind: "startEncounter", encounterId } : undefined;
    }
    case "destroyObjects": {
      const group = str(value.group);
      return group ? { kind: "destroyObjects", group } : undefined;
    }
    case "spawnCrate": {
      const spawnPointId = str(value.spawnPointId);
      if (!spawnPointId) return undefined;
      const crate: CampaignTriggerAction = { kind: "spawnCrate", spawnPointId };
      const powerUpId = str(value.powerUpId);
      if (powerUpId) crate.powerUpId = powerUpId;
      const group = str(value.group);
      if (group) crate.group = group;
      return crate;
    }
    case "lockCamera": {
      const zoneId = str(value.zoneId);
      if (!zoneId) return undefined;
      const options = boundary(value.boundary);
      return options ? { kind: "lockCamera", zoneId, boundary: options } : { kind: "lockCamera", zoneId };
    }
    case "unlockCamera":
      return { kind: "unlockCamera" };
    case "shake": {
      const intensity = num(value.intensity, 0, 1);
      return intensity === undefined ? { kind: "shake" } : { kind: "shake", intensity };
    }
    case "message": {
      const text = str(value.text);
      if (!text) return undefined;
      const durationMs = num(value.durationMs, 100, 60_000);
      return durationMs === undefined ? { kind: "message", text } : { kind: "message", text, durationMs };
    }
    case "objective": {
      const text = str(value.text);
      return text ? { kind: "objective", text } : undefined;
    }
    case "checkpoint": {
      const checkpointId = str(value.checkpointId);
      return checkpointId ? { kind: "checkpoint", checkpointId } : undefined;
    }
    case "revealSecret": {
      const secretId = str(value.secretId);
      return secretId ? { kind: "revealSecret", secretId } : undefined;
    }
    case "startBoss":
      return { kind: "startBoss" };
    case "completeLevel":
      return { kind: "completeLevel" };
    default:
      return undefined;
  }
}

function trigger(value: unknown, index: number, issues: string[]): CampaignTriggerDefinition | undefined {
  if (!isRecord(value)) return undefined;
  const id = str(value.id);
  const condition = when(value.when);
  if (!id || !condition) return undefined;
  if (!Array.isArray(value.actions)) return undefined;

  const actions: CampaignTriggerAction[] = [];
  for (const [actionIndex, entry] of value.actions.entries()) {
    const kept = action(entry, `trigger ${id}`, issues);
    if (kept) actions.push(kept);
    else issues.push(`trigger ${id}: action #${actionIndex + 1} is malformed and was dropped`);
  }

  const result: CampaignTriggerDefinition = { id, when: condition, actions };
  if (Array.isArray(value.requires)) {
    const requires = value.requires.map(str).filter((entry): entry is string => entry !== undefined);
    if (requires.length > 0) result.requires = requires;
  }
  if (typeof value.repeat === "boolean") result.repeat = value.repeat;
  void index;
  return result;
}

function interlude(value: unknown): CampaignInterlude | undefined {
  if (!isRecord(value) || value.kind !== "briefing") return undefined;
  const title = str(value.title);
  if (!title) return undefined;
  const lines = Array.isArray(value.lines)
    ? value.lines.map(str).filter((line): line is string => line !== undefined)
    : [];
  const card: CampaignInterlude = { kind: "briefing", title, lines };
  const eyebrow = str(value.eyebrow);
  if (eyebrow) card.eyebrow = eyebrow;
  const autoAdvanceMs = num(value.autoAdvanceMs, 0, 300_000);
  if (autoAdvanceMs !== undefined) card.autoAdvanceMs = autoAdvanceMs;
  return card;
}

function respawnRule(value: unknown): CampaignRespawnRule | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "checkpoint") return { kind: "checkpoint" };
  if (value.kind === "oneLife") return { kind: "oneLife" };
  if (value.kind === "lives") {
    const lives = num(value.lives, 1, 9);
    return lives === undefined ? undefined : { kind: "lives", lives: Math.round(lives) };
  }
  return undefined;
}

function bossPhase(value: unknown, index: number, issues: string[]): CampaignBossPhaseDefinition | undefined {
  if (!isRecord(value)) return undefined;
  const belowHealthPercent = num(value.belowHealthPercent, 0, 100);
  if (belowHealthPercent === undefined) return undefined;
  const phase: CampaignBossPhaseDefinition = { belowHealthPercent };
  const weapon = str(value.weapon);
  if (weapon) phase.weapon = weapon;
  const speed = num(value.speed, 0, 5);
  if (speed !== undefined) phase.speed = speed;
  const skill = num(value.skill, 1, 5);
  if (skill !== undefined) phase.skill = Math.round(skill);
  const profile = str(value.profile);
  if (profile) phase.profile = profile;
  if (typeof value.stationary === "boolean") phase.stationary = value.stationary;
  const message = str(value.message);
  if (message) phase.message = message;
  if (value.spawnAdds !== undefined) {
    phase.spawnAdds = enemySpawns(value.spawnAdds, `boss phase #${index + 1}`, issues);
  }
  return phase;
}

function boss(value: unknown, issues: string[]): CampaignBossDefinition | undefined {
  if (!isRecord(value)) return undefined;
  const enemyType = str(value.enemyType);
  const name = str(value.name);
  const x = num(value.x);
  const y = num(value.y);
  const points = num(value.points, 0, 1_000_000);
  if (!enemyType || !name || x === undefined || y === undefined || points === undefined) return undefined;
  if (!Array.isArray(value.phases)) return undefined;

  const phases: CampaignBossPhaseDefinition[] = [];
  for (const [index, entry] of value.phases.entries()) {
    const kept = bossPhase(entry, index, issues);
    if (kept) phases.push(kept);
    else issues.push(`boss: phase #${index + 1} is malformed and was dropped`);
  }
  if (phases.length === 0) return undefined;
  return { enemyType, name, x, y, points, phases };
}

function list<T>(
  value: unknown,
  what: string,
  issues: string[],
  normalizeOne: (entry: unknown) => T | undefined,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(`${what} is not a list and was dropped`);
    return [];
  }
  const kept: T[] = [];
  for (const [index, entry] of value.entries()) {
    const one = normalizeOne(entry);
    if (one !== undefined) kept.push(one);
    else issues.push(`${what} #${index + 1} is malformed and was dropped`);
  }
  return kept;
}

export function normalizeCampaignLevel(raw: unknown): NormalizedLevel {
  const issues: string[] = [];
  if (!isRecord(raw)) return { level: null, issues: ["the document is not an object"] };

  const id = str(raw.id);
  const name = str(raw.name);
  const arenaId = str(raw.arenaId);
  const startingWeapon = str(raw.startingWeapon);
  const spawn = isRecord(raw.playerSpawn)
    ? { x: num(raw.playerSpawn.x), y: num(raw.playerSpawn.y) }
    : { x: undefined, y: undefined };
  const startingGrenades = num(raw.startingGrenades, 0, 20);
  const parTimeMs = num(raw.parTimeMs, 30_000, 3_600_000);
  const rule = respawnRule(raw.respawnRule);

  if (!id) issues.push("id is missing");
  if (!name) issues.push("name is missing");
  if (!arenaId) issues.push("arenaId is missing");
  if (!startingWeapon) issues.push("startingWeapon is missing");
  if (spawn.x === undefined || spawn.y === undefined) issues.push("playerSpawn is malformed");
  if (startingGrenades === undefined) issues.push("startingGrenades is malformed");
  if (parTimeMs === undefined) issues.push("parTimeMs is malformed");
  if (!rule) issues.push("respawnRule is malformed");
  if (issues.length > 0 && (!id || !name || !arenaId || !startingWeapon || spawn.x === undefined)) {
    return { level: null, issues };
  }
  if (
    !id ||
    !name ||
    !arenaId ||
    !startingWeapon ||
    spawn.x === undefined ||
    spawn.y === undefined ||
    startingGrenades === undefined ||
    parTimeMs === undefined ||
    !rule
  ) {
    return { level: null, issues };
  }

  const level: CampaignLevelDefinition = {
    id,
    name,
    arenaId,
    playerSpawn: { x: spawn.x, y: spawn.y },
    startingWeapon,
    startingGrenades: Math.round(startingGrenades),
    parTimeMs: Math.round(parTimeMs),
    respawnRule: rule,
    checkpoints: list(raw.checkpoints, "checkpoints", issues, (entry): CampaignCheckpointDefinition | undefined => {
      if (!isRecord(entry)) return undefined;
      const checkpointId = str(entry.id);
      const x = num(entry.x);
      const y = num(entry.y);
      const area = zone(entry.zone);
      if (!checkpointId || x === undefined || y === undefined || !area) return undefined;
      return { id: checkpointId, x, y, zone: area };
    }),
    cameraZones: list(raw.cameraZones, "cameraZones", issues, (entry): CampaignCameraZoneDefinition | undefined => {
      if (!isRecord(entry)) return undefined;
      const zoneId = str(entry.id);
      const area = zone(entry.zone);
      if (!zoneId || !area) return undefined;
      return { id: zoneId, zone: area };
    }),
    crates: list(raw.crates, "crates", issues, (entry): CampaignCrateDefinition | undefined => {
      if (!isRecord(entry)) return undefined;
      const spawnPointId = str(entry.spawnPointId);
      if (!spawnPointId) return undefined;
      const crate: CampaignCrateDefinition = { spawnPointId };
      const powerUpId = str(entry.powerUpId);
      if (powerUpId) crate.powerUpId = powerUpId;
      const group = str(entry.group);
      if (group) crate.group = group;
      return crate;
    }),
    encounters: list(raw.encounters, "encounters", issues, (entry): CampaignEncounterDefinition | undefined => {
      if (!isRecord(entry)) return undefined;
      const encounterId = str(entry.id);
      if (!encounterId || !Array.isArray(entry.waves)) return undefined;
      const waves = entry.waves.map((wave, waveIndex) => ({
        enemies: isRecord(wave)
          ? enemySpawns(wave.enemies, `encounter ${encounterId} wave #${waveIndex + 1}`, issues)
          : [],
      }));
      const encounter: CampaignEncounterDefinition = { id: encounterId, waves };
      const lockCameraZone = str(entry.lockCameraZone);
      if (lockCameraZone) encounter.lockCameraZone = lockCameraZone;
      const options = boundary(entry.boundary);
      if (options) encounter.boundary = options;
      return encounter;
    }),
    triggers: list(raw.triggers, "triggers", issues, (entry) => trigger(entry, 0, issues)),
    secrets: list(raw.secrets, "secrets", issues, (entry): CampaignSecretDefinition | undefined => {
      if (!isRecord(entry)) return undefined;
      const secretId = str(entry.id);
      const area = zone(entry.zone);
      if (!secretId || !area) return undefined;
      const secret: CampaignSecretDefinition = { id: secretId, zone: area };
      const points = num(entry.points, 0, 100_000);
      if (points !== undefined) secret.points = Math.round(points);
      const message = str(entry.message);
      if (message) secret.message = message;
      return secret;
    }),
  };

  const theBoss = raw.boss === undefined ? undefined : boss(raw.boss, issues);
  if (raw.boss !== undefined && !theBoss) issues.push("boss is malformed and was dropped");
  if (theBoss) level.boss = theBoss;

  const nextLevelId = str(raw.nextLevelId);
  if (nextLevelId) level.nextLevelId = nextLevelId;
  const card = raw.interlude === undefined ? undefined : interlude(raw.interlude);
  if (raw.interlude !== undefined && !card) issues.push("interlude is malformed and was dropped");
  if (card) level.interlude = card;
  const musicTrackId = str(raw.musicTrackId);
  if (musicTrackId) level.musicTrackId = musicTrackId;
  const bossMusicTrackId = str(raw.bossMusicTrackId);
  if (bossMusicTrackId) level.bossMusicTrackId = bossMusicTrackId;
  const levelTuning = raw.enemyTuning === undefined ? undefined : tuning(raw.enemyTuning);
  if (levelTuning) level.enemyTuning = levelTuning;
  if (isRecord(raw.carryOver)) {
    const carryOver: { weapon?: boolean; grenades?: boolean } = {};
    if (typeof raw.carryOver.weapon === "boolean") carryOver.weapon = raw.carryOver.weapon;
    if (typeof raw.carryOver.grenades === "boolean") carryOver.grenades = raw.carryOver.grenades;
    if (Object.keys(carryOver).length > 0) level.carryOver = carryOver;
  }

  return { level, issues };
}
