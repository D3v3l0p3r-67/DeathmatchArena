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
export const SMG_ID = "smg";
export const SNIPER_ID = "sniper";
export const FLAMETHROWER_ID = "flamethrower";
export const ROCKET_LAUNCHER_ID = "rocket-launcher";
export const LASER_ID = "laser";

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
    // A shove carries about `speed / 5` pixels: a rifle round nudges you some
    // 40px, a point-blank shotgun throws you the better part of 170.
    knockbackDamping: 5,
    knockbackRecoveryMs: 420,
    knockbackLift: 0.45,
  },

  match: {
    // Two is a match. The room does not wait to be full: it stays open for
    // whoever wants to join until the host starts it, or until it fills.
    minPlayers: 2,
    maxPlayers: 10,
    countdownMs: 3000,
    resultsMs: 12000,
    maxDurationMs: 10 * 60 * 1000,
    // The rule set new rooms start under. The host can switch it in the lobby.
    gameMode: "deathmatch",
  },

  campaign: {
    /*
     * The single-player baseline is deliberately gentler than multiplayer: an
     * enemy tuned to challenge a human in a deathmatch is, in a side-scroller,
     * a reaction-time test. Slower movement and visibly slower shots give the
     * player time to see an attack and answer it; the difficulty and level
     * layers then shade this up or down.
     */
    enemyMoveSpeedMultiplier: 0.9,
    enemyProjectileSpeedMultiplier: 0.8,
    enemyFireRateMultiplier: 0.9,
    enemyReactionTimeMultiplier: 1.2,
  },

  flagHunt: {
    timedMatch: true,
    // The mode is already time-limited, so the walls stay put.
    arenaShrinking: false,
    // Five minutes: long enough for the lead to change hands, short enough
    // that holding it is a sprint rather than a siege.
    matchDurationMs: 5 * 60 * 1000,
    flagSpawnIntervalMs: 8000,
    maxFlagsOnMap: 8,
    initialFlags: 3,
    // An untouched flag eventually moves on, so a forgotten corner of the
    // arena does not hoard the score.
    flagLifetimeMs: 45000,
    deathDropPercent: 50,
    droppedFlagLifetimeMs: 20000,
    dropScatterPx: 60,
    pickupRadius: 40,
    respawnDelayMs: 3000,
    leaderMarkerEnabled: true,
    suddenDeathEnabled: true,
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
      knockbackForce: 0.75,
      // Held down, this walks the shooter steadily backwards -- an automatic
      // weapon should cost you your footing, not just your magazine.
      recoilForce: 0.3,
      // The yardstick. Every other weapon's weight is read against this 1, so
      // it is the one number in the ladder that should stay put.
      moveSpeedMultiplier: 1,
      ranged: {
        bulletSpeed: 1500,
        spread: 0.035,
        pellets: 1,
        // The all-rounder: no falloff, so it stays useful at every distance.
        falloff: null,
        explosion: null,
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
      // Per pellet, and the falloff below makes a full hit at range almost
      // harmless. Nine pellets is 90 at contact: lethal-looking, and the target lives on
      // 10hp. It used to be 117 against 100 health -- an instant kill with no
      // window to react, which is a role the chainsaw now holds and pays for.
      damage: 10,
      range: 620,
      // Faster pump, so two blasts still kill about as quickly as the rifle
      // does -- the shotgun stays the fastest thing in contact range.
      fireRate: 105,
      magazineSize: 5,
      reloadTime: 2600,
      automatic: false,
      // Per pellet. Nine landing at contact range is a shove of about 700px/s,
      // which the knockback cap then holds at 850.
      knockbackForce: 0.3,
      // One shot, one heavy kick: the shotgun is the weapon you can jump with.
      recoilForce: 1.1,
      moveSpeedMultiplier: 0.97,
      ranged: {
        bulletSpeed: 1150,
        spread: 0.17,
        pellets: 9,
        explosion: null,
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
      id: SMG_ID,
      name: "SMG",
      type: WeaponType.RANGED,
      enabled: true,
      // The spray weapon: half the rifle's damage at nearly twice the rate, so
      // the damage per second is similar and the *accuracy* is what differs.
      damage: 12,
      range: 900,
      fireRate: 900,
      magazineSize: 35,
      reloadTime: 1500,
      automatic: true,
      knockbackForce: 0.35,
      recoilForce: 0.16,
      // The kite weapon, and the one thing the chainsaw cannot run down.
      moveSpeedMultiplier: 1.1,
      ranged: {
        bulletSpeed: 1350,
        // Three times the rifle's cone. Fine across a room, hopeless across the
        // arena, which is the whole personality of the thing.
        spread: 0.105,
        pellets: 1,
        falloff: {
          startDistance: 380,
          endDistance: 900,
          minMultiplier: 0.45,
        },
        explosion: null,
        projectileStyle: { color: 0xa5f3fc, radius: 2, trailLength: 18 },
      },
      melee: null,
      // Stubby, with a long magazine hanging under it.
      silhouette: {
        length: 29,
        height: 18,
        gripX: 7,
        gripY: 8,
        color: 0xb9c6dc,
        parts: [
          { x: 0, y: 5, width: 8, height: 7, color: 0x76839b },
          { x: 5, y: 4, width: 11, height: 8 },
          { x: 15, y: 6, width: 14, height: 4 },
          { x: 7, y: 11, width: 5, height: 7, color: 0x76839b },
          { x: 10, y: 2, width: 6, height: 2, alpha: 0.7 },
        ],
      },
    },

    {
      id: SNIPER_ID,
      name: "Sniper Rifle",
      type: WeaponType.RANGED,
      enabled: true,
      // Two hits, or one on somebody already hurt. The cost is the rate: at 40
      // rounds a minute a miss is a second and a half of standing there.
      // Still two shots, but no longer nearly one -- at 62 any chip damage
      // made the second shot optional.
      damage: 55,
      range: 2600,
      fireRate: 40,
      magazineSize: 4,
      reloadTime: 2600,
      automatic: false,
      // It hits like a truck in both directions.
      knockbackForce: 1.4,
      recoilForce: 0.9,
      moveSpeedMultiplier: 0.78,
      ranged: {
        // Fast enough that leading a target barely matters, which is what makes
        // it the weapon for the far side of the arena.
        bulletSpeed: 3200,
        spread: 0.004,
        pellets: 1,
        falloff: null,
        explosion: null,
        projectileStyle: { color: 0xbfdbfe, radius: 2, trailLength: 90 },
      },
      melee: null,
      // Long barrel, obvious scope: recognisable in silhouette at any distance,
      // which is exactly the information somebody in the open is owed.
      silhouette: {
        length: 42,
        height: 16,
        // Held well back: on a barrel this long the hand has to sit where the
        // muzzle ends up 22px ahead, or the flash detaches from the gun.
        gripX: 20,
        gripY: 9,
        color: 0x94a3b8,
        parts: [
          { x: 0, y: 6, width: 12, height: 7, color: 0x5b6577 },
          { x: 9, y: 5, width: 14, height: 7 },
          { x: 22, y: 7, width: 20, height: 3 },
          { x: 19, y: 11, width: 5, height: 5, color: 0x5b6577 },
          // Scope.
          { x: 12, y: 1, width: 11, height: 4, color: 0x0f172a },
          { x: 14, y: 0, width: 2, height: 5, color: 0x38bdf8, alpha: 0.9 },
        ],
      },
    },

    {
      id: FLAMETHROWER_ID,
      name: "Flamethrower",
      type: WeaponType.RANGED,
      enabled: true,
      // Not a bullet weapon at all: each "shot" is a puff of burning fuel, weak
      // on its own and lethal in a stream. Standing in it is the mistake.
      damage: 7,
      range: 300,
      fireRate: 720,
      magazineSize: 80,
      reloadTime: 2400,
      automatic: true,
      // A push you can feel but not be thrown by -- being herded is the point.
      knockbackForce: 0.12,
      recoilForce: 0.05,
      // Keeps by far the best sustain in the game, and pays for it in legs:
      // area denial rather than a weapon you chase anybody with.
      moveSpeedMultiplier: 0.88,
      ranged: {
        // Slow and wide: the flame visibly travels, so both sides can see
        // exactly how far it reaches.
        bulletSpeed: 620,
        spread: 0.22,
        pellets: 2,
        // Almost nothing at the far edge, so the range is felt rather than read.
        falloff: {
          startDistance: 120,
          endDistance: 300,
          minMultiplier: 0.25,
        },
        explosion: null,
        projectileStyle: { color: 0xff9d3d, radius: 7, trailLength: 12 },
      },
      melee: null,
      // A tank on the back end and a wide nozzle: bulky, unmistakable.
      silhouette: {
        length: 30,
        height: 20,
        gripX: 9,
        gripY: 10,
        color: 0xd9534f,
        parts: [
          { x: 0, y: 3, width: 11, height: 13, color: 0x9b3b38 },
          { x: 2, y: 1, width: 7, height: 3, color: 0xb85a56 },
          { x: 9, y: 7, width: 12, height: 6, color: 0xc9d3e4 },
          { x: 20, y: 5, width: 6, height: 10, color: 0x8a94a8 },
          { x: 26, y: 7, width: 4, height: 6, color: 0xffb457, alpha: 0.9 },
        ],
      },
    },

    {
      id: ROCKET_LAUNCHER_ID,
      name: "Rocket Launcher",
      type: WeaponType.RANGED,
      enabled: true,
      // The rocket itself does nothing on contact -- `explosion` below is the
      // whole weapon, and it catches the person who fired it just as readily.
      damage: 0,
      range: 1800,
      fireRate: 48,
      magazineSize: 2,
      reloadTime: 3000,
      automatic: false,
      knockbackForce: 0,
      // Firing it downwards while jumping is a rocket jump, and that is not an
      // accident: the recoil and the blast are both tuned to allow it.
      recoilForce: 1.1,
      // The heaviest thing to carry. Rocket-jumping is how you get your
      // mobility back, which the recoil and the blast were already tuned for.
      moveSpeedMultiplier: 0.75,
      ranged: {
        // Slow enough to see coming and to dodge, which is what stops it being
        // simply the best weapon in the game.
        bulletSpeed: 820,
        spread: 0.01,
        pellets: 1,
        falloff: null,
        explosion: {
          radius: 165,
          damage: 78,
          minDamageMultiplier: 0.2,
          knockbackForce: 1.9,
        },
        projectileStyle: { color: 0xfb7185, radius: 6, trailLength: 40 },
      },
      melee: null,
      // A fat tube with a rocket nose showing at the front.
      silhouette: {
        length: 40,
        height: 18,
        gripX: 18,
        gripY: 11,
        color: 0x6b7280,
        parts: [
          { x: 0, y: 4, width: 34, height: 9 },
          { x: 15, y: 13, width: 7, height: 5, color: 0x4b5563 },
          { x: 8, y: 1, width: 9, height: 3, color: 0x4b5563 },
          { x: 33, y: 5, width: 7, height: 7, color: 0xfb7185 },
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
      // One contact, one kill. 120 rather than exactly 100 so the promise
      // survives chip damage arithmetic and a bot's dealt-damage multiplier
      // at the middle rungs -- see the note on difficulty below.
      damage: 120,
      range: 62,
      fireRate: 0,
      magazineSize: 0,
      reloadTime: 0,
      automatic: true,
      // Throws whoever it catches; a chainsaw has nothing to recoil against.
      knockbackForce: 1.3,
      recoilForce: 0,
      // Measured, not guessed: at 1.05x it never closes on anybody (30s to
      // cross 400px against a rifle), and at 1.25x a sniper gets one shot
      // where they need two. At 1.15x the heavy long-range weapons get
      // exactly the shots they need, and the rifle and SMG out-range it.
      moveSpeedMultiplier: 1.15,
      ranged: null,
      melee: {
        arcDegrees: 50,
        // The other half of the balance. An instant kill has to be dodgeable,
        // and the only counterplay to one is a whiffed swing that leaves the
        // attacker helpless -- 260ms was no punishment at all.
        attackIntervalMs: 700,
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
    {
      id: LASER_ID,
      name: "Laser",
      type: WeaponType.RANGED,
      enabled: true,
      // Three shots and then a wait, so every one of them has to be worth
      // taking: hard-hitting and pinpoint, with the magazine as the whole cost.
      damage: 34,
      range: 2000,
      fireRate: 150,
      magazineSize: 3,
      // Long for three rounds, which is the point -- the weapon is the three
      // shots, not the rate. `getReloadDurationMs` still prorates a partial
      // reload, so topping up after one shot costs a third of this.
      reloadTime: 2400,
      automatic: false,
      knockbackForce: 0.5,
      recoilForce: 0.35,
      moveSpeedMultiplier: 0.85,
      ranged: {
        // Near-instant and dead straight: a laser that could be dodged after it
        // was fired would not read as a laser.
        bulletSpeed: 3600,
        spread: 0,
        pellets: 1,
        falloff: null,
        explosion: null,
        projectileStyle: { color: 0x8b5cf6, radius: 2.6, trailLength: 120 },
      },
      melee: null,
      // A slim emitter with a bright lens at the muzzle, so the silhouette
      // reads as "laser" from across the arena rather than as another rifle.
      silhouette: {
        length: 32,
        height: 14,
        gripX: 9,
        gripY: 7,
        color: 0x64748b,
        parts: [
          { x: 0, y: 4, width: 8, height: 6, color: 0x475569 },
          { x: 6, y: 3, width: 12, height: 8 },
          { x: 17, y: 5, width: 12, height: 4, color: 0x8b5cf6 },
          { x: 28, y: 3, width: 4, height: 8, color: 0xc4b5fd },
          { x: 9, y: 10, width: 5, height: 4, color: 0x475569 },
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
      id: "weapon-laser",
      name: "Laser",
      type: PowerUpType.WEAPON,
      enabled: true,
      spawnWeight: 20,
      color: 0x8b5cf6,
      weaponId: LASER_ID,
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
    {
      id: "weapon-smg",
      name: "SMG",
      type: PowerUpType.WEAPON,
      enabled: true,
      spawnWeight: 22,
      color: 0xa5f3fc,
      weaponId: SMG_ID,
    },
    {
      id: "weapon-sniper",
      name: "Sniper Rifle",
      type: PowerUpType.WEAPON,
      enabled: true,
      // Rarer than the rest: it decides fights across the whole arena.
      spawnWeight: 12,
      color: 0xbfdbfe,
      weaponId: SNIPER_ID,
    },
    {
      id: "weapon-flamethrower",
      name: "Flamethrower",
      type: PowerUpType.WEAPON,
      enabled: true,
      spawnWeight: 14,
      color: 0xff9d3d,
      weaponId: FLAMETHROWER_ID,
    },
    {
      id: "weapon-rocket-launcher",
      name: "Rocket Launcher",
      type: PowerUpType.WEAPON,
      enabled: true,
      // The rarest thing in a crate, and the one worth crossing the map for.
      spawnWeight: 9,
      color: 0xfb7185,
      weaponId: ROCKET_LAUNCHER_ID,
    },
  ],

  crate: {
    health: 60,
    width: 44,
    height: 44,
    // Long enough that a crate in a quiet corner still gets found, short enough
    // that its spawn point eventually frees up again.
    lifetimeMs: 45000,

    // A crate is a physical object: it falls, it can be shoved, and a long
    // enough drop breaks it open by itself.
    physicsEnabled: true,
    // Heavier than a player (2200): a crate drops rather than floats.
    gravity: 2000,
    maxFallSpeed: 1400,
    // Stops within roughly its own width once you stop pushing.
    groundFriction: 900,
    // Nearly nothing, so a crate shoved off a ledge keeps the arc it left with.
    airFriction: 60,
    // About half a player's run: shoving a crate is deliberate, not incidental.
    pushSpeed: 170,
    // A rifle round moves it a few pixels; sustained fire walks it along.
    shotImpulse: 55,
    // Two player-heights of free fall. Nudging one down a step costs nothing.
    fallDamageMinDrop: 180,
    // 60 health means a crate survives about 500px of drop beyond the threshold.
    fallDamagePer100px: 12,
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
    knockbackForce: 1.8,
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
    // One place is always kept for a person: bots never play among themselves.
    maxBots: 9,
    // 8Hz. Fast enough to react inside a firefight, slow enough that a dozen
    // bots cost a fraction of a tick.
    thinkIntervalMs: 125,
    perceptionIntervalMs: 125,
    // Wide on purpose: measured over sixty simulated matches, 1500 turns a
    // few percent of trap deaths into gunfights, which is the game working.
    sightRange: 1500,
    names: [
      "Vex", "Rook", "Nyx", "Kane", "Juno", "Onyx",
      "Pike", "Wren", "Cyrus", "Mara", "Drift", "Halo",
    ],

    // The rung the "add bot" picker starts on.
    defaultDifficulty: 3,

    /*
     * The ladder.
     *
     * Level 5 is where the bots were before difficulty existed: every multiplier
     * is 1, so it plays the profiles exactly as written, takes a weapon's full
     * damage and deals it. Everything below it is a worse player *and* a softer
     * one: it hesitates, its aim wanders, it takes more from every hit and lands
     * less with its own. The weapon catalogue is untouched either way -- a rifle
     * does what the rifle says, and the difference is applied to the bot.
     *
     * Even level 5 aims through the same imperfect-aim machinery as every other
     * level, so it is a very good opponent rather than an aimbot.
     */
    difficulties: [
      {
        level: 1,
        name: "Very Easy",
        // Nearly a second of hesitation, aim that wanders, no read on movement
        // at all, and enough noise in the scoring to make its choices erratic.
        reactionTimeMultiplier: 2.4,
        aimSkillMultiplier: 0.4,
        predictionSkillMultiplier: 0.15,
        dodgeSkillMultiplier: 0.3,
        decisionNoiseMultiplier: 2.5,
        decisionIntervalMultiplier: 2.4,
        damageTakenMultiplier: 1.5,
        damageDealtMultiplier: 0.6,
        environmentalDamageTakenMultiplier: 1,
        grenadeAccuracy: 0.25,
        navigationSkill: 0.3,
        targetSelectionSkill: 0.25,
      },
      {
        level: 2,
        name: "Easy",
        reactionTimeMultiplier: 1.7,
        aimSkillMultiplier: 0.58,
        predictionSkillMultiplier: 0.35,
        dodgeSkillMultiplier: 0.5,
        decisionNoiseMultiplier: 1.8,
        decisionIntervalMultiplier: 1.7,
        damageTakenMultiplier: 1.3,
        damageDealtMultiplier: 0.75,
        environmentalDamageTakenMultiplier: 1,
        grenadeAccuracy: 0.45,
        navigationSkill: 0.5,
        targetSelectionSkill: 0.45,
      },
      {
        level: 3,
        name: "Normal",
        reactionTimeMultiplier: 1.25,
        aimSkillMultiplier: 0.75,
        predictionSkillMultiplier: 0.6,
        dodgeSkillMultiplier: 0.7,
        decisionNoiseMultiplier: 1.35,
        decisionIntervalMultiplier: 1.3,
        damageTakenMultiplier: 1.15,
        damageDealtMultiplier: 0.9,
        environmentalDamageTakenMultiplier: 1,
        grenadeAccuracy: 0.65,
        navigationSkill: 0.7,
        targetSelectionSkill: 0.7,
      },
      {
        level: 4,
        name: "Hard",
        reactionTimeMultiplier: 1.05,
        aimSkillMultiplier: 0.9,
        predictionSkillMultiplier: 0.85,
        dodgeSkillMultiplier: 0.88,
        decisionNoiseMultiplier: 1.1,
        decisionIntervalMultiplier: 1.1,
        damageTakenMultiplier: 1.05,
        damageDealtMultiplier: 0.95,
        environmentalDamageTakenMultiplier: 1,
        grenadeAccuracy: 0.85,
        navigationSkill: 0.88,
        targetSelectionSkill: 0.88,
      },
      {
        level: 5,
        name: "Very Hard",
        reactionTimeMultiplier: 1,
        aimSkillMultiplier: 1,
        predictionSkillMultiplier: 1,
        dodgeSkillMultiplier: 1,
        decisionNoiseMultiplier: 1,
        decisionIntervalMultiplier: 1,
        damageTakenMultiplier: 1.0,
        damageDealtMultiplier: 1.0,
        environmentalDamageTakenMultiplier: 1,
        grenadeAccuracy: 1,
        navigationSkill: 1,
        targetSelectionSkill: 1,
      },
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

  // Over the player by default, and out of the corner: the bars follow the
  // fight rather than the fight being read out of a panel nobody looks at.
  gauges: {
    overPlayer: true,
    inHud: false,
  },

  minimap: {
    enabled: true,
    showPlayers: true,
    showPowerUps: true,
    // Unlimited: the whole arena is shown. An admin who wants less awareness
    // dials this down rather than everyone needing to opt in.
    radius: 0,
  },
};
