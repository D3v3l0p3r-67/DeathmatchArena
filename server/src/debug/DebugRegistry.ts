import {
  ConfigRegistry,
  applyChange,
  readConfigValue,
  type ConfigFieldDefinition,
  type DebugCommandSpec,
  type DebugConfigEntry,
  type DebugParamSpec,
  type GameConfig,
  type GameConfigView,
} from "@deathmatch/shared";
import type { RoomContext } from "../rooms/RoomContext.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";
import type { MatchManager } from "../systems/MatchManager.js";
import type { GrenadeSystem } from "../systems/GrenadeSystem.js";
import type { PowerUpSystem } from "../systems/PowerUpSystem.js";
import type { TrapSystem } from "../systems/TrapSystem.js";
import type { NpcSystem } from "../npc/NpcSystem.js";
import type { WeaponSystem } from "../systems/WeaponSystem.js";

/** Everything a debug command is allowed to reach. */
export interface DebugCommandContext {
  room: RoomContext;
  weapons: WeaponSystem;
  powerUps: PowerUpSystem;
  grenades: GrenadeSystem;
  traps: TrapSystem;
  npcs: NpcSystem;
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

/**
 * The values a debug operator may change, and the limits they are held to.
 *
 * Built from the shared configuration metadata rather than a list of its own, so
 * the debug console and the admin interface always offer exactly the same set of
 * parameters with exactly the same ranges. Adding a weapon adds its fields to
 * both at once, and neither can drift from the other.
 *
 * It is also the write whitelist: a key that is not a field cannot be written,
 * which is what stops a caller reaching arbitrary parts of the configuration
 * object through a crafted dotted path.
 */
function tunablesFor(context: DebugCommandContext): ConfigRegistry {
  return new ConfigRegistry(context.config.config, context.room.baselineConfig);
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
    const tunables = tunablesFor(context)
      .list()
      .filter((field) => field.editable)
      .map((field) => ({
        value: field.key,
        // Qualified, because two categories both have a "Damage" and a bare label
        // in a flat dropdown would be a coin toss.
        label: `${field.category} / ${field.subcategory} / ${field.label}`,
      }));
    const maxHealth = context.config.getPlayerConfig().maxHealth;
    const profiles = context.config
      .listBrainProfiles()
      .map((profile) => ({ value: profile.id, label: profile.name }));
    const bots = [
      { value: "", label: "Nobody" },
      ...context.npcs.list().map((agent) => ({
        value: agent.sessionId,
        label: `${context.room.state.players.get(agent.sessionId)?.name ?? agent.sessionId} (${agent.brainProfile.name})`,
      })),
    ];

    return Array.from(this.commands.values()).map((command) => ({
      ...command.spec,
      params: command.spec.params.map((param) => {
        if (param.key === "target") return { ...param, options: targets, defaultValue: TARGET_SELF };
        if (param.key === "weaponId") return { ...param, options: weapons };
        if (param.key === "powerUpId") return { ...param, options: powerUps };
        if (param.key === "path") return { ...param, options: tunables };
        if (param.key === "profileId") return { ...param, options: profiles };
        if (param.key === "npcId") return { ...param, options: bots };
        // The health limit follows the room's configuration rather than a
        // constant, so a room with a raised maximum can actually be set to it.
        if (param.key === "value" && command.spec.id === "set-health") {
          return { ...param, max: maxHealth, defaultValue: maxHealth };
        }
        return param;
      }),
    }));
  }

