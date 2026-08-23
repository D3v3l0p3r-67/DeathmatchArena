/**
 * The values the game ships with.
 *
 * This file is data, not logic — it is the stand-in for whatever an administration
 * interface will eventually write to. Nothing here is imported by gameplay code
 * directly: systems go through `registry.ts`, so the source can be swapped for a
 * database or an API without touching a single system.
 *
 * Ids are stable and internal; `name` is what players see and is safe to change.
 */
import { PowerUpType, WeaponType, type GameConfig } from "./types.js";

export const ASSAULT_RIFLE_ID = "assault-rifle";
export const SHOTGUN_ID = "shotgun";
export const CHAINSAW_ID = "chainsaw";

export const DEFAULT_GAME_CONFIG: GameConfig = {
  defaultWeaponId: ASSAULT_RIFLE_ID,

  player: {
    maxHealth: 100,
    moveSpeed: 330,
    groundAcceleration: 3600,
    airAcceleration: 2000,
    groundFriction: 3200,
    // Deliberately far lower than ground friction: momentum carries through a
    // jump, which is what makes the movement feel like it has weight.
    airFriction: 260,
    gravity: 2200,
    maxFallSpeed: 1500,
    jumpVelocity: 780,
    maxJumps: 2,
    airJumpMultiplier: 0.92,
    jumpCutMultiplier: 0.45,
    coyoteTimeMs: 90,
    jumpBufferMs: 120,
  },

  match: {
    // Two so the game is playable in two browser windows.
    minPlayers: 2,
    maxPlayers: 10,
    countdownMs: 5000,
    resultsMs: 12000,
    maxDurationMs: 10 * 60 * 1000,
  },

  weapons: [
    {
      id: ASSAULT_RIFLE_ID,
      name: "Assault Rifle",
      type: WeaponType.RANGED,
      enabled: true,
      damage: 18,
      range: 1400,
      fireRate: 520,
      magazineSize: 30,
      reloadTime: 1800,
      automatic: true,
      ranged: {
        bulletSpeed: 1500,
        spread: 0.035,
        pellets: 1,
        // The all-rounder: no falloff, so it stays useful at every distance.
        falloff: null,
        projectileStyle: { color: 0xffd166, radius: 3, trailLength: 26 },
      },
      melee: null,
      // Long, thin and businesslike. The grip sits 22px back from the muzzle,
      // which is where the flash is drawn.
      silhouette: {
        length: 30,
        height: 16,
        gripX: 8,
        gripY: 8,
        color: 0xd7e2f5,
        parts: [
          { x: 0, y: 5, width: 9, height: 7, color: 0x8f9bb3 },
          { x: 6, y: 4, width: 11, height: 8 },
          { x: 16, y: 6, width: 14, height: 4 },
          { x: 9, y: 11, width: 6, height: 5, color: 0x8f9bb3 },
          { x: 13, y: 1, width: 3, height: 3, alpha: 0.75 },
        ],
      },
    },

    {
      id: SHOTGUN_ID,
      name: "Shotgun",
      type: WeaponType.RANGED,
      enabled: true,
      // Per pellet. Nine pellets landing at point-blank range is 117 damage --
      // lethal -- while the falloff below makes a full hit at range almost harmless.
      damage: 13,
      range: 620,
      fireRate: 75,
      magazineSize: 6,
      reloadTime: 2600,
      automatic: false,
      ranged: {
        bulletSpeed: 1150,
        spread: 0.17,
        pellets: 9,
        falloff: {
          startDistance: 170,
          endDistance: 560,
          minMultiplier: 0.2,
        },
        projectileStyle: { color: 0xff9f4a, radius: 2.4, trailLength: 15 },
      },
      melee: null,
      // The pump under the barrel and the wooden stock are the giveaway: two
      // silhouettes at a hundred paces have to be told apart by shape, not
      // detail, so the differences are deliberately gross.
      silhouette: {
        length: 30,
        height: 16,
        gripX: 8,
        gripY: 8,
        color: 0xd7e2f5,
        parts: [
          { x: 0, y: 4, width: 10, height: 9, color: 0xc98a4b },
          { x: 8, y: 4, width: 8, height: 8 },
          { x: 15, y: 5, width: 15, height: 5 },
          { x: 17, y: 10, width: 10, height: 4, color: 0xc98a4b },
          { x: 27, y: 3, width: 3, height: 9 },
        ],
      },
    },

    {
      id: CHAINSAW_ID,
      name: "Chainsaw",
      type: WeaponType.MELEE,
      enabled: true,
      // Brutal, but only if you can close the distance: `range` is barely more
      // than two player widths, and it cannot shoot back at anyone.
      damage: 34,
      range: 62,
      fireRate: 0,
      magazineSize: 0,
      reloadTime: 0,
      automatic: true,
      ranged: null,
      melee: {
        arcDegrees: 70,
        attackIntervalMs: 260,
      },
      // An orange body and a long toothed bar. Nothing else in the game is
      // orange and bar-shaped, which is the entire design goal: you should know
      // what is running at you before it arrives.
      silhouette: {
        length: 36,
        height: 18,
        gripX: 8,
        gripY: 10,
        color: 0xff8a4a,
        parts: [
          { x: 0, y: 5, width: 9, height: 9 },
          { x: 6, y: 3, width: 13, height: 12 },
          { x: 8, y: 0, width: 10, height: 3 },
          { x: 18, y: 7, width: 18, height: 5, color: 0xc9d3e4 },
          // Teeth along the top of the bar.
          { x: 21, y: 5, width: 2, height: 2, color: 0xeef3fb },
          { x: 26, y: 5, width: 2, height: 2, color: 0xeef3fb },
          { x: 31, y: 5, width: 2, height: 2, color: 0xeef3fb },
        ],
      },
    },
  ],

  powerUps: [
    {
      id: "health-50",
      name: "Medkit",
      type: PowerUpType.HEALTH,
      enabled: true,
      spawnWeight: 30,
      color: 0x4ade80,
      restoreFraction: 0.5,
    },
    {
      id: "speed-boost",
      name: "Speed Boost",
      type: PowerUpType.SPEED,
      enabled: true,
      spawnWeight: 30,
      color: 0x38bdf8,
      speedMultiplier: 1.55,
      durationMs: 8000,
    },
    {
      id: "weapon-shotgun",
      name: "Shotgun",
      type: PowerUpType.WEAPON,
      enabled: true,
      spawnWeight: 25,
      color: 0xff9f4a,
      weaponId: SHOTGUN_ID,
    },
    {
      id: "grenade-pack",
      name: "Grenades",
      type: PowerUpType.GRENADE,
      enabled: true,
      spawnWeight: 20,
      color: 0x8fd14f,
      amount: 2,
    },
    {
      id: "weapon-chainsaw",
      name: "Chainsaw",
      type: PowerUpType.WEAPON,
      enabled: true,
      spawnWeight: 15,
      color: 0xf472b6,
      weaponId: CHAINSAW_ID,
    },
  ],

  crate: {
    health: 60,
    width: 44,
    height: 44,
    // Long enough that a crate in a quiet corner still gets found, short enough
    // that its spawn point eventually frees up again.
    lifetimeMs: 45000,
  },

  grenades: {
    enabled: true,
    startingCount: 3,
    maxCount: 3,
    // A gentle lob at no charge, a long throw at full charge.
    minThrowSpeed: 420,
    maxThrowSpeed: 1250,
    maxChargeMs: 1100,
    // Heavier than a bullet and much heavier than a player, so it arcs sharply
    // and settles quickly instead of skating across the arena.
    gravity: 1900,
    bounciness: 0.42,
    friction: 0.72,
    radius: 7,
    fuseMs: 2000,
    explosionRadius: 190,
    // Lethal at the centre, survivable at the edge -- a direct hit should win a
    // fight, a near miss should only start one.
    maxDamage: 95,
    minDamageMultiplier: 0.18,
  },

  arenaShrink: {
    enabled: true,
    // Long enough for a normal match to resolve on its own, short enough that a
    // stalemate does not outlast anyone's patience.
    startAfterMs: 120000,
    // 3200px wide, so each wall has ~1500px to travel: a slow, visible squeeze
    // rather than a sudden crush.
    speedPerSecond: 26,
    minWidth: 420,
    crushDamagePerSecond: 22,
  },

  powerUpSpawning: {
    intervalMs: 15000,
    maxActiveCrates: 4,
    revealedLifetimeMs: 20000,
    pickupRadius: 34,
    firstSpawnDelayMs: 6000,
  },

  // What every trap inherits unless it says otherwise. A trap placed in an arena
  // usually overrides nothing at all, so retuning traps globally is one edit here
  // rather than one per arena.
  traps: {
    enabled: true,
    damage: 25,
    activationDelayMs: 400,
    activeDurationMs: 900,
    cooldownMs: 2200,
    moveSpeed: 160,
    triggerRadius: 90,
  },
};
