/**
 * The configuration *metadata* model.
 *
 * `types.ts` says what the configuration is; this file says what each value
 * means, what it may be set to, and where it belongs in an editing interface.
 *
 * Everything an admin form needs is described as data:
 *
 *   { key: "weapons.shotgun.damage", category: "Weapons", subcategory: "Shotgun",
 *     label: "Damage", type: "number", min: 0, max: 500, step: 1, ... }
 *
 * so the interface renders whatever the server sends rather than shipping its own
 * hard-coded list of inputs. Adding a weapon adds its fields automatically,
 * because the descriptor list is *generated from the configuration itself* --
 * see `buildConfigFields`.
 *
 * The same metadata backs the in-game debug console, so an admin and a debug
 * operator are always looking at the same set of values with the same limits.
 */
import {
  PowerUpType,
  WeaponType,
  type BotDifficultyLevel,
  type BrainProfile,
  type ConfigValue,
  type GameConfig,
  type PowerUpDefinition,
  type WeaponDefinition,
} from "./types.js";

/**
 * The control an editor should render.
 *
 * `percentage` is a number stored as 0..1 and shown as 0..100% -- a distinct type
 * rather than a formatting hint, because "50" and "0.5" being the same value is
 * exactly the confusion this is meant to prevent.
 */
export const ConfigFieldType = {
  NUMBER: "number",
  BOOLEAN: "boolean",
  STRING: "string",
  SELECT: "select",
  PERCENTAGE: "percentage",
} as const;

export type ConfigFieldTypeValue = (typeof ConfigFieldType)[keyof typeof ConfigFieldType];

export interface ConfigFieldOption {
  value: string;
  label: string;
}

/**
 * One configurable value, fully described.
 *
 * Plain JSON: it travels to the admin interface over HTTP and to the debug
 * console over the game socket, and neither end needs to know anything about the
 * shape of `GameConfig` to render it.
 */
export interface ConfigFieldDefinition {
  /** Dotted path into the configuration, e.g. `weapons.shotgun.damage`. */
  key: string;
  category: string;
  subcategory: string;
  label: string;
  type: ConfigFieldTypeValue;
  /** The value this field resets to. */
  defaultValue: ConfigValue;
  min?: number;
  max?: number;
  step?: number;
  /** Allowed values for a `select`. Anything else is rejected. */
  options?: ConfigFieldOption[];
  description: string;
  /**
   * False for values that are shown but must not be changed -- an id an arena or
   * a power-up refers to, for instance. The server enforces this; the interface
   * only greys the control out.
   */
  editable: boolean;
  /** Whole numbers only. */
  integer?: boolean;
  /** Strings and selects that may not be left empty. */
  required?: boolean;
  /** Key of a field this value may not exceed (e.g. a minimum against its maximum). */
  mustNotExceed?: string;
  /** Key of a field this value must be at least as large as. */
  mustBeAtLeast?: string;
}

/** A field description before its default has been read from the baseline. */
type FieldDescriptor = Omit<ConfigFieldDefinition, "defaultValue">;

// ---------------------------------------------------------------------------
// Path access
// ---------------------------------------------------------------------------

/**
 * Resolve a dotted key to the object holding the value and the property name.
 *
 * Two kinds of segment, which is what lets one resolver serve both
 * `player.moveSpeed` and `weapons.shotgun.damage`: a plain property, or -- when
 * the current node is an array -- the `id` of one of its entries.
 *
 * Returns null for anything that does not resolve, so a malformed key is a miss
 * rather than a crash or an accidental write to a neighbouring property.
 */
function resolvePath(
  config: GameConfig,
  key: string,
): { holder: Record<string, unknown>; property: string } | null {
  const segments = key.split(".");
  // A top-level scalar is a setting like any other: `defaultWeaponId` lives on
  // the configuration itself rather than inside a section.
  if (segments.length === 1) return { holder: config as unknown as Record<string, unknown>, property: segments[0]! };

  let node: unknown = config;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    if (Array.isArray(node)) {
      // Matched by a stable key rather than by index, so reordering a catalogue
      // does not silently repoint every stored override. Most things carry an
      // `id`; the difficulty ladder is keyed by its rung number instead.
      node = node.find(
        (entry) => isRecord(entry) && (entry.id === segment || String(entry.level) === segment),
      );
    } else if (isRecord(node)) {
      node = node[segment];
    } else {
      return null;
    }
    if (node === undefined || node === null) return null;
  }

  if (!isRecord(node) || Array.isArray(node)) return null;
  return { holder: node, property: segments[segments.length - 1]! };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Read one configured value by key, or undefined when the key does not resolve. */
export function readConfigValue(config: GameConfig, key: string): ConfigValue | undefined {
  const target = resolvePath(config, key);
  if (!target) return undefined;
  const value = target.holder[target.property];
  return typeof value === "number" || typeof value === "boolean" || typeof value === "string"
    ? value
    : undefined;
}

/**
 * Write one configured value by key.
 *
 * Deliberately unvalidated and deliberately not exported for general use: every
 * caller goes through `GameConfigValidator` first, and the field list is the
 * whitelist of keys that may be written at all.
 */
function writeConfigValue(config: GameConfig, key: string, value: ConfigValue): boolean {
  const target = resolvePath(config, key);
  if (!target) return false;
  target.holder[target.property] = value;
  return true;
}

