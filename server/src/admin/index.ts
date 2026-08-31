import { serverConfig, readConfigSeed } from "../config.js";
import { createLogger } from "../utils/logger.js";
import {
  FileArenaRepository,
  InMemoryArenaRepository,
  type ArenaRepository,
} from "./ArenaRepository.js";
import { ArenaService } from "./ArenaService.js";
import {
  FileGameConfigRepository,
  InMemoryGameConfigRepository,
  type GameConfigRepository,
} from "./GameConfigRepository.js";
import { GameConfigService } from "./GameConfigService.js";
import {
  CampaignLevelsService,
  FileCampaignLevelsRepository,
  InMemoryCampaignLevelsRepository,
} from "./CampaignLevelsService.js";

const logger = createLogger("admin");

const arenaRepository: ArenaRepository = new FileArenaRepository(serverConfig.admin.dataDir);
const configRepository: GameConfigRepository = new FileGameConfigRepository(serverConfig.admin.dataDir);

export const arenaService = new ArenaService(arenaRepository, logger);
export const gameConfigService = new GameConfigService(configRepository, logger, readConfigSeed());
export const campaignLevelsService = new CampaignLevelsService(
  new FileCampaignLevelsRepository(serverConfig.admin.dataDir),
  logger,
);

/** Fallbacks used when storage turns out to be unusable. */
const memoryArenas = new ArenaService(new InMemoryArenaRepository(), logger);
const memoryConfig = new GameConfigService(new InMemoryGameConfigRepository(), logger, readConfigSeed());
const memoryCampaignLevels = new CampaignLevelsService(new InMemoryCampaignLevelsRepository(), logger);

let active = { arenas: arenaService, config: gameConfigService, campaignLevels: campaignLevelsService };

/** The services the routes and rooms should use. */
export function adminServices(): {
  arenas: ArenaService;
  config: GameConfigService;
  campaignLevels: CampaignLevelsService;
} {
  return active;
}

/**
 * Load stored arenas and configuration before the server accepts anyone.
 *
 * Ordering matters: the configuration is published to the process-wide registry
 * here, and rooms read it at creation. Starting the listener first would mean a
 * room created in the first few milliseconds ran on the shipped defaults.
 *
 * A storage failure is survivable and is treated as such. A server that will not
 * start because a data directory is read-only is worse than one that runs on the
 * shipped values and says so loudly -- players can still play, and an operator
 * can still fix the mount.
 */
export async function initialiseAdmin(): Promise<void> {
  try {
    await gameConfigService.initialise();
    await arenaService.initialise();
    await campaignLevelsService.initialise();
  } catch (error) {
    logger.error("Could not load stored administration data; continuing in memory", {
      dataDir: serverConfig.admin.dataDir,
      error: error instanceof Error ? error.message : String(error),
    });

    active = { arenas: memoryArenas, config: memoryConfig, campaignLevels: memoryCampaignLevels };
    await memoryConfig.initialise();
    await memoryArenas.initialise();
    await memoryCampaignLevels.initialise();
    return;
  }

  if (!serverConfig.admin.persistent) {
    logger.warn(
      "Administration changes are stored in a directory that may not survive a restart. " +
        "Point DATA_DIR at a mounted volume and set DATA_PERSISTENT=true once it does.",
      { dataDir: serverConfig.admin.dataDir },
    );
  }
}

export { ArenaService } from "./ArenaService.js";
export { GameConfigService } from "./GameConfigService.js";
export { createAdminRouter } from "./router.js";
