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
    // Roughly two and a half times running speed: enough for a shotgun blast to
    // feel like one, not enough to send anybody through the arena.
    maxKnockbackSpeed: 850,
  },

  match: {
    // A match is always five, and the same five as the arena seats: the lobby
    // holds its places open for people, bots take whatever is left, and only
    // then does anything start. Lowering this lets matches begin short-handed.
    minPlayers: 5,
    maxPlayers: 5,
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
      knockbackForce: 0.25,
      // Small on purpose: at 520 rounds a minute this lands nearly nine times a
      // second, and anything larger walks the shooter backwards out of the fight.
      recoilForce: 0.04,
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
      // Per pellet. Nine landing at contact range is a shove of about 700px/s,
      // which the knockback cap then holds at 850.
      knockbackForce: 0.3,
      recoilForce: 0.4,
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
      // Throws whoever it catches; a chainsaw has nothing to recoil against.
      knockbackForce: 0.9,
      recoilForce: 0,
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
    // Radiates from the blast and falls off with it: a near miss shoves you, a
    // direct hit launches you.
    knockbackForce: 1.4,
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
    // Five seconds of warning before a crate lands, so contesting one is a
    // decision somebody had time to make rather than a surprise.
    warningMs: 5000,
  },


  // Bots. A lobby holds its places open for a minute, then fills what is left --
  // and whoever is waiting can skip the wait. There is always at least one
  // person: bots never play among themselves.
  npc: {
    enabled: true,
    // Fill the arena, so a lobby that nobody else joins still becomes a match.
    fillToPlayers: 5,
    fillAfterMs: 60000,
    // One place is always kept for a person: bots never play among themselves.
    maxBots: 4,
    // 8Hz. Fast enough to react inside a firefight, slow enough that a dozen
    // bots cost a fraction of a tick.
    thinkIntervalMs: 125,
    perceptionIntervalMs: 125,
    sightRange: 1100,
    names: [
      "Vex", "Rook", "Nyx", "Kane", "Juno", "Onyx",
      "Pike", "Wren", "Cyrus", "Mara", "Drift", "Halo",
    ],
    profiles: [
      // Walks at you and keeps walking.
      {
        id: "aggressive",
        name: "Aggressive",
        aggression: 0.95,
        survival: 0.25,
        powerupInterest: 0.3,
        grenadeUsage: 0.75,
        finishWeakEnemies: 0.85,
        chasePersistence: 0.9,
        preferredDistance: 140,
        aimSkill: 0.75,
        predictionSkill: 0.65,
        dodgeSkill: 0.55,
        reactionTimeMs: 180,
        memoryDurationMs: 3000,
        currentActionBonus: 10,
        actionSwitchThreshold: 12,
        minimumActionMs: 700,
        decisionNoise: 5,
      },
      // Holds range, breaks off early, takes the health.
      {
        id: "defensive",
        name: "Defensive",
        aggression: 0.35,
        survival: 0.9,
        powerupInterest: 0.55,
        grenadeUsage: 0.45,
        finishWeakEnemies: 0.4,
        chasePersistence: 0.3,
        preferredDistance: 420,
        aimSkill: 0.7,
        predictionSkill: 0.6,
        dodgeSkill: 0.8,
        reactionTimeMs: 220,
        memoryDurationMs: 3500,
        currentActionBonus: 12,
        actionSwitchThreshold: 15,
        minimumActionMs: 900,
        decisionNoise: 4,
      },
      // Closes to touching distance and never stops moving.
      {
        id: "rusher",
        name: "Rusher",
        aggression: 0.9,
        survival: 0.2,
        powerupInterest: 0.2,
        grenadeUsage: 0.35,
        finishWeakEnemies: 0.7,
        chasePersistence: 0.95,
        preferredDistance: 90,
        aimSkill: 0.55,
        predictionSkill: 0.4,
        dodgeSkill: 0.45,
        reactionTimeMs: 140,
        memoryDurationMs: 2000,
        currentActionBonus: 8,
        actionSwitchThreshold: 10,
        minimumActionMs: 500,
        decisionNoise: 7,
      },
      // Picks one target, usually a wounded one, and follows it.
      {
        id: "hunter",
        name: "Hunter",
        aggression: 0.75,
        survival: 0.45,
        powerupInterest: 0.35,
        grenadeUsage: 0.55,
        finishWeakEnemies: 0.95,
        chasePersistence: 0.95,
        preferredDistance: 260,
        aimSkill: 0.85,
        predictionSkill: 0.8,
        dodgeSkill: 0.55,
        reactionTimeMs: 190,
        memoryDurationMs: 6000,
        currentActionBonus: 14,
        actionSwitchThreshold: 16,
        minimumActionMs: 1100,
        decisionNoise: 3,
      },
      // Joins fights that are already going badly for somebody else.
      {
        id: "opportunist",
        name: "Opportunist",
        aggression: 0.55,
        survival: 0.6,
        powerupInterest: 0.6,
        grenadeUsage: 0.6,
        finishWeakEnemies: 0.9,
        chasePersistence: 0.4,
        preferredDistance: 300,
        aimSkill: 0.75,
        predictionSkill: 0.7,
        dodgeSkill: 0.65,
        reactionTimeMs: 210,
        memoryDurationMs: 2500,
        currentActionBonus: 8,
        actionSwitchThreshold: 9,
        minimumActionMs: 600,
        decisionNoise: 8,
      },
      // Fights on the way to the next crate.
      {
        id: "collector",
        name: "Collector",
        aggression: 0.3,
        survival: 0.65,
        powerupInterest: 0.98,
        grenadeUsage: 0.4,
        finishWeakEnemies: 0.35,
        chasePersistence: 0.25,
        preferredDistance: 340,
        aimSkill: 0.6,
        predictionSkill: 0.5,
        dodgeSkill: 0.6,
        reactionTimeMs: 240,
        memoryDurationMs: 2000,
        currentActionBonus: 12,
        actionSwitchThreshold: 14,
        minimumActionMs: 900,
        decisionNoise: 5,
      },
      // Would rather throw something than shoot it.
      {
        id: "grenadier",
        name: "Grenadier",
        aggression: 0.6,
        survival: 0.55,
        powerupInterest: 0.45,
        grenadeUsage: 0.98,
        finishWeakEnemies: 0.6,
        chasePersistence: 0.5,
        preferredDistance: 380,
        aimSkill: 0.65,
        predictionSkill: 0.75,
        dodgeSkill: 0.6,
        reactionTimeMs: 200,
        memoryDurationMs: 3000,
        currentActionBonus: 10,
        actionSwitchThreshold: 12,
        minimumActionMs: 800,
        decisionNoise: 5,
      },
      // Takes a position and makes you come to it.
      {
        id: "camper",
        name: "Camper",
        aggression: 0.4,
        survival: 0.8,
        powerupInterest: 0.25,
        grenadeUsage: 0.5,
        finishWeakEnemies: 0.55,
        chasePersistence: 0.1,
        preferredDistance: 460,
        aimSkill: 0.9,
        predictionSkill: 0.7,
        dodgeSkill: 0.35,
        reactionTimeMs: 260,
        memoryDurationMs: 4000,
        currentActionBonus: 16,
        actionSwitchThreshold: 18,
        minimumActionMs: 1400,
        decisionNoise: 3,
      },
      // Hard to pin down; changes its mind often and dodges well.
      {
        id: "trickster",
        name: "Trickster",
        aggression: 0.65,
        survival: 0.55,
        powerupInterest: 0.5,
        grenadeUsage: 0.7,
        finishWeakEnemies: 0.6,
        chasePersistence: 0.55,
        preferredDistance: 240,
        aimSkill: 0.7,
        predictionSkill: 0.65,
        dodgeSkill: 0.9,
        reactionTimeMs: 170,
        memoryDurationMs: 2500,
        currentActionBonus: 5,
        actionSwitchThreshold: 6,
        minimumActionMs: 350,
        decisionNoise: 12,
      },
      // Runs first and shoots second.
      {
        id: "coward",
        name: "Coward",
        aggression: 0.2,
        survival: 0.98,
        powerupInterest: 0.7,
        grenadeUsage: 0.35,
        finishWeakEnemies: 0.3,
        chasePersistence: 0.15,
        preferredDistance: 520,
        aimSkill: 0.55,
        predictionSkill: 0.45,
        dodgeSkill: 0.85,
        reactionTimeMs: 300,
        memoryDurationMs: 2000,
        currentActionBonus: 9,
        actionSwitchThreshold: 10,
        minimumActionMs: 600,
        decisionNoise: 6,
      },
      // No sense of self-preservation whatsoever.
      {
        id: "berserker",
        name: "Berserker",
        aggression: 1.0,
        survival: 0.05,
        powerupInterest: 0.15,
        grenadeUsage: 0.25,
        finishWeakEnemies: 0.95,
        chasePersistence: 1.0,
        preferredDistance: 70,
        aimSkill: 0.5,
        predictionSkill: 0.35,
        dodgeSkill: 0.25,
        reactionTimeMs: 120,
        memoryDurationMs: 1500,
        currentActionBonus: 14,
        actionSwitchThreshold: 18,
        minimumActionMs: 900,
        decisionNoise: 4,
      },
      // The reference personality. Everything else is a deviation from this.
      {
        id: "balanced",
        name: "Balanced",
        aggression: 0.6,
        survival: 0.6,
        powerupInterest: 0.55,
        grenadeUsage: 0.55,
        finishWeakEnemies: 0.6,
        chasePersistence: 0.6,
        preferredDistance: 260,
        aimSkill: 0.72,
        predictionSkill: 0.65,
        dodgeSkill: 0.6,
        reactionTimeMs: 200,
        memoryDurationMs: 3000,
        currentActionBonus: 10,
        actionSwitchThreshold: 12,
        minimumActionMs: 800,
        decisionNoise: 5,
      },
    ],
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