// ---------------------------------------------------------------------------
// Field descriptors
// ---------------------------------------------------------------------------

const CATEGORY = {
  PLAYER: "Player",
  WEAPONS: "Weapons",
  GRENADES: "Grenades",
  POWERUPS: "Power-ups",
  CRATES: "Crates",
  MATCH: "Match",
  ARENA: "Arena",
  TRAPS: "Traps",
  NPC: "NPCs",
  MINIMAP: "Minimap",
  GAUGES: "Gauges",
} as const;

interface NumberOptions {
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  mustNotExceed?: string;
  mustBeAtLeast?: string;
}

function number(
  key: string,
  category: string,
  subcategory: string,
  label: string,
  description: string,
  options: NumberOptions = {},
): FieldDescriptor {
  return {
    key,
    category,
    subcategory,
    label,
    type: ConfigFieldType.NUMBER,
    description,
    editable: true,
    ...options,
  };
}

/** A 0..1 value shown as a percentage. */
function percentage(
  key: string,
  category: string,
  subcategory: string,
  label: string,
  description: string,
  max = 1,
): FieldDescriptor {
  return {
    key,
    category,
    subcategory,
    label,
    type: ConfigFieldType.PERCENTAGE,
    description,
    editable: true,
    min: 0,
    max,
    step: 0.01,
  };
}

function boolean(
  key: string,
  category: string,
  subcategory: string,
  label: string,
  description: string,
): FieldDescriptor {
  return {
    key,
    category,
    subcategory,
    label,
    type: ConfigFieldType.BOOLEAN,
    description,
    editable: true,
  };
}

function text(
  key: string,
  category: string,
  subcategory: string,
  label: string,
  description: string,
  editable = true,
): FieldDescriptor {
  return {
    key,
    category,
    subcategory,
    label,
    type: ConfigFieldType.STRING,
    description,
    editable,
    required: true,
  };
}

function select(
  key: string,
  category: string,
  subcategory: string,
  label: string,
  description: string,
  options: ConfigFieldOption[],
): FieldDescriptor {
  return {
    key,
    category,
    subcategory,
    label,
    type: ConfigFieldType.SELECT,
    description,
    editable: true,
    required: true,
    options,
  };
}

// -- Player -----------------------------------------------------------------

function playerFields(): FieldDescriptor[] {
  const { PLAYER } = CATEGORY;
  return [
    number("player.maxHealth", PLAYER, "Vitality", "Maximum health", "Health a player spawns with and can be healed up to.", { min: 1, max: 1000, step: 1, integer: true }),

    number("player.moveSpeed", PLAYER, "Movement", "Movement speed", "Top running speed in pixels per second. Speed power-ups multiply this.", { min: 20, max: 2000, step: 10 }),
    number("player.groundAcceleration", PLAYER, "Movement", "Ground acceleration", "How quickly top speed is reached while standing on something, px/s².", { min: 100, max: 20000, step: 100 }),
    number("player.airAcceleration", PLAYER, "Movement", "Air acceleration", "The same while airborne. Lower makes mid-air steering feel heavier.", { min: 0, max: 20000, step: 100 }),
    number("player.groundFriction", PLAYER, "Movement", "Ground friction", "Deceleration with no input on the ground, px/s².", { min: 0, max: 20000, step: 100 }),
    number("player.airFriction", PLAYER, "Movement", "Air friction", "Deceleration with no input in the air. Keep it low so jumps carry momentum.", { min: 0, max: 20000, step: 20 }),

    number("player.gravity", PLAYER, "Jumping", "Gravity", "Downward acceleration, px/s². Raising it makes everything snappier and shortens every jump.", { min: 100, max: 12000, step: 50 }),
    number("player.maxFallSpeed", PLAYER, "Jumping", "Maximum fall speed", "Terminal velocity, px/s.", { min: 100, max: 6000, step: 50 }),
    number("player.jumpVelocity", PLAYER, "Jumping", "Jump strength", "Upward launch speed of a jump, px/s. Jump height follows from this and gravity.", { min: 100, max: 3000, step: 10 }),
    number("player.maxJumps", PLAYER, "Jumping", "Maximum jumps", "Jumps available between touching the ground. 1 is a plain jump, 2 adds the mid-air jump.", { min: 1, max: 5, step: 1, integer: true }),
    percentage("player.airJumpMultiplier", PLAYER, "Jumping", "Mid-air jump strength", "Mid-air jumps use this fraction of the full jump strength.", 2),
    percentage("player.jumpCutMultiplier", PLAYER, "Jumping", "Early-release cut", "Releasing jump early keeps this fraction of the remaining ascent."),
    number("player.coyoteTimeMs", PLAYER, "Jumping", "Coyote time (ms)", "Grace period after walking off a ledge during which a jump still counts.", { min: 0, max: 500, step: 5 }),
    number("player.jumpBufferMs", PLAYER, "Jumping", "Jump buffer (ms)", "A jump pressed this long before landing is remembered and fires on touchdown.", { min: 0, max: 500, step: 5 }),

    number("player.maxKnockbackSpeed", PLAYER, "Knockback", "Knockback limit (px/s)", "The most any single hit may add to a player's speed. The safety valve: without it a weapon tuned too high launches people across the arena.", { min: 0, max: 4000, step: 25 }),
    number("player.knockbackDamping", PLAYER, "Knockback", "Knockback damping", "How quickly a shove bleeds away, per second. A hit carries roughly speed ÷ this many pixels, so lowering it makes every hit throw people further.", { min: 0.5, max: 40, step: 0.5 }),
    number("player.knockbackRecoveryMs", PLAYER, "Knockback", "Knockback window (ms)", "How long a shove keeps its own decay before ordinary friction takes over.", { min: 0, max: 3000, step: 10 }),
    percentage("player.knockbackLift", PLAYER, "Knockback", "Knockback lift", "How much of a hit is turned into lift when it lands on somebody standing. Taking them off their feet is what stops the floor scrubbing the shove off.", 2),
  ];
}

