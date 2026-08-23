import {
  MatchState,
  createRandom,
  makeNameUnique,
  type BrainProfile,
  type DebugNpcSnapshot,
  type NpcConfig,
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

  /**
   * When the current lobby started holding its places open.
   *
   * Set when the first person arrives and deliberately not reset when more do:
   * a wait that keeps restarting is a wait nobody can plan around.
   */
  private holdingSince = 0;
  /** Set when somebody asked not to wait. Cleared with the lobby. */
  private skipRequested = false;


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
    const waiting = this.context.state.matchState === MatchState.WAITING;

    if (!waiting) {
      // The hold belongs to a lobby, not to the room.
      this.holdingSince = 0;
      this.skipRequested = false;
    }

    // Bounds first, and whether or not bots are enabled: the numbers a lobby
    // displays should be this room's, even when nothing is going to fill it.
    this.publishLimits(config);

    if (config.enabled && waiting && now >= this.nextFillAt) {
      this.nextFillAt = now + FILL_INTERVAL_MS;
      this.updateLobby(config, now);
    }

    if (!config.enabled && this.agents.size > 0 && this.context.state.matchState !== MatchState.PLAYING) {
      this.removeAll();
      this.publishHold(0, false);
    }

    // Everybody left. Bots never play among themselves, in a lobby or in a
    // match: clearing them here ends the match on the next tick and recycles
    // the room, rather than leaving a server quietly simulating a fight nobody
    // is watching.
    if (this.agents.size > 0 && this.countPeople() === 0) {
      this.removeAll();
      this.publishHold(0, false);
    }

    this.think(dt, now);
  }

  /**
   * Hold the free places open, then fill them.
   *
   * A bot is a consolation prize: given the choice a lobby should fill with
   * people, so the places stay open for the configured hold before bots take
   * them -- unless whoever is waiting has said not to bother.
   */
  private updateLobby(config: NpcConfig, now: number): void {
    const humans = this.countHumans();

    // Nobody here. Nothing to hold open, and nothing for bots to play against.
    if (humans === 0) {
      this.holdingSince = 0;
      this.skipRequested = false;
      if (this.agents.size > 0) this.removeAll();
      this.publishHold(0, false);
      return;
    }

    if (this.holdingSince === 0) this.holdingSince = now;

    const wanted = this.botsWanted(config);
    const maxPlayers = this.context.config.getMatchConfig().maxPlayers;

    // The roster is complete: everybody who is going to play is here.
    if (humans >= maxPlayers) {
      this.publishHold(0, false);
      if (this.agents.size > 0) this.removeAll();
      return;
    }

    const elapsed = now - this.holdingSince;
    const remaining = Math.max(0, config.fillAfterMs - elapsed);

    // Nothing a skip could achieve. With no bots asked for and nobody else
    // here, the only thing that starts this match is another person arriving --
    // so do not offer a button that would quietly do nothing.
    if (humans + wanted < 2) {
      this.publishHold(Math.ceil(remaining / 1000), false);
      if (this.agents.size > 0) this.removeAll();
      return;
    }

    if (!this.skipRequested && remaining > 0) {
      // Still someone else's seat -- whether a bot or a person would take it.
      // Offer the skip and wait.
      this.publishHold(Math.ceil(remaining / 1000), true);
      if (this.agents.size > 0) this.removeAll();
      return;
    }

    this.publishHold(0, false);
    this.fill(wanted);
  }

  /**
   * How many bots this lobby should have.
   *
   * The lobby's own choice, clamped to what the arena can seat and to the
   * configured cap. Zero is an ordinary answer, not a special case: it means the
   * people here would rather play among themselves.
   */
  private botsWanted(config: NpcConfig): number {
    const maxPlayers = this.context.config.getMatchConfig().maxPlayers;
    const free = Math.max(0, maxPlayers - this.countHumans());
    return Math.min(this.context.state.botCount, config.maxBots, free);
  }

  /**
   * Is this lobby everybody it is going to be?
   *
   * The match manager asks before it starts a countdown. A lobby is ready when
   * nobody else is expected: the places have stopped being held open, the bots
   * that were asked for have arrived, and there is somebody to fight -- a match
   * of one is over the moment it begins.
   */
  lobbyReady(): boolean {
    const config = this.context.config.getNpcConfig();
    if (!config.enabled) return false;

    // Countdown counts as ready too: the match manager re-checks this every tick
    // while it counts down, and a lobby that legitimately started with three
    // would otherwise abort itself on the very next tick.
    const state = this.context.state.matchState;
    if (state !== MatchState.WAITING && state !== MatchState.COUNTDOWN) return false;

    const humans = this.countHumans();
    if (humans === 0) return false;

    const maxPlayers = this.context.config.getMatchConfig().maxPlayers;
    if (humans >= maxPlayers) return true;

    const wanted = this.botsWanted(config);
    // An opponent is the one thing a match cannot do without. With no bots
    // asked for, that means waiting for a second person.
    if (humans + wanted < 2) return false;

    // Places still open for people, and nobody has said not to wait.
    if (this.context.state.canStartNow) return false;

    return this.agents.size >= wanted;
  }

  /**
   * Seed and bound the lobby's bot settings.
   *
   * Run every tick rather than at construction because the schema's own
   * initialisers ran against the *process* defaults, and a room may since have
   * been given its own configuration -- an admin change, a debug override -- in
   * which case the numbers a lobby is showing were never this room's to begin
   * with. The empty difficulty name is what marks a lobby that has not yet been
   * seeded from the configuration it is actually playing under.
   */
  private publishLimits(config: NpcConfig): void {
    const state = this.context.state;
    if (state.botDifficultyName === "") {
      state.botCount = this.context.config.clampBotCount(config.defaultBotCount);
      state.botDifficulty = this.context.config.getBotDifficulty(config.defaultDifficulty).level;
    }

    const maxPlayers = this.context.config.getMatchConfig().maxPlayers;
    // One place always belongs to a person: bots never play among themselves.
    const ceiling = Math.max(0, Math.min(config.maxBots, maxPlayers - 1));
    if (this.context.state.maxBots !== ceiling) this.context.state.maxBots = ceiling;
    if (this.context.state.botCount > ceiling) this.context.state.botCount = ceiling;

    const level = this.context.config.getBotDifficulty(this.context.state.botDifficulty);
    if (this.context.state.botDifficulty !== level.level) {
      this.context.state.botDifficulty = level.level;
    }
    if (this.context.state.botDifficultyName !== level.name) {
      this.context.state.botDifficultyName = level.name;
    }
  }

  /**
   * Change what the lobby asked for.
   *
   * Only a person in a waiting lobby, and only within what the arena can seat --
   * a client asking for forty bots at difficulty 99 gets whatever the room can
   * actually give it. Bots already standing around are added or retired
   * immediately, so the roster in front of everybody matches the number they
   * just picked.
   */
  setLobbyBots(sessionId: string, count: number, difficulty: number): boolean {
    if (this.context.state.matchState !== MatchState.WAITING) return false;
    if (this.agents.has(sessionId)) return false;

    const player = this.context.state.players.get(sessionId);
    if (!player || !player.connected) return false;

    const config = this.context.config.getNpcConfig();
    const state = this.context.state;

    state.botCount = this.context.config.clampBotCount(count);
    const level = this.context.config.getBotDifficulty(difficulty);
    state.botDifficulty = level.level;
    state.botDifficultyName = level.name;

    // Everybody already here plays at the new level from their next thought.
    for (const agent of this.agents.values()) agent.setDifficulty(level.level);

    this.updateLobby(config, this.context.now());
    return true;
  }

  /**
   * Skip the wait.
   *
   * Only a person in this lobby may ask, and only while it is actually holding
   * places open -- a bot or a spectator asking achieves nothing, and neither
   * does asking twice.
   */
  requestImmediateStart(sessionId: string): boolean {
    if (this.context.state.matchState !== MatchState.WAITING) return false;
    if (this.agents.has(sessionId)) return false;

    const player = this.context.state.players.get(sessionId);
    if (!player || !player.connected) return false;

    const config = this.context.config.getNpcConfig();
    if (!config.enabled) return false;
    // Skipping the wait cannot conjure an opponent out of a lobby that asked
    // for no bots and holds one person.
    if (this.countHumans() + this.botsWanted(config) < 2) return false;

    this.skipRequested = true;
    // Act on it now rather than at the next fill tick, so the button feels
    // like it did something.
    this.updateLobby(this.context.config.getNpcConfig(), this.context.now());
    return true;
  }

  /** Tell the lobby what it is waiting for, in whole seconds. */
  private publishHold(seconds: number, canSkip: boolean): void {
    const state = this.context.state;
    if (state.botFillSeconds !== seconds) state.botFillSeconds = seconds;
    if (state.canStartNow !== canSkip) state.canStartNow = canSkip;
  }

  /** Bring the bot count to exactly `wanted`. */
  private fill(wanted: number): void {
    while (this.agents.size < wanted) {
      if (!this.spawn()) break;
    }

    // Too many, because somebody joined: retire the newest rather than a
    // random one, so the bots that have been here longest stay.
    while (this.agents.size > wanted) {
      const last = Array.from(this.agents.keys()).pop();
      if (!last) break;
      this.remove(last);
    }
  }

  /** People connected right now. What the lobby fill is measured against. */
  private countHumans(): number {
    let humans = 0;
    for (const player of this.context.state.players.values()) {
      if (!this.agents.has(player.sessionId) && player.connected) humans++;
    }
    return humans;
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
  spawn(profileId?: string, difficulty = this.context.state.botDifficulty): NpcAgent | null {
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
      this.context.config.getBotDifficulty(difficulty).level,
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
