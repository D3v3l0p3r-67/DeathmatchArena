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
    // A way up out of the ground-level passage that does not involve the
    // staircase everybody watches.
    trap("trap-6", "jump-pad", 1660, 1720, 110, 20, TrapActivation.ALWAYS, { force: 2.6 }),
    // Hangs under the top platform and drops on whoever climbs to it.
    trap("trap-5", "falling-object", 1550, 780, 90, 90, TrapActivation.PROXIMITY, {
      direction: "down",
      travel: 480,
      fallGravity: 2400,
    }),
  ],

  updatedAt: 0,
};

/**
 * "The Gantry" -- 3600x1200, wide and low.
 *
 * The opposite shape to the Foundry: four long horizontal decks with the gaps
 * staggered so no lane is a straight run, and sightlines the length of the map
 * for anyone holding a sniper. Vertical spacing is 180px, which is above a
 * single jump (~138px) and inside a double one, so moving up a level is a
 * deliberate act rather than something you do by accident.
 */
const GANTRY: ArenaDefinition = {
  id: "gantry",
  name: "The Gantry",
  enabled: true,
  width: 3600,
  height: 1200,
  backgroundColor: 0x0f1620,
  fogColor: 0x1a2734,

  elements: [
    // --- Arena shell -------------------------------------------------------
    element("floor-1", 0, 1140, 3600, 60, FLOOR),
    element("wall-1", 0, 0, 3600, 40, WALL),
    element("wall-2", 0, 0, 40, 1200, WALL),
    element("wall-3", 3560, 0, 40, 1200, WALL),
    // --- Lower catwalks ----------------------------------------------------
    element("catwalk-1", 300, 960, 400, 24, PLATFORM),
    element("catwalk-2", 900, 960, 400, 24, PLATFORM),
    element("catwalk-3", 1500, 960, 600, 24, PLATFORM),
    element("catwalk-4", 2300, 960, 400, 24, PLATFORM),
    element("catwalk-5", 2900, 960, 400, 24, PLATFORM),
    // --- Middle catwalks, offset so no lane is a straight run --------------
    element("gantry-1", 140, 780, 380, 24, PLATFORM),
    element("gantry-2", 720, 780, 400, 24, PLATFORM),
    element("gantry-3", 1320, 780, 400, 24, PLATFORM),
    element("gantry-4", 1920, 780, 400, 24, PLATFORM),
    element("gantry-5", 2520, 780, 400, 24, PLATFORM),
    element("gantry-6", 3120, 780, 340, 24, PLATFORM),
    // --- Upper walkways ----------------------------------------------------
    element("walk-1", 360, 600, 400, 24, PLATFORM),
    element("walk-2", 1000, 600, 700, 24, PLATFORM),
    element("walk-3", 1900, 600, 700, 24, PLATFORM),
    element("walk-4", 2840, 600, 400, 24, PLATFORM),
    // --- The roof ----------------------------------------------------------
    element("roof-1", 700, 420, 400, 22, PLATFORM),
    element("roof-2", 1500, 420, 600, 22, PLATFORM),
    element("roof-3", 2500, 420, 400, 22, PLATFORM),
    element("mast-1", 1600, 260, 400, 22, PLATFORM),
    // --- Cover on the floor ------------------------------------------------
    element("obstacle-1", 520, 1020, 120, 120, OBSTACLE),
    element("obstacle-2", 1720, 1050, 160, 90, OBSTACLE),
    element("obstacle-3", 2940, 1020, 120, 120, OBSTACLE),
    element("wall-4", 1180, 1000, 26, 140, WALL),
    element("wall-5", 2380, 1000, 26, 140, WALL),
  ],

  powerUpSpawns: [
    { id: "crate-1", x: 500, y: 938, enabled: true },
    { id: "crate-2", x: 1100, y: 938, enabled: true },
    { id: "crate-3", x: 1800, y: 938, enabled: true },
    { id: "crate-4", x: 2500, y: 938, enabled: true },
    { id: "crate-5", x: 3100, y: 938, enabled: true },
    { id: "crate-6", x: 330, y: 758, enabled: true },
    { id: "crate-7", x: 1520, y: 758, enabled: true },
    { id: "crate-8", x: 2720, y: 758, enabled: true },
    { id: "crate-9", x: 1350, y: 578, enabled: true },
    { id: "crate-10", x: 2250, y: 578, enabled: true },
    { id: "crate-11", x: 1800, y: 398, enabled: true },
    { id: "crate-12", x: 900, y: 1118, enabled: true },
    { id: "crate-13", x: 2700, y: 1118, enabled: true },
    { id: "crate-14", x: 1800, y: 238, enabled: true },
  ],

  playerSpawns: [
    { id: "spawn-1", x: 300, y: 1115, enabled: true },
    { id: "spawn-2", x: 3300, y: 1115, enabled: true },
    { id: "spawn-3", x: 1500, y: 1115, enabled: true },
    { id: "spawn-4", x: 2100, y: 1115, enabled: true },
    { id: "spawn-5", x: 400, y: 935, enabled: true },
    { id: "spawn-6", x: 3200, y: 935, enabled: true },
    { id: "spawn-7", x: 900, y: 755, enabled: true },
    { id: "spawn-8", x: 2700, y: 755, enabled: true },
    { id: "spawn-9", x: 1200, y: 575, enabled: true },
    { id: "spawn-10", x: 2400, y: 575, enabled: true },
  ],

  traps: [
    // Under the two widest gaps in the lower deck: falling short is punished.
    trap("trap-1", "spikes", 760, 1116, 130, 24, TrapActivation.ALWAYS),
    trap("trap-2", "spikes", 2740, 1116, 130, 24, TrapActivation.ALWAYS),
    // The long middle walkway is the best position on the map, so it is also
    // the one thing patrolling back and forth.
    trap("trap-3", "saw", 1100, 544, 56, 56, TrapActivation.ALWAYS, {
      direction: "right",
      travel: 520,
    }),
    // Vents at both ends of the middle deck, on the routes between the towers.
    trap("trap-4", "fire", 1360, 640, 80, 140, TrapActivation.PERIODIC),
    trap("trap-5", "fire", 2240, 640, 80, 140, TrapActivation.PERIODIC),
    // The decks are a double jump apart; these are the shortcut, and standing on
    // one is as visible as it sounds.
    trap("trap-7", "jump-pad", 480, 1120, 110, 20, TrapActivation.ALWAYS, { force: 2.9 }),
    trap("trap-8", "jump-pad", 3020, 1120, 110, 20, TrapActivation.ALWAYS, { force: 2.9 }),
    // Hangs over the mast, the highest and most exposed perch.
    trap("trap-6", "falling-object", 1780, 300, 80, 80, TrapActivation.PROXIMITY, {
      direction: "down",
      travel: 420,
      fallGravity: 2400,
    }),
  ],

  updatedAt: 0,
};

