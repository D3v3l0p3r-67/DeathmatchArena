/**
 * The arena data model.
 *
 * An arena is *data*: geometry, spawn points and traps, with no behaviour
 * attached. The server builds a collision world and a trap simulation from one
 * of these at match start; the admin interface edits them; a repository stores
 * them. None of those three knows anything about the others.
 *
 * Everything is JSON-compatible, because an arena has to survive a round trip
 * through a text field, an HTTP body and -- eventually -- a database column.
 */
import type { ConfigValue } from "../config/types.js";
import type { SurfaceTypeValue } from "../game/types.js";

/**
 * One solid rectangle.
 *
 * `type` is a classification, not a behaviour: floors, platforms, walls and
 * obstacles all collide identically and differ only in how they are drawn and how
 * the editor groups them. Keeping them in one list rather than four parallel
 * arrays means the collision world, the renderer, the editor and the validator
 * each have exactly one code path.
 */
export interface ArenaElement {
  /** Unique within the arena. Stable across edits, so an editor can track it. */
  id: string;
  type: SurfaceTypeValue;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A place a player or a crate can appear. */
export interface ArenaSpawnPoint {
  id: string;
  /** Centre of whatever spawns here. */
  x: number;
  y: number;
  /** Disabled points are kept for later but never chosen. */
  enabled: boolean;
}

/**
 * How a trap decides to become dangerous.
 *
 * The mode is a property of the placement rather than the type, so the same
 * flame vent can be a permanent hazard in one arena and a proximity trap in
 * another without needing a second trap type.
 */
export const TrapActivation = {
  /** Dangerous from the moment the match starts, permanently. */
  ALWAYS: "always",
  /** Cycles by itself: arm, activate, cool down, repeat. */
  PERIODIC: "periodic",
  /** Triggers when a player comes within the trigger radius. */
  PROXIMITY: "proximity",
  /** Triggers when a player touches the trap body. */
  CONTACT: "contact",
} as const;

export type TrapActivationValue = (typeof TrapActivation)[keyof typeof TrapActivation];

/**
 * One trap placed in an arena.
 *
 * The numeric fields are *overrides*: `null` means "use the game-wide trap
 * default", which is how the global Traps configuration retunes every arena at
 * once while still letting one crusher in one arena be slower than the rest.
 */
export interface TrapDefinition {
  id: string;
  /** Id of a type registered in the `TrapRegistry`. */
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  enabled: boolean;
  activation: TrapActivationValue;

  damage: number | null;
  activationDelayMs: number | null;
  activeDurationMs: number | null;
  cooldownMs: number | null;
  moveSpeed: number | null;
  triggerRadius: number | null;

  /** Values specific to this trap type, described by the type's `params`. */
  params: Record<string, ConfigValue>;
}

/**
 * A complete arena.
 *
 * `id` is internal and stable -- rooms, saved matches and links all refer to it,
 * so it is fixed once created. `name` is the label an administrator sees and is
 * free to change at any time.
 */
export interface ArenaDefinition {
  id: string;
  name: string;
  /** Disabled arenas stay stored but are never selected for a match. */
  enabled: boolean;
  width: number;
  height: number;
  /** Rendering hints. Gameplay never depends on them. */
  backgroundColor: number;
  fogColor: number;

  elements: ArenaElement[];
  playerSpawns: ArenaSpawnPoint[];
  powerUpSpawns: ArenaSpawnPoint[];
  traps: TrapDefinition[];

  /** Set by the repository on save. Purely informational. */
  updatedAt: number;
}

/** The limits an arena must stay within, enforced by `validateArena`. */
export const ARENA_LIMITS = {
  MIN_WIDTH: 800,
  MAX_WIDTH: 12000,
  MIN_HEIGHT: 600,
  MAX_HEIGHT: 8000,
  /** Smallest edge of a piece of geometry. Below this it is invisible and unhittable. */
  MIN_ELEMENT_SIZE: 4,
  MIN_TRAP_SIZE: 8,
  MAX_ELEMENTS: 600,
  MAX_SPAWNS: 64,
  MAX_TRAPS: 120,
  MAX_NAME_LENGTH: 48,
  /** Ids are slugs: lowercase, digits and dashes. */
  ID_PATTERN: /^[a-z0-9][a-z0-9-]{1,47}$/,
} as const;
