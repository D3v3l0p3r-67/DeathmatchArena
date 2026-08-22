/**
 * Arena validation.
 *
 * Runs on the server before anything is stored, and on the client only to show
 * problems as they are created. As with configuration, the client's verdict is
 * advisory: the same repository is reachable over HTTP, so the server checks
 * again from scratch.
 *
 * Errors block a save; warnings do not. The distinction matters more than it
 * looks: a spawn point buried inside a wall is recoverable (the server nudges it
 * out at match start) and an arena with no spawn points at all is not, and an
 * editor that refuses both equally is an editor people stop using.
 */
import { PLAYER_HALF_HEIGHT, PLAYER_HALF_WIDTH } from "../game/constants.js";
import { SurfaceType } from "../game/types.js";
import { trapRegistry, type TrapRegistry } from "./traps.js";
import {
  ARENA_LIMITS,
  TrapActivation,
  type ArenaDefinition,
  type ArenaElement,
  type ArenaSpawnPoint,
  type TrapDefinition,
} from "./types.js";

export type IssueSeverity = "error" | "warning";

export interface ArenaIssue {
  /** Where the problem is, e.g. `traps.trap-3.width`. Empty for the arena itself. */
  path: string;
  message: string;
  severity: IssueSeverity;
}

export interface ArenaValidationResult {
  /** True when nothing is an error. Warnings do not block a save. */
  ok: boolean;
  issues: ArenaIssue[];
}

const SURFACE_TYPES = new Set<string>(Object.values(SurfaceType));

export interface ArenaValidationOptions {
  /** Ids already taken by other arenas, so a save cannot collide with one. */
  takenIds?: readonly string[];
  /** Catalogue the trap types are checked against. */
  traps?: TrapRegistry;
}

/**
 * Check one arena from top to bottom.
 *
 * The order is deliberate: dimensions first, because everything else is checked
 * against them, and an arena with a nonsense width produces a wall of noise
 * about objects being out of bounds otherwise.
 */
