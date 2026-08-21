/**
 * Data-driven weapon catalogue.
 *
 * Gameplay code never branches on a weapon id — it reads the definition. Adding a
 * new weapon therefore means adding one entry here (plus, optionally, a sprite).
 */

export interface WeaponDefinition {
  id: string;
  name: string;
  /** Damage applied per projectile hit. */
  damage: number;
  /** Rounds per minute; converted to a cooldown by `getFireIntervalMs`. */
  fireRate: number;
  /** Muzzle velocity in px/s. */
  bulletSpeed: number;
  magazineSize: number;
  reloadTime: number;
  /** Maximum random cone deviation in radians (applied server-side). */
  spread: number;
  /** Maximum travel distance in px before the projectile expires. */
  range: number;
  /** Held mouse button keeps firing. */
  automatic: boolean;
  /** Number of projectiles per trigger pull (shotguns > 1). */
  pellets: number;
  /** Cosmetic only — used by the client to pick a projectile tint/size. */
  projectileStyle: {
    color: number;
    radius: number;
    trailLength: number;
  };
}

export const WEAPONS: Readonly<Record<string, WeaponDefinition>> = Object.freeze({
  assault_rifle: {
    id: "assault_rifle",
    name: "Assault Rifle",
    damage: 18,
    fireRate: 520,
    bulletSpeed: 1500,
    magazineSize: 30,
    reloadTime: 1800,
    spread: 0.035,
    range: 1400,
    automatic: true,
    pellets: 1,
    projectileStyle: { color: 0xffd166, radius: 3, trailLength: 26 },
  },
});

export const DEFAULT_WEAPON_ID = "assault_rifle";

export function getWeapon(weaponId: string): WeaponDefinition {
  return WEAPONS[weaponId] ?? WEAPONS[DEFAULT_WEAPON_ID]!;
}

/** Minimum time between two shots, derived from rounds-per-minute. */
export function getFireIntervalMs(weapon: WeaponDefinition): number {
  return 60000 / weapon.fireRate;
}

/** Lifetime implied by the weapon's range and muzzle velocity. */
export function getProjectileLifetimeMs(weapon: WeaponDefinition): number {
  return (weapon.range / weapon.bulletSpeed) * 1000;
}
