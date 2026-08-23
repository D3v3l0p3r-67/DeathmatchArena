/**
 * The arena the game ships with.
 *
 * A seed rather than a fixture: on first start the repository stores this, and
 * from then on it is an ordinary arena an administrator can edit, duplicate or
 * disable like any other. Nothing in the simulation refers to it by name.
 *
 * "The Foundry" -- 3200x1800, three vertical lanes (left tower / central mesa /
 * right tower), a ground-level passage beneath the mesa, and enough overlapping
 * ledges that every area is reachable with a single jump (max jump height is
 * ~138px at the shipped gravity, max gap ~230px).
 */
import { SurfaceType, type SurfaceTypeValue } from "../game/types.js";
import { TrapActivation, type ArenaDefinition, type ArenaElement, type TrapDefinition } from "./types.js";

const { FLOOR, PLATFORM, WALL, OBSTACLE } = SurfaceType;

function element(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  type: SurfaceTypeValue,
): ArenaElement {
  return { id, type, x, y, width, height };
}

/**
 * A trap placed with everything inherited unless stated.
 *
 * Leaving the overrides `null` is the point: the shipped arena follows the
 * global trap configuration, so retuning traps in the admin interface reaches it
 * without anyone editing this file.
 */
function trap(
  id: string,
  type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  activation: TrapDefinition["activation"],
  params: TrapDefinition["params"] = {},
  overrides: Partial<TrapDefinition> = {},
): TrapDefinition {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    enabled: true,
    activation,
    damage: null,
    activationDelayMs: null,
    activeDurationMs: null,
    cooldownMs: null,
    moveSpeed: null,
    triggerRadius: null,
    params,
    ...overrides,
  };
}