export function validateArena(
  arena: ArenaDefinition,
  options: ArenaValidationOptions = {},
): ArenaValidationResult {
  const issues: ArenaIssue[] = [];
  const registry = options.traps ?? trapRegistry;
  const error = (path: string, message: string) => issues.push({ path, message, severity: "error" });
  const warn = (path: string, message: string) => issues.push({ path, message, severity: "warning" });

  // -- Identity -------------------------------------------------------------

  if (!ARENA_LIMITS.ID_PATTERN.test(arena.id)) {
    error("id", "The id must be 2-48 characters of lowercase letters, digits and dashes.");
  } else if (options.takenIds?.includes(arena.id)) {
    error("id", `Another arena already uses the id "${arena.id}".`);
  }

  const name = arena.name?.trim() ?? "";
  if (name === "") error("name", "The arena needs a name.");
  else if (name.length > ARENA_LIMITS.MAX_NAME_LENGTH) {
    error("name", `The name is limited to ${ARENA_LIMITS.MAX_NAME_LENGTH} characters.`);
  }

  // -- Dimensions -----------------------------------------------------------

  const widthOk = isWithin(arena.width, ARENA_LIMITS.MIN_WIDTH, ARENA_LIMITS.MAX_WIDTH);
  const heightOk = isWithin(arena.height, ARENA_LIMITS.MIN_HEIGHT, ARENA_LIMITS.MAX_HEIGHT);

  if (!widthOk) {
    error("width", `Width must be between ${ARENA_LIMITS.MIN_WIDTH} and ${ARENA_LIMITS.MAX_WIDTH}.`);
  }
  if (!heightOk) {
    error("height", `Height must be between ${ARENA_LIMITS.MIN_HEIGHT} and ${ARENA_LIMITS.MAX_HEIGHT}.`);
  }

  // Without sane dimensions every bounds check below would be meaningless.
  if (!widthOk || !heightOk) return { ok: false, issues };

  // -- Ids ------------------------------------------------------------------

  // One namespace across geometry, spawns and traps: the editor addresses
  // everything it can select by id, and two objects sharing one would make a
  // selection ambiguous.
  const seen = new Set<string>();
  const claimId = (path: string, id: string) => {
    if (!id) {
      error(path, "Every object needs an id.");
      return;
    }
    if (seen.has(id)) error(path, `Duplicate object id "${id}".`);
    seen.add(id);
  };

  // -- Geometry -------------------------------------------------------------

  if (arena.elements.length > ARENA_LIMITS.MAX_ELEMENTS) {
    error("elements", `An arena may hold at most ${ARENA_LIMITS.MAX_ELEMENTS} pieces of geometry.`);
  }

  arena.elements.forEach((element, index) => {
    const path = `elements.${element.id || index}`;
    claimId(path, element.id);

    if (!SURFACE_TYPES.has(element.type)) {
      error(`${path}.type`, `"${element.type}" is not a valid geometry type.`);
    }
    validateBox(element, path, arena, ARENA_LIMITS.MIN_ELEMENT_SIZE, error);
  });

  if (arena.elements.length === 0) {
    warn("elements", "The arena has no geometry, so players will fall to the bottom edge.");
  }

  // -- Spawn points ---------------------------------------------------------

  validateSpawns(arena.playerSpawns, "playerSpawns", "player spawn", arena, issues, claimId);
  validateSpawns(arena.powerUpSpawns, "powerUpSpawns", "power-up spawn", arena, issues, claimId);

  const enabledPlayerSpawns = arena.playerSpawns.filter((spawn) => spawn.enabled);
  if (enabledPlayerSpawns.length === 0) {
    error("playerSpawns", "The arena needs at least one enabled player spawn point.");
  } else if (enabledPlayerSpawns.length < 2) {
    warn("playerSpawns", "With one spawn point every player starts on top of the same spot.");
  }

  if (arena.powerUpSpawns.filter((spawn) => spawn.enabled).length === 0) {
    warn("powerUpSpawns", "No power-up spawn points, so crates will never appear.");
  }

  // Spawns stacked on top of each other put two players in the same place.
  for (const [path, spawns] of [
    ["playerSpawns", arena.playerSpawns],
    ["powerUpSpawns", arena.powerUpSpawns],
  ] as const) {
    for (let i = 0; i < spawns.length; i++) {
      for (let j = i + 1; j < spawns.length; j++) {
        const a = spawns[i]!;
        const b = spawns[j]!;
        if (Math.abs(a.x - b.x) < 8 && Math.abs(a.y - b.y) < 8) {
          warn(`${path}.${a.id}`, `Overlaps the spawn point "${b.id}".`);
        }
      }
    }
  }

  // -- Traps ----------------------------------------------------------------

  if (arena.traps.length > ARENA_LIMITS.MAX_TRAPS) {
    error("traps", `An arena may hold at most ${ARENA_LIMITS.MAX_TRAPS} traps.`);
  }

  arena.traps.forEach((trap, index) => {
    const path = `traps.${trap.id || index}`;
    claimId(path, trap.id);
    validateTrap(trap, path, arena, registry, issues);
  });

  return { ok: issues.every((issue) => issue.severity !== "error"), issues };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function validateBox(
  box: { x: number; y: number; width: number; height: number },
  path: string,
  arena: ArenaDefinition,
  minSize: number,
  error: (path: string, message: string) => void,
): void {
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) {
    error(path, "Position must be a number.");
    return;
  }
  if (box.width < minSize || box.height < minSize) {
    error(`${path}.size`, `Must be at least ${minSize}px on each side.`);
    return;
  }
  if (box.x < 0 || box.y < 0 || box.x + box.width > arena.width || box.y + box.height > arena.height) {
    error(`${path}.bounds`, "Extends outside the arena.");
  }
}

function validateSpawns(
  spawns: readonly ArenaSpawnPoint[],
  path: string,
  label: string,
  arena: ArenaDefinition,
  issues: ArenaIssue[],
  claimId: (path: string, id: string) => void,
): void {
  if (spawns.length > ARENA_LIMITS.MAX_SPAWNS) {
    issues.push({
      path,
      message: `At most ${ARENA_LIMITS.MAX_SPAWNS} ${label} points are allowed.`,
      severity: "error",
    });
  }

  spawns.forEach((spawn, index) => {
    const spawnPath = `${path}.${spawn.id || index}`;
    claimId(spawnPath, spawn.id);

    if (!Number.isFinite(spawn.x) || !Number.isFinite(spawn.y)) {
      issues.push({ path: spawnPath, message: "Position must be a number.", severity: "error" });
      return;
    }

    // A spawn is the *centre* of whatever appears there, so the body has to fit.
    const insideX = spawn.x >= PLAYER_HALF_WIDTH && spawn.x <= arena.width - PLAYER_HALF_WIDTH;
    const insideY = spawn.y >= PLAYER_HALF_HEIGHT && spawn.y <= arena.height - PLAYER_HALF_HEIGHT;
    if (!insideX || !insideY) {
      issues.push({ path: spawnPath, message: "Sits outside the arena.", severity: "error" });
      return;
    }

    // Buried spawns are survivable -- the server searches for free space at match
    // start -- so this is a warning rather than a refusal.
    if (overlapsGeometry(arena, spawn.x, spawn.y, PLAYER_HALF_WIDTH, PLAYER_HALF_HEIGHT)) {
      issues.push({
        path: spawnPath,
        message: "Sits inside solid geometry; the server will nudge it clear at match start.",
        severity: "warning",
      });
    }
  });
}

