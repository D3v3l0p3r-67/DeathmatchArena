/**
 * Level 1: "Outpost".
 *
 * The campaign's vertical slice -- a linear run-and-gun stage exercising every
 * campaign system once: patrols spawned by approach, a turret tower, a
 * checkpoint chain, a destructible barrier with an ambush behind it, a locked
 * two-wave encounter, a scripted breach, a sniper stretch, two secrets, a
 * three-phase boss and a scored finish.
 *
 * Everything here is content. The engine has never heard of "Outpost".
 */
import { TrapActivation, type ArenaDefinition, type TrapDefinition } from "../../arena/types.js";
import { SurfaceType, type SurfaceTypeValue } from "../../game/types.js";
import { LASER_ID, ROCKET_LAUNCHER_ID, ASSAULT_RIFLE_ID } from "../../config/defaults.js";
import type { CampaignLevelDefinition } from "../types.js";
import { CAMPAIGN_LIVES } from "../catalogue.js";

const { FLOOR, PLATFORM, WALL, OBSTACLE } = SurfaceType;

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

/**
 * 9000x1200, one long westerly-to-easterly run. The ground sits at y=1140;
 * a standing player's centre is ~1116. Vertical gaps stay under the ~138px
 * single-jump ceiling.
 */
export const OUTPOST_ARENA: ArenaDefinition = {
  id: "outpost",
  name: "Outpost",
  // Never offered to multiplayer rotation or the lobby picker; the campaign
  // registers and loads it directly.
  enabled: false,
  width: 9000,
  height: 1200,
  backgroundColor: 0x0c1018,
  fogColor: 0x151c28,

  elements: [
    // Shell
    el("floor", 0, 1140, 9000, 60, FLOOR),
    el("ceiling", 0, 0, 9000, 40, WALL),
    el("wall-w", 0, 0, 40, 1200, WALL),
    el("wall-e", 8960, 0, 40, 1200, WALL),

    // --- Start: a gentle rise, and a secret ledge tucked above the door.
    el("p-start-1", 300, 1010, 220, 24, PLATFORM),
    el("p-start-2", 640, 890, 220, 24, PLATFORM),
    el("p-secret-1", 120, 770, 200, 22, PLATFORM),

    // --- Patrol ground: crate-sized cover to trade fire over.
    el("cover-1", 1500, 1040, 110, 100, OBSTACLE),
    el("cover-2", 1980, 1020, 130, 120, OBSTACLE),

    // --- Tower climb: a stair of platforms up to the turret's roost.
    el("p-tower-1", 2400, 1010, 240, 24, PLATFORM),
    el("p-tower-2", 2720, 890, 240, 24, PLATFORM),
    el("p-tower-3", 3020, 770, 240, 24, PLATFORM),
    el("p-tower-top", 3180, 650, 340, 24, PLATFORM),

    // --- Barrier stretch: a wall the crates finish, cover either side.
    el("cover-3", 3900, 1050, 100, 90, OBSTACLE),
    // A doorway, not a wall: the frame stops at 1084 and the 56px gap under it
    // is exactly what the barrier crates fill. Solid to the floor -- as this
    // was -- the level simply ended here, because 240px is far above the 159px
    // a double jump reaches.
    el("barrier-lintel", 4390, 900, 132, 184, WALL),

    // --- The yard: an enclosed encounter arena with inner platforms.
    // Open arch: a 100px gap under it, so the yard can be entered on foot.
    el("yard-wall-w", 4750, 860, 30, 180, WALL),
    el("p-yard-1", 5000, 990, 220, 24, PLATFORM),
    el("p-yard-2", 5450, 990, 220, 24, PLATFORM),
    el("p-yard-3", 5210, 860, 260, 24, PLATFORM),
    // The yard's exit: a 56px gap the door crate blocks until the breach.
    el("yard-wall-e", 5950, 860, 30, 224, WALL),

    // --- Sniper stretch: long sightline, low cover, the perch high right.
    el("cover-4", 6480, 1040, 110, 100, OBSTACLE),
    el("cover-5", 6760, 1060, 100, 80, OBSTACLE),
    el("p-perch-1", 6620, 940, 200, 24, PLATFORM),
    el("p-perch-2", 6880, 800, 260, 24, PLATFORM),

    // --- Boss arena: wide floor, side platforms, one high centre ledge.
    el("p-boss-w", 7600, 970, 240, 24, PLATFORM),
    el("p-boss-c", 7960, 840, 280, 24, PLATFORM),
    el("p-boss-e", 8320, 970, 240, 24, PLATFORM),
  ],

  playerSpawns: [{ id: "start", x: 200, y: 1100, enabled: true }],

  // Every campaign crate -- pickup, secret prize, destructible barrier -- sits
  // on one of these points; the level's crate list picks them by id.
  powerUpSpawns: [
    { id: "start-med", x: 420, y: 1090, enabled: true },
    { id: "s1-prize", x: 210, y: 720, enabled: true },
    // The barrier: two crates on the floor and one bridging them, stacked
    // clear of `barrier-post` (which ends at x=4386) -- a crate spawned
    // inside solid geometry gets squeezed out by its own physics and ends up
    // nowhere near where the level meant to put it.
    // Three crates side by side filling the barrier doorway. Never stacked:
    // crate physics collides with the world, not with other crates, so a crate
    // placed on a crate falls straight through it.
    { id: "b-left", x: 4412, y: 1118, enabled: true },
    { id: "b-mid", x: 4456, y: 1118, enabled: true },
    { id: "b-right", x: 4500, y: 1118, enabled: true },
    { id: "yard-med", x: 5330, y: 810, enabled: true },
    { id: "door", x: 5965, y: 1118, enabled: true },
    { id: "cp2-rocket", x: 6150, y: 1090, enabled: true },
    { id: "s2-prize", x: 6806, y: 1010, enabled: true },
    { id: "cp3-med", x: 7280, y: 1090, enabled: true },
    { id: "boss-gren", x: 7520, y: 1090, enabled: true },
    { id: "boss-med", x: 8620, y: 1090, enabled: true },
  ],

  traps: [
    // A pit of spikes under the tower climb keeps the ground route honest.
    trap("t-spikes-1", "spikes", 2830, 1116, 150, 24, TrapActivation.ALWAYS),
    // The sniper stretch punishes hiding in the one obvious spot forever.
    trap("t-spikes-2", "spikes", 6620, 1116, 120, 24, TrapActivation.ALWAYS),
    // A pad into the boss arena's centre ledge keeps the fight vertical.
    trap("t-pad-boss", "jump-pad", 8060, 1120, 110, 20, TrapActivation.ALWAYS, { force: 2.4 }),
  ],

  updatedAt: 0,
};

