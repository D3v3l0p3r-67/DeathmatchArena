import {
  BUILT_IN_ARENAS,
  normaliseArena,
  type ArenaDefinition,
} from "@deathmatch/shared";
import { JsonStore } from "./JsonStore.js";

/**
 * Where arenas are stored.
 *
 * Async on purpose, and deliberately narrow: everything above it -- the service,
 * the routes, the room -- is written against these five methods, so replacing the
 * file store with a database table is a new class and one line in the wiring.
 */
export interface ArenaRepository {
  list(): Promise<ArenaDefinition[]>;
  get(id: string): Promise<ArenaDefinition | null>;
  /** Insert or replace. The arena is assumed valid; the service checks first. */
  save(arena: ArenaDefinition): Promise<ArenaDefinition>;
  delete(id: string): Promise<boolean>;
}

/**
 * Arenas in memory only.
 *
 * Used by tests, and the fallback when no data directory is writable -- a server
 * that cannot persist should still run and still let an administrator try things
 * out, it should just be honest that the changes will not survive a restart.
 */
export class InMemoryArenaRepository implements ArenaRepository {
  private readonly arenas = new Map<string, ArenaDefinition>();

  constructor(seed: readonly ArenaDefinition[] = BUILT_IN_ARENAS) {
    for (const arena of seed) this.arenas.set(arena.id, structuredClone(arena));
  }

  async list(): Promise<ArenaDefinition[]> {
    return Array.from(this.arenas.values()).map((arena) => structuredClone(arena));
  }

  async get(id: string): Promise<ArenaDefinition | null> {
    const arena = this.arenas.get(id);
    return arena ? structuredClone(arena) : null;
  }

  async save(arena: ArenaDefinition): Promise<ArenaDefinition> {
    const stored = { ...structuredClone(arena), updatedAt: Date.now() };
    this.arenas.set(stored.id, stored);
    return structuredClone(stored);
  }

  async delete(id: string): Promise<boolean> {
    return this.arenas.delete(id);
  }
}

/**
 * Arenas in a JSON file.
 *
 * The whole collection is one document rather than a file per arena: there are
 * tens of these, not thousands, and one document makes every write atomic.
 *
 * On first run the file does not exist and the built-in arenas are written into
 * it. From that moment they are ordinary rows -- an administrator can rename,
 * edit or delete them, and nothing puts them back.
 */
export class FileArenaRepository implements ArenaRepository {
  private readonly store: JsonStore<{ arenas: unknown[] }>;
  private cache: Map<string, ArenaDefinition> | null = null;

  constructor(directory: string) {
    this.store = new JsonStore(directory, "arenas.json");
  }

  get location(): string {
    return this.store.location;
  }

  async list(): Promise<ArenaDefinition[]> {
    const arenas = await this.load();
    return Array.from(arenas.values()).map((arena) => structuredClone(arena));
  }

  async get(id: string): Promise<ArenaDefinition | null> {
    const arenas = await this.load();
    const arena = arenas.get(id);
    return arena ? structuredClone(arena) : null;
  }

  async save(arena: ArenaDefinition): Promise<ArenaDefinition> {
    const arenas = await this.load();
    const stored = { ...structuredClone(arena), updatedAt: Date.now() };
    arenas.set(stored.id, stored);
    await this.flush(arenas);
    return structuredClone(stored);
  }

  async delete(id: string): Promise<boolean> {
    const arenas = await this.load();
    if (!arenas.delete(id)) return false;
    await this.flush(arenas);
    return true;
  }

  private async load(): Promise<Map<string, ArenaDefinition>> {
    if (this.cache) return this.cache;

    const document = await this.store.read();
    if (!document) {
      // First run: seed from the build, then treat them as data like any other.
      this.cache = new Map(BUILT_IN_ARENAS.map((arena) => [arena.id, structuredClone(arena)]));
      await this.flush(this.cache);
      return this.cache;
    }

    // Normalise on the way in: a file edited by hand, or written by an older
    // build, becomes a well-formed arena instead of a crash somewhere later.
    const arenas = (document.arenas ?? []).map((raw) => normaliseArena(raw));
    this.cache = new Map(arenas.map((arena) => [arena.id, arena]));
    return this.cache;
  }

  private async flush(arenas: Map<string, ArenaDefinition>): Promise<void> {
    this.cache = arenas;
    await this.store.write({ arenas: Array.from(arenas.values()) });
  }
}
