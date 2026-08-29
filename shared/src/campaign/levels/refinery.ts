/**
 * Level 2: "Refinery".
 *
 * Where Outpost was a yard fight on open ground, this is a working plant: the
 * hazards are half the opposition. Saws patrol the catwalks, crushers come
 * down on the gauntlet, a marksman watches the long hall, and the boss is a
 * mounted gun that eventually tears itself off its rail.
 *
 * Authored against the figures the engine actually has, not the ones the first
 * level assumed: a single jump rises 91px and a double 159px, so nothing on
 * the route is taller than that; crates rest at floor - 22 and never stack;
 * and no wall reaches the floor on the main route -- the two arches leave a
 * gap, and only a crate in that gap closes it.
 */
import { TrapActivation, type ArenaDefinition, type TrapDefinition } from "../../arena/types.js";
import { SurfaceType, type SurfaceTypeValue } from "../../game/types.js";
import { ASSAULT_RIFLE_ID, FLAMETHROWER_ID, LASER_ID } from "../../config/defaults.js";
import type { CampaignLevelDefinition } from "../types.js";

const { FLOOR, PLATFORM, WALL, OBSTACLE } = SurfaceType;

/** Top of the walking surface. Everything vertical is measured from here. */
const FLOOR_Y = 1340;
/** A crate at rest, and a player at rest, relative to `FLOOR_Y`. */
const CRATE_REST = FLOOR_Y - 22;

function el(id: string, x: number, y: number, width: number, height: number, type: SurfaceTypeValue) {
  return { id, type, x, y, width, height };
}

function trap(
  id: string,
  type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  activation: TrapDefinition["activation"],
  params: TrapDefinition["params"] = {},
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
  };
}

