import {
  ServerMessage,
  type DebugNpcPayload,
  type DebugNpcSnapshot,
  type DebugAuthRequest,
  type DebugParamSpec,
  type DebugCommandRequest,
  type DebugCommandResult,
  type DebugStatePayload,
  type GameConfig,
} from "@deathmatch/shared";
import type { RoomContext } from "../rooms/RoomContext.js";
import type { DebugAuthorizationService } from "./DebugAuthorizationService.js";
import type { DebugArgs, DebugCommandContext, DebugRegistry } from "./DebugRegistry.js";

/**
 * The entry point for every debug interaction, and the place authorization is
 * enforced.
 *
 * The rule this class exists to guarantee: **nothing debug-related happens for a
 * session that is not authorized**. Both public entry points check
 * `canUseDebug` before doing anything else, so a client that fabricates
 * `debugCommand` messages by hand gets the same refusal as one that never asked.
 * Hiding the console on the client is a convenience, never a control.
 *
 * The service also owns argument validation: parameters arrive as untrusted
 * values and are coerced against the command's own spec before a handler runs.
 */
export class DebugCommandService {
  constructor(
    private readonly context: RoomContext,
    private readonly authorization: DebugAuthorizationService,
    private readonly registry: DebugRegistry,
    /** Builds the per-call command context; the room owns the systems. */
    private readonly commandContextFor: (callerId: string) => DebugCommandContext,
    /** The server's unmodified configuration, for the "overridden" flags. */
    private readonly baseline: () => GameConfig,
  ) {}

  /**
   * Handle an access request and reply with the outcome.
   *
   * A refusal carries no command catalogue and no configuration, so an
   * unauthorized client cannot even learn what commands exist.
   */
  handleAuthRequest(sessionId: string, playerName: string, payload: unknown): void {
    const request = (payload ?? {}) as DebugAuthRequest;
    const token = typeof request.token === "string" ? request.token : undefined;

    const decision = this.authorization.authorize({ sessionId, playerName, token });

    if (!decision.granted) {
      this.sendState(sessionId, { granted: false, reason: decision.reason });
      return;
    }

    this.sendState(sessionId, { granted: true, reason: decision.reason });
  }

  /**
   * Execute one command on behalf of a session.
   *
   * Every path out of here is guarded: unauthorized callers are refused before
   * the command id is even looked up.
   */
  handleCommand(sessionId: string, payload: unknown): void {
    if (!this.authorization.canUseDebug(sessionId)) {
      this.context.logger.warn("Rejected debug command from unauthorized session", { sessionId });
      // Tell the client it has no access rather than staying silent, so a
      // legitimate console whose grant lapsed can close itself.
      this.sendState(sessionId, { granted: false, reason: "Debug access denied" });
      return;
    }

    const request = (payload ?? {}) as DebugCommandRequest;
    const commandId = typeof request.commandId === "string" ? request.commandId : "";
    const command = this.registry.get(commandId);
    if (!command) {
      this.sendResult(sessionId, { commandId, ok: false, message: "Unknown command" });
      return;
    }

    const commandContext = this.commandContextFor(sessionId);
    const args = this.validateArgs(command.spec.params, request.params);

    let outcome;
    try {
      outcome = command.run(commandContext, args);
    } catch (error) {
      // A broken debug command must never take the room down with it.
      this.context.logger.error("Debug command threw", {
        commandId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.sendResult(sessionId, { commandId, ok: false, message: "Command failed" });
      return;
    }

    this.context.logger.info("Debug command executed", {
      sessionId,
      commandId,
      ok: outcome.ok,
      message: outcome.message,
    });

    this.sendResult(sessionId, { commandId, ok: outcome.ok, message: outcome.message });

    // Config changes alter what the console displays, so push a fresh snapshot.
    if (outcome.refreshState) this.sendState(sessionId, { granted: true, reason: "" });
  }

  /**
   * Stream what the bots are thinking to whoever is watching.
   *
   * Pushed on a timer rather than bundled into the state snapshot: scores change
   * several times a second and the catalogue does not, so sending them together
   * would mean re-sending the whole command list at the same rate.
   *
   * Costs nothing when nobody is authorized -- the caller checks first.
   */
  sendNpcState(snapshot: () => DebugNpcSnapshot[]): void {
    let payload: DebugNpcPayload | null = null;

    for (const sessionId of this.context.state.players.keys()) {
      if (!this.authorization.canUseDebug(sessionId)) continue;
      // Built once, on the first authorized session, and only if there is one.
      payload ??= { npcs: snapshot() };
      this.context.sendTo(sessionId, ServerMessage.DEBUG_NPC, payload);
    }
  }

  /** True when at least one session could receive debug traffic. */
  get hasAudience(): boolean {
    for (const sessionId of this.context.state.players.keys()) {
      if (this.authorization.canUseDebug(sessionId)) return true;
    }
    return false;
  }

  /** Re-send state to every authorized session. Used after a room-wide change. */
  refreshAll(): void {
    for (const sessionId of this.context.state.players.keys()) {
      if (this.authorization.canUseDebug(sessionId)) {
        this.sendState(sessionId, { granted: true, reason: "" });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Coerce untrusted params against the command's own spec.
   *
   * Anything absent, malformed or out of range becomes the spec's default rather
   * than reaching a handler. Keys the command did not declare are dropped, so a
   * caller cannot smuggle extra arguments into a handler.
   */
  private validateArgs(params: readonly DebugParamSpec[], raw: unknown): DebugArgs {
    const source = (raw ?? {}) as Record<string, unknown>;
    const args: DebugArgs = {};

    for (const param of params) {
      const value = source[param.key];

      switch (param.type) {
        case "number": {
          const numeric = Number(value);
          const fallback = Number(param.defaultValue ?? 0);
          const resolved = Number.isFinite(numeric) ? numeric : fallback;
          args[param.key] = clamp(resolved, param.min, param.max);
          break;
        }
        case "boolean":
          args[param.key] = value === true || value === "true" || value === 1;
          break;
        default: {
          // Strings and selects are carried as text and resolved by the handler
          // against the catalogue, so an unknown id is rejected there.
          //
          // A number or a boolean is stringified rather than refused: a console
          // that sends 42 for a text parameter plainly means "42", and a caller
          // should not have to know which of the two a parameter happens to be.
          // Anything that is not a primitive is not a value and falls back.
          const primitive =
            typeof value === "string" || typeof value === "number" || typeof value === "boolean";
          args[param.key] = primitive ? String(value) : String(param.defaultValue ?? "");
          break;
        }
      }
    }

    return args;
  }

  private sendState(sessionId: string, base: { granted: boolean; reason: string }): void {
    const payload: DebugStatePayload = {
      granted: base.granted,
      reason: base.reason,
      commands: [],
      config: [],
      roomId: this.context.roomId,
    };

    if (base.granted) {
      const commandContext = this.commandContextFor(sessionId);
      payload.commands = this.registry.describeCommands(commandContext);
      payload.config = this.registry.describeConfig(commandContext, this.baseline());
    }

    this.context.sendTo(sessionId, ServerMessage.DEBUG_STATE, payload);
  }

  private sendResult(sessionId: string, result: DebugCommandResult): void {
    this.context.sendTo(sessionId, ServerMessage.DEBUG_RESULT, result);
  }
}

function clamp(value: number, min?: number, max?: number): number {
  let result = value;
  if (min !== undefined) result = Math.max(min, result);
  if (max !== undefined) result = Math.min(max, result);
  return result;
}
