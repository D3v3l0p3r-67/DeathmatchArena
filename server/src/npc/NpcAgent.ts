import {
  PLAYER,
  applyBotDifficulty,
  createInputCommand,
  type BotDifficultyLevel,
  type BrainProfile,
  type InputCommand,
} from "@deathmatch/shared";
import type { RoomContext } from "../rooms/RoomContext.js";
import { throwAngleFor, throwClearance, throwSpeedFor } from "./throwArc.js";
import { Brain, deriveEffectiveProfile, type ScoreEntry } from "./Brain.js";
import { CombatController, type CombatOutput } from "./CombatController.js";
import { Memory } from "./Memory.js";
import { MovementController } from "./MovementController.js";
import { Perception } from "./Perception.js";
import { TargetSelector } from "./TargetSelector.js";
import { getNavGraph } from "./Navigation.js";
import type { BrainContext, PerceivedEnemy } from "./context.js";

/** What the combat controller should be doing until the brain says otherwise. */
type CombatMode =
  | { kind: "idle" }
  | { kind: "engage"; targetId: string }
  | { kind: "track"; targetId: string }
  | { kind: "look"; x: number; y: number }
  | { kind: "shoot"; x: number; y: number; radius: number }
  | { kind: "throw"; x: number; y: number };

/** One line of the decision log. */
export interface DecisionLogEntry {
  at: number;
  message: string;
}

const LOG_LIMIT = 40;
/** How much daylight a throw needs beyond its own blast, in px. */
const SELF_LOB_MARGIN = 40;

/**
 * One NPC.
 *
 * The composition root for a single bot: it owns the parts, runs them at the
 * right rates, and turns the result into exactly one `InputCommand` per
 * simulation tick -- the same thing a human client sends, through the same queue,
 * against the same budget. Nothing here reaches into the simulation.
 *
 * The layering the design asks for is enforced by what each part is handed. The
 * brain gets a context and returns an intent; it has no reference to the movement
 * or combat controllers and could not move the bot if it wanted to. The
 * controllers get the intent and the context; they have no idea why they were
 * asked. Only this class knows both, and all it does is wire them together.
 */
export class NpcAgent {
  readonly memory = new Memory();
  readonly brain: Brain;
  readonly movement: MovementController;
  readonly combat: CombatController;
  readonly targets = new TargetSelector();

  /** The state machine label of whatever the current action is doing. */
  private actionState = "";
  private combatMode: CombatMode = { kind: "idle" };

  private context: BrainContext | null = null;
  private effective: BrainProfile;
  /** Who this bot currently cares about. Chosen before any action scores. */
  private chosenTarget: PerceivedEnemy | null = null;

  private nextThinkAt = 0;
  private nextPerceiveAt = 0;
  private sequence = 0;

  private readonly log: DecisionLogEntry[] = [];
  private logging = false;

  /** Scratch input, reused so a bot allocates nothing per tick. */
  private readonly input: InputCommand = createInputCommand();

  constructor(
    private readonly room: RoomContext,
    readonly sessionId: string,
    /** Fallback, used when the id no longer resolves. See `resolveProfile`. */
    private profile: BrainProfile,
    private readonly perception: Perception,
    /** Shared with the brain, so one bot's choices stay reproducible. */
    readonly random: () => number,
    /** Spread the first think across the interval so bots do not pulse together. */
    startOffsetMs: number,
    /**
     * Which rung of the difficulty ladder this bot plays at.
     *
     * Held as a number and resolved against the configuration on every thought,
     * so retuning a rung in the admin interface reaches the bots already playing.
     */
    private difficultyLevel: number,
  ) {
    this.brain = new Brain(random);
    this.effective = profile;

    const graph = getNavGraph(room.arena, room.world, room.config.getPlayerConfig());
    this.movement = new MovementController(graph, room.world);
    this.combat = new CombatController(random);

    this.nextThinkAt = startOffsetMs;
    this.nextPerceiveAt = startOffsetMs;
  }

  // -------------------------------------------------------------------------
  // Identity and debug
  // -------------------------------------------------------------------------