// -- Weapons ----------------------------------------------------------------

/**
 * Fields for one weapon.
 *
 * Generated from the weapon itself, so a weapon added to the catalogue is
 * editable with no change here. `type` decides which of the two optional blocks
 * contributes fields -- a chainsaw has no magazine and a rifle has no swing arc.
 */
function weaponFields(weapon: WeaponDefinition): FieldDescriptor[] {
  const { WEAPONS } = CATEGORY;
  const group = weapon.name || weapon.id;
  const prefix = `weapons.${weapon.id}`;

  const fields: FieldDescriptor[] = [
    text(`${prefix}.name`, WEAPONS, group, "Display name", "Shown in the HUD and the kill feed. Safe to change at any time."),
    boolean(`${prefix}.enabled`, WEAPONS, group, "Enabled", "A disabled weapon can neither be equipped nor spawned, but stays in the catalogue."),
    number(`${prefix}.damage`, WEAPONS, group, "Damage", weapon.type === WeaponType.RANGED ? "Damage per projectile that hits, before distance falloff." : "Damage per contact.", { min: 0, max: 500, step: 1 }),
    number(`${prefix}.range`, WEAPONS, group, weapon.type === WeaponType.RANGED ? "Range (px)" : "Contact range (px)", weapon.type === WeaponType.RANGED ? "How far a projectile travels before expiring." : "How close a target must be to be hit.", { min: 1, max: 4000, step: 1 }),

    number(`${prefix}.knockbackForce`, WEAPONS, group, "Knockback", weapon.ranged && weapon.ranged.pellets > 1 ? "How hard each *pellet* shoves whoever it hits. Nine of them land at contact range." : "How hard a hit shoves whoever it lands on. 1 is a firm push, 2 launches.", { min: 0, max: 5, step: 0.05 }),
    number(`${prefix}.recoilForce`, WEAPONS, group, "Recoil", "How hard firing shoves the shooter backwards. Separate from knockback: a weapon that throws people need not throw its owner. Applied once per shot, so an automatic applies it several times a second.", { min: 0, max: 5, step: 0.05 }),
  ];

  if (weapon.type === WeaponType.RANGED) {
    fields.push(
      number(`${prefix}.fireRate`, WEAPONS, group, "Fire rate (rpm)", "Shots per minute while the trigger is down.", { min: 1, max: 3000, step: 5 }),
      number(`${prefix}.magazineSize`, WEAPONS, group, "Magazine size", "Shots before a reload is required. 0 means the weapon never reloads.", { min: 0, max: 500, step: 1, integer: true }),
      number(`${prefix}.reloadTime`, WEAPONS, group, "Reload time (ms)", "How long a reload takes.", { min: 0, max: 20000, step: 50 }),
      boolean(`${prefix}.automatic`, WEAPONS, group, "Automatic", "Holding the trigger keeps firing."),
    );
  }

  if (weapon.ranged) {
    fields.push(
      number(`${prefix}.ranged.bulletSpeed`, WEAPONS, group, "Bullet speed (px/s)", "Muzzle velocity. Slower rounds need more leading.", { min: 50, max: 8000, step: 25 }),
      number(`${prefix}.ranged.spread`, WEAPONS, group, "Spread (rad)", "Maximum random cone deviation applied per projectile by the server.", { min: 0, max: 1.5, step: 0.005 }),
      number(`${prefix}.ranged.pellets`, WEAPONS, group, "Pellets per shot", "Projectiles fired per trigger pull. More than one makes it a shotgun.", { min: 1, max: 64, step: 1, integer: true }),
    );

    if (weapon.ranged.explosion) {
      fields.push(
        number(`${prefix}.ranged.explosion.radius`, WEAPONS, group, "Blast radius (px)", "How far the explosion reaches. An explosive round never applies its own damage -- the blast is the weapon.", { min: 10, max: 1200, step: 5 }),
        number(`${prefix}.ranged.explosion.damage`, WEAPONS, group, "Blast damage", "Damage at the very centre of the explosion.", { min: 0, max: 500, step: 1 }),
        percentage(`${prefix}.ranged.explosion.minDamageMultiplier`, WEAPONS, group, "Blast damage floor", "Fraction of that damage still dealt at the outer edge of the radius."),
        number(`${prefix}.ranged.explosion.knockbackForce`, WEAPONS, group, "Blast knockback", "How hard the blast throws whoever it catches, at the centre. This is what makes a rocket jump possible.", { min: 0, max: 6, step: 0.05 }),
      );
    }

    if (weapon.ranged.falloff) {
      fields.push(
        number(`${prefix}.ranged.falloff.startDistance`, WEAPONS, group, "Falloff start (px)", "Damage is full up to this distance.", { min: 0, max: 4000, step: 10, mustNotExceed: `${prefix}.ranged.falloff.endDistance` }),
        number(`${prefix}.ranged.falloff.endDistance`, WEAPONS, group, "Falloff end (px)", "Damage reaches its floor at this distance and stays there.", { min: 0, max: 4000, step: 10, mustBeAtLeast: `${prefix}.ranged.falloff.startDistance` }),
        percentage(`${prefix}.ranged.falloff.minMultiplier`, WEAPONS, group, "Damage floor", "Fraction of the base damage still dealt beyond the falloff end."),
      );
    }
  }

  if (weapon.melee) {
    fields.push(
      number(`${prefix}.melee.arcDegrees`, WEAPONS, group, "Swing arc (°)", "Half-angle of the damage cone around the aim direction.", { min: 1, max: 180, step: 1 }),
      number(`${prefix}.melee.attackIntervalMs`, WEAPONS, group, "Attack interval (ms)", "Minimum time between two swings.", { min: 20, max: 5000, step: 10 }),
    );
  }

  return fields;
}

