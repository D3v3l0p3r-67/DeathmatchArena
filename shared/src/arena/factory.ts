/**
 * Making arenas: new ones, copies of existing ones, and repaired ones.
 *
 * Kept apart from the repository and the editor because all three need it and
 * none of them should own it: creating an arena is the same operation whether it
 * happens through the admin interface, a seed script or a test.
 */
import { SurfaceType } from "../game/types.js";
import { trapRegistry, type TrapRegistry } from "./traps.js";
import {
  TrapActivation,
  type ArenaDefinition,
  type ArenaElement,
  type ArenaSpawnPoint,
  type TrapDefinition,
} from "./types.js";

/** A readable id from a display name: "The Foundry" becomes "the-foundry". */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "arena";
}

/**
 * A slug that is not already taken, by appending a counter.
 *
 * Used when an arena is duplicated: "the-foundry" becomes "the-foundry-2", not a
 * random string, because ids end up in URLs and logs and being able to read them
 * is worth more than being able to generate them blindly.
 */
export function uniqueId(base: string, taken: readonly string[]): string {
  const slug = slugify(base);
  if (!taken.includes(slug)) return slug;

  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${slug}-${suffix}`.slice(0, 48);
    if (!taken.includes(candidate)) return candidate;
  }
  return `${slug}-${Date.now().toString(36)}`.slice(0, 48);
}

/** Ids for objects inside an arena. Unique within that arena, not globally. */
export function nextObjectId(prefix: string, existing: readonly { id: string }[]): string {
  let index = existing.length + 1;
  const taken = new Set(existing.map((item) => item.id));
  while (taken.has(`${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
}

/**
 * A blank arena that is immediately playable.
 *
 * Not literally empty: a floor, walls and two spawn points, because an arena
 * with no ground is a thing you have to fix before you can look at it, and the
 * first thing anyone does with a new map is press play.
 */
export function createEmptyArena(id: string, name: string, width = 3200, height = 1800): ArenaDefinition {
  const wallThickness = 40;
  const floorHeight = 60;

  const elements: ArenaElement[] = [
    { id: "floor-1", type: SurfaceType.FLOOR, x: 0, y: height - floorHeight, width, height: floorHeight },
    { id: "wall-1", type: SurfaceType.WALL, x: 0, y: 0, width, height: wallThickness },
    { id: "wall-2", type: SurfaceType.WALL, x: 0, y: 0, width: wallThickness, height },
    { id: "wall-3", type: SurfaceType.WALL, x: width - wallThickness, y: 0, width: wallThickness, height },
  ];

  const groundY = height - floorHeight - 24;
  const playerSpawns: ArenaSpawnPoint[] = [
    { id: "spawn-1", x: Math.round(width * 0.2), y: groundY, enabled: true },
    { id: "spawn-2", x: Math.round(width * 0.8), y: groundY, enabled: true },
  ];

  const powerUpSpawns: ArenaSpawnPoint[] = [
    { id: "crate-1", x: Math.round(width * 0.5), y: groundY, enabled: true },
  ];

  return {
    id,
    name,
    enabled: true,
    width,
    height,
    backgroundColor: 0x11151f,
    fogColor: 0x1b2233,
    elements,
    playerSpawns,
    powerUpSpawns,
    traps: [],
    updatedAt: 0,
  };
}

/** A deep copy under a new id and name. Everything inside keeps its own ids. */
export function duplicateArena(source: ArenaDefinition, id: string, name: string): ArenaDefinition {
  return { ...structuredClone(source), id, name, updatedAt: 0 };
}

/**
 * Coerce whatever arrived over the wire into a well-formed arena.
 *
 * The admin interface sends JSON, and JSON has no types. Rather than trusting
 * the shape and failing somewhere deep in the simulation, every field is read
 * defensively here and anything unrecognisable is replaced with a sane value.
 * Validation happens afterwards, on the result -- so a malformed request becomes
 * a list of problems rather than a stack trace.
 */
export function normaliseArena(
  raw: unknown,
  registry: TrapRegistry = trapRegistry,
): ArenaDefinition {
  const source = isRecord(raw) ? raw : {};

  const width = clampNumber(source.width, 800, 12000, 3200);
  const height = clampNumber(source.height, 600, 8000, 1800);

  return {
    id: slugify(readString(source.id, "arena")),
    name: readString(source.name, "Untitled arena").slice(0, 48),
    enabled: source.enabled !== false,
    width,
    height,
    backgroundColor: clampNumber(source.backgroundColor, 0, 0xffffff, 0x11151f),
    fogColor: clampNumber(source.fogColor, 0, 0xffffff, 0x1b2233),
    elements: readArray(source.elements).map((entry, index) => normaliseElement(entry, index)),
    playerSpawns: readArray(source.playerSpawns).map((entry, index) => normaliseSpawn(entry, "spawn", index)),
    powerUpSpawns: readArray(source.powerUpSpawns).map((entry, index) => normaliseSpawn(entry, "crate", index)),
    traps: readArray(source.traps).flatMap((entry, index) => {
      const trap = normaliseTrap(entry, index, registry);
      return trap ? [trap] : [];
    }),
    updatedAt: clampNumber(source.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

function normaliseElement(raw: unknown, index: number): ArenaElement {
  const source = isRecord(raw) ? raw : {};
  const type = Object.values(SurfaceType).includes(source.type as never)
    ? (source.type as ArenaElement["type"])
    : SurfaceType.PLATFORM;

  return {
    id: readString(source.id, `element-${index + 1}`),
    type,
    x: clampNumber(source.x, -100000, 100000, 0),
    y: clampNumber(source.y, -100000, 100000, 0),
    width: clampNumber(source.width, 0, 100000, 100),
    height: clampNumber(source.height, 0, 100000, 24),
  };
}

function normaliseSpawn(raw: unknown, prefix: string, index: number): ArenaSpawnPoint {
  const source = isRecord(raw) ? raw : {};
  return {
    id: readString(source.id, `${prefix}-${index + 1}`),
    x: clampNumber(source.x, -100000, 100000, 0),
    y: clampNumber(source.y, -100000, 100000, 0),
    enabled: source.enabled !== false,
  };
}

/**
 * A trap of an unknown type is dropped rather than repaired: there is nothing to
 * repair it against, and keeping it would mean storing something the simulation
 * cannot run.
 */
function normaliseTrap(raw: unknown, index: number, registry: TrapRegistry): TrapDefinition | null {
  const source = isRecord(raw) ? raw : {};
  const type = registry.get(readString(source.type, ""));
  if (!type) return null;

  const activation = Object.values(TrapActivation).includes(source.activation as never)
    ? (source.activation as TrapDefinition["activation"])
    : type.defaultActivation;

  const params: TrapDefinition["params"] = {};
  const rawParams = isRecord(source.params) ? source.params : {};
  for (const param of type.params) {
    const value = rawParams[param.key];
    params[param.key] =
      typeof value === "number" || typeof value === "boolean" || typeof value === "string"
        ? value
        : param.defaultValue;
  }

  return {
    id: readString(source.id, `trap-${index + 1}`),
    type: type.id,
    x: clampNumber(source.x, -100000, 100000, 0),
    y: clampNumber(source.y, -100000, 100000, 0),
    width: clampNumber(source.width, 0, 100000, type.defaultSize.width),
    height: clampNumber(source.height, 0, 100000, type.defaultSize.height),
    enabled: source.enabled !== false,
    activation,
    damage: readOverride(source.damage),
    activationDelayMs: readOverride(source.activationDelayMs),
    activeDurationMs: readOverride(source.activeDurationMs),
    cooldownMs: readOverride(source.cooldownMs),
    moveSpeed: readOverride(source.moveSpeed),
    triggerRadius: readOverride(source.triggerRadius),
    params,
  };
}

/** `null` is meaningful here -- it is "inherit" -- so it survives normalisation. */
function readOverride(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}
