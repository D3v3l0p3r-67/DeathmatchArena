/**
 * Trap types, and the registry that holds them.
 *
 * The point of this file is that the *server has no trap-specific code*. A trap
 * type is a description: how its body moves, how it meters damage, what it looks
 * like, and which extra parameters it takes. `TrapSystem` reads those and
 * simulates them generically, so adding a new hazard is a registration here
 * rather than a branch in the simulation.
 *
 * The six that ship are the ones the design called for -- spikes, fire, moving
 * hazards, falling objects, electric zones and crushers -- and between them they
 * exercise every motion and damage mode, which is the real test of whether the
 * generic model holds.
 */
import { ConfigFieldType, type ConfigFieldOption, type ConfigFieldTypeValue } from "../config/schema.js";
import type { ConfigValue } from "../config/types.js";
import { TrapActivation, type TrapActivationValue, type TrapDefinition } from "./types.js";

/**
 * How a trap's body moves.
 *
 * The simulation turns each of these into an offset from the placed position, so
 * collision, rendering and damage all work off one rectangle regardless of type.
 */
export const TrapMotion = {
  /** Never moves. Spikes, fire, electric zones. */
  STATIC: "static",
  /** Slides back and forth continuously, whatever the activation state. Saws. */
  PATROL: "patrol",
  /** Drives out at a constant speed while active, withdraws while cooling down. Crushers. */
  SLAM: "slam",
  /** Accelerates away under gravity while active, resets while cooling down. Falling objects. */
  DROP: "drop",
} as const;

export type TrapMotionValue = (typeof TrapMotion)[keyof typeof TrapMotion];

/**
 * How damage is metered.
 *
 * `continuous` treats the configured damage as a rate per second, which is what
 * a fire or an electric field wants. `on-enter` applies it once per contact and
 * re-arms when the player leaves, which is what a spike or a crusher wants --
 * standing on spikes should not be instantly fatal.
 */
export const TrapDamageMode = {
  CONTINUOUS: "continuous",
  ON_ENTER: "on-enter",
  /**
   * Throws whoever touches it instead of hurting them.
   *
   * A trap that helps is still a trap: same placement, same activation modes,
   * same everything -- it simply answers "what does contact do to you" with a
   * push rather than with damage. Putting it here rather than inventing a second
   * kind of arena object is what keeps one system in charge of contact.
   */
  LAUNCH: "launch",
} as const;

export type TrapDamageModeValue = (typeof TrapDamageMode)[keyof typeof TrapDamageMode];

/** One type-specific parameter, described so an editor can render a control for it. */
export interface TrapParamDefinition {
  key: string;
  label: string;
  type: ConfigFieldTypeValue;
  defaultValue: ConfigValue;
  min?: number;
  max?: number;
  step?: number;
  options?: ConfigFieldOption[];
  description: string;
}

/** Everything the simulation and the editor need to know about a kind of trap. */
export interface TrapTypeDefinition {
  id: string;
  label: string;
  description: string;
  motion: TrapMotionValue;
  damageMode: TrapDamageModeValue;
  /** Size a freshly placed trap of this type gets. */
  defaultSize: { width: number; height: number };
  /** Tint used by the editor and the game renderer. */
  color: number;
  /** Activation mode a freshly placed trap gets. Any mode may be chosen later. */
  defaultActivation: TrapActivationValue;
  /**
   * Overrides a freshly placed trap carries, on top of the global trap defaults.
   * Only what genuinely differs for this type -- everything else stays inherited,
   * so retuning traps globally still reaches it.
   */
  defaultOverrides?: Partial<Pick<TrapDefinition, "damage" | "activationDelayMs" | "activeDurationMs" | "cooldownMs" | "moveSpeed" | "triggerRadius">>;
  params: TrapParamDefinition[];
}