// -- Grenades ---------------------------------------------------------------

function grenadeFields(): FieldDescriptor[] {
  const { GRENADES } = CATEGORY;
  return [
    boolean("grenades.enabled", GRENADES, "Carrying", "Enabled", "Off means grenades cannot be thrown, granted or spawned."),
    number("grenades.startingCount", GRENADES, "Carrying", "Starting grenades", "Issued to every player at the start of a match.", { min: 0, max: 20, step: 1, integer: true, mustNotExceed: "grenades.maxCount" }),
    number("grenades.maxCount", GRENADES, "Carrying", "Maximum grenades", "Hard cap on how many a player may carry.", { min: 0, max: 20, step: 1, integer: true, mustBeAtLeast: "grenades.startingCount" }),

    number("grenades.minThrowSpeed", GRENADES, "Throw", "Minimum throw power (px/s)", "Throw speed with no charge at all.", { min: 0, max: 4000, step: 10, mustNotExceed: "grenades.maxThrowSpeed" }),
    number("grenades.maxThrowSpeed", GRENADES, "Throw", "Maximum throw power (px/s)", "Throw speed at a full charge.", { min: 0, max: 4000, step: 10, mustBeAtLeast: "grenades.minThrowSpeed" }),
    number("grenades.maxChargeMs", GRENADES, "Throw", "Maximum charge time (ms)", "How long the button must be held to reach full power. The server measures this itself.", { min: 50, max: 10000, step: 50 }),

    number("grenades.gravity", GRENADES, "Flight", "Gravity", "Downward acceleration on a thrown grenade, px/s².", { min: 0, max: 12000, step: 50 }),
    percentage("grenades.bounciness", GRENADES, "Flight", "Bounce", "Fraction of the impact speed kept when bouncing off geometry."),
    percentage("grenades.friction", GRENADES, "Flight", "Friction", "Fraction of the sliding speed kept on contact. Lower brings a grenade to rest sooner."),
    number("grenades.radius", GRENADES, "Flight", "Collision radius (px)", "How big the grenade is for collision purposes.", { min: 1, max: 60, step: 1 }),
    number("grenades.fuseMs", GRENADES, "Flight", "Fuse duration (ms)", "Time from leaving the hand to detonation.", { min: 100, max: 20000, step: 100 }),

    number("grenades.explosionRadius", GRENADES, "Explosion", "Explosion radius (px)", "Everything within this distance of the blast takes damage.", { min: 10, max: 1500, step: 10 }),
    number("grenades.knockbackForce", GRENADES, "Explosion", "Knockback", "How hard the blast throws whoever it catches, radiating from the centre and falling off like the damage does.", { min: 0, max: 5, step: 0.05 }),
    number("grenades.maxDamage", GRENADES, "Explosion", "Maximum damage", "Damage at the very centre of the blast. The thrower is not exempt.", { min: 0, max: 1000, step: 1 }),
    percentage("grenades.minDamageMultiplier", GRENADES, "Explosion", "Damage falloff floor", "Fraction of the maximum damage still dealt at the edge of the radius."),
  ];
}

// -- Power-ups --------------------------------------------------------------

