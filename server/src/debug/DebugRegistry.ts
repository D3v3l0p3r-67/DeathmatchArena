import {
  PLAYER,
  PowerUpType,
  type DebugCommandSpec,
  type DebugConfigEntry,
  type DebugParamSpec,
  type GameConfig,
  type GameConfigView,
  type PowerUpDefinition,
  type WeaponDefinition,
} from "@deathmatch/shared";
import type { RoomContext } from "../rooms/RoomContext.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";
import type { MatchManager } from "../systems/MatchManager.js";
import type { GrenadeSystem } from "../systems/GrenadeSystem.js";
import type { PowerUpSystem } from "../systems/PowerUpSystem.js";
import type { WeaponSystem } from "../systems/WeaponSystem.js";

/** Everything a debug command is allowed to reach. */
export interface DebugCommandContext {
  room: RoomContext;
  weapons: WeaponSystem;
  powerUps: PowerUpSystem;
  grenades: GrenadeSystem;
  matchManager: MatchManager;
  /** The room's current configuration view. */
  config: GameConfigView;
  /**
   * Replace this room's configuration.
   *
   * Room-scoped by construction: it swaps one room's view and never touches the
   * process-wide config, so tuning one match cannot disturb another.
   */
  replaceConfig(config: GameConfig): void;
  /** Session that issued the command, already verified as authorized. */
  callerId: string;
}

export interface DebugCommandOutcome {
  ok: boolean;
  message: string;
  /** True when the command changed something the console displays. */
  refreshState?: boolean;
}

/** A command's validated arguments. Values are already range-checked. */
export type DebugArgs = Record<string, number | boolean | string>;

export interface DebugCommand {
  spec: DebugCommandSpec;
  run(context: DebugCommandContext, args: DebugArgs): DebugCommandOutcome;
}

// ---------------------------------------------------------------------------
// Room-scoped tunables
// ---------------------------------------------------------------------------

/** One value the console may read and change, plus how to reach it. */
interface Tunable {
  path: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  read(config: GameConfig): number | boolean | string | undefined;
  write(config: GameConfig, value: number | boolean | string): void;
}

function weaponBy(config: GameConfig, id: string): WeaponDefinition | undefined {
  return config.weapons.find((weapon) => weapon.id === id);
}

function powerUpBy(config: GameConfig, id: string): PowerUpDefinition | undefined {
  return config.powerUps.find((powerUp) => powerUp.id === id);
}

/**
 * Build the tunable list from the configuration itself.
 *
 * Generated rather than hand-listed, so a weapon or power-up added through
 * configuration becomes tunable with no change here. It doubles as the write
 * whitelist: a path that is not in this list cannot be set, which is what stops
 * a caller from poking at arbitrary parts of the config object.
 */
