import type { WeaponDefinition } from "@deathmatch/shared";

/**
 * What an NPC believes about the world.
 *
 * The important word is *believes*. The server knows everything; perception
 * deliberately narrows that to what this bot could plausibly sense, and this is
 * the only thing the brain and the controllers are allowed to read. A bot that
 * reached past this into the room state would be cheating, and would stop
 * feeling like an opponent.
 *
 * Every derived value is normalised to 0..1 so utility scores stay comparable.
 * Raw pixels and milliseconds keep their units and say so in the name.
 */

/** An enemy, either currently seen or recalled from memory. */
export interface PerceivedEnemy {
  sessionId: string;
  name: string;
  /** Where they are, or were when last seen. */
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  /** 0..1 of their maximum. */
  health: number;
  weaponId: string;
  distance: number;
  /** Direction from us to them, radians. */
  angle: number;
  /** False when this is a memory rather than a sighting. */
  visible: boolean;
  /**
   * Whether a shot fired now would actually reach them.
   *
   * Not the same as being visible, and the difference is the whole point: a
   * head showing over a low wall is plainly *seen*, and a bullet leaving the
   * chest still hits the wall. Bots that could not tell the two apart stood
   * either side of an obstacle firing into it, and the ones holding an
   * explosive killed themselves doing it.
   */
  shootable: boolean;
  /** How long ago they were last seen, in ms. 0 while visible. */
  ageMs: number;
  /** 0..1 — how nearly they are pointing at us. Only meaningful while visible. */
  facingUs: number;
  /**
   * How many flags they hold. Always current, never remembered: the score is
   * on the leaderboard for everyone to read, so even a bot that last *saw*
   * this enemy ten seconds ago knows exactly what they are worth now.
   */
  flagCount: number;
  /** True when nobody in the match holds more flags than they do. */
  isLeader: boolean;
}

/** A flag on the ground, spawned or dropped. */
export interface PerceivedFlag {
  id: string;
  x: number;
  y: number;
  distance: number;
  /** True for one shaken loose by a death — those expire fast. */
  dropped: boolean;
}

/** Something worth walking to. */
export interface PerceivedItem {
  id: string;
  kind: "crate" | "powerup";
  /** Only known for a revealed power-up; a sealed crate keeps its secret. */
  powerUpId: string | null;
  x: number;
  y: number;
  distance: number;
}

/** A grenade in flight or on the ground, and how much it should worry us. */
export interface PerceivedGrenade {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  distance: number;
  /** Whole seconds left on the fuse, as the state reports it. */
  fuseSeconds: number;
  /** 0..1 — near and about to go off is 1, far and freshly thrown is 0. */
  threat: number;
}

/** A trap, and whether it is currently something to stay out of. */
export interface PerceivedTrap {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  distance: number;
  /** True while it is dangerous or winding up to be. */
  hot: boolean;
  /**
   * Whether contact costs health.
   *
   * False for a jump pad, which is a trap in every way except the one that
   * matters here: it throws you rather than hurting you, and a bot that fled
   * one would be avoiding a shortcut the arena put there on purpose.
   */
  harmful: boolean;
  /** 0..1 by proximity and phase. */
  threat: number;
}

/** Our own condition. */
export interface SelfContext {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  onGround: boolean;
  jumpsRemaining: number;
  /** 0..1 of maximum. */
  health: number;
  /** 0..1 of the magazine; 1 for a weapon that needs no ammunition. */
  ammo: number;
  reloading: boolean;
  grenades: number;
  weapon: WeaponDefinition;
  /** Flags we are carrying. 0 outside Flag Hunt. */
  flagCount: number;
}

export interface BrainContext {
  now: number;
  self: SelfContext;

  /** Everything known about, seen or remembered, nearest first. */
  enemies: PerceivedEnemy[];
  /** The subset actually in sight right now. */
  visibleEnemies: PerceivedEnemy[];
  nearestEnemy: PerceivedEnemy | null;

  items: PerceivedItem[];
  nearestPowerUp: PerceivedItem | null;
  /** The nearest pickup that would change our weapon, if any. */
  nearestWeaponPickup: PerceivedItem | null;

  grenades: PerceivedGrenade[];
  traps: PerceivedTrap[];

  /** 0..1 — the worst single grenade threat. */
  grenadeDanger: number;
  /** 0..1 — the worst single trap threat. */
  trapDanger: number;
  /** 0..1 — how hard the closing walls are pressing on us. */
  wallDanger: number;
  /** 0..1 — everything above, plus enemies pointing at us, in one number. */
  danger: number;

  /**
   * 0..1 — how well the weapon we are holding suits the fight we are in.
   *
   * A shotgun across the arena scores near zero; the same shotgun at contact
   * range scores near one. Actions weigh this instead of naming weapons.
   */
  weaponEffectiveness: number;
  /** 0..1 — how nearly dead the nearest enemy is. */
  enemyVulnerability: number;
  /** True while a match is actually being played. */
  playing: boolean;

  /** True when the current match is Flag Hunt. */
  flagHunt: boolean;
  /** True during a Flag Hunt sudden-death tie-break. */
  suddenDeath: boolean;
  /** Flags on the ground within sight, nearest first. Empty outside Flag Hunt. */
  flags: PerceivedFlag[];
  nearestFlag: PerceivedFlag | null;
  /** The best flag count anyone in the match holds, ours included. 0 when none. */
  leaderFlagCount: number;
  /**
   * 0..1 — how well this bot reads the scoreboard.
   *
   * Difficulty's target-selection skill, resurfaced under the name of what it
   * does for mode play: a rookie bot barely notices who is winning or that a
   * flag matters more than a fight; a master plays the mode, not the brawl.
   */
  gameSense: number;

  /**
   * Middle of what is still playable, in px.
   *
   * The arena's own centre until the walls start closing, then the centre of
   * the gap -- which is where anything fleeing the walls should be heading.
   */
  safeCentreX: number;
  /** Blast radius of a grenade, so actions can keep out of their own. */
  explosionRadius: number;
}