/** Fields for one power-up. The `type` decides which effect fields appear. */
function powerUpFields(powerUp: PowerUpDefinition): FieldDescriptor[] {
  const { POWERUPS } = CATEGORY;
  const group = powerUp.name || powerUp.id;
  const prefix = `powerUps.${powerUp.id}`;

  const fields: FieldDescriptor[] = [
    text(`${prefix}.name`, POWERUPS, group, "Display name", "Shown in the pickup notification."),
    boolean(`${prefix}.enabled`, POWERUPS, group, "Enabled", "A disabled power-up never spawns but stays in the catalogue."),
    number(`${prefix}.spawnWeight`, POWERUPS, group, "Spawn weight", "Relative likelihood of being chosen as a crate's contents, compared against the other power-ups.", { min: 0, max: 1000, step: 1 }),
  ];

  switch (powerUp.type) {
    case PowerUpType.HEALTH:
      fields.push(percentage(`${prefix}.restoreFraction`, POWERUPS, group, "Health restored", "Fraction of maximum health restored, never exceeding the maximum."));
      break;
    case PowerUpType.SPEED:
      fields.push(
        number(`${prefix}.speedMultiplier`, POWERUPS, group, "Speed multiplier", "Multiplies the top running speed while the effect lasts.", { min: 1, max: 5, step: 0.05 }),
        number(`${prefix}.durationMs`, POWERUPS, group, "Duration (ms)", "How long the effect lasts.", { min: 500, max: 120000, step: 500 }),
      );
      break;
    case PowerUpType.GRENADE:
      fields.push(number(`${prefix}.amount`, POWERUPS, group, "Grenades granted", "How many grenades this pickup hands over, up to the carrying limit.", { min: 1, max: 20, step: 1, integer: true }));
      break;
    case PowerUpType.WEAPON:
      // Which weapon it grants is a genuine choice, so it is a select over the
      // catalogue rather than free text -- an unknown id would make dead crates.
      break;
  }

  return fields;
}

function weaponPowerUpSelect(powerUp: PowerUpDefinition, weapons: readonly WeaponDefinition[]): FieldDescriptor | null {
  if (powerUp.type !== PowerUpType.WEAPON) return null;
  return select(
    `powerUps.${powerUp.id}.weaponId`,
    CATEGORY.POWERUPS,
    powerUp.name || powerUp.id,
    "Weapon granted",
    "Which weapon a player receives on pickup.",
    weapons.map((weapon) => ({ value: weapon.id, label: weapon.name })),
  );
}

// -- Crates, match, arena, traps --------------------------------------------

function crateFields(): FieldDescriptor[] {
  const { CRATES } = CATEGORY;
  return [
    number("crate.health", CRATES, "Crates", "Crate health", "Damage a crate absorbs before it breaks open.", { min: 1, max: 2000, step: 1 }),
    number("crate.width", CRATES, "Crates", "Crate width (px)", "Also its hit box.", { min: 8, max: 300, step: 2 }),
    number("crate.height", CRATES, "Crates", "Crate height (px)", "Also its hit box.", { min: 8, max: 300, step: 2 }),
    number("crate.lifetimeMs", CRATES, "Crates", "Crate lifetime (ms)", "How long an untouched crate stays before it is removed, freeing its spawn point. 0 disables expiry.", { min: 0, max: 600000, step: 1000 }),

    number("powerUpSpawning.intervalMs", CRATES, "Spawning", "Spawn interval (ms)", "Time between crate spawn attempts.", { min: 500, max: 600000, step: 500 }),
    number("powerUpSpawning.firstSpawnDelayMs", CRATES, "Spawning", "First spawn delay (ms)", "Quiet period after the match starts before the first crate appears.", { min: 0, max: 600000, step: 500 }),
    number("powerUpSpawning.warningMs", CRATES, "Spawning", "Landing warning (ms)", "How long the spot is marked before a crate lands there. 0 drops crates with no warning at all.", { min: 0, max: 60000, step: 250 }),
    number("powerUpSpawning.maxActiveCrates", CRATES, "Spawning", "Maximum active crates", "Upper bound on crates present at once, regardless of how many spawn points are free.", { min: 0, max: 64, step: 1, integer: true }),
    number("powerUpSpawning.revealedLifetimeMs", CRATES, "Spawning", "Revealed power-up lifetime (ms)", "How long a revealed power-up waits to be collected before vanishing.", { min: 0, max: 600000, step: 1000 }),
    number("powerUpSpawning.pickupRadius", CRATES, "Spawning", "Pickup radius (px)", "How close a player must come to collect a revealed power-up.", { min: 4, max: 400, step: 1 }),
  ];
}

function matchFields(weapons: readonly WeaponDefinition[]): FieldDescriptor[] {
  const { MATCH } = CATEGORY;
  return [
    select(
      "defaultWeaponId",
      MATCH,
      "Match",
      "Starting weapon",
      "What everybody spawns holding. A select rather than free text: an unknown id would leave a match with nothing to shoot with.",
      weapons.map((weapon) => ({ value: weapon.id, label: weapon.name })),
    ),
    number("match.minPlayers", MATCH, "Match", "Minimum players", "The fewest participants a match may start with, bots included. The room does not wait to be full -- the host starts it.", { min: 2, max: 32, step: 1, integer: true, mustNotExceed: "match.maxPlayers" }),
    number("match.maxPlayers", MATCH, "Match", "Maximum players", "Hard cap on players in one room, people and bots together. A room that reaches it starts by itself. Rooms created afterwards use the new limit.", { min: 2, max: 32, step: 1, integer: true, mustBeAtLeast: "match.minPlayers" }),
    number("match.countdownMs", MATCH, "Match", "Countdown (ms)", "How long the pre-match countdown runs.", { min: 1000, max: 60000, step: 500 }),
    number("match.resultsMs", MATCH, "Match", "Result screen (ms)", "How long the results stay up before the room recycles into a new lobby.", { min: 1000, max: 300000, step: 500 }),
    number("match.maxDurationMs", MATCH, "Match", "Maximum match length (ms)", "Safety valve: a match can never run longer than this.", { min: 30000, max: 3600000, step: 10000 }),
  ];
}

