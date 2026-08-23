import {
  MatchState,
  createRandom,
  makeNameUnique,
  type BrainProfile,
  type DebugNpcSnapshot,
} from "@deathmatch/shared";
import { PlayerRuntime } from "../rooms/PlayerRuntime.js";
import type { RoomContext } from "../rooms/RoomContext.js";
import { PlayerState } from "../rooms/schema/PlayerState.js";
import type { MovementSystem } from "../systems/MovementSystem.js";
import { NpcAgent } from "./NpcAgent.js";
import { Perception } from "./Perception.js";
import { registerDefaultActions } from "./actions/index.js";

/** How often the lobby is topped up, in ms. Bots do not need to arrive instantly. */
const FILL_INTERVAL_MS = 1000;

/**
 * The bots in one room.
 *
 * The design constraint that shapes this file: an NPC is a *player*, not a
 * special case. It gets a `PlayerState` and a `PlayerRuntime` like anyone else,
 * its decisions come out as `InputCommand`s, and those go into the same queue a
 * browser's inputs go into -- so it is spawned by the same match manager, moved
 * by the same integrator, limited by the same input budget, and shot by the same
 * collision code. Nothing downstream of here knows a bot exists.
 *
 * That is also why there is no bot movement code anywhere else: if a bot could
 * be moved by anything other than an input command, it would stop being bound by
 * the rules it is meant to be playing under.
 */
export class NpcSystem {
  private readonly agents = new Map<string, NpcAgent>();
  private readonly perception: Perception;
  private readonly random: () => number;

  private nextFillAt = 0;
  private nextBotNumber = 1;
  private loggingFor: string | null = null;

  constructor(
    private readonly context: RoomContext,
    private readonly movement: MovementSystem,
    seed: number,
    /**
     * Called whenever a bot joins or leaves.
     *
     * The debug console builds its "which bot" dropdowns from the roster at the
     * moment it was last sent one, so without this the list is whatever it was
     * when the console opened -- usually empty, because bots arrive afterwards.
     */
    private readonly onRosterChanged: () => void = () => {},
  ) {
    this.perception = new Perception(context);
    this.random = createRandom(seed ^ 0x5eed);
  }

  get count(): number {
    return this.agents.size;
  }

  list(): readonly NpcAgent[] {
    return Array.from(this.agents.values());
  }

  get(sessionId: string): NpcAgent | null {
    return this.agents.get(sessionId) ?? null;
  }

  isNpc(sessionId: string): boolean {
    return this.agents.has(sessionId);
  }

  // -------------------------------------------------------------------------
  // Population
  // -------------------------------------------------------------------------

  /**
   * Keep the lobby topped up.
   *
   * Only while waiting: dropping a bot into a running match would give it a free
   * spawn among people who have been fighting, and taking one out mid-match
   * would look like a disconnect.
   */
  update(dt: number, now: number): void {
    const config = this.context.config.getNpcConfig();

    if (config.enabled && now >= this.nextFillAt) {
      this.nextFillAt = now + FILL_INTERVAL_MS;
      if (this.context.state.matchState === MatchState.WAITING) this.fill(config.fillToPlayers, config.maxBots);
    }

    if (!config.enabled && this.agents.size > 0 && this.context.state.matchState !== MatchState.PLAYING) {
      this.removeAll();
    }

    this.think(dt, now);
  }

  /** Add bots until the lobby has enough participants, within the cap. */
  private fill(target: number, maxBots: number): void {
    if (target <= 0) return;

    const humans = this.countHumans();
    // Bots are only worth adding once somebody is there to play against them.
    if (humans === 0) {
      if (this.agents.size > 0) this.removeAll();
      return;
    }

    const wanted = Math.min(maxBots, Math.max(0, target - humans));
    while (this.agents.size < wanted) {
      if (!this.spawn()) break;
    }

    // Too many, because a human joined: retire the newest rather than a random one.
    while (this.agents.size > wanted) {
      const last = Array.from(this.agents.keys()).pop();
      if (!last) break;
      this.remove(last);
    }
  }

  private countHumans(): number {
    let humans = 0;
    for (const player of this.context.state.players.values()) {
      if (!this.agents.has(player.sessionId) && player.connected) humans++;
    }
    return humans;
  }

  /** Add one bot with a randomly chosen personality. */
  spawn(profileId?: string): NpcAgent | null {
    const config = this.context.config.getNpcConfig();
    const profiles = config.profiles;
    if (profiles.length === 0) return null;
    if (this.context.state.players.size >= this.context.config.getMatchConfig().maxPlayers) return null;

    const profile =
      (profileId ? this.context.config.getBrainProfile(profileId) : null) ??
      profiles[Math.floor(this.random() * profiles.length)]!;

    const sessionId = `npc-${this.nextBotNumber++}`;
    const player = new PlayerState();
    player.sessionId = sessionId;
    player.name = this.pickName(config.names, profile);
    player.bot = true;
    // Bots are always "connected": there is no socket to drop, and the match
    // manager counts connected players when it decides to start.
    player.connected = true;
    player.alive = false;
    player.inMatch = false;
    player.health = this.context.config.getPlayerConfig().maxHealth;

    this.context.state.players.set(sessionId, player);
    this.context.runtimes.set(sessionId, new PlayerRuntime(this.context.now()));

    const agent = new NpcAgent(
      this.context,
      sessionId,
      profile,
      this.perception,
      this.random,
      this.random() * Math.max(20, config.thinkIntervalMs),
    );
    registerDefaultActions(agent.brain);
    this.agents.set(sessionId, agent);

    this.context.logger.info("Bot joined", { sessionId, name: player.name, profile: profile.id });
    this.onRosterChanged();
    return agent;
  }