  /**
   * Current values of every room-scoped tunable, flagged where overridden.
   *
   * "Overridden" here means *this room* differs from what the server is
   * configured to use -- not from what the game ships with. An administrator's
   * saved change is the server's value, so it must not show up in a debug console
   * as a room override.
   */
  describeConfig(context: DebugCommandContext, baseline: GameConfig): DebugConfigEntry[] {
    const config = context.config.config;

    return tunablesFor(context)
      .list()
      .flatMap((field) => {
        const value = readConfigValue(config, field.key);
        if (value === undefined) return [];

        const serverValue = readConfigValue(baseline, field.key);
        return [describeField(field, value, serverValue !== undefined && serverValue !== value)];
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
            // The range is filled in per room by `describeCommands`, because the
            // maximum is configurable.
            { key: "value", label: "Health", type: "number", min: 1, step: 1 },
          ],
        },
        run: (context, args) => {
          const value = clampNumber(Number(args.value), 1, context.config.getPlayerConfig().maxHealth);
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
          id: "add-npc",
          label: "Add bot",
          description: "Drop an NPC into this room. It plays through the same input queue a browser does.",
          category: "Bots",
          params: [
            {
              key: "profileId",
              label: "Personality",
              type: "select",
              options: [],
              hint: "Blank picks one at random",
            },
            { key: "count", label: "How many", type: "number", min: 1, max: 8, step: 1, defaultValue: 1 },
          ],
        },
        run: (context, args) => {
          const requested = String(args.profileId ?? "").trim();
          const count = clampNumber(Number(args.count), 1, 8);

          let added = 0;
          for (let i = 0; i < count; i++) {
            if (context.npcs.spawn(requested || undefined)) added += 1;
          }

          return added > 0
            ? { ok: true, message: `Added ${added} bot(s)`, refreshState: true }
            : { ok: false, message: "No room for another bot" };
        },
      },

      {
        spec: {
          id: "remove-npc",
          label: "Remove bots",
          description: "Take one bot out, or all of them.",
          category: "Bots",
          params: [{ key: "npcId", label: "Bot", type: "select", options: [], hint: "Blank removes every bot" }],
        },
        run: (context, args) => {
          const requested = String(args.npcId ?? "").trim();
          if (!requested) {
            const removed = context.npcs.count;
            context.npcs.removeAll();
            return { ok: true, message: `Removed ${removed} bot(s)`, refreshState: true };
          }

          return context.npcs.remove(requested)
            ? { ok: true, message: "Bot removed", refreshState: true }
            : { ok: false, message: "No such bot" };
        },
      },

      {
        spec: {
          id: "watch-npc",
          label: "Watch bot",
          description: "Log one bot's decisions. Logging is off for everyone else, and off entirely by default.",
          category: "Bots",
          params: [{ key: "npcId", label: "Bot", type: "select", options: [], hint: "Blank stops logging" }],
        },
        run: (context, args) => {
          const requested = String(args.npcId ?? "").trim();
          if (requested && !context.npcs.get(requested)) {
            return { ok: false, message: "No such bot" };
          }

          context.npcs.setLoggingFor(requested || null);
          return {
            ok: true,
            message: requested ? "Logging this bot's decisions" : "Decision logging off",
            refreshState: true,
          };
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
            // Carried as text and coerced by the validator, so one command can
            // set a number, a switch or a choice without three variants of it.
            { key: "value", label: "Value", type: "string" },
          ],
        },
        run: (context, args) => {
          const key = String(args.path ?? "");
          const registry = tunablesFor(context);
          const field = registry.get(key);
          if (!field) return { ok: false, message: `Unknown parameter "${key}"` };

          // The same validator the admin interface uses, so a debug operator is
          // held to exactly the same ranges and dependencies -- one path in,
          // one set of rules.
          const outcome = applyChange(registry, context.config.config, key, args.value);
          if (!outcome.ok) {
            return { ok: false, message: outcome.issues[0]?.message ?? "Rejected" };
          }

          context.replaceConfig(outcome.config);
          const applied = readConfigValue(outcome.config, key);
          return {
            ok: true,
            message: `${field.label} = ${String(applied)} (this room only)`,
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

/** Turn a configuration field into the entry the console renders. */
function describeField(
  field: ConfigFieldDefinition,
  value: DebugConfigEntry["value"],
  overridden: boolean,
): DebugConfigEntry {
  return {
    path: field.key,
    label: field.label,
    category: field.category,
    subcategory: field.subcategory,
    value,
    overridden,
    editable: field.editable,
    min: field.min,
    max: field.max,
    step: field.step,
    options: field.options,
  };
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
