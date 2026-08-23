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
   * Housekeeping only.
   *
   * Bots no longer arrive on a timer: the host adds them, one at a time, at
   * whatever difficulty they choose. All that is left to do each tick is notice
   * when they should not be here at all.
   */
  update(dt: number, now: number): void {
    const config = this.context.config.getNpcConfig();

    if (!config.enabled && this.agents.size > 0 && this.context.state.matchState !== MatchState.PLAYING) {
      this.removeAll();
    }

    // Everybody left. Bots never play among themselves, in a lobby or in a
    // match: clearing them here ends the match on the next tick and recycles
    // the room, rather than leaving a server quietly simulating a fight nobody
    // is watching.
    if (this.agents.size > 0 && this.countPeople() === 0) {
      this.removeAll();
    }

    this.think(dt, now);
  }

  /**
   * Add one bot, at the host's request.
   *
   * Everything the client could get wrong is decided here: that the asker is
   * this room's host, that the room is between matches, that there is a place
   * free, that bots are allowed at all, and which rung of the ladder the
   * difficulty actually lands on.
   */
  addBot(sessionId: string, difficulty: number): boolean {
    if (!this.canHostEdit(sessionId)) return false;

    const config = this.context.config.getNpcConfig();
    if (!config.enabled) return false;
    if (this.agents.size >= config.maxBots) return false;
    if (this.context.state.players.size >= this.context.config.getMatchConfig().maxPlayers) return false;

    return this.spawn(undefined, difficulty) !== null;
  }

  /** Remove one bot, at the host's request. People are not removable this way. */
  removeBot(sessionId: string, botId: string): boolean {
    if (!this.canHostEdit(sessionId)) return false;
    if (!this.agents.has(botId)) return false;
    return this.remove(botId);
  }

  /**
   * May this session change the room's line-up?
   *
   * Only the host, only a connected person, and only between matches -- adding a
   * bot to a running match would hand it a free spawn among people who have been
   * fighting, and taking one out would look like a disconnect.
   */
  private canHostEdit(sessionId: string): boolean {
    if (this.context.state.matchState !== MatchState.WAITING) return false;
    if (this.context.state.hostId !== sessionId) return false;

    const player = this.context.state.players.get(sessionId);
    return Boolean(player && player.connected && !player.bot);
  }

  /**
   * People in the room at all, connected or not.
   *
   * Deliberately more forgiving than `countHumans`: somebody whose connection
   * dropped still holds their seat for the reconnection window, and ending their
   * match because of a blip would be worse than letting the bots play on for a
   * few seconds.
   */
  private countPeople(): number {
    let people = 0;
    for (const player of this.context.state.players.values()) {
      if (!this.agents.has(player.sessionId)) people++;
    }
    return people;
  }

  /**
   * Add one bot with a randomly chosen personality.
   *
   * Personality and skill arrive separately on purpose: the profile decides how
   * this bot wants to play, the difficulty decides how well it manages to.
   */
  spawn(profileId?: string, difficulty = this.context.config.getNpcConfig().defaultDifficulty): NpcAgent | null {
    const config = this.context.config.getNpcConfig();
    const profiles = config.profiles;
    if (profiles.length === 0) return null;
    if (this.context.state.players.size >= this.context.config.getMatchConfig().maxPlayers) return null;

    const profile =
      (profileId ? this.context.config.getBrainProfile(profileId) : null) ??
      profiles[Math.floor(this.random() * profiles.length)]!;

    const level = this.context.config.getBotDifficulty(difficulty);
    const sessionId = `npc-${this.nextBotNumber++}`;
    const player = new PlayerState();
    player.sessionId = sessionId;
    player.name = this.pickName(config.names, profile);
    player.bot = true;
    // Carried on the player rather than on the room: each bot is added on its
    // own and may be as good or as poor as the host likes.
    player.botDifficulty = level.level;
    player.botDifficultyName = level.name;
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
      level.level,
    );
    registerDefaultActions(agent.brain);
    this.agents.set(sessionId, agent);

    this.context.logger.info("Bot joined", {
      sessionId,
      name: player.name,
      profile: profile.id,
      difficulty: level.level,
    });
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

  /** The room changed arena: every bot's navigation describes the old one. */
  onArenaChanged(): void {
    for (const agent of this.agents.values()) agent.onArenaChanged();
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
        difficulty: agent.difficulty.level,
        difficultyName: agent.difficulty.name,
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
