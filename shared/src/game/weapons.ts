/**
 * Weapon behaviour derived from weapon *data*.
 *
 * The catalogue itself lives in `config/`; this module only turns configured
 * numbers into the quantities systems need. Gameplay code never branches on a
 * weapon id — it asks these helpers, so a new weapon is a data change.
 */
import { clamp } from "../core/math.js";
import { PROJECTILE } from "./constants.js";
import { getWeapon } from "../config/registry.js";
import { WeaponType, type WeaponDefinition } from "../config/types.js";

export { getWeapon };

/** True when the weapon resolves hits by contact instead of by projectile. */
export function isMelee(weapon: WeaponDefinition): boolean {
  return weapon.type === WeaponType.MELEE;
}

/** True when the weapon consumes ammunition and can be reloaded. */
export function usesAmmo(weapon: WeaponDefinition): boolean {
  return weapon.magazineSize > 0;
}

/**
 * Minimum time between two shots.
 *
 * Melee weapons carry an explicit interval because "swings per minute" is an
 * awkward thing for a designer to reason about; ranged weapons derive it from
 * rounds-per-minute.
 */
export function getFireIntervalMs(weapon: WeaponDefinition): number {
  if (weapon.melee) return Math.max(0, weapon.melee.attackIntervalMs);
  if (weapon.fireRate <= 0) return 0;
  return 60000 / weapon.fireRate;
}

/** Lifetime implied by a projectile weapon's range and muzzle velocity. */
export function getProjectileLifetimeMs(weapon: WeaponDefinition): number {
  const speed = weapon.ranged?.bulletSpeed ?? 0;
  if (speed <= 0) return 0;
  return (weapon.range / speed) * 1000;
}

/**
 * Damage a projectile deals after travelling `distance` pixels.
 *
 * Weapons without a falloff curve deal full damage at any range. With one,
 * damage holds until `startDistance`, then falls linearly to `minMultiplier` at
 * `endDistance` — which is what makes the shotgun devastating up close and close
 * to useless across the arena.
 */
export function getDamageAtDistance(weapon: WeaponDefinition, distance: number): number {
  const falloff = weapon.ranged?.falloff;
  if (!falloff) return weapon.damage;

  const { startDistance, endDistance, minMultiplier } = falloff;
  if (distance <= startDistance) return weapon.damage;

  const span = endDistance - startDistance;
  // A degenerate curve (end <= start) means damage drops the moment falloff begins.
  const progress = span > 0 ? clamp((distance - startDistance) / span, 0, 1) : 1;
  const multiplier = 1 + (minMultiplier - 1) * progress;

  return weapon.damage * clamp(multiplier, 0, 1);
}

/** Fallback used when a weapon has no projectile styling of its own (melee). */
const DEFAULT_PROJECTILE_STYLE = Object.freeze({
  color: 0xffd166,
  radius: PROJECTILE.RADIUS,
  trailLength: 20,
});

/** Cosmetic projectile styling. Rendering-only; never affects gameplay. */
export function getProjectileStyle(weapon: WeaponDefinition): {
  color: number;
  radius: number;
  trailLength: number;
} {
  return weapon.ranged?.projectileStyle ?? DEFAULT_PROJECTILE_STYLE;
}

/** Half-angle of a melee weapon's damage arc, in radians. */
export function getMeleeArcRadians(weapon: WeaponDefinition): number {
  if (!weapon.melee) return 0;
  return (clamp(weapon.melee.arcDegrees, 0, 180) * Math.PI) / 180;
}