  get brainProfile(): BrainProfile {
    return this.profile;
  }

  /** The rung this bot plays at. Personality is `brainProfile`; this is skill. */
  get difficulty(): BotDifficultyLevel {
    return this.room.config.getBotDifficulty(this.difficultyLevel);
  }

  setDifficulty(level: number): void {
    this.difficultyLevel = level;
  }

  /** The room changed arena: forget the old one's geometry and memories. */
  onArenaChanged(): void {
    this.movement.retarget(
      getNavGraph(this.room.arena, this.room.world, this.room.config.getPlayerConfig()),
      this.room.world,
    );
    this.memory.clear();
    this.context = null;
  }

  get profileId(): string {
    return this.profile.id;
  }

  /**
   * Re-read the personality from the room's configuration.
   *
   * Called on every decision rather than held from spawn, so that turning
   * aggression down in the debug console or the admin interface changes how this
   * bot plays on its very next thought -- which is the only way tuning a
   * personality against a live match is bearable.
   */
  private resolveProfile(): BrainProfile {
    const base = this.room.config.getBrainProfile(this.profile.id) ?? this.profile;
    // Personality first, then skill. The profile says what this bot wants; the
    // difficulty says how well it manages any of it, and multiplying the two is
    // what gives five skill levels for every personality without a second
    // profile ever being written.
    return applyBotDifficulty(base, this.difficulty);
  }

  /** The profile after the situation has bent it. What actually scores. */
  get effectiveProfile(): BrainProfile {
    return this.effective;
  }

  setProfile(profile: BrainProfile): void {
    this.profile = profile;
    this.effective = profile;
  }

  get state(): string {
    return this.actionState;
  }

  get lastContext(): BrainContext | null {
    return this.context;
  }

  /**
   * The enemy this bot has settled on.
   *
   * Chosen by the target selector before any action is scored, so every action
   * reasons about the same enemy -- which is what stops "attack" going after the
   * nearest one while "throw grenade" aims at another.
   */
  get target(): PerceivedEnemy | null {
    return this.chosenTarget;
  }

  get scores(): readonly ScoreEntry[] {
    return this.brain.scores;
  }

  get decisionLog(): readonly DecisionLogEntry[] {
    return this.log;
  }

  setLogging(enabled: boolean): void {
    this.logging = enabled;
    if (!enabled) this.log.length = 0;
  }

  /**
   * Record a decision.
   *
   * Off unless somebody is watching: a dozen bots logging every state change at
   * eight hertz is a lot of string building for nobody to read.
   */
  note(message: string, now: number): void {
    if (!this.logging) return;
    this.log.push({ at: now, message });
    if (this.log.length > LOG_LIMIT) this.log.shift();
  }

  // -------------------------------------------------------------------------
  // What an action is allowed to command
  // -------------------------------------------------------------------------

  setState(state: string): void {
    this.actionState = state;
  }

  /**
   * Would a grenade thrown at this spot actually get away from us?
   *
   * The action decides whether a grenade is the right idea; this answers the
   * one question it cannot see from the context -- whether the ledge overhead
   * or the crate in front would send it straight back. Kept on the agent
   * because it needs the arena, and actions deliberately never touch the room.
   */
  canLobAt(x: number, y: number): boolean {
    const context = this.context;
    if (!context) return false;

    const config = this.room.config.getGrenadeConfig();
    const dx = x - context.self.x;
    const dy = y - context.self.y;
    const clearance = throwClearance(
      this.room.world,
      config,
      context.self.x,
      context.self.y,
      throwAngleFor(dx, dy),
      throwSpeedFor(Math.hypot(dx, dy), config),
    );

    // Anything that lands inside our own blast is a grenade thrown at our feet.
    return clearance > config.explosionRadius + SELF_LOB_MARGIN;
  }

  moveTo(x: number, y: number): void {
    if (!this.context) return;
    this.movement.setGoal(x, y, this.context.self, this.context.now);
  }

  stopMoving(): void {
    this.movement.clearGoal();
    this.movement.stop();
  }

  /** Shoot at them. */
  engage(target: PerceivedEnemy): void {
    this.combatMode = { kind: "engage", targetId: target.sessionId };
  }

