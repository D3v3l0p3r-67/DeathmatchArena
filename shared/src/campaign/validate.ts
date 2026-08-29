/**
 * Sanity for level content, run at load and in tests.
 *
 * Catching a misspelt spawn point or enemy id here is the difference between a
 * clear message and an encounter that silently never spawns.
 */
import { SurfaceType } from "../game/types.js";
import { getCrateConfig } from "../config/registry.js";
import type { ArenaDefinition } from "../arena/types.js";
import { getCampaignEnemy } from "./catalogue.js";
import type { CampaignEnemySpawn, CampaignLevelDefinition } from "./types.js";

export function validateCampaignLevel(
  level: CampaignLevelDefinition,
  arena: ArenaDefinition,
  /** Ids the campaign knows about, so `nextLevelId` can be checked too. */
  knownLevelIds?: Iterable<string>,
): string[] {
  const issues: string[] = [];
  const say = (message: string) => issues.push(message);

  if (level.nextLevelId !== undefined && knownLevelIds) {
    const known = new Set(knownLevelIds);
    if (!known.has(level.nextLevelId)) {
      say(`level ${level.id} leads to unknown level ${level.nextLevelId}`);
    }
    if (level.nextLevelId === level.id) say(`level ${level.id} leads to itself`);
  }

  if (level.arenaId !== arena.id) say(`level ${level.id} names arena ${level.arenaId}, got ${arena.id}`);

  const spawnPoints = new Set(arena.powerUpSpawns.map((point) => point.id));
  for (const crate of level.crates) {
    if (!spawnPoints.has(crate.spawnPointId)) say(`crate spawn point ${crate.spawnPointId} not in arena`);
  }

  /*
   * A crate placed inside a wall is not a crate in a wall: box physics shoves
   * it out on the first tick, so it ends up somewhere the level never chose --
   * once 212px away, on top of a post, which is exactly the sort of thing that
   * is invisible in the data and obvious in the game.
   */
  const crateConfig = getCrateConfig();
  const halfWidth = crateConfig.width / 2;
  const halfHeight = crateConfig.height / 2;
  for (const crate of level.crates) {
    const point = arena.powerUpSpawns.find((candidate) => candidate.id === crate.spawnPointId);
    if (!point) continue;

    for (const element of arena.elements) {
      // Platforms are one-way: a crate resting on one is not stuck in it.
      if (element.type === SurfaceType.PLATFORM) continue;
      const overlapsX = point.x + halfWidth > element.x && point.x - halfWidth < element.x + element.width;
      const overlapsY = point.y + halfHeight > element.y && point.y - halfHeight < element.y + element.height;
      if (overlapsX && overlapsY) {
        say(`crate spawn ${crate.spawnPointId} starts inside solid element ${element.id}`);
      }
    }
  }

  const cameraZones = new Set(level.cameraZones.map((zone) => zone.id));
  const encounterIds = new Set(level.encounters.map((encounter) => encounter.id));
  const triggerIds = new Set(level.triggers.map((trigger) => trigger.id));
  const checkpointIds = new Set(level.checkpoints.map((checkpoint) => checkpoint.id));

  const checkSpawns = (spawns: readonly CampaignEnemySpawn[], where: string) => {
    for (const spawn of spawns) {
      if (!getCampaignEnemy(spawn.type)) say(`unknown enemy type ${spawn.type} in ${where}`);
      if (spawn.x < 0 || spawn.x > arena.width || spawn.y < 0 || spawn.y > arena.height) {
        say(`enemy spawn out of bounds in ${where}: ${spawn.x},${spawn.y}`);
      }
    }
  };

  for (const encounter of level.encounters) {
    if (encounter.lockCameraZone && !cameraZones.has(encounter.lockCameraZone)) {
      say(`encounter ${encounter.id} locks unknown camera zone ${encounter.lockCameraZone}`);
    }
    encounter.waves.forEach((wave, index) => checkSpawns(wave.enemies, `${encounter.id} wave ${index}`));
  }

  for (const trigger of level.triggers) {
    for (const required of trigger.requires ?? []) {
      if (!triggerIds.has(required)) say(`trigger ${trigger.id} requires unknown trigger ${required}`);
    }
    if (trigger.when.kind === "checkpointReached" && !checkpointIds.has(trigger.when.checkpointId)) {
      say(`trigger ${trigger.id} watches unknown checkpoint`);
    }
    for (const action of trigger.actions) {
      if (action.kind === "spawnEnemies") checkSpawns(action.enemies, `trigger ${trigger.id}`);
      if (action.kind === "startEncounter" && !encounterIds.has(action.encounterId)) {
        say(`trigger ${trigger.id} starts unknown encounter ${action.encounterId}`);
      }
      if (action.kind === "lockCamera" && !cameraZones.has(action.zoneId)) {
        say(`trigger ${trigger.id} locks unknown camera zone ${action.zoneId}`);
      }
      if (action.kind === "checkpoint" && !checkpointIds.has(action.checkpointId)) {
        say(`trigger ${trigger.id} claims unknown checkpoint ${action.checkpointId}`);
      }
      if (action.kind === "spawnCrate" && !spawnPoints.has(action.spawnPointId)) {
        say(`trigger ${trigger.id} spawns crate on unknown point ${action.spawnPointId}`);
      }
      if (action.kind === "startBoss" && !level.boss) say(`trigger ${trigger.id} starts a boss the level lacks`);
    }
  }

  if (level.boss) {
    if (!getCampaignEnemy(level.boss.enemyType)) say(`boss uses unknown enemy type ${level.boss.enemyType}`);
    for (const phase of level.boss.phases) checkSpawns(phase.spawnAdds ?? [], "boss phase");
  }

  return issues;
}