  /** Remove one bot and everything that belonged to it. */
  remove(sessionId: string): boolean {
    const agent = this.agents.get(sessionId);
    if (!agent) return false;

    this.agents.delete(sessionId);
    this.context.state.players.delete(sessionId);
    this.context.runtimes.delete(sessionId);
    if (this.loggingFor === sessionId) this.loggingFor = null;

    this.context.logger.info("Bot left", { sessionId });
    this.onRosterChanged();
    return true;
  }

  removeAll(): void {
    for (const sessionId of Array.from(this.agents.keys())) this.remove(sessionId);
  }

  /** Give a bot a different personality, mid-match if you like. */
  setProfile(sessionId: string, profile: BrainProfile): boolean {
    const agent = this.agents.get(sessionId);
    if (!agent) return false;
    agent.setProfile(profile);
    return true;
  }

  // -------------------------------------------------------------------------
  // Thinking
  // -------------------------------------------------------------------------

  /**
   * Let every bot produce this tick's input.
   *
   * The input goes through `MovementSystem.enqueue`, which is the same door a
   * decoded network message comes through -- including the sequence check and
   * the queue cap.
   */
  private think(dt: number, now: number): void {
    if (this.agents.size === 0) return;

    for (const agent of this.agents.values()) {
      const runtime = this.context.runtimes.get(agent.sessionId);
      if (!runtime) continue;

      const input = agent.update(dt, now);
      if (input) this.movement.enqueue(runtime, input);
    }
  }

  /** Called when a match starts, so nobody carries last match's plan into it. */
  onMatchStarted(now: number): void {
    for (const agent of this.agents.values()) agent.onSpawn(now);
  }

  onMatchEnded(): void {
    for (const agent of this.agents.values()) agent.rest();
  }

  // -------------------------------------------------------------------------
  // Debug
  // -------------------------------------------------------------------------

  /**
   * Turn the decision log on for exactly one bot.
   *
   * One at a time on purpose: the log exists to explain a single bot's
   * behaviour, and a dozen of them logging at eight hertz is noise nobody can
   * read. Off entirely unless somebody asked.
   */
  setLoggingFor(sessionId: string | null): void {
    for (const agent of this.agents.values()) agent.setLogging(agent.sessionId === sessionId);
    this.loggingFor = sessionId;
  }

  get loggedSessionId(): string | null {
    return this.loggingFor;
  }

  /**
   * What every bot is thinking, for the debug console.
   *
   * Built on demand and only when somebody is watching -- see
   * `DebugCommandService.sendNpcState`. Read-only: it is a picture of the
   * decision, never an input to it.
   */
  describe(): DebugNpcSnapshot[] {
    return this.list().map((agent) => {
      const player = this.context.state.players.get(agent.sessionId);
      const context = agent.lastContext;
      const nearest = context?.nearestEnemy ?? null;

      return {
        sessionId: agent.sessionId,
        name: player?.name ?? agent.sessionId,
        profileId: agent.brainProfile.id,
        profileName: agent.brainProfile.name,
        action: agent.brain.currentAction?.id ?? "-",
        state: agent.state || "-",
        targetName: agent.target?.name ?? "-",
        scores: agent.scores.map((entry) => ({ ...entry })),

        danger: context?.danger ?? 0,
        health: context?.self.health ?? 0,
        ammo: context?.self.ammo ?? 0,
        grenadeDanger: context?.grenadeDanger ?? 0,
        weaponEffectiveness: context?.weaponEffectiveness ?? 0,
        enemyDistance: nearest ? Math.round(nearest.distance) : -1,
        visibleEnemies: context?.visibleEnemies.length ?? 0,

        watched: this.loggingFor === agent.sessionId,
        log: agent.decisionLog.map((entry) => `${formatTime(entry.at)} ${entry.message}`),
      };
    });
  }

  /** A readable name that is not already taken. */
  private pickName(names: readonly string[], profile: BrainProfile): string {
    const taken = Array.from(this.context.state.players.values()).map((player) => player.name);
    const base = names.length > 0 ? names[Math.floor(this.random() * names.length)]! : profile.name;
    return makeNameUnique(base, taken);
  }
}

/** `hh:mm:ss.mmm`, so a log line can be lined up against what was on screen. */
function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