function arenaFields(): FieldDescriptor[] {
  const { ARENA } = CATEGORY;
  return [
    boolean("arenaShrink.enabled", ARENA, "Closing walls", "Enabled", "Off means the arena never shrinks and a stalemate runs to the match time limit."),
    number("arenaShrink.startAfterMs", ARENA, "Closing walls", "Start after (ms)", "Play time before the left and right walls start advancing.", { min: 0, max: 1800000, step: 5000 }),
    number("arenaShrink.speedPerSecond", ARENA, "Closing walls", "Wall speed (px/s)", "How fast each wall advances. Both sides move at once, so the gap closes twice as fast.", { min: 1, max: 1000, step: 1 }),
    number("arenaShrink.minWidth", ARENA, "Closing walls", "Minimum width (px)", "The walls stop once the gap between them reaches this.", { min: 100, max: 4000, step: 20 }),
    number("arenaShrink.crushDamagePerSecond", ARENA, "Closing walls", "Crush damage (per second)", "Damage to a player the walls are pressing against, so a wedged player cannot stall the match.", { min: 0, max: 500, step: 1 }),
  ];
}

function gaugeFields(): FieldDescriptor[] {
  const { GAUGES } = CATEGORY;
  return [
    boolean("gauges.overPlayer", GAUGES, "Health and ammo", "Above every player", "Health and ammunition bars over each player's head, where the fight is. Legible for everybody, not just you."),
    boolean("gauges.inHud", GAUGES, "Health and ammo", "In the corner panel", "The same two gauges in the HUD's bottom-left panel, for the local player only. Off by default -- the bars over the player replace them."),
  ];
}

function minimapFields(): FieldDescriptor[] {
  const { MINIMAP } = CATEGORY;
  return [
    boolean("minimap.enabled", MINIMAP, "Panel", "Enabled", "Off means the panel never appears, whatever the switches below say."),
    boolean("minimap.showPlayers", MINIMAP, "Panel", "Show players", "A dot for every living player within range -- yours in a different colour from everyone else's."),
    boolean("minimap.showPowerUps", MINIMAP, "Panel", "Show power-ups", "A marker for every power-up currently on the ground and within range."),
    number("minimap.radius", MINIMAP, "Panel", "Reveal radius (px)", "How far from the local player (or whoever a spectator is watching) something must be to earn a dot. 0 shows the whole arena regardless of distance.", { min: 0, max: 4000, step: 50 }),
  ];
}

function trapFields(): FieldDescriptor[] {
  const { TRAPS } = CATEGORY;
  return [
    boolean("traps.enabled", TRAPS, "Defaults", "Traps enabled", "Master switch. Off means no trap in any arena ever activates."),
    number("traps.damage", TRAPS, "Defaults", "Damage", "Damage per activation, or per second for a trap that damages continuously. Individual traps may override this.", { min: 0, max: 1000, step: 1 }),
    number("traps.activationDelayMs", TRAPS, "Defaults", "Activation delay (ms)", "Warning period between a trap being triggered and becoming dangerous.", { min: 0, max: 20000, step: 50 }),
    number("traps.activeDurationMs", TRAPS, "Defaults", "Active duration (ms)", "How long a trap stays dangerous. 0 means it never switches off once active.", { min: 0, max: 60000, step: 50 }),
    number("traps.cooldownMs", TRAPS, "Defaults", "Cooldown (ms)", "Rest period after an activation before the trap can trigger again.", { min: 0, max: 120000, step: 50 }),
    number("traps.moveSpeed", TRAPS, "Defaults", "Movement speed (px/s)", "Speed of a trap that moves, such as a crusher or a roaming hazard.", { min: 0, max: 2000, step: 10 }),
    number("traps.triggerRadius", TRAPS, "Defaults", "Trigger radius (px)", "How near a player must come to set off a proximity trap.", { min: 0, max: 1500, step: 5 }),
  ];
}

// -- NPCs -------------------------------------------------------------------

function npcFields(): FieldDescriptor[] {
  const { NPC } = CATEGORY;
  return [
    boolean("npc.enabled", NPC, "Bots", "Bots enabled", "Off means no NPC ever joins a match, whatever the fill target says."),
    number("npc.maxBots", NPC, "Bots", "Maximum bots", "Hard cap on bots in one match.", { min: 0, max: 32, step: 1, integer: true }),
    number("npc.sightRange", NPC, "Bots", "Sight range (px)", "Beyond this a bot simply cannot see an enemy. Raising it makes bots feel omniscient.", { min: 100, max: 4000, step: 50 }),
    number("npc.thinkIntervalMs", NPC, "Thinking", "Decision interval (ms)", "How often a brain re-decides what it wants. Lower is sharper and more expensive.", { min: 30, max: 2000, step: 5 }),
    number("npc.perceptionIntervalMs", NPC, "Thinking", "Perception interval (ms)", "How often a bot refreshes what it can sense.", { min: 30, max: 2000, step: 5 }),

    number("npc.defaultDifficulty", NPC, "Bots", "Default difficulty", "The rung the lobby's \"add bot\" picker starts on, 1 (Very Easy) to 5 (Very Hard).", { min: 1, max: 5, step: 1, integer: true }),
  ];
}

