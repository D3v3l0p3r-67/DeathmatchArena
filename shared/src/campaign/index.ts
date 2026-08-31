export * from "./types.js";
export * from "./catalogue.js";
export * from "./tuning.js";
export * from "./overrides.js";
export * from "./validate.js";
export { OUTPOST_ARENA, OUTPOST_LEVEL } from "./levels/outpost.js";
export { REFINERY_ARENA, REFINERY_LEVEL } from "./levels/refinery.js";

import type { ArenaDefinition } from "../arena/types.js";
import { OUTPOST_ARENA, OUTPOST_LEVEL } from "./levels/outpost.js";
import { REFINERY_ARENA, REFINERY_LEVEL } from "./levels/refinery.js";
import type { CampaignLevelDefinition } from "./types.js";

/**
 * Every level that exists. The *order* of a playthrough comes from each
 * level's `nextLevelId`, not from this array -- this is the catalogue, the
 * chain is the content.
 */
export const CAMPAIGN_LEVELS: readonly CampaignLevelDefinition[] = [OUTPOST_LEVEL, REFINERY_LEVEL];

/** The level the campaign opens on: the one nothing else leads to. */
export const CAMPAIGN_FIRST_LEVEL_ID = OUTPOST_LEVEL.id;

export function getCampaignLevel(levelId: string): CampaignLevelDefinition | null {
  return CAMPAIGN_LEVELS.find((level) => level.id === levelId) ?? null;
}

/**
 * The chain from `startId` onwards, in play order.
 *
 * Follows `nextLevelId` and stops at the end, at an unknown id, or on a loop --
 * a campaign that pointed at itself would otherwise hang whoever walked it.
 */
export function campaignChain(startId: string = CAMPAIGN_FIRST_LEVEL_ID): CampaignLevelDefinition[] {
  const chain: CampaignLevelDefinition[] = [];
  const seen = new Set<string>();

  let current = getCampaignLevel(startId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.nextLevelId ? getCampaignLevel(current.nextLevelId) : null;
  }
  return chain;
}

/**
 * Campaign maps, looked up directly.
 *
 * Deliberately not through `getArena`: campaign arenas ship `enabled: false`
 * so multiplayer rotation and the lobby picker never offer them, and the
 * general lookup treats disabled arenas as unplayable -- which, for a match,
 * they are. A campaign level is the one thing allowed to play on one.
 */
const CAMPAIGN_ARENAS: readonly ArenaDefinition[] = [OUTPOST_ARENA, REFINERY_ARENA];

export function getCampaignArena(arenaId: string): ArenaDefinition | null {
  return CAMPAIGN_ARENAS.find((arena) => arena.id === arenaId) ?? null;
}
