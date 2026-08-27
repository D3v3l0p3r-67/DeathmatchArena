import { GameMode as GameModeId } from "@deathmatch/shared";
import { DeathmatchMode } from "./DeathmatchMode.js";
import { FlagHuntMode } from "./FlagHuntMode.js";
import type { GameMode, GameModeServices } from "./GameMode.js";

export type { GameMode, GameModeServices } from "./GameMode.js";
export { DeathmatchMode } from "./DeathmatchMode.js";
export { FlagHuntMode } from "./FlagHuntMode.js";
export { GAME_MODES } from "@deathmatch/shared";

/**
 * Build the mode a match will be played under.
 *
 * An unknown id falls back to deathmatch rather than refusing to start: a
 * stored configuration from a build that had more modes should degrade to a
 * playable room, not a stuck one.
 */
export function createGameMode(id: string, services: GameModeServices): GameMode {
  if (id === GameModeId.FLAG_HUNT) return new FlagHuntMode(services);
  return new DeathmatchMode(services);
}
