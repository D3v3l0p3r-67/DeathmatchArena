import type { ConfigValue } from "@deathmatch/shared";
import { JsonStore } from "./JsonStore.js";

/** What has been changed away from the shipped values, keyed by field. */
export type ConfigOverrides = Record<string, ConfigValue>;

/**
 * Where configuration changes are stored.
 *
 * Note what is stored: *overrides*, not a whole configuration. Two reasons, and
 * both matter more than they look.
 *
 * A stored snapshot would freeze the shipped values at the moment somebody first
 * touched the admin interface -- change one number, and every rebalance in every
 * future release silently stops reaching this server. Storing only the deltas
 * means a new default flows through to everything nobody has overridden.
 *
 * And it makes "reset to default" exact: it deletes a key rather than trying to
 * remember what the value used to be.
 */
export interface GameConfigRepository {
  read(): Promise<ConfigOverrides>;
  write(overrides: ConfigOverrides): Promise<void>;
}

export class InMemoryGameConfigRepository implements GameConfigRepository {
  private overrides: ConfigOverrides = {};

  async read(): Promise<ConfigOverrides> {
    return { ...this.overrides };
  }

  async write(overrides: ConfigOverrides): Promise<void> {
    this.overrides = { ...overrides };
  }
}

export class FileGameConfigRepository implements GameConfigRepository {
  private readonly store: JsonStore<{ overrides: ConfigOverrides }>;

  constructor(directory: string) {
    this.store = new JsonStore(directory, "game-config.json");
  }

  get location(): string {
    return this.store.location;
  }

  async read(): Promise<ConfigOverrides> {
    const document = await this.store.read();
    if (!document?.overrides) return {};

    // Only primitives are accepted back: the file is editable by hand, and an
    // object or an array here would end up written straight into the config.
    const overrides: ConfigOverrides = {};
    for (const [key, value] of Object.entries(document.overrides)) {
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
        overrides[key] = value;
      }
    }
    return overrides;
  }

  async write(overrides: ConfigOverrides): Promise<void> {
    await this.store.write({ overrides });
  }
}
