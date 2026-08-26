/**
 * Access to game configuration.
 *
 * Two layers, for two different needs:
 *
 *   - `GameConfigView` is an *indexed, immutable* read model over one
 *     `GameConfig`. A room holds its own view, which is what lets debug tooling
 *     retune a single match without touching anything else on the server.
 *   - The module-level functions delegate to a process-wide default view. The
 *     client and any code that only ever needs the shipped values use those.
 *
 * `loadGameConfig()` replaces the process default — the seam an administration
 * interface will use to feed values in from a database or an API at boot.
 *
 * Lookups are indexed on construction rather than scanned per call, because some
 * of them (weapon lookups in particular) run on every simulation tick.
 */
import { DEFAULT_GAME_CONFIG } from "./defaults.js";
import { clampBotCount, getBotDifficulty } from "./difficulty.js";
import type {
  ArenaShrinkConfig,
  BotDifficultyLevel,
  CrateConfig,
  GameConfig,
  GaugesConfig,
  GrenadeConfig,
  BrainProfile,
  MatchConfig,
  MinimapConfig,
  NpcConfig,
  PlayerConfig,
  PowerUpDefinition,
  PowerUpSpawnConfig,
  TrapConfig,
  WeaponDefinition,
} from "./types.js";

/**
 * An indexed read model over one configuration.
 *
 * Treat instances as immutable: to change values, build a new view from a new
 * `GameConfig` (see `withOverrides`). That keeps a room's configuration a single
 * atomic swap rather than a set of fields other code might observe mid-update.
 */
export class GameConfigView {
  private readonly weaponsById: Map<string, WeaponDefinition>;
  private readonly powerUpsById: Map<string, PowerUpDefinition>;
  /** Enabled power-ups with a positive weight, i.e. everything a crate may contain. */
  private readonly spawnable: PowerUpDefinition[];
  private readonly totalSpawnWeight: number;
  private readonly defaultWeapon: WeaponDefinition;

  constructor(readonly config: GameConfig) {
    this.weaponsById = new Map(config.weapons.map((weapon) => [weapon.id, weapon]));
    this.powerUpsById = new Map(config.powerUps.map((powerUp) => [powerUp.id, powerUp]));

    this.spawnable = config.powerUps.filter((powerUp) => {
      if (!powerUp.enabled || powerUp.spawnWeight <= 0) return false;
      // A weapon power-up granting a disabled or unknown weapon must not spawn,
      // otherwise disabling a weapon would leave dead crates behind.
      if (powerUp.type === "weapon") {
        const weapon = this.weaponsById.get(powerUp.weaponId);
        return weapon !== undefined && weapon.enabled;
      }
      return true;
    });

    this.totalSpawnWeight = this.spawnable.reduce((sum, powerUp) => sum + powerUp.spawnWeight, 0);

    const fallback =
      this.weaponsById.get(config.defaultWeaponId) ??
      config.weapons.find((weapon) => weapon.enabled) ??
      config.weapons[0];
    if (!fallback) throw new Error("Game config contains no weapons");
    this.defaultWeapon = fallback;
  }

  // -- Weapons --------------------------------------------------------------

  getDefaultWeaponId(): string {
    return this.defaultWeapon.id;
  }

  /**
   * Look up a weapon, falling back to the default.
   *
   * Never returns undefined: an unknown or disabled id means a player ends up
   * with the standard weapon rather than an unusable one.
   */
  getWeapon(weaponId: string): WeaponDefinition {
    const weapon = this.weaponsById.get(weaponId);
    return weapon && weapon.enabled ? weapon : this.defaultWeapon;
  }

  listWeapons(): readonly WeaponDefinition[] {
    return this.config.weapons;
  }

  // -- Power-ups ------------------------------------------------------------

  getPowerUp(powerUpId: string): PowerUpDefinition | null {
    return this.powerUpsById.get(powerUpId) ?? null;
  }

  listPowerUps(): readonly PowerUpDefinition[] {
    return this.config.powerUps;
  }

  /** Power-ups a crate may currently contain. */
  listSpawnablePowerUps(): readonly PowerUpDefinition[] {
    return this.spawnable;
  }

  /**
   * Weighted random pick of a crate's contents.
   *
   * `random` must return [0, 1) — the room passes its own seeded generator so the
   * choice is reproducible and never depends on `Math.random` inside a system.
   * Returns null when nothing is currently spawnable (everything disabled).
   */
  pickWeightedPowerUp(random: () => number): PowerUpDefinition | null {
    if (this.spawnable.length === 0 || this.totalSpawnWeight <= 0) return null;

    let ticket = random() * this.totalSpawnWeight;
    for (const powerUp of this.spawnable) {
      ticket -= powerUp.spawnWeight;
      if (ticket < 0) return powerUp;
    }
    // Floating-point drift only; the last candidate is the correct answer.
    return this.spawnable[this.spawnable.length - 1]!;
  }

  // -- Crates and spawning --------------------------------------------------

  getCrateConfig(): CrateConfig {
    return this.config.crate;
  }

