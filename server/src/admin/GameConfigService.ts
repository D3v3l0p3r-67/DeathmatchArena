import {
  ConfigRegistry,
  DEFAULT_GAME_CONFIG,
  applyChange,
  cloneConfig,
  loadGameConfig,
  readConfigValue,
  validateConfig,
  type ConfigFieldDefinition,
  type ConfigValue,
  type GameConfig,
  type ValidationIssue,
} from "@deathmatch/shared";
import type { Logger } from "../utils/logger.js";
import type { ConfigOverrides, GameConfigRepository } from "./GameConfigRepository.js";

/** One configurable value as the admin interface sees it. */
export interface ConfigFieldView extends ConfigFieldDefinition {
  /** What the server is using right now. */
  value: ConfigValue;
  /** True when this differs from the default and can be reset. */
  overridden: boolean;
}

export interface ConfigChangeResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** The fields as they stand after the attempt, so the caller can just render them. */
  fields: ConfigFieldView[];
}

/**
 * The game's configuration, as an administrator sees and changes it.
 *
 * Three layers, applied in order:
 *
 *   1. the values the game ships with (`DEFAULT_GAME_CONFIG`);
 *   2. deployment seeds from environment variables, for things an operator sets
 *      per environment rather than per game;
 *   3. stored administrator overrides.
 *
 * The result is the process-wide configuration every new room starts from. That
 * is the important difference from the debug console: a debug change lives and
 * dies with one room, an administrator change is stored and becomes the truth
 * for every room created afterwards.
 *
 * Rooms already running keep the configuration they started with, deliberately.
 * Changing a weapon's damage under a match in progress would mean players seeing
 * one number while the server used another.
 */
export class GameConfigService {
  /** Defaults plus deployment seeds. What "reset to default" restores. */
  private base: GameConfig = cloneConfig(DEFAULT_GAME_CONFIG);
  private overrides: ConfigOverrides = {};
  private effective: GameConfig = cloneConfig(DEFAULT_GAME_CONFIG);
  private registry = new ConfigRegistry(this.effective, this.base);

  constructor(
    private readonly repository: GameConfigRepository,
    private readonly logger: Logger,
    /** Values an operator set through the environment, applied over the defaults. */
    private readonly environmentSeed: ConfigOverrides = {},
  ) {}

  /** Read the stored overrides and publish the result. Called once at startup. */
  async initialise(): Promise<void> {
    this.overrides = await this.repository.read();
    this.rebuild();

    const applied = Object.keys(this.overrides).length;
    this.logger.info("Game configuration loaded", {
      overrides: applied,
      seeded: Object.keys(this.environmentSeed).length,
    });
  }

  /** The configuration new rooms start from. */
  getConfig(): GameConfig {
    return this.effective;
  }

  /** The defaults, so a room can show what has been changed away from them. */
  getBaseline(): GameConfig {
    return this.base;
  }

  /** Every configurable value, with its current setting and whether it is overridden. */
  listFields(): ConfigFieldView[] {
    return this.registry.list().map((field) => ({
      ...field,
      value: readConfigValue(this.effective, field.key) ?? field.defaultValue,
      overridden: Object.prototype.hasOwnProperty.call(this.overrides, field.key),
    }));
  }

  categories(): { category: string; subcategories: string[] }[] {
    return this.registry.categories().map((category) => ({
      category,
      subcategories: this.registry.subcategories(category),
    }));
  }