export const REFINERY_ARENA: ArenaDefinition = {
  id: "refinery",
  name: "Refinery",
  // Campaign maps are loaded directly by the campaign, never offered to
  // multiplayer rotation or the lobby's map picker.
  enabled: false,
  width: 9600,
  height: 1400,
  backgroundColor: 0x120e0c,
  fogColor: 0x241a14,

  elements: [
    // Shell
    el("floor", 0, FLOOR_Y, 9600, 60, FLOOR),
    el("ceiling", 0, 0, 9600, 40, WALL),
    el("wall-w", 0, 0, 40, 1400, WALL),
    el("wall-e", 9560, 0, 40, 1400, WALL),

    // --- A. Entry stair: two 90px steps, both within a single jump.
    el("p-a1", 420, 1250, 220, 24, PLATFORM),
    el("p-a2", 760, 1160, 220, 24, PLATFORM),
    el("p-a3", 1080, 1250, 220, 24, PLATFORM),

    // --- B. Saw hall: cover on the floor, a catwalk above it for the brave.
    el("cover-b1", 1620, 1250, 110, 90, OBSTACLE),
    el("p-b1", 1700, 1130, 400, 24, PLATFORM),
    el("cover-b2", 2050, 1250, 110, 90, OBSTACLE),
    el("p-b2", 2400, 1160, 200, 24, PLATFORM),

    // --- D. Crusher gauntlet: nothing underfoot but spikes and timing.
    el("cover-d1", 3000, 1250, 110, 90, OBSTACLE),
    el("cover-d2", 3720, 1250, 110, 90, OBSTACLE),

    // --- E. Pump floor: an enclosed fight, entered and left through arches
    //     that stop well clear of the ground.
    el("pump-arch-w", 4080, 860, 30, 400, WALL),
    el("p-e1", 4300, 1220, 220, 24, PLATFORM),
    el("p-e3", 4700, 1100, 260, 24, PLATFORM),
    el("p-e2", 5150, 1220, 220, 24, PLATFORM),
    el("pump-arch-e", 5480, 860, 30, 400, WALL),

    // --- G. Ascent: catwalks over a floor a saw owns.
    el("p-g1", 5950, 1150, 260, 24, PLATFORM),
    el("p-g2", 6300, 1030, 260, 24, PLATFORM),
    el("p-g3", 6650, 1150, 260, 24, PLATFORM),

    // --- H. The alcove, and the last cover before the doors.
    el("p-h1", 7400, 1130, 200, 24, PLATFORM),
    el("cover-h1", 7800, 1250, 110, 90, OBSTACLE),

    // --- J. Boss hall: two tiers and a pad, so the fight is not fought
    //     standing in one place.
    el("p-j1", 8400, 1200, 240, 24, PLATFORM),
    el("p-j2", 8800, 1080, 260, 24, PLATFORM),
    el("p-j3", 9150, 1200, 240, 24, PLATFORM),
  ],

  playerSpawns: [{ id: "start", x: 200, y: FLOOR_Y - 40, enabled: true }],

  powerUpSpawns: [
    { id: "start-med", x: 300, y: CRATE_REST, enabled: true },
    { id: "saw-prize", x: 1900, y: 1108, enabled: true },
    { id: "hall-med", x: 2300, y: CRATE_REST, enabled: true },
    { id: "gauntlet-med", x: 3400, y: CRATE_REST, enabled: true },
    { id: "pump-med", x: 4700, y: 1078, enabled: true },
    { id: "pump-door", x: 5495, y: CRATE_REST, enabled: true },
    { id: "cp2-rocket", x: 5680, y: CRATE_REST, enabled: true },
    { id: "alcove-prize", x: 7500, y: 1108, enabled: true },
    { id: "cp3-med", x: 8150, y: CRATE_REST, enabled: true },
    { id: "boss-gren", x: 8300, y: CRATE_REST, enabled: true },
    { id: "boss-med", x: 9320, y: CRATE_REST, enabled: true },
  ],

  traps: [
    // A. A vent that has to be waited out or run through.
    trap("t-fire-1", "fire", 1350, FLOOR_Y - 140, 90, 140, TrapActivation.PERIODIC),

    // B. The catwalk is the fast route and the saw is the price of it.
    trap("t-saw-1", "saw", 1750, 1074, 56, 56, TrapActivation.ALWAYS, {
      direction: "right",
      travel: 300,
    }),

    // D. Three presses over the gauntlet, and spikes where you would stand.
    trap("t-crush-1", "crusher", 2950, 1040, 90, 90, TrapActivation.PROXIMITY, {
      direction: "down",
      travel: 210,
    }),
    trap("t-crush-2", "crusher", 3350, 1040, 90, 90, TrapActivation.PROXIMITY, {
      direction: "down",
      travel: 210,
    }),
    trap("t-crush-3", "crusher", 3750, 1040, 90, 90, TrapActivation.PROXIMITY, {
      direction: "down",
      travel: 210,
    }),
    trap("t-spikes-1", "spikes", 3180, FLOOR_Y - 24, 140, 24, TrapActivation.ALWAYS),

    // G. A saw owns the floor, a pad offers the way over it.
    trap("t-pad-1", "jump-pad", 5800, FLOOR_Y - 20, 110, 20, TrapActivation.ALWAYS, { force: 2.8 }),
    trap("t-saw-2", "saw", 6100, FLOOR_Y - 56, 56, 56, TrapActivation.ALWAYS, {
      direction: "right",
      travel: 350,
    }),

    // J. Keeps the boss fight vertical.
    trap("t-pad-2", "jump-pad", 8650, FLOOR_Y - 20, 110, 20, TrapActivation.ALWAYS, { force: 2.5 }),
  ],

  updatedAt: 0,
};

