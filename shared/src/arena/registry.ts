/**
 * The process-wide arena catalogue.
 *
 * The same shape as the configuration registry, and for the same reason: the
 * server replaces its contents at boot from whatever the `ArenaRepository`
 * holds, while tests and the shipped build fall back to the built-in seeds.
 *
 * A client never reads from here for the arena it is playing -- the server sends
 * that with the welcome message, because an admin-created arena exists only on
 * the server and could not possibly be in the client's bundle.
 */
import { BUILT_IN_ARENAS, DEFAULT_ARENA_ID } from "./defaults.js";
import type { ArenaDefinition } from "./types.js";

export { DEFAULT_ARENA_ID };

let arenas = new Map<string, ArenaDefinition>(BUILT_IN_ARENAS.map((arena) => [arena.id, arena]));

/** Replace the catalogue wholesale, e.g. with what the repository holds. */
export function loadArenas(list: readonly ArenaDefinition[]): void {
  if (list.length === 0) return;
  arenas = new Map(list.map((arena) => [arena.id, arena]));
}

/** Add or replace one arena, e.g. after an administrator saves it. */
export function registerArena(arena: ArenaDefinition): void {
  arenas.set(arena.id, arena);
}

export function forgetArena(arenaId: string): void {
  arenas.delete(arenaId);
}

export function listArenas(): readonly ArenaDefinition[] {
  return Array.from(arenas.values());
}

/** Arenas a match may actually be played on. */
export function listPlayableArenas(): readonly ArenaDefinition[] {
  return listArenas().filter((arena) => arena.enabled);
}

/**
 * Look up an arena, falling back to something playable.
 *
 * Never returns undefined: an unknown or disabled id means a match starts on the
 * default arena rather than failing to start at all.
 */
export function getArena(arenaId: string): ArenaDefinition {
  const requested = arenas.get(arenaId);
  if (requested?.enabled) return requested;

  // The default has to be playable too, or disabling it would hand every match
  // the very arena an administrator just took out of rotation.
  const preferred = arenas.get(DEFAULT_ARENA_ID);
  const fallback =
    (preferred?.enabled ? preferred : undefined) ?? listPlayableArenas()[0] ?? listArenas()[0];

  if (!fallback) throw new Error("No arenas are available");
  return fallback;
}