/**
 * Fields for one rung of the difficulty ladder.
 *
 * Generated from the level itself for the same reason profiles are: a sixth rung
 * added to the ladder is tunable without a change here. Almost everything is a
 * multiplier on what the personality asked for -- difficulty scales a profile,
 * it does not replace one.
 */
function botDifficultyFields(level: BotDifficultyLevel): FieldDescriptor[] {
  const { NPC } = CATEGORY;
  const group = `Difficulty ${level.level} - ${level.name}`;
  const prefix = `npc.difficulties.${level.level}`;

  return [
    text(`${prefix}.name`, NPC, group, "Display name", "What this rung is called in the lobby."),

    number(`${prefix}.reactionTimeMultiplier`, NPC, group, "Reaction time x", "Scales the profile's reaction time. Above 1 hesitates longer, i.e. plays worse.", { min: 0.1, max: 6, step: 0.05 }),
    number(`${prefix}.aimSkillMultiplier`, NPC, group, "Aim skill x", "Scales the profile's aim. Even at 1 a bot aims through the same imperfect-aim machinery as every other rung -- there is no perfect aim at any difficulty.", { min: 0, max: 1.5, step: 0.05 }),
    number(`${prefix}.predictionSkillMultiplier`, NPC, group, "Prediction skill x", "Scales how well it leads a moving target.", { min: 0, max: 1.5, step: 0.05 }),
    number(`${prefix}.dodgeSkillMultiplier`, NPC, group, "Dodge skill x", "Scales how well it gets out of the way.", { min: 0, max: 1.5, step: 0.05 }),
    number(`${prefix}.decisionNoiseMultiplier`, NPC, group, "Decision noise x", "Scales the profile's own jitter. Above 1 makes its choices less consistent.", { min: 0, max: 6, step: 0.05 }),
    number(`${prefix}.decisionIntervalMultiplier`, NPC, group, "Decision interval x", "Scales how often it re-decides. Above 1 thinks less often, i.e. reacts to a changing fight more slowly.", { min: 0.2, max: 6, step: 0.05 }),

    number(`${prefix}.damageTakenMultiplier`, NPC, group, "Damage taken x", "How much of a weapon's damage a bot at this rung actually takes. Above 1 makes it softer. Chosen by the bot being hit, never by whoever shot it, and the weapon's own damage is untouched.", { min: 0, max: 10, step: 0.05 }),
    number(`${prefix}.damageDealtMultiplier`, NPC, group, "Damage dealt x", "How much of a weapon's damage a bot at this rung lands on somebody else. Below 1 makes its shots weaker without weakening the weapon.", { min: 0, max: 10, step: 0.05 }),
    number(`${prefix}.environmentalDamageTakenMultiplier`, NPC, group, "Environmental damage x", "The same, for damage with nobody behind it: traps and the closing walls. 1 by default, because those are the deaths a bot should avoid by playing better rather than by being tougher.", { min: 0, max: 10, step: 0.05 }),

    percentage(`${prefix}.grenadeAccuracy`, NPC, group, "Grenade accuracy", "How well it judges a throw. Below 100% it misjudges the angle and the charge."),
    percentage(`${prefix}.navigationSkill`, NPC, group, "Navigation skill", "How well it reads the arena: how far ahead it looks for hazards, how quickly it notices it is stuck."),
    percentage(`${prefix}.targetSelectionSkill`, NPC, group, "Target selection", "How reliably it switches to the enemy actually worth fighting, rather than staying on whoever it was already shooting at."),
  ];
}

/**
 * Fields for one brain profile.
 *
 * Generated from the profile itself, so a personality added to the catalogue is
 * tunable in the admin interface and the debug console without a change here --
 * which is the point of having no `AggressiveNpc` class to edit instead.
 */
