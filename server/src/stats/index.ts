/**
 * The player statistics service, wired to storage.
 *
 * The same shape as the administration services next door: a file-backed
 * repository, an in-memory fallback for when storage turns out to be unusable,
 * and a single accessor so nothing else has to know which one it got. A server
 * that refused to start because a data directory is read-only would be worse
 * than one that plays perfectly well and forgets.
 */
import { serverConfig } from "../config.js";
import { createLogger } from "../utils/logger.js";
import {
  FilePlayerStatsRepository,
  InMemoryPlayerStatsRepository,
} from "./PlayerStatsRepository.js";
import { PlayerStatsService } from "./PlayerStatsService.js";

const logger = createLogger("stats");

const fileBacked = new PlayerStatsService(
  new FilePlayerStatsRepository(serverConfig.admin.dataDir),
  logger,
);
const memoryBacked = new PlayerStatsService(new InMemoryPlayerStatsRepository(), logger);

let active = fileBacked;

/** The service rooms should use. */
export function playerStats(): PlayerStatsService {
  return active;
}

export async function initialisePlayerStats(): Promise<void> {
  try {
    await fileBacked.load();
  } catch (error) {
    logger.error("Could not load stored player statistics; continuing in memory", {
      dataDir: serverConfig.admin.dataDir,
      error: error instanceof Error ? error.message : String(error),
    });
    active = memoryBacked;
    await memoryBacked.load();
  }
}

export { PlayerStatsService, emptyCareer } from "./PlayerStatsService.js";
export {
  FilePlayerStatsRepository,
  InMemoryPlayerStatsRepository,
  type PlayerStatsRepository,
} from "./PlayerStatsRepository.js";
