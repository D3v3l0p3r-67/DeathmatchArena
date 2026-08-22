/**
 * Validation for configuration changes.
 *
 * Runs on the server for every change an administrator or a debug operator
 * makes, and on the client only to give immediate feedback -- the client's
 * verdict is never trusted, because the same code path is reachable by anyone
 * who can craft an HTTP request.
 *
 * Two levels:
 *
 *   - `validateChange` checks one value against its own field metadata: type,
 *     range, whole numbers, allowed options, and the dependencies between fields
 *     (a minimum that would exceed its maximum, say).
 *   - `validateConfig` checks the configuration as a whole for the invariants no
 *     single field can see -- that the default weapon exists, that a weapon
 *     power-up grants something real, that ids are unique.
 *
 * Nothing here mutates: `applyChange` returns a new configuration or a failure.
 */
import { ConfigFieldType, ConfigRegistry, readConfigValue, type ConfigFieldDefinition } from "./schema.js";
import { cloneConfig } from "./registry.js";
import { PowerUpType, type ConfigValue, type GameConfig } from "./types.js";

export interface ValidationIssue {
  /** Field key, or a section name for a whole-configuration problem. */
  key: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export interface ChangeResult extends ValidationResult {
  /** The coerced value actually stored. Absent when validation failed. */
  value?: ConfigValue;
}

const OK: ValidationResult = { ok: true, issues: [] };

function fail(key: string, message: string): ValidationResult {
  return { ok: false, issues: [{ key, message }] };
}

/**
 * Coerce and check one value against its field.
 *
 * Coercion is deliberate rather than strict: an HTML form sends "42" and "true",
 * and rejecting those would mean every caller re-implementing the same parsing.
 * What is *not* forgiven is a value that cannot be read as the declared type at
 * all, or one outside the declared range -- those are refused, never clamped, so
 * an administrator finds out that a limit exists instead of silently getting a
 * different number than they typed.
 */
export function validateChange(
  field: ConfigFieldDefinition,
  raw: unknown,
  config: GameConfig,
): ChangeResult {
  if (!field.editable) return fail(field.key, `"${field.label}" cannot be changed.`);

  switch (field.type) {
    case ConfigFieldType.BOOLEAN: {
      const value = coerceBoolean(raw);
      if (value === undefined) return fail(field.key, `"${field.label}" must be true or false.`);
      return { ok: true, issues: [], value };
    }

    case ConfigFieldType.STRING: {
      if (typeof raw !== "string") return fail(field.key, `"${field.label}" must be text.`);
      const value = raw.trim();
      if (field.required && value === "") return fail(field.key, `"${field.label}" is required.`);
      if (value.length > 64) return fail(field.key, `"${field.label}" is limited to 64 characters.`);
      return { ok: true, issues: [], value };
    }

    case ConfigFieldType.SELECT: {
      if (typeof raw !== "string") return fail(field.key, `"${field.label}" must be one of the listed options.`);
      const allowed = (field.options ?? []).some((option) => option.value === raw);
      if (!allowed) return fail(field.key, `"${raw}" is not a valid option for "${field.label}".`);
      return { ok: true, issues: [], value: raw };
    }

    default: {
      const numeric = coerceNumber(raw);
      if (numeric === undefined) return fail(field.key, `"${field.label}" must be a number.`);
      if (field.integer && !Number.isInteger(numeric)) {
        return fail(field.key, `"${field.label}" must be a whole number.`);
      }
      if (field.min !== undefined && numeric < field.min) {
        return fail(field.key, `"${field.label}" must be at least ${field.min}.`);
      }
      if (field.max !== undefined && numeric > field.max) {
        return fail(field.key, `"${field.label}" must be at most ${field.max}.`);
      }

      const dependency = checkDependencies(field, numeric, config);
      if (!dependency.ok) return dependency;

      return { ok: true, issues: [], value: numeric };
    }
  }
}

/**
 * Relationships between two fields.
 *
 * The pairs that matter are all "this one must not overtake that one": a minimum
 * throw power above the maximum, a falloff that ends before it starts, a lobby
 * minimum above its own capacity. Each is declared on the field rather than
 * hard-coded here, so a new pair is metadata.
 */
function checkDependencies(
  field: ConfigFieldDefinition,
  value: number,
  config: GameConfig,
): ValidationResult {
  if (field.mustNotExceed) {
    const ceiling = readConfigValue(config, field.mustNotExceed);
    if (typeof ceiling === "number" && value > ceiling) {
      return fail(field.key, `"${field.label}" cannot be greater than ${ceiling}.`);
    }
  }

  if (field.mustBeAtLeast) {
    const floor = readConfigValue(config, field.mustBeAtLeast);
    if (typeof floor === "number" && value < floor) {
      return fail(field.key, `"${field.label}" cannot be less than ${floor}.`);
    }
  }

  return OK;
}

/**
 * Apply one change to a copy of `config`.
 *
 * The copy is what makes this safe to call speculatively: a rejected change
 * leaves the caller's configuration untouched, and an accepted one is a whole
 * new object the caller can swap in atomically.
 */
export function applyChange(
  registry: ConfigRegistry,
  config: GameConfig,
  key: string,
  raw: unknown,
): { ok: boolean; issues: ValidationIssue[]; config: GameConfig } {
  const field = registry.get(key);
  if (!field) {
    return { ok: false, issues: [{ key, message: `Unknown setting "${key}".` }], config };
  }

  const change = validateChange(field, raw, config);
  if (!change.ok || change.value === undefined) {
    return { ok: false, issues: change.issues, config };
  }

  const next = cloneConfig(config);
  if (!registry.write(next, key, change.value)) {
    return { ok: false, issues: [{ key, message: `"${field.label}" could not be written.` }], config };
  }

  // Re-check the whole configuration: one legal-looking value can still break an
  // invariant, such as disabling the last weapon a power-up grants.
  const overall = validateConfig(next);
  if (!overall.ok) return { ok: false, issues: overall.issues, config };

  return { ok: true, issues: [], config: next };
}

/**
 * Whole-configuration invariants.
 *
 * These are the things that make a configuration *unusable* rather than merely
 * odd, so they are refused outright: a room built on any of them would fail at
 * match start rather than at save time, which is far harder to explain.
 */
export function validateConfig(config: GameConfig): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (config.weapons.length === 0) {
    issues.push({ key: "weapons", message: "At least one weapon must exist." });
  }

