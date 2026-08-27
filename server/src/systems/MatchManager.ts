import {
  MatchState,
  ServerMessage,
  clamp,
  createMovementState,
  findFreeSpawnPosition,
  scaleBotDamage,
  type BotDifficultyLevel,
  type DamagePayload,
  type KillPayload,
  type MatchResultMessage,
  type CareerUpdate,
} from "@deathmatch/shared";
import type { PlayerRuntime } from "../rooms/PlayerRuntime.js";
import { DamageSource, type DamageSourceValue, type RoomContext } from "../rooms/RoomContext.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";
import type { ArenaShrinkSystem } from "./ArenaShrinkSystem.js";
import type { GrenadeSystem } from "./GrenadeSystem.js";
import type { PowerUpSystem } from "./PowerUpSystem.js";
import type { ProjectileSystem } from "./ProjectileSystem.js";
import type { TrapSystem } from "./TrapSystem.js";
import type { NpcSystem } from "../npc/NpcSystem.js";
import type { WeaponSystem } from "./WeaponSystem.js";
import { createGameMode, type GameMode } from "../modes/index.js";

/**
 * Owns the match lifecycle: WAITING -> COUNTDOWN -> PLAYING -> FINISHED -> WAITING.
 *
 * The server is the only authority here. Clients observe `state.matchState` and
 * render the matching screen; they cannot start, end or influence a match.
 */
export class MatchManager {
  /** Timestamp at which the current phase ends (countdown / results). */
  private phaseEndsAt = 0;
  private matchDeadline = 0;
  /**
   * Set when the host asks to begin, cleared when the countdown starts.
   *
   * A request rather than an action: what actually starts the match is the next
   * tick finding the room in a state where starting is allowed.
   */
  private startRequested = false;

  /** Players who pressed "play again" on the results screen. */
  private readonly requeueRequests = new Set<string>();

  /**
   * The rules this match is played under.
   *
   * Rebuilt at every match start from the room's `gameModeId`, so a mode's
   * per-match state (flags, respawn timers, a sudden death) never leaks into
   * the next match -- or into a match of a different mode. Between matches it
   * holds the previous mode, whose hooks are only reachable while PLAYING.
   */
  private mode: GameMode = createGameMode("", this.modeServices());

  /**
   * The narrow slice of this manager a mode may drive. Safe to build in the
   * field initializer above: parameter properties are assigned first, so
   * `this.context` already exists (`useDefineForClassFields` is off).
   */
  private modeServices() {
    return {
      context: this.context,
      respawn: (player: PlayerState, now: number) => this.respawn(player, now),
      finish: (winner: PlayerState | null, now: number) => this.finishMatch(winner, now),
    };
  }

  constructor(
    private readonly context: RoomContext,
    private readonly weapons: WeaponSystem,
    private readonly projectiles: ProjectileSystem,
    private readonly powerUps: PowerUpSystem,
    private readonly arenaShrink: ArenaShrinkSystem,
    private readonly grenades: GrenadeSystem,
    private readonly traps: TrapSystem,
  ) {}

  /**
   * Told about the bots after construction.
   *
   * Set separately rather than injected because the NPC system needs the
   * movement system, which needs this one -- and a setter is a smaller price
   * than an indirection nobody else would use.
   */
  private npcs: NpcSystem | null = null;

  /** Spawn spots promised during the countdown, by session. See reserveSpawns. */
  private readonly reservedSpawns = new Map<string, number>();

  setNpcSystem(npcs: NpcSystem): void {
    this.npcs = npcs;
  }