function validateTrap(
  trap: TrapDefinition,
  path: string,
  arena: ArenaDefinition,
  registry: TrapRegistry,
  issues: ArenaIssue[],
): void {
  const error = (subPath: string, message: string) =>
    issues.push({ path: subPath, message, severity: "error" });
  const warn = (subPath: string, message: string) =>
    issues.push({ path: subPath, message, severity: "warning" });

  const type = registry.get(trap.type);
  if (!type) {
    error(`${path}.type`, `"${trap.type}" is not a known trap type.`);
    return;
  }

  if (!Object.values(TrapActivation).includes(trap.activation)) {
    error(`${path}.activation`, `"${trap.activation}" is not a valid activation mode.`);
  }

  validateBox(trap, path, arena, ARENA_LIMITS.MIN_TRAP_SIZE, error);

  // Overrides: `null` means "inherit", which is always fine. A number has to make
  // sense on its own.
  const ranges: [keyof TrapDefinition, number, number, string][] = [
    ["damage", 0, 1000, "Damage"],
    ["activationDelayMs", 0, 20000, "Activation delay"],
    ["activeDurationMs", 0, 60000, "Active duration"],
    ["cooldownMs", 0, 120000, "Cooldown"],
    ["moveSpeed", 0, 2000, "Movement speed"],
    ["triggerRadius", 0, 1500, "Trigger radius"],
  ];

  for (const [key, min, max, label] of ranges) {
    const value = trap[key];
    if (value === null || value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      error(`${path}.${String(key)}`, `${label} must be between ${min} and ${max}.`);
    }
  }

  // Type-specific parameters, checked against the type's own metadata.
  for (const param of type.params) {
    const value = trap.params?.[param.key];
    if (value === undefined) {
      warn(`${path}.params.${param.key}`, `"${param.label}" is missing; the type default will be used.`);
      continue;
    }

    if (param.type === "select") {
      const allowed = (param.options ?? []).some((option) => option.value === value);
      if (!allowed) error(`${path}.params.${param.key}`, `"${String(value)}" is not a valid ${param.label}.`);
      continue;
    }

    if (param.type === "boolean") {
      if (typeof value !== "boolean") error(`${path}.params.${param.key}`, `"${param.label}" must be true or false.`);
      continue;
    }

    if (param.type === "string") {
      if (typeof value !== "string") error(`${path}.params.${param.key}`, `"${param.label}" must be text.`);
      continue;
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
      error(`${path}.params.${param.key}`, `"${param.label}" must be a number.`);
      continue;
    }
    if (param.min !== undefined && value < param.min) {
      error(`${path}.params.${param.key}`, `"${param.label}" must be at least ${param.min}.`);
    }
    if (param.max !== undefined && value > param.max) {
      error(`${path}.params.${param.key}`, `"${param.label}" must be at most ${param.max}.`);
    }
  }

  // A proximity trap with no reach can never fire, which reads as a broken trap
  // rather than a disabled one.
  if (trap.activation === TrapActivation.PROXIMITY && trap.triggerRadius === 0) {
    warn(`${path}.triggerRadius`, "A proximity trap with a zero trigger radius will never activate.");
  }
}

function overlapsGeometry(
  arena: ArenaDefinition,
  cx: number,
  cy: number,
  halfWidth: number,
  halfHeight: number,
): boolean {
  const left = cx - halfWidth;
  const right = cx + halfWidth;
  const top = cy - halfHeight;
  const bottom = cy + halfHeight;

  return arena.elements.some(
    (element: ArenaElement) =>
      left < element.x + element.width &&
      right > element.x &&
      top < element.y + element.height &&
      bottom > element.y,
  );
}

function isWithin(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}
