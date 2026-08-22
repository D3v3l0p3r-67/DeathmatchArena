import {
  createEmptyArena,
  duplicateArena,
  normaliseArena,
  registerArena,
  forgetArena,
  loadArenas,
  slugify,
  uniqueId,
  validateArena,
  type ArenaDefinition,
  type ArenaIssue,
} from "@deathmatch/shared";
import type { Logger } from "../utils/logger.js";
import type { ArenaRepository } from "./ArenaRepository.js";

/** A short row for the arena list, without shipping every rectangle. */
export interface ArenaSummary {
  id: string;
  name: string;
  enabled: boolean;
  width: number;
  height: number;
  elementCount: number;
  playerSpawnCount: number;
  powerUpSpawnCount: number;
  trapCount: number;
  updatedAt: number;
}

export interface ArenaSaveResult {
  ok: boolean;
  issues: ArenaIssue[];
  arena?: ArenaDefinition;
}

/**
 * Arena management, above the storage and below the routes.
 *
 * Everything a route can do to an arena goes through here, which is what makes
 * the guarantees actually hold: nothing reaches the repository without being
 * normalised and validated first, and nothing reaches the running game without
 * having been stored.
 *
 * The service also keeps the process-wide arena catalogue in step, so a room
 * created after a save picks the new geometry up. A match already in progress
 * keeps the arena it started on -- changing the floor under a running match would
 * desynchronise every client in it.
 */
export class ArenaService {
  constructor(
    private readonly repository: ArenaRepository,
    private readonly logger: Logger,
  ) {}

  /** Load everything into the process-wide catalogue. Called once at startup. */
  async initialise(): Promise<void> {
    const arenas = await this.repository.list();
    loadArenas(arenas);
    this.logger.info("Arenas loaded", {
      count: arenas.length,
      playable: arenas.filter((arena) => arena.enabled).length,
    });
  }

  async list(): Promise<ArenaSummary[]> {
    const arenas = await this.repository.list();
    return arenas.map(summarise).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<ArenaDefinition | null> {
    return this.repository.get(id);
  }

  /**
   * Create an arena.
   *
   * The id is derived from the name and made unique, rather than asked for: an
   * id is an internal handle, and having to invent one is a step between an
   * administrator and the thing they actually wanted to do.
   */
  async create(name: string, width?: number, height?: number): Promise<ArenaSaveResult> {
    const trimmed = name.trim() || "New arena";
    const taken = (await this.repository.list()).map((arena) => arena.id);
    const arena = createEmptyArena(uniqueId(slugify(trimmed), taken), trimmed, width, height);
    return this.persist(arena, taken);
  }

  /** Store an edited arena. `raw` is untrusted JSON straight from a request. */
  async save(id: string, raw: unknown): Promise<ArenaSaveResult> {
    const existing = await this.repository.get(id);
    if (!existing) {
      return { ok: false, issues: [{ path: "id", message: "No such arena.", severity: "error" }] };
    }

    // The id in the path wins over anything in the body: renaming an arena's id
    // would orphan every reference to it, so it is simply not a thing that can
    // happen through a save.
    const arena = { ...normaliseArena(raw), id: existing.id };
    const taken = (await this.repository.list())
      .map((other) => other.id)
      .filter((other) => other !== existing.id);

    return this.persist(arena, taken);
  }

  async duplicate(id: string): Promise<ArenaSaveResult> {
    const source = await this.repository.get(id);
    if (!source) {
      return { ok: false, issues: [{ path: "id", message: "No such arena.", severity: "error" }] };
    }

    const taken = (await this.repository.list()).map((arena) => arena.id);
    const name = `${source.name} copy`.slice(0, 48);
    const copy = duplicateArena(source, uniqueId(slugify(name), taken), name);
    return this.persist(copy, taken);
  }

  async setEnabled(id: string, enabled: boolean): Promise<ArenaSaveResult> {
    const arena = await this.repository.get(id);
    if (!arena) {
      return { ok: false, issues: [{ path: "id", message: "No such arena.", severity: "error" }] };
    }

    const others = (await this.repository.list()).map((other) => other.id).filter((other) => other !== id);
    return this.persist({ ...arena, enabled }, others);
  }

  /**
   * Delete an arena.
   *
   * Refused when it is the last one that could host a match: a server with no
   * playable arena cannot start a game, and discovering that at the next match
   * start is a much worse way to find out.
   */
  async delete(id: string): Promise<{ ok: boolean; message: string }> {
    const arenas = await this.repository.list();
    const target = arenas.find((arena) => arena.id === id);
    if (!target) return { ok: false, message: "No such arena." };

    const remainingPlayable = arenas.filter((arena) => arena.id !== id && arena.enabled);
    if (remainingPlayable.length === 0) {
      return { ok: false, message: "This is the only playable arena; matches would have nowhere to run." };
    }

    await this.repository.delete(id);
    forgetArena(id);
    this.logger.info("Arena deleted", { arena: id });
    return { ok: true, message: `Deleted "${target.name}".` };
  }

  /** Validate without storing, so an editor can show problems while they are made. */
  async check(id: string | null, raw: unknown): Promise<ArenaSaveResult> {
    const arena = normaliseArena(raw);
    const taken = (await this.repository.list())
      .map((other) => other.id)
      .filter((other) => other !== (id ?? arena.id));
    const result = validateArena(arena, { takenIds: taken });
    return { ok: result.ok, issues: result.issues, arena };
  }

  // -------------------------------------------------------------------------

  /** Validate, store, and publish to the catalogue. The only write path. */
  private async persist(arena: ArenaDefinition, takenIds: readonly string[]): Promise<ArenaSaveResult> {
    const result = validateArena(arena, { takenIds });
    if (!result.ok) return { ok: false, issues: result.issues };

    const stored = await this.repository.save(arena);
    // Rooms created from here on get the new geometry; rooms already playing keep
    // the arena object they started with.
    registerArena(stored);
    this.logger.info("Arena saved", { arena: stored.id, traps: stored.traps.length });

    // Warnings survive a successful save -- they are advice, not a refusal.
    return { ok: true, issues: result.issues, arena: stored };
  }
}

function summarise(arena: ArenaDefinition): ArenaSummary {
  return {
    id: arena.id,
    name: arena.name,
    enabled: arena.enabled,
    width: arena.width,
    height: arena.height,
    elementCount: arena.elements.length,
    playerSpawnCount: arena.playerSpawns.length,
    powerUpSpawnCount: arena.powerUpSpawns.length,
    trapCount: arena.traps.length,
    updatedAt: arena.updatedAt,
  };
}
