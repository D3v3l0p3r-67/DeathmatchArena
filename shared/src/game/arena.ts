import type { Rect } from "../core/geometry.js";
import { SurfaceType, type SurfaceTypeValue } from "./types.js";

/** A solid piece of arena geometry. `type` is cosmetic only — everything collides. */
export interface Surface extends Rect {
  type: SurfaceTypeValue;
}

export interface SpawnPoint {
  /** World position of the player's centre at spawn. */
  x: number;
  y: number;
}

export interface ArenaDefinition {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Rendering hints; gameplay never depends on them. */
  backgroundColor: number;
  fogColor: number;
  surfaces: Surface[];
  spawnPoints: SpawnPoint[];
}

const { FLOOR, PLATFORM, WALL, OBSTACLE } = SurfaceType;

function surface(x: number, y: number, width: number, height: number, type: SurfaceTypeValue): Surface {
  return { x, y, width, height, type };
}

/**
 * "The Foundry" — the default 3200x1800 arena.
 *
 * Layout goals: three vertical lanes (left tower / central mesa / right tower), a
 * ground-level passage beneath the mesa, and enough overlapping ledges that every
 * area is reachable with a single jump (max jump height is ~138px, max gap ~230px).
 */
const FOUNDRY: ArenaDefinition = {
  id: "foundry",
  name: "The Foundry",
  width: 3200,
  height: 1800,
  backgroundColor: 0x11151f,
  fogColor: 0x1b2233,
  surfaces: [
    // --- Arena shell -------------------------------------------------------
    surface(0, 1740, 3200, 60, FLOOR),
    surface(0, 0, 3200, 40, WALL),
    surface(0, 0, 40, 1800, WALL),
    surface(3160, 0, 40, 1800, WALL),

    // --- Left tower --------------------------------------------------------
    surface(160, 1620, 240, 24, PLATFORM),
    surface(480, 1500, 240, 24, PLATFORM),
    surface(160, 1380, 240, 24, PLATFORM),
    surface(480, 1260, 240, 24, PLATFORM),
    surface(160, 1140, 240, 24, PLATFORM),
    surface(480, 1020, 240, 24, PLATFORM),
    surface(160, 900, 300, 24, PLATFORM),
    surface(820, 1260, 26, 480, WALL),

    // --- Central mesa and the passage underneath it ------------------------
    surface(1150, 1320, 900, 40, PLATFORM),
    surface(900, 1560, 200, 24, PLATFORM),
    surface(1040, 1440, 200, 24, PLATFORM),
    surface(2100, 1560, 200, 24, PLATFORM),
    surface(1960, 1440, 200, 24, PLATFORM),
    surface(1010, 1620, 120, 120, OBSTACLE),
    surface(2070, 1620, 120, 120, OBSTACLE),
    surface(1520, 1650, 160, 90, OBSTACLE),

    // --- Above the mesa ----------------------------------------------------
    surface(1400, 1140, 400, 24, PLATFORM),
    surface(1580, 1164, 26, 156, WALL),
    surface(1150, 1020, 220, 24, PLATFORM),
    surface(1830, 1020, 220, 24, PLATFORM),
    surface(1440, 880, 320, 24, PLATFORM),
    surface(1300, 700, 600, 30, PLATFORM),

    // --- Right tower -------------------------------------------------------
    surface(2800, 1620, 240, 24, PLATFORM),
    surface(2480, 1500, 240, 24, PLATFORM),
    surface(2800, 1380, 240, 24, PLATFORM),
    surface(2480, 1260, 240, 24, PLATFORM),
    surface(2800, 1140, 240, 24, PLATFORM),
    surface(2480, 1020, 240, 24, PLATFORM),
    surface(2740, 900, 300, 24, PLATFORM),
    surface(2354, 1260, 26, 480, WALL),

    // --- Upper ring --------------------------------------------------------
    surface(200, 760, 380, 26, PLATFORM),
    surface(2620, 760, 380, 26, PLATFORM),
    surface(700, 640, 300, 22, PLATFORM),
    surface(2200, 640, 300, 22, PLATFORM),
    surface(420, 500, 260, 22, PLATFORM),
    surface(2520, 500, 260, 22, PLATFORM),
    surface(900, 380, 400, 24, PLATFORM),
    surface(1900, 380, 400, 24, PLATFORM),
    surface(1400, 260, 400, 24, PLATFORM),
    surface(1080, 520, 200, 22, PLATFORM),
    surface(1920, 520, 200, 22, PLATFORM),
  ],
  spawnPoints: [
    { x: 280, y: 1595 },
    { x: 600, y: 1715 },
    { x: 1250, y: 1271 },
    { x: 1950, y: 1271 },
    { x: 2920, y: 1595 },
    { x: 2620, y: 1715 },
    { x: 1600, y: 651 },
    { x: 390, y: 711 },
    { x: 2810, y: 711 },
    { x: 1600, y: 1091 },
  ],
};

export const ARENAS: Readonly<Record<string, ArenaDefinition>> = Object.freeze({
  [FOUNDRY.id]: FOUNDRY,
});

export const DEFAULT_ARENA_ID = FOUNDRY.id;

export function getArena(arenaId: string): ArenaDefinition {
  return ARENAS[arenaId] ?? ARENAS[DEFAULT_ARENA_ID]!;
}