const DIRECTIONS: ConfigFieldOption[] = [
  { value: "down", label: "Down" },
  { value: "up", label: "Up" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
];

/** Shared by every trap that travels: which way, and how far. */
function travelParams(defaultDirection: string, defaultTravel: number): TrapParamDefinition[] {
  return [
    {
      key: "direction",
      label: "Direction",
      type: ConfigFieldType.SELECT,
      defaultValue: defaultDirection,
      options: DIRECTIONS,
      description: "Which way the trap travels from where it is placed.",
    },
    {
      key: "travel",
      label: "Travel distance (px)",
      type: ConfigFieldType.NUMBER,
      defaultValue: defaultTravel,
      min: 0,
      max: 2000,
      step: 10,
      description: "How far it moves before stopping or turning back.",
    },
  ];
}

/** The trap types the game ships with. */
export const BUILT_IN_TRAP_TYPES: readonly TrapTypeDefinition[] = Object.freeze([
  {
    id: "spikes",
    label: "Spikes",
    description: "A permanently dangerous strip. Hurts once each time a player touches it.",
    motion: TrapMotion.STATIC,
    damageMode: TrapDamageMode.ON_ENTER,
    defaultSize: { width: 120, height: 24 },
    color: 0xb0bec5,
    defaultActivation: TrapActivation.ALWAYS,
    defaultOverrides: { damage: 30, activationDelayMs: 0 },
    params: [],
  },
  {
    id: "fire",
    label: "Fire vent",
    description: "Erupts on a cycle, burning anyone standing in it while it is lit.",
    motion: TrapMotion.STATIC,
    damageMode: TrapDamageMode.CONTINUOUS,
    defaultSize: { width: 90, height: 140 },
    color: 0xff7043,
    defaultActivation: TrapActivation.PERIODIC,
    defaultOverrides: { damage: 45, activationDelayMs: 600, activeDurationMs: 1400, cooldownMs: 2400 },
    params: [],
  },
  {
    id: "electric",
    label: "Electric zone",
    description: "A field that switches on and off, shocking anyone inside it.",
    motion: TrapMotion.STATIC,
    damageMode: TrapDamageMode.CONTINUOUS,
    defaultSize: { width: 200, height: 200 },
    color: 0x64b5f6,
    defaultActivation: TrapActivation.PERIODIC,
    defaultOverrides: { damage: 32, activationDelayMs: 500, activeDurationMs: 2000, cooldownMs: 3000 },
    params: [],
  },
  {
    id: "jump-pad",
    label: "Jump pad",
    description: "Throws whoever steps on it upwards. Hurts nobody -- it is a route, not a hazard.",
    motion: TrapMotion.STATIC,
    damageMode: TrapDamageMode.LAUNCH,
    defaultSize: { width: 110, height: 20 },
    color: 0x4ade80,
    defaultActivation: TrapActivation.ALWAYS,
    // No damage at all: the launch is the whole effect.
    defaultOverrides: { damage: 0, activationDelayMs: 0 },
    params: [
      {
        key: "force",
        label: "Launch force",
        type: ConfigFieldType.NUMBER,
        defaultValue: 2.6,
        min: 0.2,
        max: 6,
        step: 0.1,
        description:
          "How hard it throws, in knockback impulses. Around 2.6 is a little higher than a jump; the player's knockback limit still caps it.",
      },
    ],
  },
  {
    id: "saw",
    label: "Moving hazard",
    description: "Runs back and forth along its path and hurts anything it touches.",
    motion: TrapMotion.PATROL,
    damageMode: TrapDamageMode.ON_ENTER,
    defaultSize: { width: 56, height: 56 },
    color: 0xef5350,
    defaultActivation: TrapActivation.ALWAYS,
    defaultOverrides: { damage: 35, activationDelayMs: 0, moveSpeed: 190 },
    params: travelParams("right", 320),
  },
  {
    id: "crusher",
    label: "Crusher",
    description: "Drives out when a player comes near, then withdraws and resets.",
    motion: TrapMotion.SLAM,
    damageMode: TrapDamageMode.ON_ENTER,
    defaultSize: { width: 140, height: 90 },
    color: 0x8d6e63,
    defaultActivation: TrapActivation.PROXIMITY,
    defaultOverrides: { damage: 60, activationDelayMs: 500, activeDurationMs: 900, cooldownMs: 2600, moveSpeed: 700 },
    params: travelParams("down", 260),
  },
  {
    id: "falling-object",
    label: "Falling object",
    description: "Hangs overhead until someone walks under it, then drops.",
    motion: TrapMotion.DROP,
    damageMode: TrapDamageMode.ON_ENTER,
    defaultSize: { width: 90, height: 90 },
    color: 0x9575cd,
    defaultActivation: TrapActivation.PROXIMITY,
    defaultOverrides: { damage: 70, activationDelayMs: 350, activeDurationMs: 1600, cooldownMs: 4000 },
    params: [
      ...travelParams("down", 520),
      {
        key: "fallGravity",
        label: "Fall acceleration (px/s²)",
        type: ConfigFieldType.NUMBER,
        defaultValue: 2400,
        min: 100,
        max: 12000,
        step: 100,
        description: "How hard it accelerates once it lets go.",
      },
    ],
  },
]);

/**
 * The catalogue of trap types.
 *
 * A registry rather than a constant so a deployment can add its own types
 * without editing this file -- register at boot, and the admin editor lists it,
 * the validator accepts it and the simulation runs it.
 */
export class TrapRegistry {
  private readonly byId = new Map<string, TrapTypeDefinition>();

  constructor(types: readonly TrapTypeDefinition[] = BUILT_IN_TRAP_TYPES) {
    for (const type of types) this.register(type);
  }

  register(type: TrapTypeDefinition): void {
    this.byId.set(type.id, type);
  }

  get(typeId: string): TrapTypeDefinition | null {
    return this.byId.get(typeId) ?? null;
  }

  has(typeId: string): boolean {
    return this.byId.has(typeId);
  }

  list(): readonly TrapTypeDefinition[] {
    return Array.from(this.byId.values());
  }

  /**
   * A trap of `typeId`, placed at (x, y), with this type's defaults filled in.
   *
   * Everything the type does not have an opinion about is left `null` so it keeps
   * inheriting the global trap configuration.
   */
  createTrap(typeId: string, id: string, x: number, y: number): TrapDefinition | null {
    const type = this.get(typeId);
    if (!type) return null;

    const params: Record<string, ConfigValue> = {};
    for (const param of type.params) params[param.key] = param.defaultValue;

    return {
      id,
      type: type.id,
      x,
      y,
      width: type.defaultSize.width,
      height: type.defaultSize.height,
      enabled: true,
      activation: type.defaultActivation,
      damage: type.defaultOverrides?.damage ?? null,
      activationDelayMs: type.defaultOverrides?.activationDelayMs ?? null,
      activeDurationMs: type.defaultOverrides?.activeDurationMs ?? null,
      cooldownMs: type.defaultOverrides?.cooldownMs ?? null,
      moveSpeed: type.defaultOverrides?.moveSpeed ?? null,
      triggerRadius: type.defaultOverrides?.triggerRadius ?? null,
      params,
    };
  }
}

/** The process-wide catalogue. Deployments may register additional types on it. */
export const trapRegistry = new TrapRegistry();

/** A unit vector for a direction param, defaulting to straight down. */
export function directionVector(direction: unknown): { x: number; y: number } {
  switch (direction) {
    case "up":
      return { x: 0, y: -1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
    default:
      return { x: 0, y: 1 };
  }
}

/**
 * One trap's effective settings, with every inherited value filled in.
 *
 * Placement overrides beat the game-wide trap defaults, and `null` means "not
 * overridden". Resolving in one place keeps the rule in one place: the
 * simulation, the editor preview and the validator all agree on what a trap
 * actually does.
 */
export interface ResolvedTrap {
  definition: TrapDefinition;
  type: TrapTypeDefinition;
  damage: number;
  activationDelayMs: number;
  activeDurationMs: number;
  cooldownMs: number;
  moveSpeed: number;
  triggerRadius: number;
}

/** The trap defaults a placement inherits from. */
export interface TrapDefaults {
  damage: number;
  activationDelayMs: number;
  activeDurationMs: number;
  cooldownMs: number;
  moveSpeed: number;
  triggerRadius: number;
}

export function resolveTrap(
  trap: TrapDefinition,
  defaults: TrapDefaults,
  registry: TrapRegistry = trapRegistry,
): ResolvedTrap | null {
  const type = registry.get(trap.type);
  if (!type) return null;

  return {
    definition: trap,
    type,
    damage: trap.damage ?? defaults.damage,
    activationDelayMs: trap.activationDelayMs ?? defaults.activationDelayMs,
    activeDurationMs: trap.activeDurationMs ?? defaults.activeDurationMs,
    cooldownMs: trap.cooldownMs ?? defaults.cooldownMs,
    moveSpeed: trap.moveSpeed ?? defaults.moveSpeed,
    triggerRadius: trap.triggerRadius ?? defaults.triggerRadius,
  };
}

/** Read a numeric type parameter, falling back to the type's declared default. */
export function trapParamNumber(resolved: ResolvedTrap, key: string, fallback = 0): number {
  const value = resolved.definition.params?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const declared = resolved.type.params.find((param) => param.key === key)?.defaultValue;
  return typeof declared === "number" ? declared : fallback;
}

/** Read a string type parameter, falling back to the type's declared default. */
export function trapParamString(resolved: ResolvedTrap, key: string, fallback = ""): string {
  const value = resolved.definition.params?.[key];
  if (typeof value === "string") return value;
  const declared = resolved.type.params.find((param) => param.key === key)?.defaultValue;
  return typeof declared === "string" ? declared : fallback;
}