function brainProfileFields(profile: BrainProfile): FieldDescriptor[] {
  const { NPC } = CATEGORY;
  const group = profile.name || profile.id;
  const prefix = `npc.profiles.${profile.id}`;

  return [
    text(`${prefix}.name`, NPC, group, "Display name", "Shown on the bot's own label and in the debug console."),

    percentage(`${prefix}.aggression`, NPC, group, "Aggression", "How much it wants to fight at all."),
    percentage(`${prefix}.survival`, NPC, group, "Survival", "How much it values staying alive. Weighs against aggression under fire."),
    percentage(`${prefix}.powerupInterest`, NPC, group, "Power-up interest", "How far it will detour for a crate."),
    percentage(`${prefix}.grenadeUsage`, NPC, group, "Grenade usage", "How readily it reaches for a grenade."),
    percentage(`${prefix}.finishWeakEnemies`, NPC, group, "Finish the wounded", "How strongly a hurt enemy pulls it in."),
    percentage(`${prefix}.chasePersistence`, NPC, group, "Chase persistence", "How long it keeps after something it can no longer see."),
    number(`${prefix}.preferredDistance`, NPC, group, "Preferred distance (px)", "The range it tries to fight at. A shotgun personality wants this small.", { min: 20, max: 2000, step: 10 }),

    percentage(`${prefix}.aimSkill`, NPC, group, "Aim skill", "0 is hopeless, 100% is perfect. Drives aim error, never damage."),
    percentage(`${prefix}.predictionSkill`, NPC, group, "Prediction skill", "How well it leads a moving target."),
    percentage(`${prefix}.dodgeSkill`, NPC, group, "Dodge skill", "How well it gets out of the way of a grenade."),
    number(`${prefix}.reactionTimeMs`, NPC, group, "Reaction time (ms)", "Delay between noticing something and acting on it.", { min: 0, max: 2000, step: 10 }),
    number(`${prefix}.memoryDurationMs`, NPC, group, "Memory (ms)", "How long an enemy stays remembered after leaving sight.", { min: 0, max: 30000, step: 100 }),

    number(`${prefix}.currentActionBonus`, NPC, group, "Commitment bonus", "Added to whatever it is already doing, so it does not flicker between two close options.", { min: 0, max: 100, step: 1 }),
    number(`${prefix}.actionSwitchThreshold`, NPC, group, "Switch threshold", "How much better an alternative must score before it changes its mind.", { min: 0, max: 100, step: 1 }),
    number(`${prefix}.minimumActionMs`, NPC, group, "Minimum action time (ms)", "How long an action runs before it may be replaced at all.", { min: 0, max: 10000, step: 50 }),
    number(`${prefix}.decisionNoise`, NPC, group, "Decision noise", "Random spread added to every score. Small on purpose: it should add hesitation, not stupidity.", { min: 0, max: 40, step: 1 }),
  ];
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Build the complete field list for a configuration.
 *
 * Generated from `config` rather than hand-listed, which is the whole point: add
 * a weapon or a power-up to the catalogue and its fields appear in the admin
 * interface and the debug console without either of them changing.
 *
 * `baseline` supplies each field's default -- the value "reset to default"
 * restores. It is the configuration the server ships with (plus any deployment
 * seed), never the currently-edited one.
 */
export function buildConfigFields(config: GameConfig, baseline: GameConfig = config): ConfigFieldDefinition[] {
  const descriptors: FieldDescriptor[] = [
    ...playerFields(),
    ...matchFields(config.weapons),
    ...config.weapons.flatMap(weaponFields),
    ...grenadeFields(),
    ...config.powerUps.flatMap((powerUp) => {
      const fields = powerUpFields(powerUp);
      const weaponChoice = weaponPowerUpSelect(powerUp, config.weapons);
      return weaponChoice ? [...fields, weaponChoice] : fields;
    }),
    ...crateFields(),
    ...arenaFields(),
    ...minimapFields(),
    ...gaugeFields(),
    ...trapFields(),
    ...npcFields(),
    ...config.npc.difficulties.flatMap(botDifficultyFields),
    ...config.npc.profiles.flatMap(brainProfileFields),
  ];

  return descriptors.flatMap((descriptor) => {
    // A descriptor whose value is missing from both configurations describes
    // something that is not there -- a falloff block that was removed, say. Drop
    // it rather than presenting a control that writes into nothing.
    const defaultValue = readConfigValue(baseline, descriptor.key) ?? readConfigValue(config, descriptor.key);
    if (defaultValue === undefined) return [];
    return [{ ...descriptor, defaultValue }];
  });
}

/**
 * The set of configurable values, indexed for lookup.
 *
 * Also the write whitelist: a key that is not a field cannot be written, which is
 * what stops a caller from reaching arbitrary parts of the configuration object
 * through a crafted dotted path.
 */
export class ConfigRegistry {
  private readonly byKey: Map<string, ConfigFieldDefinition>;
  private readonly fields: ConfigFieldDefinition[];

  constructor(config: GameConfig, baseline: GameConfig = config) {
    this.fields = buildConfigFields(config, baseline);
    this.byKey = new Map(this.fields.map((field) => [field.key, field]));
  }

  list(): readonly ConfigFieldDefinition[] {
    return this.fields;
  }

  get(key: string): ConfigFieldDefinition | null {
    return this.byKey.get(key) ?? null;
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /** Every category, in the order the fields declare them. */
  categories(): string[] {
    return unique(this.fields.map((field) => field.category));
  }

  /** Subcategories within one category, in declaration order. */
  subcategories(category: string): string[] {
    return unique(
      this.fields.filter((field) => field.category === category).map((field) => field.subcategory),
    );
  }

  /** Keys belonging to a category, optionally narrowed to one subcategory. */
  keysIn(category: string, subcategory?: string): string[] {
    return this.fields
      .filter(
        (field) =>
          field.category === category &&
          (subcategory === undefined || field.subcategory === subcategory),
      )
      .map((field) => field.key);
  }

  read(config: GameConfig, key: string): ConfigValue | undefined {
    return this.has(key) ? readConfigValue(config, key) : undefined;
  }

  /**
   * Write a value that has already been validated.
   *
   * Returns false for an unknown key, a non-editable field, or a path that no
   * longer resolves -- never throws, because a stale key from an interface that
   * was open while the catalogue changed is a miss, not an error.
   */
  write(config: GameConfig, key: string, value: ConfigValue): boolean {
    const field = this.byKey.get(key);
    if (!field || !field.editable) return false;
    return writeConfigValue(config, key, value);
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
