/**
 * The single point through which gameplay reads configuration.
 *
 * Systems call these accessors instead of importing `defaults.ts`, which is what
 * keeps the door open for an administration interface: `loadGameConfig()` can be
 * handed a config fetched from a database or an HTTP API at boot, and every
 * system picks it up without a change.
 *
 * Lookups are indexed on load rather than scanned per call, because some of them
 * (weapon lookups in particular) run on every simulation tick.
 */
import { DEFAULT_GAME_CONFIG } from "./defaults.js";
import type {
  CrateConfig,
  GameConfig,
  PowerUpDefinition,
  PowerUpSpawnConfig,
  WeaponDefinition,
} from "./types.js";

interface ConfigIndex {
  config: GameConfig;
  weaponsById: Map<string, WeaponDefinition>;
  powerUpsById: Map<string, PowerUpDefinition>;
  /** Enabled power-ups with a positive weight, i.e. everything a crate may contain. */
  spawnable: PowerUpDefinition[];
  totalSpawnWeight: number;
  defaultWeapon: WeaponDefinition;
}

function index(config: GameConfig): ConfigIndex {
  const weaponsById = new Map(config.weapons.map((weapon) => [weapon.id, weapon]));
  const powerUpsById = new Map(config.powerUps.map((powerUp) => [powerUp.id, powerUp]));

  const spawnable = config.powerUps.filter((powerUp) => {
    if (!powerUp.enabled || powerUp.spawnWeight <= 0) return false;
    // A weapon power-up granting a disabled or unknown weapon must not spawn,
    // otherwise disabling a weapon would leave dead crates behind.
    if (powerUp.type === "weapon") {
      const weapon = weaponsById.get(powerUp.weaponId);
      return weapon !== undefined && weapon.enabled;
    }
    return true;
  });

  const defaultWeapon =
    weaponsById.get(config.defaultWeaponId) ??
    config.weapons.find((weapon) => weapon.enabled) ??
    config.weapons[0];

  if (!defaultWeapon) throw new Error("Game config contains no weapons");

  return {
    config,
    weaponsById,
    powerUpsById,
    spawnable,
    totalSpawnWeight: spawnable.reduce((sum, powerUp) => sum + powerUp.spawnWeight, 0),
    defaultWeapon,
  };
}

let current: ConfigIndex = index(DEFAULT_GAME_CONFIG);

/**
 * Replace the active configuration.
 *
 * Intended for a future admin interface (and used by tests to exercise specific
 * tunings). Re-indexes eagerly so callers never pay for the change.
 */
export function loadGameConfig(config: GameConfig): void {
  current = index(config);
}

/** Restore the values the game ships with. */
export function resetGameConfig(): void {
  current = index(DEFAULT_GAME_CONFIG);
}

export function getGameConfig(): GameConfig {
  return current.config;
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

export function getDefaultWeaponId(): string {
  return current.defaultWeapon.id;
}

/**
 * Look up a weapon, falling back to the default.
 *
 * Never returns undefined: an unknown or disabled id means a player ends up with
 * the standard weapon rather than an unusable one.
 */
export function getWeapon(weaponId: string): WeaponDefinition {
  const weapon = current.weaponsById.get(weaponId);
  return weapon && weapon.enabled ? weapon : current.defaultWeapon;
}

export function listWeapons(): readonly WeaponDefinition[] {
  return current.config.weapons;
}

// ---------------------------------------------------------------------------
// Power-ups
// ---------------------------------------------------------------------------

export function getPowerUp(powerUpId: string): PowerUpDefinition | null {
  return current.powerUpsById.get(powerUpId) ?? null;
}

export function listPowerUps(): readonly PowerUpDefinition[] {
  return current.config.powerUps;
}

/** Power-ups a crate may currently contain. */
export function listSpawnablePowerUps(): readonly PowerUpDefinition[] {
  return current.spawnable;
}

/**
 * Weighted random pick of a crate's contents.
 *
 * `random` must return [0, 1) — the room passes its own seeded generator so the
 * choice is reproducible and never depends on `Math.random` inside a system.
 * Returns null when nothing is currently spawnable (everything disabled).
 */
export function pickWeightedPowerUp(random: () => number): PowerUpDefinition | null {
  const { spawnable, totalSpawnWeight } = current;
  if (spawnable.length === 0 || totalSpawnWeight <= 0) return null;

  let ticket = random() * totalSpawnWeight;
  for (const powerUp of spawnable) {
    ticket -= powerUp.spawnWeight;
    if (ticket < 0) return powerUp;
  }
  // Floating-point drift only; the last candidate is the correct answer.
  return spawnable[spawnable.length - 1]!;
}

// ---------------------------------------------------------------------------
// Crates and spawning
// ---------------------------------------------------------------------------

export function getCrateConfig(): CrateConfig {
  return current.config.crate;
}

export function getPowerUpSpawnConfig(): PowerUpSpawnConfig {
  return current.config.powerUpSpawning;
}