  const weaponIds = new Set<string>();
  for (const weapon of config.weapons) {
    if (!weapon.id) {
      issues.push({ key: "weapons", message: "Every weapon needs an id." });
      continue;
    }
    if (weaponIds.has(weapon.id)) {
      issues.push({ key: `weapons.${weapon.id}`, message: `Duplicate weapon id "${weapon.id}".` });
    }
    weaponIds.add(weapon.id);
  }

  const defaultWeapon = config.weapons.find((weapon) => weapon.id === config.defaultWeaponId);
  if (!defaultWeapon) {
    issues.push({ key: "defaultWeaponId", message: `The default weapon "${config.defaultWeaponId}" does not exist.` });
  } else if (!defaultWeapon.enabled) {
    // Every player spawns with this weapon, so it is the one weapon that cannot
    // be switched off.
    issues.push({ key: `weapons.${defaultWeapon.id}.enabled`, message: "The default weapon cannot be disabled." });
  }

  const powerUpIds = new Set<string>();
  for (const powerUp of config.powerUps) {
    if (powerUpIds.has(powerUp.id)) {
      issues.push({ key: `powerUps.${powerUp.id}`, message: `Duplicate power-up id "${powerUp.id}".` });
    }
    powerUpIds.add(powerUp.id);

    if (powerUp.type === PowerUpType.WEAPON && !weaponIds.has(powerUp.weaponId)) {
      issues.push({
        key: `powerUps.${powerUp.id}.weaponId`,
        message: `"${powerUp.name}" grants the unknown weapon "${powerUp.weaponId}".`,
      });
    }
  }

  if (config.match.minPlayers > config.match.maxPlayers) {
    issues.push({ key: "match.minPlayers", message: "Minimum players cannot exceed maximum players." });
  }

  if (config.player.maxHealth <= 0) {
    issues.push({ key: "player.maxHealth", message: "Maximum health must be greater than zero." });
  }

  return issues.length === 0 ? OK : { ok: false, issues };
}

function coerceNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function coerceBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === 1 || raw === "1") return true;
  if (raw === "false" || raw === 0 || raw === "0") return false;
  return undefined;
}
