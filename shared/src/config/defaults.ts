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
    startingCount: 1,
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
};
