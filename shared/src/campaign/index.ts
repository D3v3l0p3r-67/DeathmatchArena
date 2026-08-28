export * from "./types.js";
export * from "./catalogue.js";
export * from "./validate.js";
export { OUTPOST_ARENA, OUTPOST_LEVEL } from "./levels/outpost.js";

import type { ArenaDefinition } from "../arena/types.js";
import { OUTPOST_ARENA, OUTPOST_LEVEL } from "./levels/outpost.js";
import type { CampaignLevelDefinition } from "./types.js";

/** The campaign, in play order. Levels unlock front to back. */
export const CAMPAIGN_LEVELS: readonly CampaignLevelDefinition[] = [OUTPOST_LEVEL];

/**
 * Campaign maps, looked up directly.
 *
 * Deliberately not through `getArena`: campaign arenas ship `enabled: false`
 * so multiplayer rotation and the lobby picker never offer them, and the
 * general lookup treats disabled arenas as unplayable -- which, for a match,
 * they are. A campaign level is the one thing allowed to play on one.
 */
const CAMPAIGN_ARENAS: readonly ArenaDefinition[] = [OUTPOST_ARENA];

export function getCampaignArena(arenaId: string): ArenaDefinition | null {
  return CAMPAIGN_ARENAS.find((arena) => arena.id === arenaId) ?? null;
}