const FOUNDRY: ArenaDefinition = {
  id: "foundry",
  name: "The Foundry",
  enabled: true,
  width: 3200,
  height: 1800,
  backgroundColor: 0x11151f,
  fogColor: 0x1b2233,

  elements: [
    // --- Arena shell -------------------------------------------------------
    element("floor-1", 0, 1740, 3200, 60, FLOOR),
    element("wall-1", 0, 0, 3200, 40, WALL),
    element("wall-2", 0, 0, 40, 1800, WALL),
    element("wall-3", 3160, 0, 40, 1800, WALL),
    // --- Left tower --------------------------------------------------------
    element("platform-1", 160, 1620, 240, 24, PLATFORM),
    element("platform-2", 480, 1500, 240, 24, PLATFORM),
    element("platform-3", 160, 1380, 240, 24, PLATFORM),
    element("platform-4", 480, 1260, 240, 24, PLATFORM),
    element("platform-5", 160, 1140, 240, 24, PLATFORM),
    element("platform-6", 480, 1020, 240, 24, PLATFORM),
    element("platform-7", 160, 900, 300, 24, PLATFORM),
    element("wall-4", 820, 1260, 26, 480, WALL),
    // --- Central mesa and the passage underneath it ------------------------
    element("platform-8", 1150, 1320, 900, 40, PLATFORM),
    element("platform-9", 900, 1560, 200, 24, PLATFORM),
    element("platform-10", 1040, 1440, 200, 24, PLATFORM),
    element("platform-11", 2100, 1560, 200, 24, PLATFORM),
    element("platform-12", 1960, 1440, 200, 24, PLATFORM),
    element("obstacle-1", 1010, 1620, 120, 120, OBSTACLE),
    element("obstacle-2", 2070, 1620, 120, 120, OBSTACLE),
    element("obstacle-3", 1520, 1650, 160, 90, OBSTACLE),
    // --- Above the mesa ----------------------------------------------------
    element("platform-13", 1400, 1140, 400, 24, PLATFORM),
    element("wall-5", 1580, 1164, 26, 156, WALL),
    element("platform-14", 1150, 1020, 220, 24, PLATFORM),
    element("platform-15", 1830, 1020, 220, 24, PLATFORM),
    element("platform-16", 1440, 880, 320, 24, PLATFORM),
    element("platform-17", 1300, 700, 600, 30, PLATFORM),
    // --- Right tower -------------------------------------------------------
    element("platform-18", 2800, 1620, 240, 24, PLATFORM),
    element("platform-19", 2480, 1500, 240, 24, PLATFORM),
    element("platform-20", 2800, 1380, 240, 24, PLATFORM),
    element("platform-21", 2480, 1260, 240, 24, PLATFORM),
    element("platform-22", 2800, 1140, 240, 24, PLATFORM),
    element("platform-23", 2480, 1020, 240, 24, PLATFORM),
    element("platform-24", 2740, 900, 300, 24, PLATFORM),
    element("wall-6", 2354, 1260, 26, 480, WALL),
    // --- Upper ring --------------------------------------------------------
    element("platform-25", 200, 760, 380, 26, PLATFORM),
    element("platform-26", 2620, 760, 380, 26, PLATFORM),
    element("platform-27", 700, 640, 300, 22, PLATFORM),
    element("platform-28", 2200, 640, 300, 22, PLATFORM),
    element("platform-29", 420, 500, 260, 22, PLATFORM),
    element("platform-30", 2520, 500, 260, 22, PLATFORM),
    element("platform-31", 900, 380, 400, 24, PLATFORM),
    element("platform-32", 1900, 380, 400, 24, PLATFORM),
    element("platform-33", 1400, 260, 400, 24, PLATFORM),
    element("platform-34", 1080, 520, 200, 22, PLATFORM),
    element("platform-35", 1920, 520, 200, 22, PLATFORM),
  ],

  // Where power-up crates may appear: each point is a crate's centre, resting on
  // a surface. Part of the map rather than the game configuration, because a
  // position is only meaningful against this geometry.
  powerUpSpawns: [
    { id: "crate-1", x: 280, y: 1598, enabled: true },
    { id: "crate-2", x: 600, y: 1478, enabled: true },
    { id: "crate-3", x: 310, y: 878, enabled: true },
    { id: "crate-4", x: 700, y: 1718, enabled: true },
    { id: "crate-5", x: 1350, y: 1718, enabled: true },
    { id: "crate-6", x: 2500, y: 1718, enabled: true },
    { id: "crate-7", x: 1300, y: 1298, enabled: true },
    { id: "crate-8", x: 1900, y: 1298, enabled: true },
    { id: "crate-9", x: 1500, y: 1118, enabled: true },
    { id: "crate-10", x: 1600, y: 858, enabled: true },
    { id: "crate-11", x: 1600, y: 678, enabled: true },
    { id: "crate-12", x: 2600, y: 1478, enabled: true },
    { id: "crate-13", x: 2920, y: 1598, enabled: true },
    { id: "crate-14", x: 2890, y: 878, enabled: true },
  ],

  playerSpawns: [
    { id: "spawn-1", x: 280, y: 1595, enabled: true },
    { id: "spawn-2", x: 600, y: 1715, enabled: true },
    { id: "spawn-3", x: 1250, y: 1271, enabled: true },
    { id: "spawn-4", x: 1950, y: 1271, enabled: true },
    { id: "spawn-5", x: 2920, y: 1595, enabled: true },
    { id: "spawn-6", x: 2620, y: 1715, enabled: true },
    { id: "spawn-7", x: 1600, y: 651, enabled: true },
    { id: "spawn-8", x: 390, y: 711, enabled: true },
    { id: "spawn-9", x: 2810, y: 711, enabled: true },
    { id: "spawn-10", x: 1600, y: 1091, enabled: true },
  ],

  // A handful of hazards, spread so that no single route through the arena is
  // free of them and none of them can trap a player with no way out.
  traps: [
    trap("trap-1", "spikes", 700, 1716, 160, 24, TrapActivation.ALWAYS),
    trap("trap-2", "spikes", 2340, 1716, 160, 24, TrapActivation.ALWAYS),
    // In the ground-level passage beneath the mesa, so the safe-looking shortcut
    // is not actually safe.
    trap("trap-3", "fire", 1250, 1600, 90, 140, TrapActivation.PERIODIC),
    // Patrols the length of the central mesa, the arena's most contested ledge.
    // Starts clear of the two mesa spawn points: its old route came within
    // thirty pixels of both, which is not a hazard, it is an ambush on whoever
    // happens to spawn there.
    trap("trap-4", "saw", 1440, 1264, 56, 56, TrapActivation.ALWAYS, {
      direction: "right",
      travel: 380,
    }),
    // Hangs under the top platform and drops on whoever climbs to it.
    trap("trap-5", "falling-object", 1550, 780, 90, 90, TrapActivation.PROXIMITY, {
      direction: "down",
      travel: 480,
      fallGravity: 2400,
    }),
  ],

  updatedAt: 0,
};

/** The arenas built into the build, keyed by id. Seeds for the repository. */
export const BUILT_IN_ARENAS: readonly ArenaDefinition[] = Object.freeze([FOUNDRY]);

export const DEFAULT_ARENA_ID = FOUNDRY.id;