  /** Follow them with the gun, but hold fire. */
  trackTarget(target: PerceivedEnemy): void {
    this.combatMode = { kind: "track", targetId: target.sessionId };
  }

  /**
   * Is there a clear line to this spot?
   *
   * The same question `shootable` answers for a person, for the things that
   * are not people. Crates sit on platforms, bots stand under them, and a bot
   * that did not ask emptied magazine after magazine into the underside of the
   * platform: nine thousand trigger pulls across thirty matches opened seven
   * crates.
   */
  canShootAt(x: number, y: number): boolean {
    const context = this.context;
    if (!context) return false;

    const fromX = context.self.x;
    const fromY = context.self.y + PLAYER.AIM_ORIGIN_Y;
    const hit = this.room.world.raycast(fromX, fromY, x, y);
    if (!hit) return true;

    const blocked = Math.hypot(hit.x - fromX, hit.y - fromY);
    return blocked >= Math.hypot(x - fromX, y - fromY) - 1;
  }

  /** Shoot at something that is not a person -- a crate worth opening. */
  shootAt(x: number, y: number, radius: number): void {
    this.combatMode = { kind: "shoot", x, y, radius };
  }

  /** Point somewhere, e.g. where an enemy was last seen. */
  lookAt(x: number, y: number): void {
    this.combatMode = { kind: "look", x, y };
  }

  throwAt(x: number, y: number): void {
    this.combatMode = { kind: "throw", x, y };
  }

  holdFire(): void {
    if (this.combatMode.kind === "throw") this.combat.cancelThrow();
    this.combatMode = { kind: "idle" };
  }