function buildTunables(config: GameConfig): Tunable[] {
  const tunables: Tunable[] = [
    {
      path: "powerUpSpawning.intervalMs",
      label: "Crate spawn interval (ms)",
      min: 500,
      max: 120000,
      step: 500,
      read: (c) => c.powerUpSpawning.intervalMs,
      write: (c, v) => void (c.powerUpSpawning.intervalMs = Number(v)),
    },
    {
      path: "powerUpSpawning.firstSpawnDelayMs",
      label: "First crate delay (ms)",
      min: 0,
      max: 120000,
      step: 500,
      read: (c) => c.powerUpSpawning.firstSpawnDelayMs,
      write: (c, v) => void (c.powerUpSpawning.firstSpawnDelayMs = Number(v)),
    },
    {
      path: "powerUpSpawning.maxActiveCrates",
      label: "Max active crates",
      min: 0,
      max: 32,
      step: 1,
      read: (c) => c.powerUpSpawning.maxActiveCrates,
      write: (c, v) => void (c.powerUpSpawning.maxActiveCrates = Math.round(Number(v))),
    },
    {
      path: "powerUpSpawning.pickupRadius",
      label: "Pickup radius (px)",
      min: 8,
      max: 200,
      step: 1,
      read: (c) => c.powerUpSpawning.pickupRadius,
      write: (c, v) => void (c.powerUpSpawning.pickupRadius = Number(v)),
    },
    {
      path: "powerUpSpawning.revealedLifetimeMs",
      label: "Revealed power-up lifetime (ms)",
      min: 0,
      max: 300000,
      step: 1000,
      read: (c) => c.powerUpSpawning.revealedLifetimeMs,
      write: (c, v) => void (c.powerUpSpawning.revealedLifetimeMs = Number(v)),
    },
    {
      path: "crate.health",
      label: "Crate health",
      min: 1,
      max: 1000,
      step: 1,
      read: (c) => c.crate.health,
      write: (c, v) => void (c.crate.health = Math.round(Number(v))),
    },
    {
      path: "grenades.enabled",
      label: "Grenades: enabled",
      read: (c) => c.grenades.enabled,
      write: (c, v) => void (c.grenades.enabled = Boolean(v)),
    },
    {
      path: "grenades.startingCount",
      label: "Grenades: starting count",
      min: 0,
      max: 20,
      step: 1,
      read: (c) => c.grenades.startingCount,
      write: (c, v) => void (c.grenades.startingCount = Math.round(Number(v))),
    },
    {
      path: "grenades.maxCount",
      label: "Grenades: carrying limit",
      min: 1,
      max: 20,
      step: 1,
      read: (c) => c.grenades.maxCount,
      write: (c, v) => void (c.grenades.maxCount = Math.round(Number(v))),
    },
    {
      path: "grenades.minThrowSpeed",
      label: "Grenades: min throw (px/s)",
      min: 50,
      max: 3000,
      step: 10,
      read: (c) => c.grenades.minThrowSpeed,
      write: (c, v) => void (c.grenades.minThrowSpeed = Number(v)),
    },
    {
      path: "grenades.maxThrowSpeed",
      label: "Grenades: max throw (px/s)",
      min: 50,
      max: 4000,
      step: 10,
      read: (c) => c.grenades.maxThrowSpeed,
      write: (c, v) => void (c.grenades.maxThrowSpeed = Number(v)),
    },
    {
      path: "grenades.maxChargeMs",
      label: "Grenades: max charge (ms)",
      min: 50,
      max: 10000,
      step: 50,
      read: (c) => c.grenades.maxChargeMs,
      write: (c, v) => void (c.grenades.maxChargeMs = Number(v)),
    },
    {
      path: "grenades.gravity",
      label: "Grenades: gravity (px/s2)",
      min: 0,
      max: 8000,
      step: 50,
      read: (c) => c.grenades.gravity,
      write: (c, v) => void (c.grenades.gravity = Number(v)),
    },
    {
      path: "grenades.bounciness",
      label: "Grenades: bounciness",
      min: 0,
      max: 1,
      step: 0.02,
      read: (c) => c.grenades.bounciness,
      write: (c, v) => void (c.grenades.bounciness = Number(v)),
    },
    {
      path: "grenades.friction",
      label: "Grenades: friction",
      min: 0,
      max: 1,
      step: 0.02,
      read: (c) => c.grenades.friction,
      write: (c, v) => void (c.grenades.friction = Number(v)),
    },
    {
      path: "grenades.fuseMs",
      label: "Grenades: fuse (ms)",
      min: 100,
      max: 20000,
      step: 100,
      read: (c) => c.grenades.fuseMs,
      write: (c, v) => void (c.grenades.fuseMs = Number(v)),
    },
    {
      path: "grenades.explosionRadius",
      label: "Grenades: blast radius (px)",
      min: 10,
      max: 1200,
      step: 5,
      read: (c) => c.grenades.explosionRadius,
      write: (c, v) => void (c.grenades.explosionRadius = Number(v)),
    },
    {
      path: "grenades.maxDamage",
      label: "Grenades: max damage",
      min: 0,
      max: 500,
      step: 1,
      read: (c) => c.grenades.maxDamage,
      write: (c, v) => void (c.grenades.maxDamage = Number(v)),
    },
    {
      path: "grenades.minDamageMultiplier",
      label: "Grenades: damage at edge",
      min: 0,
      max: 1,
      step: 0.02,
      read: (c) => c.grenades.minDamageMultiplier,
      write: (c, v) => void (c.grenades.minDamageMultiplier = Number(v)),
    },
    {
      path: "arenaShrink.enabled",
      label: "Arena shrink: enabled",
      read: (c) => c.arenaShrink.enabled,
      write: (c, v) => void (c.arenaShrink.enabled = Boolean(v)),
    },
    {
      path: "arenaShrink.startAfterMs",
      label: "Arena shrink: starts after (ms)",
      min: 0,
      max: 1800000,
      step: 1000,
      read: (c) => c.arenaShrink.startAfterMs,
      write: (c, v) => void (c.arenaShrink.startAfterMs = Number(v)),
    },
    {
      path: "arenaShrink.speedPerSecond",
      label: "Arena shrink: wall speed (px/s)",
      min: 0,
      max: 500,
      step: 1,
      read: (c) => c.arenaShrink.speedPerSecond,
      write: (c, v) => void (c.arenaShrink.speedPerSecond = Number(v)),
    },
    {
      path: "arenaShrink.minWidth",
      label: "Arena shrink: minimum width (px)",
      min: 100,
      max: 4000,
      step: 10,
      read: (c) => c.arenaShrink.minWidth,
      write: (c, v) => void (c.arenaShrink.minWidth = Number(v)),
    },
    {
      path: "arenaShrink.crushDamagePerSecond",
      label: "Arena shrink: crush damage/s",
      min: 0,
      max: 200,
      step: 1,
      read: (c) => c.arenaShrink.crushDamagePerSecond,
      write: (c, v) => void (c.arenaShrink.crushDamagePerSecond = Number(v)),
    },
    {
      path: "crate.lifetimeMs",
      label: "Crate lifetime (ms)",
      min: 0,
      max: 600000,
      step: 1000,
      read: (c) => c.crate.lifetimeMs,
      write: (c, v) => void (c.crate.lifetimeMs = Number(v)),
    },
  ];

  for (const weapon of config.weapons) {
    const id = weapon.id;
    const prefix = `weapons.${id}`;
    const name = weapon.name;

    tunables.push(
      {
        path: `${prefix}.enabled`,
        label: `${name}: enabled`,
        read: (c) => weaponBy(c, id)?.enabled,
        write: (c, v) => {
          const target = weaponBy(c, id);
          if (target) target.enabled = Boolean(v);
        },
      },
      {
        path: `${prefix}.damage`,
        label: `${name}: damage`,
        min: 0,
        max: 500,
        step: 1,
        read: (c) => weaponBy(c, id)?.damage,
        write: (c, v) => {
          const target = weaponBy(c, id);
          if (target) target.damage = Number(v);
        },
      },
      {
        path: `${prefix}.range`,
        label: `${name}: range (px)`,
        min: 1,
        max: 4000,
        step: 1,
        read: (c) => weaponBy(c, id)?.range,
        write: (c, v) => {
          const target = weaponBy(c, id);
          if (target) target.range = Number(v);
        },
      },
      {
        path: `${prefix}.fireRate`,
        label: `${name}: fire rate (rpm)`,
        min: 0,
        max: 2000,
        step: 5,
        read: (c) => weaponBy(c, id)?.fireRate,
        write: (c, v) => {
          const target = weaponBy(c, id);
          if (target) target.fireRate = Number(v);
        },
      },
      {
        path: `${prefix}.magazineSize`,
        label: `${name}: magazine`,
        min: 0,
        max: 500,
        step: 1,
        read: (c) => weaponBy(c, id)?.magazineSize,
        write: (c, v) => {
          const target = weaponBy(c, id);
          if (target) target.magazineSize = Math.round(Number(v));
        },
      },
      {
        path: `${prefix}.reloadTime`,
        label: `${name}: reload (ms)`,
        min: 0,
        max: 20000,
        step: 100,
        read: (c) => weaponBy(c, id)?.reloadTime,
        write: (c, v) => {
          const target = weaponBy(c, id);
          if (target) target.reloadTime = Number(v);
        },
      },
    );

    if (weapon.ranged) {
      tunables.push(
        {
          path: `${prefix}.ranged.pellets`,
          label: `${name}: pellets`,
          min: 1,
          max: 64,
          step: 1,
          read: (c) => weaponBy(c, id)?.ranged?.pellets,
          write: (c, v) => {
            const target = weaponBy(c, id);
            if (target?.ranged) target.ranged.pellets = Math.round(Number(v));
          },
        },
        {
          path: `${prefix}.ranged.spread`,
          label: `${name}: spread (rad)`,
          min: 0,
          max: 1.5,
          step: 0.005,
          read: (c) => weaponBy(c, id)?.ranged?.spread,
          write: (c, v) => {
            const target = weaponBy(c, id);
            if (target?.ranged) target.ranged.spread = Number(v);
          },
        },
        {
          path: `${prefix}.ranged.bulletSpeed`,
          label: `${name}: bullet speed (px/s)`,
          min: 100,
          max: 20000,
          step: 50,
          read: (c) => weaponBy(c, id)?.ranged?.bulletSpeed,
          write: (c, v) => {
            const target = weaponBy(c, id);
            if (target?.ranged) target.ranged.bulletSpeed = Number(v);
          },
        },
      );
    }

    if (weapon.melee) {
      tunables.push(
        {
          path: `${prefix}.melee.attackIntervalMs`,
          label: `${name}: attack interval (ms)`,
          min: 20,
          max: 5000,
          step: 10,
          read: (c) => weaponBy(c, id)?.melee?.attackIntervalMs,
          write: (c, v) => {
            const target = weaponBy(c, id);
            if (target?.melee) target.melee.attackIntervalMs = Number(v);
          },
        },
        {
          path: `${prefix}.melee.arcDegrees`,
          label: `${name}: arc (degrees)`,
          min: 5,
          max: 360,
          step: 5,
          read: (c) => weaponBy(c, id)?.melee?.arcDegrees,
          write: (c, v) => {
            const target = weaponBy(c, id);
            if (target?.melee) target.melee.arcDegrees = Number(v);
          },
        },
      );
    }
  }

  for (const powerUp of config.powerUps) {
    const id = powerUp.id;
    const prefix = `powerUps.${id}`;
    const name = powerUp.name;

    tunables.push(
      {
        path: `${prefix}.enabled`,
        label: `${name}: enabled`,
        read: (c) => powerUpBy(c, id)?.enabled,
        write: (c, v) => {
          const target = powerUpBy(c, id);
          if (target) target.enabled = Boolean(v);
        },
      },
      {
        path: `${prefix}.spawnWeight`,
        label: `${name}: spawn weight`,
        min: 0,
        max: 1000,
        step: 1,
        read: (c) => powerUpBy(c, id)?.spawnWeight,
        write: (c, v) => {
          const target = powerUpBy(c, id);
          if (target) target.spawnWeight = Number(v);
        },
      },
    );

    if (powerUp.type === PowerUpType.HEALTH) {
      tunables.push({
        path: `${prefix}.restoreFraction`,
        label: `${name}: restore fraction`,
        min: 0,
        max: 1,
        step: 0.05,
        read: (c) => {
          const target = powerUpBy(c, id);
          return target?.type === PowerUpType.HEALTH ? target.restoreFraction : undefined;
        },
        write: (c, v) => {
          const target = powerUpBy(c, id);
          if (target?.type === PowerUpType.HEALTH) target.restoreFraction = Number(v);
        },
      });
    }

    if (powerUp.type === PowerUpType.GRENADE) {
      tunables.push({
        path: `${prefix}.amount`,
        label: `${name}: grenades granted`,
        min: 1,
        max: 20,
        step: 1,
        read: (c) => {
          const target = powerUpBy(c, id);
          return target?.type === PowerUpType.GRENADE ? target.amount : undefined;
        },
        write: (c, v) => {
          const target = powerUpBy(c, id);
          if (target?.type === PowerUpType.GRENADE) target.amount = Math.round(Number(v));
        },
      });
    }

    if (powerUp.type === PowerUpType.SPEED) {
      tunables.push(
        {
          path: `${prefix}.speedMultiplier`,
          label: `${name}: speed multiplier`,
          min: 1,
          max: 6,
          step: 0.05,
          read: (c) => {
            const target = powerUpBy(c, id);
            return target?.type === PowerUpType.SPEED ? target.speedMultiplier : undefined;
          },
          write: (c, v) => {
            const target = powerUpBy(c, id);
            if (target?.type === PowerUpType.SPEED) target.speedMultiplier = Number(v);
          },
        },
        {
          path: `${prefix}.durationMs`,
          label: `${name}: duration (ms)`,
          min: 0,
          max: 300000,
          step: 500,
          read: (c) => {
            const target = powerUpBy(c, id);
            return target?.type === PowerUpType.SPEED ? target.durationMs : undefined;
          },
          write: (c, v) => {
            const target = powerUpBy(c, id);
            if (target?.type === PowerUpType.SPEED) target.durationMs = Number(v);
          },
        },
      );
    }
  }

  return tunables;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const TARGET_SELF = "@self";
const TARGET_ALL = "@all";

/**
 * The catalogue of debug commands and tunables.
 *
 * It holds *descriptions* and *handlers*; it enforces nothing. Authorization is
 * `DebugAuthorizationService`'s job and dispatch is `DebugCommandService`'s, so
 * this stays a plain registry that is easy to extend.
 */
export class DebugRegistry {
  private readonly commands = new Map<string, DebugCommand>();

  constructor() {
    for (const command of this.buildCommands()) {
      this.commands.set(command.spec.id, command);
    }
  }

  get(commandId: string): DebugCommand | null {
    return this.commands.get(commandId) ?? null;
  }

  /**
   * Command specs for the console, with option lists resolved against the room
   * as it is right now (which players exist, which weapons the room allows).
   */
  describeCommands(context: DebugCommandContext): DebugCommandSpec[] {
    const targets = this.targetOptions(context);
    const weapons = context.config
      .listWeapons()
      .map((weapon) => ({ value: weapon.id, label: `${weapon.name}${weapon.enabled ? "" : " (disabled)"}` }));
    const powerUps = context.config
      .listPowerUps()
      .map((powerUp) => ({ value: powerUp.id, label: powerUp.name }));
    const tunables = buildTunables(context.config.config).map((tunable) => ({
      value: tunable.path,
      label: tunable.label,
    }));

    return Array.from(this.commands.values()).map((command) => ({
      ...command.spec,
      params: command.spec.params.map((param) => {
        if (param.key === "target") return { ...param, options: targets, defaultValue: TARGET_SELF };
        if (param.key === "weaponId") return { ...param, options: weapons };
        if (param.key === "powerUpId") return { ...param, options: powerUps };
        if (param.key === "path") return { ...param, options: tunables };
        return param;
      }),
    }));
  }

  /** Current values of every room-scoped tunable, flagged where overridden. */
  describeConfig(context: DebugCommandContext, baseline: GameConfig): DebugConfigEntry[] {
    const config = context.config.config;

    return buildTunables(config).flatMap((tunable) => {
      const value = tunable.read(config);
      if (value === undefined) return [];

      const baseValue = tunable.read(baseline);
      return [
        {
          path: tunable.path,
          label: tunable.label,
          value,
          overridden: baseValue !== undefined && baseValue !== value,
          min: tunable.min,
          max: tunable.max,
          step: tunable.step,
        },
      ];
    });
  }

  private targetOptions(context: DebugCommandContext): { value: string; label: string }[] {
    const options = [
      { value: TARGET_SELF, label: "Me" },
      { value: TARGET_ALL, label: "Everyone" },
    ];
    for (const player of context.room.state.players.values()) {
      options.push({ value: player.sessionId, label: player.name });
    }
    return options;
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  private buildCommands(): DebugCommand[] {
    const targetParam: DebugParamSpec = {
      key: "target",
      label: "Target",
      type: "select",
      options: [],
      hint: "Who the command applies to",
    };

    return [
      {
        spec: {
          id: "grant-weapon",
          label: "Grant weapon",
          description: "Equip a weapon immediately, magazine full.",
          category: "Loadout",
          params: [targetParam, { key: "weaponId", label: "Weapon", type: "select", options: [] }],
        },
        run: (context, args) => {
          const weaponId = String(args.weaponId ?? "");
          const weapon = context.config.getWeapon(weaponId);
          const targets = resolveTargets(context, args.target);
          if (targets.length === 0) return { ok: false, message: "No matching player" };

          for (const player of targets) {
            const runtime = context.room.runtimes.get(player.sessionId);
            if (runtime) context.weapons.equip(player, runtime, weapon.id);
          }
          return {
            ok: true,
            message: `Granted ${weapon.name} to ${describeTargets(targets)}`,
          };
        },
      },

      {
        spec: {
          id: "grant-powerup",
          label: "Grant power-up",
          description: "Apply a power-up's effect directly, skipping the crate.",
          category: "Loadout",
          params: [targetParam, { key: "powerUpId", label: "Power-up", type: "select", options: [] }],
        },
        run: (context, args) => {
          const definition = context.config.getPowerUp(String(args.powerUpId ?? ""));
          if (!definition) return { ok: false, message: "Unknown power-up" };

          const targets = resolveTargets(context, args.target);
          if (targets.length === 0) return { ok: false, message: "No matching player" };

          let applied = 0;
          for (const player of targets) {
            const runtime = context.room.runtimes.get(player.sessionId);
            if (!runtime) continue;
            // Reuse the real applier, so debug grants behave exactly like pickups.
            if (context.powerUps.applyPowerUp(definition, player, runtime, context.room.now())) {
              applied += 1;
            }
          }
          return applied > 0
            ? { ok: true, message: `Applied ${definition.name} to ${applied} player(s)` }
            : { ok: false, message: `${definition.name} had no effect on the target` };
        },
      },

      {
        spec: {
          id: "grant-grenades",
          label: "Grant grenades",
          description: "Top a player up to the carrying limit.",
          category: "Loadout",
          params: [
            targetParam,
            { key: "amount", label: "Amount", type: "number", min: 1, max: 20, step: 1, defaultValue: 1 },
          ],
        },
        run: (context, args) => {
          const amount = Math.max(1, Math.round(Number(args.amount)));
          const targets = resolveTargets(context, args.target);
          if (targets.length === 0) return { ok: false, message: "No matching player" };

          let granted = 0;
          for (const player of targets) {
            if (context.grenades.grant(player, amount)) granted += 1;
          }
          return granted > 0
            ? { ok: true, message: `Gave grenades to ${granted} player(s)` }
            : { ok: false, message: "Everyone targeted is already carrying the maximum" };
        },
      },

      {
        spec: {
          id: "set-health",
          label: "Set health",
          description: "Force a player's health. Does not trigger an elimination.",
          category: "Player",
          params: [
            targetParam,
            {
              key: "value",
              label: "Health",
              type: "number",
              min: 1,
              max: PLAYER.MAX_HEALTH,
              step: 1,
              defaultValue: PLAYER.MAX_HEALTH,
            },
          ],
        },
        run: (context, args) => {
          const value = clampNumber(Number(args.value), 1, PLAYER.MAX_HEALTH);
          const targets = resolveTargets(context, args.target);
          if (targets.length === 0) return { ok: false, message: "No matching player" };

          for (const player of targets) player.health = value;
          return { ok: true, message: `Set health to ${value} for ${describeTargets(targets)}` };
        },
      },

      {
        spec: {
          id: "kill-player",
          label: "Eliminate",
          description: "Eliminate a player through the normal match path.",
          category: "Player",
          params: [targetParam],
        },
        run: (context, args) => {
          const targets = resolveTargets(context, args.target).filter((player) => player.alive);
          if (targets.length === 0) return { ok: false, message: "No living target" };

          for (const player of targets) {
            context.matchManager.eliminate(player, null, player.weaponId);
          }
          return { ok: true, message: `Eliminated ${describeTargets(targets)}` };
        },
      },

      {
        spec: {
          id: "spawn-crate",
          label: "Spawn crate",
          description: "Drop a crate on a free spawn point, optionally with chosen contents.",
          category: "World",
          params: [
            {
              key: "powerUpId",
              label: "Contents",
              type: "select",
              options: [],
              hint: "Random (weighted)",
            },
          ],
        },
        run: (context, args) => {
          const requested = String(args.powerUpId ?? "").trim();
          const definition = requested ? context.config.getPowerUp(requested) : null;
          if (requested && !definition) return { ok: false, message: "Unknown power-up" };

          const spawned = context.powerUps.debugSpawnCrate(definition, context.room.now());
          return spawned
            ? { ok: true, message: `Spawned a crate containing ${spawned}` }
            : { ok: false, message: "No free power-up spawn point" };
        },
      },

      {
        spec: {
          id: "clear-crates",
          label: "Clear crates",
          description: "Remove every crate and uncollected power-up from the arena.",
          category: "World",
          params: [],
        },
        run: (context) => {
          const removed = context.powerUps.activeCrateCount + context.powerUps.activePickupCount;
          context.powerUps.clear();
          return { ok: true, message: `Removed ${removed} entities` };
        },
      },

      {
        spec: {
          id: "set-config",
          label: "Set parameter",
          description: "Change a tuning value for this room only. Never saved.",
          category: "Configuration",
          params: [
            { key: "path", label: "Parameter", type: "select", options: [] },
            { key: "value", label: "Value", type: "number", step: 1 },
          ],
        },
        run: (context, args) => {
          const path = String(args.path ?? "");
          const next = applyTunable(context.config.config, path, args.value);
          if (!next) return { ok: false, message: `Unknown parameter "${path}"` };

          context.replaceConfig(next.config);
          return {
            ok: true,
            message: `${next.label} = ${next.value} (this room only)`,
            refreshState: true,
          };
        },
      },

      {
        spec: {
          id: "reset-config",
          label: "Reset parameters",
          description: "Drop this room's overrides and return to the server's values.",
          category: "Configuration",
          params: [],
        },
        run: (context) => {
          context.replaceConfig(context.room.baselineConfig);
          return { ok: true, message: "Room configuration reset", refreshState: true };
        },
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Apply one tunable to a copy of the config.
 *
 * Returns null when the path is not a known tunable — the write whitelist. The
 * original config is never mutated: a room's configuration is swapped whole.
 */
function applyTunable(
  config: GameConfig,
  path: string,
  rawValue: unknown,
): { config: GameConfig; label: string; value: number | boolean | string } | null {
  const next = structuredClone(config);
  const tunable = buildTunables(next).find((candidate) => candidate.path === path);
  if (!tunable) return null;

  const currentValue = tunable.read(next);
  let value: number | boolean | string;

  if (typeof currentValue === "boolean") {
    value = rawValue === true || rawValue === "true" || rawValue === 1;
  } else {
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) return null;
    value = clampNumber(numeric, tunable.min ?? -Infinity, tunable.max ?? Infinity);
  }

  tunable.write(next, value);
  return { config: next, label: tunable.label, value };
}

function resolveTargets(context: DebugCommandContext, rawTarget: unknown): PlayerState[] {
  const target = String(rawTarget ?? TARGET_SELF);
  const players = context.room.state.players;

  if (target === TARGET_ALL) return Array.from(players.values());
  if (target === TARGET_SELF) {
    const self = players.get(context.callerId);
    return self ? [self] : [];
  }

  const named = players.get(target);
  return named ? [named] : [];
}

function describeTargets(targets: readonly PlayerState[]): string {
  if (targets.length === 1) return targets[0]!.name;
  return `${targets.length} players`;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min === -Infinity ? 0 : min;
  return Math.min(max, Math.max(min, value));
}