  update(now: number): void {
    switch (this.context.state.matchState) {
      case MatchState.WAITING:
        this.updateWaiting(now);
        break;
      case MatchState.COUNTDOWN:
        this.updateCountdown(now);
        break;
      case MatchState.PLAYING:
        this.updatePlaying(now);
        break;
      case MatchState.FINISHED:
        this.updateFinished(now);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  /** Match pacing and size, read live so a configuration change lands next tick. */
  private get rules() {
    return this.context.config.getMatchConfig();
  }

  private updateWaiting(now: number): void {
    // The lobby is showing both of these, and both change for reasons other
    // than somebody joining -- a bot added, a connection dropped. Cheap enough
    // at ten players to simply keep true.
    this.refreshCounters();
    this.context.state.canStart = this.couldStart();

    // A room that has filled up has nothing left to wait for, so it does not
    // make the host say so. Anything short of full waits to be told.
    if (!this.startRequested && this.countConnectedPlayers() < this.rules.maxPlayers) return;
    if (!this.couldStart()) return;

    this.startRequested = false;
    this.beginCountdown(now);
  }

  /**
   * Could a match begin right now?
   *
   * Two conditions, and no third: enough players for a fight, and at least one
   * of them a person. Everything else about the line-up -- how many bots, how
   * good they are, whether to wait for a friend -- is the host's business, not
   * a rule.
   */
  private couldStart(): boolean {
    const players = this.getConnectedPlayers();
    if (players.length < Math.max(2, this.rules.minPlayers)) return false;
    return players.some((player) => !player.bot);
  }

  /**
   * "Begin, with whoever is here."
   *
   * The room checks that the asker is its host before this is reached; what is
   * checked here is whether starting is a thing that could happen at all.
   */
  requestStart(): boolean {
    if (this.context.state.matchState !== MatchState.WAITING) return false;
    if (!this.couldStart()) return false;

    this.startRequested = true;
    return true;
  }

  private beginCountdown(now: number): void {
    this.context.state.matchState = MatchState.COUNTDOWN;
    this.phaseEndsAt = now + this.rules.countdownMs;
    this.context.state.countdownSeconds = Math.ceil(this.rules.countdownMs / 1000);
    this.reserveSpawns();
    this.context.logger.info("Countdown started", { players: this.countConnectedPlayers() });
  }

  /**
   * Decide who will spawn where, before anybody does.
   *
   * Spawns used to be dealt out at the moment the match started, which was fine
   * until the countdown needed to *show* them: the client flies the camera over
   * the arena during 3-2-1 and dives to the local player's spot, and it cannot
   * dive to a decision that has not been made. So the deal happens here, is
   * published on each player (`spawnX`/`spawnY`), and `startMatch` honours it.
   *
   * The reservation is by session, not by position in a list: a player leaving
   * mid-countdown must not shift everybody else onto spots the flyover no
   * longer matches.
   */
  private reserveSpawns(): void {
    const spawns = this.playerSpawns();
    const order = this.shuffledSpawnIndices();
    this.reservedSpawns.clear();

    this.getConnectedPlayers().forEach((player, index) => {
      const spawnIndex = order[index % order.length]!;
      const spawn = spawns[spawnIndex]!;
      this.reservedSpawns.set(player.sessionId, spawnIndex);
      player.spawnX = Math.round(spawn.x);
      player.spawnY = Math.round(spawn.y);
    });
  }

  private updateCountdown(now: number): void {
    // Players may leave during the countdown: fall back to WAITING if what is
    // left could not have been started in the first place.
    if (!this.couldStart()) {
      this.context.state.matchState = MatchState.WAITING;
      this.context.state.countdownSeconds = 0;
      this.reservedSpawns.clear();
      this.context.logger.info("Countdown aborted, not enough players");
      return;
    }

    const remaining = Math.max(0, this.phaseEndsAt - now);
    // Only whole seconds are synchronised, so this changes a handful of times total.
    const seconds = Math.ceil(remaining / 1000);
    if (seconds !== this.context.state.countdownSeconds) {
      this.context.state.countdownSeconds = seconds;
    }

    if (remaining <= 0) this.startMatch(now);
  }

  private startMatch(now: number): void {
    const state = this.context.state;

    // Lock the room: matchmaking now creates a new room for arriving players
    // instead of dropping them into a match already in progress.
    this.context.setLocked(true);

    const participants = this.getConnectedPlayers();

    // The countdown promised everybody a spot; keep that promise. Somebody who
    // slipped in after the deal (a reconnect landing mid-countdown) gets a spot
    // nobody holds, falling back to any spot only when all are reserved.
    const spawnOrder = this.shuffledSpawnIndices();
    const taken = new Set(this.reservedSpawns.values());
    const free = spawnOrder.filter((index) => !taken.has(index));

    participants.forEach((player, index) => {
      const runtime = this.context.runtimes.get(player.sessionId);
      if (!runtime) return;
      const reserved = this.reservedSpawns.get(player.sessionId);
      const spawnIndex = reserved ?? free.shift() ?? spawnOrder[index % spawnOrder.length]!;
      this.spawnPlayer(player, runtime, spawnIndex, now);
    });
    this.reservedSpawns.clear();

    // Anyone who arrived but is not participating (e.g. reconnecting) stays a spectator.
    for (const player of state.players.values()) {
      if (!participants.includes(player)) {
        player.inMatch = false;
        player.alive = false;
      }
    }

    state.matchState = MatchState.PLAYING;
    state.countdownSeconds = 0;
    state.matchStartedAt = now;
    state.startingPlayerCount = participants.length;
    state.winnerId = "";
    state.winnerName = "";
    this.matchDeadline = now + this.rules.maxDurationMs;

    this.powerUps.onMatchStarted(now);
    this.arenaShrink.onMatchStarted();
    // Traps start every match from rest, so a crusher left extended by the last
    // one is not already on top of somebody at the countdown.
    this.traps.reset();
    this.npcs?.onMatchStarted(now);

    // A fresh mode instance per match: whatever rules the room is set to when
    // the countdown ends are the rules for the whole match, and nothing a mode
    // accumulated last match survives into this one.
    this.mode = createGameMode(state.gameModeId, this.modeServices());
    this.mode.onMatchStarted(now);

    this.refreshCounters();
    this.context.logger.info("Match started", {
      players: participants.length,
      arena: state.arenaId,
      mode: this.mode.id,
    });
  }

  private updatePlaying(now: number): void {
    this.refreshCounters();

    // The duration cap is a safety valve over every mode, not a rule of any:
    // a mode with its own clock ends itself well before this fires.
    if (now >= this.matchDeadline) {
      this.context.logger.warn("Match hit the duration cap, ending it");
      this.finishMatch(this.mode.pickTimeoutWinner(), now);
      return;
    }

    // Everything else that can end a match is the mode's call: last player
    // standing in deathmatch, the clock and sudden death in flag hunt.
    this.mode.update(now);
  }

  private finishMatch(winner: PlayerState | null, now: number): void {
    const state = this.context.state;
    if (state.matchState !== MatchState.PLAYING) return;

    if (winner) {
      winner.placement = 1;
      state.winnerId = winner.sessionId;
      state.winnerName = winner.name;
    }

    state.matchState = MatchState.FINISHED;
    this.phaseEndsAt = now + this.rules.resultsMs;
    this.projectiles.clear();
    this.powerUps.clear();
    this.arenaShrink.reset();
    this.grenades.clear();
    this.traps.reset();
    this.npcs?.onMatchEnded();

    // Standings before the mode's cleanup: a timed mode ranks by scores its
    // cleanup is about to reset.
    const standings = this.mode.buildStandings();
    this.mode.onMatchEnded(now);
    const payload: MatchResultMessage = {
      winnerId: state.winnerId,
      winnerName: state.winnerName,
      standings,
    };
    this.context.broadcast(ServerMessage.MATCH_RESULT, payload);
    this.recordCareers();

    this.context.logger.info("Match finished", { winner: state.winnerName || "(nobody)" });
  }

  private updateFinished(now: number): void {
    if (now < this.phaseEndsAt) return;
    this.resetToWaiting(now);
  }

  /** Recycle the room so the same group can immediately play another match. */
  private resetToWaiting(now: number): void {
    const state = this.context.state;

    this.projectiles.clear();
    this.powerUps.clear();
    this.arenaShrink.reset();
    this.grenades.clear();
    this.traps.reset();
    this.requeueRequests.clear();

    for (const player of state.players.values()) {
      const runtime = this.context.runtimes.get(player.sessionId);
      player.alive = false;
      player.inMatch = false;
      player.health = this.context.config.getPlayerConfig().maxHealth;
      player.kills = 0;
      player.deaths = 0;
      player.placement = 0;
      player.ammo = 0;
      player.reloading = false;
      player.lastProcessedInput = 0;
      // Power-up weapons are earned per match, never carried into the next one.
      player.weaponId = this.context.config.getDefaultWeaponId();
      player.grenades = 0;
      player.chargingGrenade = false;
      player.flagCount = 0;
      if (runtime) this.powerUps.clearSpeedBoost(player, runtime);
      runtime?.resetForMatch(now);
    }

    state.matchState = MatchState.WAITING;
    state.winnerId = "";
    state.winnerName = "";
    state.countdownSeconds = 0;
    state.startingPlayerCount = 0;
    state.matchStartedAt = 0;

    this.context.setLocked(false);
    this.startRequested = false;

    // A new lobby is the moment to change map: the fight is over, nobody is
    // standing on anything, and the next one deserves somewhere different.
    this.context.rotateArena();

    this.refreshCounters();
    this.context.logger.info("Room reset, waiting for players");
  }

  // -------------------------------------------------------------------------
  // Player lifecycle
  // -------------------------------------------------------------------------

  /**
   * Put a player into the world at a spawn point.
   *
   * `fresh` separates a match start from a mid-match respawn: a fresh spawn
   * zeroes the scoreboard (kills, deaths, placement, flags), a respawn only
   * revives -- in a mode where the dead come back, dying already cost what the
   * mode says it costs, and wiping the score would cost the match too.
   */
  private spawnPlayer(
    player: PlayerState,
    runtime: PlayerRuntime,
    spawnIndex: number,
    now: number,
    fresh = true,
  ): void {
    const spawn = this.playerSpawns()[spawnIndex]!;
    const position = findFreeSpawnPosition(this.context.world, spawn.x, spawn.y);

    runtime.resetForMatch(now);
    runtime.spawnIndex = spawnIndex;

    const player0 = this.context.config.getPlayerConfig();
    const movement = createMovementState(position.x, position.y, player0.maxJumps);
    Object.assign(runtime.movement, movement);

    player.x = position.x;
    player.y = position.y;
    player.spawnX = Math.round(position.x);
    player.spawnY = Math.round(position.y);
    player.velocityX = 0;
    player.velocityY = 0;
    player.onGround = false;
    player.facing = position.x < this.context.arena.width / 2 ? 1 : -1;
    player.aimAngle = player.facing > 0 ? 0 : Math.PI;
    player.health = player0.maxHealth;
    player.alive = true;
    player.inMatch = true;
    if (fresh) {
      player.kills = 0;
      player.deaths = 0;
      player.placement = 0;
      player.flagCount = 0;
    }
    player.lastProcessedInput = 0;

    // Everyone starts a match on the default weapon; the rest is earned from crates.
    this.weapons.equip(player, runtime, this.context.config.getDefaultWeaponId());
    this.grenades.resupply(player);
  }

  /**
   * Bring a dead player back into a running match, on a mode's say-so.
   *
   * A random spawn each time rather than the one they started on, so dying
   * relocates you -- and so a camper cannot learn where a victim reappears.
   */
  private respawn(player: PlayerState, now: number): void {
    if (this.context.state.matchState !== MatchState.PLAYING) return;
    const runtime = this.context.runtimes.get(player.sessionId);
    if (!runtime || player.alive) return;

    const spawnIndex = this.shuffledSpawnIndices()[0] ?? 0;
    this.spawnPlayer(player, runtime, spawnIndex, now, false);
    this.refreshCounters();
  }

  /**
   * Resolve a damage event. This is the only place health ever drops.
   *
   * Nothing here comes from a client: the amount is read from the weapon
   * definition and the hit was computed by the collision system, so a modified
   * client cannot claim a hit, pick its own damage, or kill anyone.
   */
  applyDamage(
    victimId: string,
    attackerId: string,
    amount: number,
    x: number,
    y: number,
    weaponId: string,
    source: DamageSourceValue = DamageSource.COMBAT,
  ): void {
    const victim = this.context.state.players.get(victimId);
    if (!victim || !victim.alive || !victim.inMatch) return;
    if (this.context.state.matchState !== MatchState.PLAYING) return;

    const attacker = attackerId ? this.context.state.players.get(attackerId) ?? null : null;

    /*
     * A bot's difficulty decides how much of a hit it takes and how much of one
     * it lands. Applied here, in the one place health ever drops, so it covers
     * every weapon there is and every weapon there will be -- bullets, pellets,
     * blasts, melee -- without each system having to remember. The weapon
     * catalogue is untouched: a rifle does what the rifle says, and the
     * difference belongs to the bot rather than to the gun.
     */
    const scaled = scaleBotDamage(
      amount,
      this.difficultyOf(attacker),
      this.difficultyOf(victim),
      source === DamageSource.ENVIRONMENT,
    );
    const damage = clamp(Math.round(scaled), 0, this.context.config.getPlayerConfig().maxHealth);
    victim.health = Math.max(0, victim.health - damage);

    const fatal = victim.health === 0;
    const payload: DamagePayload = {
      victimId,
      attackerId,
      amount: damage,
      health: victim.health,
      x,
      y,
      fatal,
    };

    /*
     * Everybody, not just the two involved. A fight you can see but not read
     * looks like nothing happening: players watching two others trade fire --
     * or spectating after their own elimination -- saw silent flashes and no
     * numbers, because this used to go only to the attacker and the victim.
     * The client draws somebody else's exchange quieter than your own.
     *
     * No new information leaves the server: every player's position and health
     * is already in the synchronised state that all clients receive, so this
     * tells a modified client nothing it could not already read. The cost is a
     * few dozen bytes per hit per client, against a schema patch that carries
     * every player twenty times a second.
     */
    this.context.broadcast(ServerMessage.DAMAGE, payload);

    if (fatal) this.eliminate(victim, attacker, weaponId);
  }

  /** The rung a player plays at, or null for a human -- who is never scaled. */
  private difficultyOf(player: PlayerState | null): BotDifficultyLevel | null {
    if (!player?.bot) return null;
    return this.context.config.getBotDifficulty(player.botDifficulty);
  }

  /**
   * Mark a player dead and record the elimination.
   * Called by the room when damage brings health to zero, and when a player
   * disconnects mid-match.
   */
  eliminate(victim: PlayerState, killer: PlayerState | null, weaponId: string): void {
    if (!victim.alive) return;

    victim.alive = false;
    victim.health = 0;
    victim.deaths += 1;
    victim.velocityX = 0;
    victim.velocityY = 0;

    const runtime = this.context.runtimes.get(victim.sessionId);
    runtime?.clearInputs();
    if (runtime) {
      this.powerUps.clearSpeedBoost(victim, runtime);
      // A wind-up dies with its owner; grenades already in flight do not.
      this.grenades.cancelCharge(victim, runtime);
    }
    this.projectiles.destroyOwnedBy(victim.sessionId);

    if (killer && killer.sessionId !== victim.sessionId) {
      killer.kills += 1;
    }

    // Whether death places you (last of N finishes Nth) or the table waits for
    // the clock is the mode's rule, and so is whether this kill ends anything.
    const survivors = this.getAlivePlayers().length;
    const placement = this.mode.placementOnDeath(survivors);
    if (placement !== null) victim.placement = placement;

    const payload: KillPayload = {
      killerId: killer?.sessionId ?? "",
      killerName: killer?.name ?? "",
      victimId: victim.sessionId,
      victimName: victim.name,
      weaponId,
      // Decided here rather than by the client, which will not learn the match
      // is over until the next patch.
      endsMatch: this.mode.killEndsMatch(survivors),
      selfInflicted: !killer || killer.sessionId === victim.sessionId,
    };
    this.context.broadcast(ServerMessage.KILL, payload);

    // After the kill is public: a mode that drops the victim's flags wants the
    // kill feed to already carry the death it is scattering loot for.
    this.mode.onEliminated(victim, killer, this.context.now());

    this.refreshCounters();
  }

  onPlayerJoined(): void {
    this.refreshCounters();
  }

  onPlayerRemoved(sessionId: string): void {
    this.requeueRequests.delete(sessionId);
    this.refreshCounters();
  }

  /**
   * "Play again" from the results screen. Once everyone still connected has asked
   * for it, the results delay is cut short instead of waiting it out.
   */
  requestRequeue(sessionId: string, now: number): void {
    if (this.context.state.matchState !== MatchState.FINISHED) return;
    this.requeueRequests.add(sessionId);

    // People only. Bots are always "connected" and will never ask for anything,
    // so counting them meant a room with a single bot in it could never cut the
    // wait short -- which looked exactly like the button doing nothing.
    const waitingOn = this.getConnectedPlayers().filter((player) => !player.bot);
    if (waitingOn.length === 0) return;

    const ready = waitingOn.every((player) => this.requeueRequests.has(player.sessionId));
    if (ready) this.phaseEndsAt = now;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  refreshCounters(): void {
    const state = this.context.state;
    let connected = 0;
    let alive = 0;

    for (const player of state.players.values()) {
      if (player.connected) connected++;
      if (player.alive && player.inMatch) alive++;
    }

    state.playerCount = connected;
    state.aliveCount = alive;
  }

  private countConnectedPlayers(): number {
    return this.getConnectedPlayers().length;
  }

  private getConnectedPlayers(): PlayerState[] {
    return Array.from(this.context.state.players.values()).filter((player) => player.connected);
  }

  private getAlivePlayers(): PlayerState[] {
    return Array.from(this.context.state.players.values()).filter(
      (player) => player.alive && player.inMatch,
    );
  }

  /**
   * Fold this match into the players' records.
   *
   * People only: a bot has no record to keep, and neither does somebody whose
   * browser never offered an id. Deaths come from the state rather than from
   * "did they win", because a match can end with several people already down.
   */
  private recordCareers(): void {
    const updates: CareerUpdate[] = [];

    for (const player of this.context.state.players.values()) {
      if (player.bot) continue;
      if (player.placement <= 0 && !player.inMatch) continue;

      const playerId = this.context.careerUpdateFor(player.sessionId);
      if (!playerId) continue;

      updates.push({
        playerId,
        kills: player.kills,
        deaths: player.deaths,
        placement: player.placement > 0 ? player.placement : 1,
      });
    }

    if (updates.length > 0) this.context.recordCareers(updates);
  }

  /**
   * The spawn points this arena offers.
   *
   * Filtered every time rather than cached: an arena is data an administrator can
   * change, and a cached list would keep spawning players on a point that was
   * switched off.
   */
  private playerSpawns() {
    const enabled = this.context.arena.playerSpawns.filter((spawn) => spawn.enabled);
    // An arena with nothing enabled would leave nowhere to stand; the validator
    // refuses to save one, but a hand-edited file could still get here.
    return enabled.length > 0 ? enabled : this.context.arena.playerSpawns;
  }

  /** Distinct, shuffled spawn points so nobody starts on top of anyone else. */
  private shuffledSpawnIndices(): number[] {
    const indices = this.playerSpawns().map((_, index) => index);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(this.context.random() * (i + 1));
      const swap = indices[i]!;
      indices[i] = indices[j]!;
      indices[j] = swap;
    }
    return indices;
  }
}
