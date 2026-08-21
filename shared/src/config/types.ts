/**
 * The configuration data model.
 *
 * These interfaces describe *data*, never behaviour. Gameplay systems read them
 * and act accordingly; they never branch on a specific id. That is what allows a
 * future administration interface to add a weapon, retune a power-up or move a
 * spawn point without a code change — and why every value a designer might want
 * to touch lives here rather than inline in a system.
 *
 * Everything is expressed in plain JSON-compatible types on purpose: the whole
 * config could arrive from a database or an HTTP API instead of `defaults.ts`.
 */

/**
 * How a weapon delivers damage.
 *
 * `ranged` spawns projectiles the server simulates; `melee` resolves an instant
 * contact test around the attacker. The type selects which optional config block
 * is required — see `WeaponDefinition`.
 */
export const WeaponType = {
  RANGED: "ranged",
  MELEE: "melee",
} as const;

export type WeaponTypeValue = (typeof WeaponType)[keyof typeof WeaponType];

/**
 * Distance-based damage scaling, applied to every projectile hit.
 *
 * Damage is full up to `startDistance`, then falls linearly to
 * `damage * minMultiplier` at `endDistance` and stays there. A shotgun sets a
 * short start and a low multiplier; a rifle can leave this `null` for flat damage.
 */
export interface DamageFalloff {
  startDistance: number;
  endDistance: number;
  /** 0..1 — the fraction of base damage left at and beyond `endDistance`. */
  minMultiplier: number;
}

/** Projectile-weapon specifics. Required when `type` is `ranged`. */
export interface RangedWeaponConfig {
  /** Muzzle velocity in px/s. */
  bulletSpeed: number;
  /** Maximum random cone deviation in radians, applied per pellet by the server. */
  spread: number;
  /** Projectiles per trigger pull. Shotguns fire several; rifles fire one. */
  pellets: number;
  falloff: DamageFalloff | null;
  /** Cosmetic only — the client picks a projectile tint and size from this. */
  projectileStyle: {
    color: number;
    radius: number;
    trailLength: number;
  };
}

/** Contact-weapon specifics. Required when `type` is `melee`. */
export interface MeleeWeaponConfig {
  /**
   * Half-angle of the damage arc around the aim direction, in degrees.
   * The target must be inside this cone *and* within the weapon's range.
   */
  arcDegrees: number;
  /** Minimum time between swings, in milliseconds. */
  attackIntervalMs: number;
}

/**
 * A weapon, fully described by data.
 *
 * `damage`, `range`, `fireRate`, `magazineSize` and `reloadTime` are common to
 * every weapon so an admin form can present them uniformly; the `ranged` and
 * `melee` blocks carry what only one kind needs.
 */
export interface WeaponDefinition {
  /** Stable internal id (e.g. "shotgun"). Never shown to players. */
  id: string;
  /** Display name, shown in the HUD and kill feed. Free to change at any time. */
  name: string;
  type: WeaponTypeValue;
  /** Disabled weapons cannot be granted or spawned, but stay in the catalogue. */
  enabled: boolean;
  /** Base damage per projectile hit, or per melee contact. */
  damage: number;
  /** Ranged: maximum projectile travel. Melee: contact distance. Both in px. */
  range: number;
  /** Shots per minute. Ignored by melee weapons, which use `attackIntervalMs`. */
  fireRate: number;
  /** 0 means the weapon needs no ammunition (melee). */
  magazineSize: number;
  /** Reload duration in ms. Irrelevant when `magazineSize` is 0. */
  reloadTime: number;
  /** Holding the trigger keeps firing. */
  automatic: boolean;
  ranged: RangedWeaponConfig | null;
  melee: MeleeWeaponConfig | null;
}

/**
 * What a power-up does when picked up.
 *
 * Each value maps to exactly one applier registered by the server's power-up
 * system, so adding a *weapon* power-up is pure data. Adding a genuinely new kind
 * of effect is the one case that also needs an applier.
 */
export const PowerUpType = {
  WEAPON: "weapon",
  HEALTH: "health",
  SPEED: "speed",
} as const;

export type PowerUpTypeValue = (typeof PowerUpType)[keyof typeof PowerUpType];

interface PowerUpDefinitionBase {
  /** Stable internal id (e.g. "health-50"). */
  id: string;
  /** Display name, shown in the pickup toast. */
  name: string;
  /** Disabled power-ups never spawn. Kept in the catalogue so they can return. */
  enabled: boolean;
  /**
   * Relative likelihood of being chosen as a crate's contents. Weights are
   * compared against each other, so they need not sum to anything in particular;
   * a weight of 0 means "never spawn" just as `enabled: false` does.
   */
  spawnWeight: number;
  /** Cosmetic tint used by the client for the floating pickup. */
  color: number;
}

/** Grants a weapon. The weapon itself is configured in the weapon catalogue. */
export interface WeaponPowerUp extends PowerUpDefinitionBase {
  type: typeof PowerUpType.WEAPON;
  /** Id of the weapon to equip. Must exist in the weapon catalogue. */
  weaponId: string;
}

/** Restores a percentage of the player's maximum health. */
export interface HealthPowerUp extends PowerUpDefinitionBase {
  type: typeof PowerUpType.HEALTH;
  /** 0..1 — fraction of *maximum* health restored, never exceeding the maximum. */
  restoreFraction: number;
}

/** Temporarily multiplies movement speed. */
export interface SpeedPowerUp extends PowerUpDefinitionBase {
  type: typeof PowerUpType.SPEED;
  speedMultiplier: number;
  durationMs: number;
}

export type PowerUpDefinition = WeaponPowerUp | HealthPowerUp | SpeedPowerUp;

/** The breakable container power-ups arrive in. */
export interface CrateConfig {
  /** Hit points a crate absorbs before breaking open. */
  health: number;
  width: number;
  height: number;
  /**
   * How long an untouched crate stays in the arena before it is removed, freeing
   * its spawn point. 0 disables expiry.
   */
  lifetimeMs: number;
}

/** How often crates appear, and how long their contents linger. */
export interface PowerUpSpawnConfig {
  /** Interval between spawn attempts, in ms. */
  intervalMs: number;
  /** Upper bound on crates present at once, regardless of free spawn points. */
  maxActiveCrates: number;
  /** How long a revealed power-up waits to be collected before vanishing. */
  revealedLifetimeMs: number;
  /** Distance in px at which a player collects a revealed power-up. */
  pickupRadius: number;
  /** Delay after the match starts before the first spawn attempt. */
  firstSpawnDelayMs: number;
}

/**
 * The complete tunable game configuration.
 *
 * Power-up spawn *points* are deliberately not here: they are part of a map's
 * geometry and live on the arena definition, so a new map brings its own.
 */
export interface GameConfig {
  weapons: WeaponDefinition[];
  /** Weapon every player starts a match with. */
  defaultWeaponId: string;
  powerUps: PowerUpDefinition[];
  crate: CrateConfig;
  powerUpSpawning: PowerUpSpawnConfig;
}
