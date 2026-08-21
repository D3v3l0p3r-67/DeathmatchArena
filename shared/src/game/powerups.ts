/**
 * Power-up behaviour derived from power-up *data*.
 *
 * As with weapons, nothing here knows that a "shotgun" or a "medkit" exists. The
 * catalogue lives in `config/`; these helpers only turn configured values into
 * the quantities systems need.
 */
import { clamp } from "../core/math.js";
import { getPowerUp, listSpawnablePowerUps, pickWeightedPowerUp } from "../config/registry.js";
import { PowerUpType, type HealthPowerUp, type PowerUpDefinition } from "../config/types.js";

export { getPowerUp, listSpawnablePowerUps, pickWeightedPowerUp };

/**
 * Health restored by a health power-up, given the player's maximum.
 *
 * The amount is a configured *fraction of maximum health*, never a hard-coded
 * number, so retuning it is a config change. The caller is still responsible for
 * clamping the result to the maximum — see `applyHealthRestore`.
 */
export function getHealthRestoreAmount(powerUp: HealthPowerUp, maxHealth: number): number {
  return Math.round(maxHealth * clamp(powerUp.restoreFraction, 0, 1));
}

/**
 * Health after applying a restore, capped at the maximum.
 *
 * A player on 30 of 100 picking up a 50% medkit ends on 80; the same player on
 * 70 ends on 100, not 120.
 */
export function applyHealthRestore(
  currentHealth: number,
  maxHealth: number,
  powerUp: HealthPowerUp,
): number {
  const restored = currentHealth + getHealthRestoreAmount(powerUp, maxHealth);
  return clamp(restored, 0, maxHealth);
}

/** Narrowing helper so callers can read type-specific fields safely. */
export function isPowerUpOfType<T extends PowerUpDefinition["type"]>(
  powerUp: PowerUpDefinition,
  type: T,
): powerUp is Extract<PowerUpDefinition, { type: T }> {
  return powerUp.type === type;
}

export { PowerUpType };
