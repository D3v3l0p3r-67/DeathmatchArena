import {
  MATCH,
  MatchState,
  PLAYER,
  ServerMessage,
  clamp,
  createMovementState,
  findFreeSpawnPosition,
  type DamagePayload,
  type KillPayload,
  type MatchResultMessage,
  type MatchStanding,
} from "@deathmatch/shared";
import { serverConfig } from "../config.js";
import type { PlayerRuntime } from "../rooms/PlayerRuntime.js";
import type { RoomContext } from "../rooms/RoomContext.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";
import type { ArenaShrinkSystem } from "./ArenaShrinkSystem.js";
import type { GrenadeSystem } from "./GrenadeSystem.js";
import type { PowerUpSystem } from "./PowerUpSystem.js";
import type { ProjectileSystem } from "./ProjectileSystem.js";
import type { WeaponSystem } from "./WeaponSystem.js";

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

  /** Players who pressed "play again" on the results screen. */
  private readonly requeueRequests = new Set<string>();

  constructor(
    private readonly context: RoomContext,
    private readonly weapons: WeaponSystem,
    private readonly projectiles: ProjectileSystem,
    private readonly powerUps: PowerUpSystem,
    private readonly arenaShrink: ArenaShrinkSystem,
    private readonly grenades: GrenadeSystem,
  ) {}

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

  private updateWaiting(now: number): void {
    if (this.countConnectedPlayers() < serverConfig.match.minPlayersToStart) return;
    this.beginCountdown(now);
  }

  private beginCountdown(now: number): void {
    this.context.state.matchState = MatchState.COUNTDOWN;
    this.phaseEndsAt = now + serverConfig.match.countdownMs;
    this.context.state.countdownSeconds = Math.ceil(serverConfig.match.countdownMs / 1000);
    this.context.logger.info("Countdown started", { players: this.countConnectedPlayers() });
  }

  private updateCountdown(now: number): void {
    // Players may leave during the countdown; fall back to WAITING if we drop below the threshold.
    if (this.countConnectedPlayers() < serverConfig.match.minPlayersToStart) {
      this.context.state.matchState = MatchState.WAITING;
      this.context.state.countdownSeconds = 0;
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
    const spawnOrder = this.shuffledSpawnIndices();

    participants.forEach((player, index) => {
      const runtime = this.context.runtimes.get(player.sessionId);
      if (!runtime) return;
      this.spawnPlayer(player, runtime, spawnOrder[index % spawnOrder.length]!, now);
    });

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
    this.matchDeadline = now + MATCH.MAX_MATCH_DURATION_MS;

    this.powerUps.onMatchStarted(now);
    this.arenaShrink.onMatchStarted();

    this.refreshCounters();
    this.context.logger.info("Match started", { players: participants.length, arena: state.arenaId });
  }

  private updatePlaying(now: number): void {
    this.refreshCounters();

    const state = this.context.state;

    if (now >= this.matchDeadline) {
      this.context.logger.warn("Match hit the duration cap, ending it");
      this.finishMatch(this.pickLeader(), now);
      return;
    }

    if (state.aliveCount <= 1) {
      const survivor = this.getAlivePlayers()[0] ?? null;
      this.finishMatch(survivor, now);
    }
  }

  private finishMatch(winner: PlayerState | null, now: number): void {
    const state = this.context.state;

    if (winner) {
      winner.placement = 1;
      state.winnerId = winner.sessionId;
      state.winnerName = winner.name;
    }

    state.matchState = MatchState.FINISHED;
    this.phaseEndsAt = now + serverConfig.match.resultsMs;
    this.projectiles.clear();
    this.powerUps.clear();
    this.arenaShrink.reset();
    this.grenades.clear();

    const standings = this.buildStandings();
    const payload: MatchResultMessage = {
      winnerId: state.winnerId,
      winnerName: state.winnerName,
      standings,
    };
    this.context.broadcast(ServerMessage.MATCH_RESULT, payload);

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
    this.requeueRequests.clear();

    for (const player of state.players.values()) {
      const runtime = this.context.runtimes.get(player.sessionId);
      player.alive = false;
      player.inMatch = false;
      player.health = PLAYER.MAX_HEALTH;
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
    this.refreshCounters();
    this.context.logger.info("Room reset, waiting for players");
  }

  // -------------------------------------------------------------------------
  // Player lifecycle
  // -------------------------------------------------------------------------

  private spawnPlayer(player: PlayerState, runtime: PlayerRuntime, spawnIndex: number, now: number): void {
    const spawn = this.context.arena.spawnPoints[spawnIndex]!;
    const position = findFreeSpawnPosition(this.context.world, spawn.x, spawn.y);

    runtime.resetForMatch(now);
    runtime.spawnIndex = spawnIndex;

    const movement = createMovementState(position.x, position.y);
    Object.assign(runtime.movement, movement);

    player.x = position.x;
    player.y = position.y;
    player.velocityX = 0;
    player.velocityY = 0;
    player.onGround = false;
    player.facing = position.x < this.context.arena.width / 2 ? 1 : -1;
    player.aimAngle = player.facing > 0 ? 0 : Math.PI;
    player.health = PLAYER.MAX_HEALTH;
    player.alive = true;
    player.inMatch = true;
    player.kills = 0;
    player.deaths = 0;
    player.placement = 0;
    player.lastProcessedInput = 0;

    // Everyone starts a match on the default weapon; the rest is earned from crates.
    this.weapons.equip(player, runtime, this.context.config.getDefaultWeaponId());
    this.grenades.resupply(player);
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
  ): void {
    const victim = this.context.state.players.get(victimId);
    if (!victim || !victim.alive || !victim.inMatch) return;
    if (this.context.state.matchState !== MatchState.PLAYING) return;

    const attacker = attackerId ? this.context.state.players.get(attackerId) ?? null : null;
    const damage = clamp(Math.round(amount), 0, PLAYER.MAX_HEALTH);
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

    // Only the two players involved need this; broadcasting it would be waste.
    this.context.sendTo(victimId, ServerMessage.DAMAGE, payload);
    if (attackerId && attackerId !== victimId) {
      this.context.sendTo(attackerId, ServerMessage.DAMAGE, payload);
    }

    if (fatal) this.eliminate(victim, attacker, weaponId);
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

    // Placement counts the survivors: the last player out of N finishes Nth.
    victim.placement = this.getAlivePlayers().length + 1;

    const payload: KillPayload = {
      killerId: killer?.sessionId ?? "",
      killerName: killer?.name ?? "",
      victimId: victim.sessionId,
      victimName: victim.name,
      weaponId,
      selfInflicted: !killer || killer.sessionId === victim.sessionId,
    };
    this.context.broadcast(ServerMessage.KILL, payload);

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

    const connected = this.countConnectedPlayers();
    if (connected > 0 && this.requeueRequests.size >= connected) {
      this.phaseEndsAt = now;
    }
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

  /** Fallback "winner" when a match times out: most kills, then least damage taken. */
  private pickLeader(): PlayerState | null {
    const alive = this.getAlivePlayers();
    if (alive.length === 0) return null;
    return alive.reduce((best, player) => {
      if (player.kills !== best.kills) return player.kills > best.kills ? player : best;
      return player.health > best.health ? player : best;
    });
  }

  private buildStandings(): MatchStanding[] {
    const players = Array.from(this.context.state.players.values()).filter((player) => player.placement > 0 || player.inMatch);

    return players
      .map<MatchStanding>((player) => ({
        sessionId: player.sessionId,
        name: player.name,
        kills: player.kills,
        placement: player.placement > 0 ? player.placement : 1,
      }))
      .sort((a, b) => a.placement - b.placement || b.kills - a.kills);
  }

  /** Distinct, shuffled spawn points so nobody starts on top of anyone else. */
  private shuffledSpawnIndices(): number[] {
    const indices = this.context.arena.spawnPoints.map((_, index) => index);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(this.context.random() * (i + 1));
      const swap = indices[i]!;
      indices[i] = indices[j]!;
      indices[j] = swap;
    }
    return indices;
  }
}