  /**
   * Apply a batch of changes.
   *
   * All or nothing: the batch is applied to a copy, and if any single change is
   * rejected nothing is stored. A form that sends five fields should not leave
   * three of them applied and two not, with no way to tell which.
   */
  async setMany(changes: Record<string, unknown>): Promise<ConfigChangeResult> {
    const issues: ValidationIssue[] = [];
    let candidate = cloneConfig(this.effective);
    const nextOverrides: ConfigOverrides = { ...this.overrides };

    for (const [key, raw] of Object.entries(changes)) {
      const outcome = applyChange(this.registry, candidate, key, raw);
      if (!outcome.ok) {
        issues.push(...outcome.issues);
        continue;
      }
      candidate = outcome.config;

      const stored = readConfigValue(candidate, key);
      const shipped = readConfigValue(this.base, key);
      // A value set back to its default stops being an override, so the field
      // goes back to tracking future changes to the shipped value.
      if (stored === undefined || stored === shipped) delete nextOverrides[key];
      else nextOverrides[key] = stored;
    }

    if (issues.length > 0) return { ok: false, issues, fields: this.listFields() };

    return this.commit(nextOverrides, `${Object.keys(changes).length} setting(s) changed`);
  }

  /** Restore one value to its default. */
  async resetKey(key: string): Promise<ConfigChangeResult> {
    if (!this.registry.has(key)) {
      return { ok: false, issues: [{ key, message: `Unknown setting "${key}".` }], fields: this.listFields() };
    }
    const next = { ...this.overrides };
    delete next[key];
    return this.commit(next, `reset ${key}`);
  }

  /**
   * Restore a whole category, or one subcategory within it.
   *
   * Resolved through the registry rather than by matching key prefixes: the key
   * of a weapon field says nothing about which category it belongs to, and the
   * registry is the only thing that knows.
   */
  async resetGroup(category: string, subcategory?: string): Promise<ConfigChangeResult> {
    const keys = this.registry.keysIn(category, subcategory);
    if (keys.length === 0) {
      return {
        ok: false,
        issues: [{ key: category, message: `Nothing to reset in "${category}".` }],
        fields: this.listFields(),
      };
    }

    const next = { ...this.overrides };
    for (const key of keys) delete next[key];
    return this.commit(next, `reset ${subcategory ? `${category} / ${subcategory}` : category}`);
  }

  /** Restore everything. */
  async resetAll(): Promise<ConfigChangeResult> {
    return this.commit({}, "reset every setting");
  }

  // -------------------------------------------------------------------------

  /**
   * Store a new set of overrides and publish the result.
   *
   * The rebuilt configuration is validated as a whole before anything is written:
   * removing an override can break an invariant just as setting one can (dropping
   * an override on a weapon id, say, when the weapon it pointed at is gone).
   */
  private async commit(overrides: ConfigOverrides, description: string): Promise<ConfigChangeResult> {
    const previous = this.overrides;
    this.overrides = overrides;
    this.rebuild();

    const check = validateConfig(this.effective);
    if (!check.ok) {
      this.overrides = previous;
      this.rebuild();
      return { ok: false, issues: check.issues, fields: this.listFields() };
    }

    await this.repository.write(overrides);
    this.logger.info("Game configuration updated", { change: description, overrides: Object.keys(overrides).length });
    return { ok: true, issues: [], fields: this.listFields() };
  }

  /**
   * Rebuild the effective configuration from the three layers.
   *
   * An override whose key no longer resolves is skipped rather than treated as an
   * error: a weapon can be removed from the catalogue between releases, and a
   * stale key in a stored file must not stop the server from starting.
   */
  private rebuild(): void {
    this.base = cloneConfig(DEFAULT_GAME_CONFIG);
    const seedRegistry = new ConfigRegistry(this.base, this.base);
    for (const [key, value] of Object.entries(this.environmentSeed)) {
      seedRegistry.write(this.base, key, value);
    }

    const effective = cloneConfig(this.base);
    const registry = new ConfigRegistry(effective, this.base);
    for (const [key, value] of Object.entries(this.overrides)) {
      if (!registry.write(effective, key, value)) {
        this.logger.warn("Ignoring an override that no longer applies", { key });
      }
    }

    this.effective = effective;
    this.registry = new ConfigRegistry(this.effective, this.base);

    // Publish: every room created from now on starts from these values.
    loadGameConfig(this.effective);
  }
}