export const REFINERY_LEVEL: CampaignLevelDefinition = {
  id: "level-02",
  name: "Refinery",
  arenaId: "refinery",

  playerSpawn: { x: 200, y: FLOOR_Y - 40 },
  startingWeapon: ASSAULT_RIFLE_ID,
  startingGrenades: 2,

  // Arriving with what Outpost was finished with: the reward for clearing a
  // level is that the next one starts with the gun you earned.
  carryOver: { weapon: true, grenades: true },

  interlude: {
    kind: "briefing",
    eyebrow: "Sector 2",
    title: "Refinery",
    lines: [
      "The outpost fell. What it was guarding did not.",
      "The plant is still running — and the machinery does not care whose side you are on.",
      "Shut down the Foreman.",
    ],
  },

  parTimeMs: 6 * 60 * 1000,
  respawnRule: { kind: "checkpoint" },

  checkpoints: [
    { id: "cp1", x: 2700, y: FLOOR_Y - 40, zone: { x: 2660, y: 0, width: 140, height: 1400 } },
    { id: "cp2", x: 5620, y: FLOOR_Y - 40, zone: { x: 5580, y: 0, width: 140, height: 1400 } },
    { id: "cp3", x: 8120, y: FLOOR_Y - 40, zone: { x: 8060, y: 0, width: 140, height: 1400 } },
  ],

  cameraZones: [
    { id: "pump", zone: { x: 4040, y: 0, width: 1500, height: 1400 } },
    { id: "boss-hall", zone: { x: 8200, y: 0, width: 1400, height: 1400 } },
  ],

  crates: [
    { spawnPointId: "start-med", powerUpId: "health-50" },
    { spawnPointId: "saw-prize", powerUpId: "weapon-sniper" },
    { spawnPointId: "hall-med", powerUpId: "health-50" },
    { spawnPointId: "gauntlet-med", powerUpId: "health-50" },
    { spawnPointId: "pump-med", powerUpId: "health-50" },
    // The one crate holding the pump floor's exit shut.
    { spawnPointId: "pump-door", group: "pump-door" },
    { spawnPointId: "cp2-rocket", powerUpId: "weapon-rocket-launcher" },
    { spawnPointId: "alcove-prize", powerUpId: "speed-boost" },
    { spawnPointId: "cp3-med", powerUpId: "health-50" },
    { spawnPointId: "boss-gren", powerUpId: "grenade-pack" },
    { spawnPointId: "boss-med", powerUpId: "health-50" },
  ],

  encounters: [
    {
      id: "pump",
      lockCameraZone: "pump",
      waves: [
        {
          enemies: [
            { type: "soldier", x: 4250, y: 1290 },
            { type: "soldier", x: 5300, y: 1290 },
            { type: "enforcer", x: 4800, y: 1290 },
            { type: "runner", x: 5050, y: 1290, difficulties: ["hard", "extreme"] },
          ],
        },
        {
          enemies: [
            { type: "enforcer", x: 4300, y: 1290 },
            { type: "heavy", x: 5250, y: 1290 },
            { type: "zealot", x: 4800, y: 1070, difficulties: ["extreme"] },
          ],
        },
      ],
    },
  ],

  triggers: [
    {
      id: "t-briefing",
      when: { kind: "levelStarted" },
      actions: [
        { kind: "objective", text: "Work through the plant" },
        { kind: "message", text: "REFINERY — mind the machinery", durationMs: 3500 },
      ],
    },
    {
      id: "t-patrol",
      when: { kind: "enterZone", zone: { x: 900, y: 0, width: 120, height: 1400 } },
      actions: [
        {
          kind: "spawnEnemies",
          group: "patrol",
          enemies: [
            { type: "soldier", x: 1500, y: 1290 },
            { type: "soldier", x: 1850, y: 1290 },
            { type: "runner", x: 1650, y: 1290, difficulties: ["hard", "extreme"] },
          ],
        },
      ],
    },
    {
      id: "t-saw-hall",
      when: { kind: "enterZone", zone: { x: 1560, y: 0, width: 120, height: 1400 } },
      actions: [
        { kind: "objective", text: "Cross the saw hall" },
        {
          kind: "spawnEnemies",
          group: "hall",
          enemies: [
            { type: "marksman", x: 2500, y: 1136 },
            { type: "soldier", x: 2250, y: 1290 },
            { type: "enforcer", x: 2600, y: 1290, difficulties: ["hard", "extreme"] },
          ],
        },
      ],
    },
    {
      id: "t-gauntlet",
      when: { kind: "enterZone", zone: { x: 2820, y: 0, width: 120, height: 1400 } },
      actions: [
        { kind: "objective", text: "Get through the presses" },
        {
          kind: "spawnEnemies",
          group: "gauntlet",
          enemies: [
            { type: "enforcer", x: 3550, y: 1290 },
            { type: "soldier", x: 3900, y: 1290 },
            { type: "marksman", x: 3980, y: 1290, difficulties: ["hard", "extreme"] },
          ],
        },
      ],
    },
    {
      id: "t-pump",
      when: { kind: "enterZone", zone: { x: 4140, y: 0, width: 100, height: 1400 } },
      actions: [
        { kind: "objective", text: "Clear the pump floor" },
        { kind: "startEncounter", encounterId: "pump" },
      ],
    },
    {
      // Scripted: clearing the floor blows its own exit open.
      id: "t-breach",
      when: { kind: "encounterCompleted", encounterId: "pump" },
      actions: [
        { kind: "destroyObjects", group: "pump-door" },
        { kind: "shake", intensity: 0.01 },
        { kind: "message", text: "Pressure released — the east door is open.", durationMs: 2500 },
        { kind: "objective", text: "Climb to the control deck" },
      ],
    },
    {
      id: "t-ascent",
      when: { kind: "enterZone", zone: { x: 5760, y: 0, width: 120, height: 1400 } },
      actions: [
        {
          kind: "spawnEnemies",
          group: "deck",
          enemies: [
            { type: "zealot", x: 6430, y: 1006 },
            { type: "soldier", x: 6780, y: 1126 },
            { type: "enforcer", x: 7000, y: 1290, difficulties: ["hard", "extreme"] },
          ],
        },
      ],
    },
    {
      id: "t-boss-gate",
      when: { kind: "enterZone", zone: { x: 8250, y: 0, width: 100, height: 1400 } },
      actions: [
        { kind: "lockCamera", zoneId: "boss-hall" },
        { kind: "startBoss" },
        { kind: "objective", text: "Shut down the Foreman" },
      ],
    },
    {
      id: "t-boss-down",
      when: { kind: "bossDefeated" },
      actions: [
        { kind: "unlockCamera" },
        { kind: "shake", intensity: 0.012 },
        { kind: "message", text: "FOREMAN OFFLINE", durationMs: 3000 },
        { kind: "objective", text: "Leave the plant" },
      ],
    },
    {
      id: "t-finish",
      when: { kind: "enterZone", zone: { x: 9380, y: 0, width: 160, height: 1400 } },
      requires: ["t-boss-down"],
      actions: [{ kind: "completeLevel" }],
    },
  ],

  secrets: [
    {
      id: "s1",
      zone: { x: 1820, y: 1040, width: 180, height: 90 },
      message: "Secret found — catwalk locker",
    },
    {
      id: "s2",
      zone: { x: 7420, y: 1040, width: 180, height: 90 },
      message: "Secret found — maintenance alcove",
    },
  ],

  boss: {
    enemyType: "foreman",
    name: "The Foreman",
    x: 9100,
    y: 1290,
    points: 1800,
    phases: [
      {
        belowHealthPercent: 100,
        message: "THE FOREMAN",
      },
      {
        // It tears loose from its mount and starts walking.
        belowHealthPercent: 60,
        stationary: false,
        weapon: FLAMETHROWER_ID,
        speed: 0.75,
        profile: "aggressive",
        message: "The Foreman tears loose!",
        spawnAdds: [
          { type: "enforcer", x: 8350, y: 1290 },
          { type: "enforcer", x: 9400, y: 1290, difficulties: ["hard", "extreme"] },
        ],
      },
      {
        belowHealthPercent: 30,
        weapon: LASER_ID,
        speed: 1.05,
        skill: 5,
        message: "The Foreman overloads!",
      },
    ],
  },
};