  /** Look up a perceived enemy by id, or null when it is no longer perceived. */
  findEnemy(sessionId: string | null): PerceivedEnemy | null {
    if (!sessionId || !this.context) return null;
    return this.context.enemies.find((enemy) => enemy.sessionId === sessionId) ?? null;
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  /**
   * Advance one simulation tick.
   *
   * Perception and deciding run on their own clocks; steering, aiming and firing
   * run every tick, because those are the parts that have to look smooth.
   */
  update(dt: number, now: number): InputCommand | null {
    const player = this.room.state.players.get(this.sessionId);
    const runtime = this.room.runtimes.get(this.sessionId);
    if (!player || !runtime) return null;

    if (!player.alive || !player.inMatch) {
      this.rest();
      return null;
    }

    if (now >= this.nextPerceiveAt) {
      const interval = Math.max(20, this.room.config.getNpcConfig().perceptionIntervalMs);
      this.nextPerceiveAt = now + interval;
      this.context = this.perception.build(player, runtime, this.memory, this.profile, now);
    }

    const context = this.context;
    if (!context) return null;
    // Keep the clock fresh between perception passes so reaction timing and
    // aim slew stay honest at tick rate.
    context.now = now;
    // And the body with it. What a bot knows about *others* is deliberately a
    // few frames old; where its own feet are is not something anybody has to
    // perceive, and steering a jump by a stale snapshot is how a climb turns
    // into a hop. See `Perception.refreshSelf`.
    this.perception.refreshSelf(context.self, player, runtime);

    if (now >= this.nextThinkAt) {
      // A poorer bot reconsiders less often, so a fight that turns against it
      // takes longer to register. Same brain, running slower.
      const base = Math.max(20, this.room.config.getNpcConfig().thinkIntervalMs);
      this.nextThinkAt = now + base * Math.max(0.1, this.difficulty.decisionIntervalMultiplier);
      this.think(context, now);
    }

    // Only the live ones: a dormant trap is scenery, and steering round it would
    // make bots look nervous rather than careful.
    this.movement.steer(context.self, now, context.traps);
    const combat = this.resolveCombat(context, dt);
    return this.buildInput(combat);
  }

  /** Score, choose, and let the winner run. */
  private think(context: BrainContext, now: number): void {
    this.profile = this.resolveProfile();
    // Re-applied every thought rather than at spawn, so a difficulty retuned in
    // the admin interface reaches a bot already in a match.
    this.movement.setNavigationSkill(this.difficulty.navigationSkill);
    // What is still playable, which the closing walls narrow as a match runs on.
    this.movement.setPlayableBounds(this.room.state.shrinkLeft, this.room.state.shrinkRight);
    this.combat.setGrenadeAccuracy(this.difficulty.grenadeAccuracy);
    this.effective = deriveEffectiveProfile(this.profile, context);

    // Who before what: every action then reasons about the same enemy.
    const sightRange = this.room.config.getNpcConfig().sightRange;
    const previousTarget = this.chosenTarget?.sessionId ?? null;
    this.chosenTarget = this.targets.pick(context, this.effective, sightRange, {
      skill: this.difficulty.targetSelectionSkill,
      random: this.random,
      currentId: previousTarget,
    });
    // Both sides normalised: `undefined !== null` is true, and comparing the two
    // directly logged "target → none" on every single thought.
    const currentTarget = this.chosenTarget?.sessionId ?? null;
    if (this.logging && currentTarget !== previousTarget) {
      this.note(`target → ${this.chosenTarget?.name ?? "none"}`, now);
    }

    const previous = this.brain.currentAction?.id ?? null;
    const decision = this.brain.decide(context, this.effective, this, now);
    if (!decision.action) return;

    if (decision.switched && this.logging) {
      const score = decision.scores.find((entry) => entry.id === decision.action.id)?.score ?? 0;
      this.note(
        previous
          ? `${previous} → ${decision.action.id} (${score.toFixed(0)})`
          : `${decision.action.id} (${score.toFixed(0)})`,
        now,
      );
    }

    decision.action.execute(this, context);
  }

  /** Run whichever combat mode the current action asked for. */
  private resolveCombat(context: BrainContext, dt: number): CombatOutput {
    switch (this.combatMode.kind) {
      case "engage": {
        const target = this.findEnemy(this.combatMode.targetId);
        if (!target) return this.combat.idle(context);
        return this.combat.engage(target, context, this.effective, dt);
      }

      case "track": {
        const target = this.findEnemy(this.combatMode.targetId);
        if (target) this.combat.track(target, context, this.effective, dt);
        return this.combat.idle(context);
      }

      case "look": {
        this.combat.lookAt(this.combatMode.x, this.combatMode.y, context, this.effective, dt);
        return this.combat.idle(context);
      }

      case "shoot":
        return this.combat.shootAt(
          this.combatMode.x,
          this.combatMode.y,
          this.combatMode.radius,
          context,
          this.effective,
          dt,
        );

      case "throw": {
        const config = this.room.config.getGrenadeConfig();
        return this.combat.throwGrenade(this.combatMode, context, this.effective, config, dt);
      }

      default:
        return this.combat.idle(context);
    }
  }

  /**
   * Pack the tick into an input command.
   *
   * This is the only output of the whole system, and it is the same shape a
   * browser sends. Everything above it is advice; the simulation does what it
   * would do for any player pressing these buttons.
   */
  private buildInput(combat: CombatOutput): InputCommand {
    const buttons = this.movement.takeButtons();

    this.input.seq = ++this.sequence;
    this.input.moveLeft = buttons.moveLeft;
    this.input.moveRight = buttons.moveRight;
    this.input.jump = buttons.jump;
    this.input.fire = combat.fire;
    this.input.reload = combat.reload;
    this.input.chargeGrenade = combat.chargeGrenade;
    this.input.aimAngle = combat.aimAngle;

    return this.input;
  }

  /** Between lives and between matches: forget everything and stand still. */
  rest(): void {
    this.movement.reset();
    this.combat.reset();
    this.memory.clear();
    this.brain.reset(this);
    this.combatMode = { kind: "idle" };
    this.actionState = "";
    this.context = null;
    this.chosenTarget = null;
  }

  /** Called at spawn, so a new life does not inherit the last one's plan. */
  onSpawn(now: number): void {
    this.rest();
    const spread = Math.max(20, this.room.config.getNpcConfig().thinkIntervalMs);
    this.nextThinkAt = now + this.random() * spread;
    this.nextPerceiveAt = now;
  }
}