export const OUTPOST_LEVEL: CampaignLevelDefinition = {
  id: "level-01",
  name: "Outpost",
  arenaId: "outpost",

  playerSpawn: { x: 200, y: 1100 },
  startingWeapon: ASSAULT_RIFLE_ID,
  startingGrenades: 2,

  parTimeMs: 5 * 60 * 1000,
  respawnRule: { kind: "lives", lives: CAMPAIGN_LIVES },

  /*
   * The opening level is a lesson, not a reflex test: the player is still
   * learning to move, jump, shoot and read an incoming shot. Everything here
   * multiplies on top of the campaign-wide and difficulty layers, so on Normal
   * a soldier in this level walks at roughly two thirds of authored speed and
   * its bullets fly at just over half of the weapon's listed velocity.
   */
  enemyTuning: { moveSpeed: 0.85, projectileSpeed: 0.8, fireRate: 0.9, reactionTime: 1.15 },

  /** Clearing the outpost opens the refinery. */
  nextLevelId: "level-02",


  checkpoints: [
    { id: "cp1", x: 3600, y: 1100, zone: { x: 3560, y: 0, width: 140, height: 1200 } },
    { id: "cp2", x: 6080, y: 1100, zone: { x: 6040, y: 0, width: 140, height: 1200 } },
    { id: "cp3", x: 7240, y: 1100, zone: { x: 7180, y: 0, width: 140, height: 1200 } },
  ],

  cameraZones: [
    { id: "yard", zone: { x: 4700, y: 0, width: 1290, height: 1200 } },
    { id: "boss-arena", zone: { x: 7360, y: 0, width: 1560, height: 1200 } },
  ],

  crates: [
    { spawnPointId: "start-med", powerUpId: "health-50" },
    { spawnPointId: "s1-prize", powerUpId: "weapon-laser" },
    // The barrier: three crates the player shoots (or blows) through.
    { spawnPointId: "b-left", group: "barrier" },
    { spawnPointId: "b-mid", group: "barrier" },
    { spawnPointId: "b-right", group: "barrier" },
    { spawnPointId: "yard-med", powerUpId: "health-50" },
    // The yard's exit, opened by a scripted breach when the encounter falls.
    { spawnPointId: "door", group: "yard-door" },
    { spawnPointId: "cp2-rocket", powerUpId: "weapon-rocket-launcher" },
    { spawnPointId: "s2-prize", powerUpId: "speed-boost" },
    { spawnPointId: "cp3-med", powerUpId: "health-50" },
    { spawnPointId: "boss-gren", powerUpId: "grenade-pack" },
    { spawnPointId: "boss-med", powerUpId: "health-50" },
  ],

  encounters: [
    {
      id: "yard",
      lockCameraZone: "yard",
      waves: [
        {
          enemies: [
            { type: "soldier", x: 5100, y: 1080 },
            { type: "soldier", x: 5750, y: 1080 },
            { type: "runner", x: 5450, y: 1080 },
            { type: "runner", x: 5300, y: 1080, difficulties: ["hard", "extreme"] },
          ],
        },
        {
          enemies: [
            { type: "grenadier", x: 5150, y: 1080 },
            { type: "heavy", x: 5650, y: 1080 },
            { type: "soldier", x: 5330, y: 820, difficulties: ["extreme"] },
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
        { kind: "objective", text: "Push through the outpost" },
        { kind: "message", text: "OUTPOST — clear the yard, take down the Warden", durationMs: 3500 },
      ],
    },
    {
      id: "t-patrol",
      when: { kind: "enterZone", zone: { x: 950, y: 0, width: 120, height: 1200 } },
      actions: [
        {
          kind: "spawnEnemies",
          group: "patrol",
          enemies: [
            { type: "soldier", x: 1620, y: 1080 },
            { type: "soldier", x: 1980, y: 1080 },
            { type: "soldier", x: 1800, y: 1080, difficulties: ["hard", "extreme"] },
          ],
        },
      ],
    },
    {
      id: "t-tower",
      when: { kind: "enterZone", zone: { x: 2250, y: 0, width: 120, height: 1200 } },
      actions: [
        {
          kind: "spawnEnemies",
          group: "tower",
          enemies: [
            { type: "turret", x: 3350, y: 610 },
            { type: "soldier", x: 3140, y: 1080 },
            { type: "runner", x: 3420, y: 1080, difficulties: ["hard", "extreme"] },
          ],
        },
      ],
    },
    {
      id: "t-barrier-guard",
      when: { kind: "enterZone", zone: { x: 3760, y: 0, width: 120, height: 1200 } },
      actions: [
        { kind: "objective", text: "Break through the barrier" },
        {
          kind: "spawnEnemies",
          group: "barrier-guard",
          enemies: [
            { type: "grenadier", x: 4620, y: 1080 },
            { type: "soldier", x: 4520, y: 1080 },
            { type: "heavy", x: 4700, y: 1080, difficulties: ["hard", "extreme"] },
          ],
        },
      ],
    },
    {
      // Scripted: the barrier coming down is heard, and answered.
      id: "t-alarm",
      when: { kind: "objectsDestroyed", group: "barrier" },
      actions: [
        { kind: "shake", intensity: 0.008 },
        { kind: "message", text: "They know you're here.", durationMs: 2500 },
        {
          kind: "spawnEnemies",
          group: "ambush",
          enemies: [
            { type: "runner", x: 4150, y: 1080 },
            { type: "runner", x: 3980, y: 1080, difficulties: ["extreme"] },
          ],
        },
      ],
    },
    {
      id: "t-yard",
      when: { kind: "enterZone", zone: { x: 4850, y: 0, width: 100, height: 1200 } },
      actions: [
        { kind: "objective", text: "Clear the yard" },
        { kind: "startEncounter", encounterId: "yard" },
      ],
    },
    {
      // Scripted breach: the yard falling blows its own exit open.
      id: "t-breach",
      when: { kind: "encounterCompleted", encounterId: "yard" },
      actions: [
        { kind: "destroyObjects", group: "yard-door" },
        { kind: "shake", intensity: 0.01 },
        { kind: "message", text: "Breach! The way east is open.", durationMs: 2500 },
        { kind: "objective", text: "Reach the comm tower" },
      ],
    },
    {
      id: "t-sniper",
      when: { kind: "enterZone", zone: { x: 6260, y: 0, width: 120, height: 1200 } },
      actions: [
        {
          kind: "spawnEnemies",
          group: "overwatch",
          enemies: [
            { type: "sniper", x: 6980, y: 760 },
            { type: "soldier", x: 6700, y: 1080 },
            { type: "runner", x: 7050, y: 1080, difficulties: ["hard", "extreme"] },
          ],
        },
      ],
    },
    {
      id: "t-boss-gate",
      when: { kind: "enterZone", zone: { x: 7480, y: 0, width: 100, height: 1200 } },
      actions: [
        { kind: "lockCamera", zoneId: "boss-arena" },
        { kind: "startBoss" },
        { kind: "objective", text: "Defeat the Warden" },
      ],
    },
    {
      id: "t-boss-down",
      when: { kind: "bossDefeated" },
      actions: [
        { kind: "unlockCamera" },
        { kind: "shake", intensity: 0.012 },
        { kind: "message", text: "WARDEN DOWN", durationMs: 3000 },
        { kind: "objective", text: "Exit the outpost" },
      ],
    },
    {
      id: "t-finish",
      when: { kind: "enterZone", zone: { x: 8760, y: 0, width: 200, height: 1200 } },
      requires: ["t-boss-down"],
      actions: [{ kind: "completeLevel" }],
    },
  ],

  secrets: [
    {
      id: "s1",
      zone: { x: 130, y: 700, width: 180, height: 90 },
      message: "Secret found — armory cache",
    },
    {
      id: "s2",
      zone: { x: 6760, y: 980, width: 110, height: 90 },
      message: "Secret found — field stash",
    },
  ],

  boss: {
    enemyType: "warden",
    name: "The Warden",
    x: 8420,
    y: 1080,
    points: 1500,
    phases: [
      {
        belowHealthPercent: 100,
        message: "THE WARDEN",
      },
      {
        belowHealthPercent: 60,
        weapon: ROCKET_LAUNCHER_ID,
        speed: 0.7,
        message: "The Warden switches to rockets!",
        /*
         * Adds are hard-mode spice, and they join from the boss's side of the
         * arena, never from the entrance: spawned at x=7500 one appeared on
         * top of the player, and a chainsaw at contact range ended runs in
         * under two seconds. On Easy and Normal the first boss is the rocket
         * phase alone -- one thing to read at a time.
         */
        spawnAdds: [
          { type: "runner", x: 8700, y: 1080, difficulties: ["hard", "extreme"] },
          { type: "runner", x: 8850, y: 1080, difficulties: ["hard", "extreme"] },
        ],
      },
      {
        belowHealthPercent: 30,
        weapon: LASER_ID,
        speed: 0.9,
        skill: 4,
        message: "The Warden overcharges!",
      },
    ],
  },
};