/**
 * "The Silo" -- 2000x2400, tall and narrow.
 *
 * A vertical fight. A solid column runs up the middle of the lower half, so the
 * bottom is two rooms rather than one, and the way up is a spiral of ledges
 * alternating left and right with a stepping stone between each pair. Falls are
 * long, cover is scarce, and the crown at the top is worth holding and hard to
 * hold -- which is what the crusher hanging over it is for.
 */
const SILO: ArenaDefinition = {
  id: "silo",
  name: "The Silo",
  enabled: true,
  width: 2000,
  height: 2400,
  backgroundColor: 0x14101a,
  fogColor: 0x241d2e,

  elements: [
    // --- Arena shell -------------------------------------------------------
    element("floor-1", 0, 2340, 2000, 60, FLOOR),
    element("wall-1", 0, 0, 2000, 40, WALL),
    element("wall-2", 0, 0, 40, 2400, WALL),
    element("wall-3", 1960, 0, 40, 2400, WALL),
    // --- The column the whole map winds around -----------------------------
    element("column-1", 940, 900, 120, 1140, WALL),
    element("column-2", 820, 2040, 360, 40, PLATFORM),
    // --- The spiral: alternating ledges, 180px apart -----------------------
    element("ledge-1", 140, 2160, 420, 24, PLATFORM),
    element("step-1", 660, 2070, 200, 22, PLATFORM),
    element("ledge-2", 1300, 1980, 420, 24, PLATFORM),
    element("step-2", 900, 1890, 200, 22, PLATFORM),
    element("ledge-3", 140, 1800, 420, 24, PLATFORM),
    element("step-3", 660, 1710, 200, 22, PLATFORM),
    element("ledge-4", 1300, 1620, 420, 24, PLATFORM),
    element("step-4", 900, 1530, 200, 22, PLATFORM),
    element("ledge-5", 140, 1440, 420, 24, PLATFORM),
    element("step-5", 660, 1350, 200, 22, PLATFORM),
    element("ledge-6", 1300, 1260, 420, 24, PLATFORM),
    element("step-6", 900, 1170, 200, 22, PLATFORM),
    element("ledge-7", 140, 1080, 420, 24, PLATFORM),
    element("step-7", 660, 990, 200, 22, PLATFORM),
    element("ledge-8", 1300, 900, 420, 24, PLATFORM),
    element("step-8", 900, 810, 200, 22, PLATFORM),
    element("ledge-9", 140, 720, 420, 24, PLATFORM),
    element("step-9", 660, 630, 200, 22, PLATFORM),
    // The rung the ladder was missing. Without it the crown of the tower --
    // and the crate that spawns on it -- could not be reached by anybody, bot
    // or person: the gap from step-9 to ledge-10 was 440px, past any jump.
    element("step-9b", 1080, 590, 160, 22, PLATFORM),
    // The rung the ladder was missing. Without it the crown of the tower --
    // and the crate that spawns on it -- could not be reached by anybody, bot
    // or person: the gap from step-9 to ledge-10 was 440px, past any jump.
    element("ledge-10", 1300, 540, 420, 24, PLATFORM),
    element("step-10", 900, 450, 200, 22, PLATFORM),
    // --- The top of the silo -----------------------------------------------
    element("crown-1", 700, 380, 600, 26, PLATFORM),
    element("crown-2", 300, 260, 260, 22, PLATFORM),
    element("crown-3", 1440, 260, 260, 22, PLATFORM),
    element("crown-4", 860, 200, 280, 22, PLATFORM),
    // --- Cover at the bottom -----------------------------------------------
    element("obstacle-1", 420, 2220, 120, 120, OBSTACLE),
    element("obstacle-2", 1460, 2220, 120, 120, OBSTACLE),
  ],

  powerUpSpawns: [
    { id: "crate-1", x: 300, y: 2138, enabled: true },
    { id: "crate-2", x: 1500, y: 1958, enabled: true },
    { id: "crate-3", x: 300, y: 1778, enabled: true },
    { id: "crate-4", x: 1500, y: 1598, enabled: true },
    { id: "crate-5", x: 300, y: 1418, enabled: true },
    { id: "crate-6", x: 1500, y: 1238, enabled: true },
    { id: "crate-7", x: 300, y: 1058, enabled: true },
    { id: "crate-8", x: 1500, y: 878, enabled: true },
    { id: "crate-9", x: 1000, y: 358, enabled: true },
    // On the lip of the column's base that sticks out past the column itself.
    { id: "crate-10", x: 1140, y: 2018, enabled: true },
    { id: "crate-11", x: 700, y: 2318, enabled: true },
    { id: "crate-12", x: 1300, y: 2318, enabled: true },
  ],

  playerSpawns: [
    { id: "spawn-1", x: 250, y: 2315, enabled: true },
    { id: "spawn-2", x: 1750, y: 2315, enabled: true },
    { id: "spawn-3", x: 300, y: 2135, enabled: true },
    { id: "spawn-4", x: 1500, y: 1955, enabled: true },
    { id: "spawn-5", x: 300, y: 1775, enabled: true },
    { id: "spawn-6", x: 1500, y: 1595, enabled: true },
    { id: "spawn-7", x: 300, y: 1415, enabled: true },
    { id: "spawn-8", x: 1500, y: 1235, enabled: true },
    { id: "spawn-9", x: 300, y: 1055, enabled: true },
    { id: "spawn-10", x: 860, y: 2015, enabled: true },
  ],

  traps: [
    // The bottom of a long fall is not a good place to land.
    trap("trap-1", "spikes", 860, 2316, 280, 24, TrapActivation.ALWAYS),
    // Crushes anyone holding the crown, which is the only reason not to.
    trap("trap-2", "crusher", 880, 220, 240, 90, TrapActivation.PERIODIC, {
      direction: "down",
      travel: 150,
    }),
    // Two vents on the spiral, on opposite sides, so neither route up is free.
    trap("trap-3", "fire", 620, 1660, 80, 130, TrapActivation.PERIODIC),
    trap("trap-4", "fire", 1320, 1120, 80, 130, TrapActivation.PERIODIC),
    // Patrols the wide ledge halfway up.
    trap("trap-5", "saw", 1340, 1544, 52, 52, TrapActivation.ALWAYS, {
      direction: "right",
      travel: 320,
    }),
    // The fastest way back into the spiral after a long fall.
    trap("trap-7", "jump-pad", 300, 2320, 110, 20, TrapActivation.ALWAYS, { force: 3.2 }),
    // Hangs over the two-room floor.
    trap("trap-6", "falling-object", 1420, 2100, 80, 80, TrapActivation.PROXIMITY, {
      direction: "down",
      travel: 220,
      fallGravity: 2400,
    }),
  ],

  updatedAt: 0,
};

/** The arenas built into the build, keyed by id. Seeds for the repository. */
export const BUILT_IN_ARENAS: readonly ArenaDefinition[] = Object.freeze([FOUNDRY, GANTRY, SILO]);

export const DEFAULT_ARENA_ID = FOUNDRY.id;