  getPowerUpSpawnConfig(): PowerUpSpawnConfig {
    return this.config.powerUpSpawning;
  }

  getArenaShrinkConfig(): ArenaShrinkConfig {
    return this.config.arenaShrink;
  }

  getMinimapConfig(): MinimapConfig {
    return this.config.minimap;
  }

  getGaugesConfig(): GaugesConfig {
    return this.config.gauges;
  }

  getGrenadeConfig(): GrenadeConfig {
    return this.config.grenades;
  }

  /** Movement and vitality. Client prediction reads the very same values. */
  getPlayerConfig(): PlayerConfig {
    return this.config.player;
  }

  getMatchConfig(): MatchConfig {
    return this.config.match;
  }

  /** Trap defaults. An individual trap may override any of them. */
  getTrapConfig(): TrapConfig {
    return this.config.traps;
  }

  // -- NPCs -----------------------------------------------------------------

  getNpcConfig(): NpcConfig {
    return this.config.npc;
  }

  /**
   * Look up a brain profile, falling back to something usable.
   *
   * Never returns undefined for the same reason `getWeapon` does not: an unknown
   * id should give a bot a personality, not stop it from playing.
   */
  getBrainProfile(profileId: string): BrainProfile | null {
    return this.config.npc.profiles.find((profile) => profile.id === profileId) ?? null;
  }

  listBrainProfiles(): readonly BrainProfile[] {
    return this.config.npc.profiles;
  }

  /** One rung of the difficulty ladder. Never null: see `getBotDifficulty`. */
  getBotDifficulty(level: number): BotDifficultyLevel {
    return getBotDifficulty(this.config.npc, level);
  }

  listBotDifficulties(): readonly BotDifficultyLevel[] {
    return this.config.npc.difficulties;
  }

  /** Clamp a requested bot count to what this room may actually seat. */
  clampBotCount(count: number): number {
    return clampBotCount(count, this.config.npc, this.config.match.maxPlayers);
  }
}

/** Build an independent view over a deep copy of `config`. */
export function createGameConfigView(config: GameConfig): GameConfigView {
  return new GameConfigView(cloneConfig(config));
}

/**
 * Deep copy of a configuration.
 *
 * Used whenever a view is created so that two views can never share a nested
 * object — a room-scoped override must not leak into the process default.
 */
export function cloneConfig(config: GameConfig): GameConfig {
  return structuredClone(config);
}

// ---------------------------------------------------------------------------
// Process-wide default
// ---------------------------------------------------------------------------

let current = createGameConfigView(DEFAULT_GAME_CONFIG);

/**
 * Replace the process-wide configuration.
 *
 * Intended for a future admin interface (and used by tests to exercise specific
 * tunings). Rooms created afterwards start from the new values.
 */
export function loadGameConfig(config: GameConfig): void {
  current = createGameConfigView(config);
}

/** Restore the values the game ships with. */
export function resetGameConfig(): void {
  current = createGameConfigView(DEFAULT_GAME_CONFIG);
}

/** The process-wide view. Rooms hold their own; prefer that where one exists. */
export function getGameConfigView(): GameConfigView {
  return current;
}

export function getGameConfig(): GameConfig {
  return current.config;
}

export function getDefaultWeaponId(): string {
  return current.getDefaultWeaponId();
}

export function getWeapon(weaponId: string): WeaponDefinition {
  return current.getWeapon(weaponId);
}

export function listWeapons(): readonly WeaponDefinition[] {
  return current.listWeapons();
}

export function getPowerUp(powerUpId: string): PowerUpDefinition | null {
  return current.getPowerUp(powerUpId);
}

export function listPowerUps(): readonly PowerUpDefinition[] {
  return current.listPowerUps();
}

export function listSpawnablePowerUps(): readonly PowerUpDefinition[] {
  return current.listSpawnablePowerUps();
}

export function pickWeightedPowerUp(random: () => number): PowerUpDefinition | null {
  return current.pickWeightedPowerUp(random);
}

export function getCrateConfig(): CrateConfig {
  return current.getCrateConfig();
}

export function getPowerUpSpawnConfig(): PowerUpSpawnConfig {
  return current.getPowerUpSpawnConfig();
}

export function getArenaShrinkConfig(): ArenaShrinkConfig {
  return current.getArenaShrinkConfig();
}

export function getMinimapConfig(): MinimapConfig {
  return current.getMinimapConfig();
}

export function getGaugesConfig(): GaugesConfig {
  return current.getGaugesConfig();
}

export function getGrenadeConfig(): GrenadeConfig {
  return current.getGrenadeConfig();
}

export function getPlayerConfig(): PlayerConfig {
  return current.getPlayerConfig();
}

export function getMatchConfig(): MatchConfig {
  return current.getMatchConfig();
}

export function getTrapConfig(): TrapConfig {
  return current.getTrapConfig();
}

export function getNpcConfig(): NpcConfig {
  return current.getNpcConfig();
}

export function listBrainProfiles(): readonly BrainProfile[] {
  return current.listBrainProfiles();
}
