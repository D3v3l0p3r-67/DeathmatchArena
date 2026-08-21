import Phaser from "phaser";
import {
  CAMERA,
  FIXED_DELTA_MS,
  MatchState,
  PLAYER,
  getArena,
  getCollisionWorld,
  type ArenaDefinition,
  type CollisionWorld,
  type CrateDestroyedPayload,
  type DamagePayload,
  type MeleeSwingPayload,
  type PowerUpCollectedPayload,
  type SyncedCrate,
  type SyncedGameState,
  type SyncedPlayer,
  type SyncedPowerUp,
  type SyncedProjectile,
} from "@deathmatch/shared";
import type { NetworkManager } from "../../net/NetworkManager.js";
import { PredictionController } from "../../net/PredictionController.js";
import { SnapshotBuffer } from "../../net/SnapshotBuffer.js";
import { ArenaRenderer } from "../ArenaRenderer.js";
import { CameraController } from "../CameraController.js";
import { EffectsSystem } from "../EffectsSystem.js";
import { InputController } from "../InputController.js";
import { ShrinkWallsView } from "../ShrinkWallsView.js";
import { CrateView } from "../entities/CrateView.js";
import { PlayerView } from "../entities/PlayerView.js";
import { PowerUpView } from "../entities/PowerUpView.js";
import { ProjectileView } from "../entities/ProjectileView.js";

export const GAME_SCENE_KEY = "GameScene";

/** Guard against a long tab-suspension turning into a burst of catch-up ticks. */
const MAX_TICKS_PER_FRAME = 5;

export interface GameSceneEvents {
  onLocalDeath(): void;
  /** Fired when the local player comes back alive, i.e. at the start of a new match. */
  onLocalRespawn(): void;
  onSpectateTargetChanged(name: string): void;
  /** A power-up was collected by anyone; the shell decides whether to announce it. */
  onPowerUpCollected(payload: PowerUpCollectedPayload): void;
}

/**
 * The gameplay scene.
 *
 * It owns rendering and the local prediction loop, and nothing else:
 *   - the local player is predicted and reconciled against the server;
 *   - remote players are interpolated from buffered snapshots;
 *   - projectiles are rendered from server-owned state;
 *   - the camera follows the local player, or a survivor while spectating.
 *
 * No gameplay decision is made here. Health, hits, kills and the winner all
 * arrive from the server.
 */
export class GameScene extends Phaser.Scene {
  private network!: NetworkManager;
  private hooks!: GameSceneEvents;

  private arena!: ArenaDefinition;
  private world!: CollisionWorld;

  private arenaRenderer!: ArenaRenderer;
  private cameraController!: CameraController;
  private inputController!: InputController;
  private effects!: EffectsSystem;
  private shrinkWalls!: ShrinkWallsView;
  private prediction!: PredictionController;

  private readonly playerViews = new Map<string, PlayerView>();
  private readonly remoteBuffers = new Map<string, SnapshotBuffer>();
  private readonly projectileViews = new Map<string, ProjectileView>();
  private readonly crateViews = new Map<string, CrateView>();
  private readonly powerUpViews = new Map<string, PowerUpView>();

  private accumulatorMs = 0;
  private started = false;

  /** Session id currently followed by the camera (self, or a survivor when dead). */
  private spectateTargetId = "";
  private wasAlive = false;

  constructor() {
    super({ key: GAME_SCENE_KEY });
  }

  /** Called by the app shell once a room has been joined. */
  begin(network: NetworkManager, hooks: GameSceneEvents): void {
    this.network = network;
    this.hooks = hooks;

    const state = network.state;
    this.arena = getArena(state?.arenaId ?? "");
    this.world = getCollisionWorld(this.arena);
    this.prediction = new PredictionController(this.world);

    this.buildWorld();
    this.subscribeToNetwork();
    this.syncEntitiesFromState();
    this.started = true;
  }

  create(): void {
    // The scene starts idle: `begin()` runs once a room is joined.
    this.cameras.main.setBackgroundColor(0x0a0d14);
  }

  private buildWorld(): void {
    this.arenaRenderer = new ArenaRenderer(this, this.arena);
    this.cameraController = new CameraController(this, this.arena);
    this.inputController = new InputController(this);
    this.effects = new EffectsSystem(this);
    this.shrinkWalls = new ShrinkWallsView(this, this.arena);

    // Start looking at the middle of the arena until we spawn.
    this.cameraController.snapTo(this.arena.width / 2, this.arena.height / 2);

    this.input.keyboard?.on("keydown-LEFT", () => this.cycleSpectateTarget(-1));
    this.input.keyboard?.on("keydown-RIGHT", () => this.cycleSpectateTarget(1));
  }

  private subscribeToNetwork(): void {
    const events = this.network.events;

    events.on("playerAdded", ({ player, sessionId }) => this.addPlayerView(player, sessionId));
    events.on("playerRemoved", ({ sessionId }) => this.removePlayerView(sessionId));
    events.on("projectileAdded", ({ projectile }) => this.addProjectileView(projectile));
    events.on("projectileRemoved", ({ projectile }) => this.removeProjectileView(projectile));
    events.on("crateAdded", ({ crate }) => this.addCrateView(crate));
    events.on("crateRemoved", ({ crate }) => this.removeCrateView(crate));
    events.on("powerUpAdded", ({ powerUp }) => this.addPowerUpView(powerUp));
    events.on("powerUpRemoved", ({ powerUp }) => this.removePowerUpView(powerUp));
    events.on("crateDestroyed", (payload) => this.onCrateDestroyed(payload));
    events.on("powerUpCollected", (payload) => this.onPowerUpCollected(payload));
    events.on("meleeSwing", (payload) => this.onMeleeSwing(payload));
    events.on("patch", ({ state, receivedAt }) => this.onPatch(state, receivedAt));
    events.on("damage", (payload) => this.onDamage(payload));
    events.on("matchStateChanged", ({ matchState }) => this.onMatchStateChanged(matchState));
  }

  // ---------------------------------------------------------------------------
  // State synchronisation
  // ---------------------------------------------------------------------------

  private syncEntitiesFromState(): void {
    const state = this.network.state;
    if (!state) return;

    for (const [sessionId, player] of state.players) this.addPlayerView(player, sessionId);
    for (const projectile of state.projectiles.values()) this.addProjectileView(projectile);
    for (const crate of state.crates.values()) this.addCrateView(crate);
    for (const powerUp of state.powerUps.values()) this.addPowerUpView(powerUp);
  }

  // ---------------------------------------------------------------------------
  // Crates and power-ups
  // ---------------------------------------------------------------------------

  private addCrateView(crate: SyncedCrate): void {
    if (this.crateViews.has(crate.id)) return;
    this.crateViews.set(crate.id, new CrateView(this, crate));
  }

  private removeCrateView(crate: SyncedCrate): void {
    this.crateViews.get(crate.id)?.destroy();
    this.crateViews.delete(crate.id);
  }

  private addPowerUpView(powerUp: SyncedPowerUp): void {
    if (this.powerUpViews.has(powerUp.id)) return;
    this.powerUpViews.set(powerUp.id, new PowerUpView(this, powerUp));
  }

  private removePowerUpView(powerUp: SyncedPowerUp): void {
    const view = this.powerUpViews.get(powerUp.id);
    if (!view) return;
    view.destroy();
    this.powerUpViews.delete(powerUp.id);
  }

  /** The crate broke open -- splinters, and a nudge of screen shake if it was ours. */
  private onCrateDestroyed(payload: CrateDestroyedPayload): void {
    this.effects.impact(payload.x, payload.y, 0xc9a227, 16);
    if (payload.destroyedBy === this.network.sessionId) {
      this.cameraController.shake(90, 0.003);
    }
  }

  private onPowerUpCollected(payload: PowerUpCollectedPayload): void {
    this.effects.impact(payload.x, payload.y, 0xffffff, 12);
    this.hooks.onPowerUpCollected(payload);
  }

  /**
   * Draw a melee swing.
   *
   * The server has already decided what the swing hit; this only visualises it,
   * which is why `connected` arrives as a flag rather than being inferred here.
   */
  private onMeleeSwing(payload: MeleeSwingPayload): void {
    const view = this.playerViews.get(payload.sessionId);
    if (!view) return;

    this.effects.meleeSwing(
      view.container.x,
      view.container.y + PLAYER.AIM_ORIGIN_Y,
      payload.aimAngle,
      payload.weaponId,
      payload.connected,
    );

    if (payload.connected && payload.sessionId === this.network.sessionId) {
      this.cameraController.shake(70, 0.0022);
    }
  }

  private addPlayerView(player: SyncedPlayer, sessionId: string): void {
    if (this.playerViews.has(sessionId)) return;

    const isLocal = sessionId === this.network.sessionId;
    const view = new PlayerView(this, sessionId, player.name, isLocal);
    view.container.setVisible(player.alive);
    this.playerViews.set(sessionId, view);

    if (isLocal) {
      this.prediction.reset(player);
      this.spectateTargetId = sessionId;
    } else {
      this.remoteBuffers.set(sessionId, new SnapshotBuffer());
    }
  }

  private removePlayerView(sessionId: string): void {
    this.playerViews.get(sessionId)?.destroy();
    this.playerViews.delete(sessionId);
    this.remoteBuffers.delete(sessionId);

    if (this.spectateTargetId === sessionId) this.cycleSpectateTarget(1);
  }

  private addProjectileView(projectile: SyncedProjectile): void {
    if (this.projectileViews.has(projectile.id)) return;

    const now = performance.now();
    this.projectileViews.set(projectile.id, new ProjectileView(this, projectile, now));

    // A new projectile is the only signal we need for a muzzle flash -- no extra
    // "shot fired" message has to cross the wire.
    const angle = Math.atan2(projectile.velocityY, projectile.velocityX);
    this.effects.muzzleFlash(projectile.x, projectile.y, angle, projectile.weaponId);

    if (projectile.ownerId === this.network.sessionId) {
      this.cameraController.shake(60, 0.0016);
    }
  }

  private removeProjectileView(projectile: SyncedProjectile): void {
    const view = this.projectileViews.get(projectile.id);
    if (!view) return;

    // The server removes a projectile exactly where it stopped, so this position
    // is the real impact point.
    this.effects.impact(view.x, view.y, 0xffd166, 5);
    view.destroy();
    this.projectileViews.delete(projectile.id);
  }

  /** One authoritative snapshot: reconcile the local player, buffer the rest. */
  private onPatch(state: SyncedGameState, receivedAt: number): void {
    const localId = this.network.sessionId;

    // Prediction has to clamp where the server clamps, or a player pressed
    // against a closing wall would fight a correction on every patch.
    this.prediction.setBounds({ left: state.shrinkLeft, right: state.shrinkRight });

    for (const [sessionId, player] of state.players) {
      const view = this.playerViews.get(sessionId);
      if (view) view.setName(player.name);

      if (sessionId === localId) {
        if (player.inMatch && player.alive) this.prediction.reconcile(player);
        continue;
      }

      this.remoteBuffers.get(sessionId)?.push({
        receivedAt,
        x: player.x,
        y: player.y,
        velocityX: player.velocityX,
        velocityY: player.velocityY,
        aimAngle: player.aimAngle,
        facing: player.facing,
        alive: player.alive,
        onGround: player.onGround,
      });
    }

    for (const view of this.projectileViews.values()) view.syncFromServer(receivedAt);

    for (const [id, view] of this.crateViews) {
      const crate = state.crates.get(id);
      if (crate) view.refresh(crate);
    }
    for (const [id, view] of this.powerUpViews) {
      const powerUp = state.powerUps.get(id);
      if (powerUp) view.refresh(powerUp);
    }

    this.detectLocalDeath(state);
  }

  private detectLocalDeath(state: SyncedGameState): void {
    const local = state.players.get(this.network.sessionId);
    if (!local) return;

    if (this.wasAlive && !local.alive) {
      const view = this.playerViews.get(this.network.sessionId);
      if (view) this.effects.deathBurst(view.container.x, view.container.y, view.colorValue);

      this.inputController.setEnabled(false);
      this.cameraController.shake(320, 0.008);
      this.hooks.onLocalDeath();
      this.pickInitialSpectateTarget();
    }

    if (!this.wasAlive && local.alive) {
      // Fresh spawn: drop prediction history and re-enable controls.
      this.prediction.reset(local);
      this.inputController.setEnabled(true);
      this.spectateTargetId = this.network.sessionId;
      this.cameraController.snapTo(local.x, local.y);
      this.hooks.onLocalRespawn();
    }

    this.wasAlive = local.alive;
  }

  private onDamage(payload: DamagePayload): void {
    const localId = this.network.sessionId;

    if (payload.victimId === localId) {
      this.cameraController.shake(120, 0.004);
    }
    if (payload.attackerId === localId && payload.victimId !== localId) {
      this.effects.damageNumber(payload.x, payload.y - 20, payload.amount, payload.fatal);
    }
    this.effects.impact(payload.x, payload.y, 0xff4d5e, payload.fatal ? 14 : 7);
  }

  private onMatchStateChanged(matchState: string): void {
    if (matchState === MatchState.PLAYING) {
      this.inputController.setEnabled(true);
      return;
    }

    this.inputController.setEnabled(false);

    if (matchState === MatchState.FINISHED || matchState === MatchState.WAITING) {
      for (const view of this.projectileViews.values()) view.destroy();
      this.projectileViews.clear();
      for (const view of this.crateViews.values()) view.destroy();
      this.crateViews.clear();
      for (const view of this.powerUpViews.values()) view.destroy();
      this.powerUpViews.clear();
    }
  }

  // ---------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------

  override update(_time: number, deltaMs: number): void {
    if (!this.started || !this.network.isConnected) return;

    const now = performance.now();
    const deltaSeconds = deltaMs / 1000;

    this.updateAim();
    this.runFixedSteps(deltaMs, now);
    this.network.flushInput(now);

    this.prediction.update(deltaSeconds);
    this.renderLocalPlayer(deltaSeconds);
    this.renderRemotePlayers(now, deltaSeconds);
    this.renderProjectiles(now);
    this.renderShrinkWalls(deltaSeconds);
    this.updateCamera(deltaSeconds);
  }

  private renderShrinkWalls(deltaSeconds: number): void {
    const state = this.network.state;
    if (!state) return;
    this.shrinkWalls.update(state.shrinkLeft, state.shrinkRight, state.shrinking, deltaSeconds);
  }

  /** Aim from the player's shoulder towards the pointer, in world space. */
  private updateAim(): void {
    const localView = this.playerViews.get(this.network.sessionId);
    const originX = localView ? localView.container.x : this.prediction.renderX;
    const originY = (localView ? localView.container.y : this.prediction.renderY) + PLAYER.AIM_ORIGIN_Y;
    this.inputController.updateAim(originX, originY);
  }

  /**
   * Advance prediction in fixed steps.
   *
   * Physics must never depend on frame rate or on how often packets arrive, so
   * leftover frame time is carried in an accumulator -- exactly as the server does.
   */
  private runFixedSteps(deltaMs: number, now: number): void {
    const state = this.network.state;
    const local = state?.players.get(this.network.sessionId);
    const canPlay = state?.matchState === MatchState.PLAYING && local?.alive === true && local.inMatch;

    this.accumulatorMs += Math.min(deltaMs, FIXED_DELTA_MS * MAX_TICKS_PER_FRAME);

    let ticks = 0;
    while (this.accumulatorMs >= FIXED_DELTA_MS && ticks < MAX_TICKS_PER_FRAME) {
      this.accumulatorMs -= FIXED_DELTA_MS;
      ticks++;

      const input = this.inputController.sample();
      if (!canPlay) continue;

      // Predict locally, then queue the very same command for the server.
      this.prediction.predict(input);
      this.network.queueInput(input);
    }

    if (ticks === MAX_TICKS_PER_FRAME) this.accumulatorMs = 0;
    void now;
  }

  private renderLocalPlayer(deltaSeconds: number): void {
    const view = this.playerViews.get(this.network.sessionId);
    const player = this.network.state?.players.get(this.network.sessionId);
    if (!view || !player) return;

    view.apply(
      {
        // Prediction drives the position; the server's copy only corrects it.
        x: this.prediction.renderX,
        y: this.prediction.renderY,
        aimAngle: this.inputController.currentAimAngle,
        facing: this.prediction.movement.facing,
        alive: player.alive && player.inMatch,
        onGround: this.prediction.movement.onGround,
        health: player.health,
        speedX: this.prediction.movement.velocityX,
      },
      deltaSeconds,
    );
  }

  private renderRemotePlayers(now: number, deltaSeconds: number): void {
    const state = this.network.state;
    if (!state) return;

    for (const [sessionId, buffer] of this.remoteBuffers) {
      const view = this.playerViews.get(sessionId);
      const player = state.players.get(sessionId);
      if (!view || !player) continue;

      const sample = buffer.sample(now);
      if (!sample) continue;

      view.apply(
        {
          x: sample.x,
          y: sample.y,
          aimAngle: sample.aimAngle,
          facing: sample.facing,
          alive: player.alive && player.inMatch,
          onGround: sample.onGround,
          health: player.health,
          speedX: sample.speedX,
        },
        deltaSeconds,
      );
      view.setSpectated(sessionId === this.spectateTargetId && !this.isLocalAlive());
    }
  }

  private renderProjectiles(now: number): void {
    for (const view of this.projectileViews.values()) view.render(now);
  }

  private updateCamera(deltaSeconds: number): void {
    const target = this.getCameraTarget();
    if (!target) return;

    this.cameraController.follow(target.x, target.y, target.aimAngle, deltaSeconds);
  }

  private getCameraTarget(): { x: number; y: number; aimAngle: number } | null {
    if (this.isLocalAlive()) {
      return {
        x: this.prediction.renderX,
        y: this.prediction.renderY,
        aimAngle: this.inputController.currentAimAngle,
      };
    }

    const view = this.playerViews.get(this.spectateTargetId);
    if (view) {
      return { x: view.container.x, y: view.container.y, aimAngle: 0 };
    }

    return { x: this.arena.width / 2, y: this.arena.height / 2, aimAngle: 0 };
  }

  // ---------------------------------------------------------------------------
  // Spectating
  // ---------------------------------------------------------------------------

  private isLocalAlive(): boolean {
    const local = this.network.state?.players.get(this.network.sessionId);
    return local?.alive === true && local.inMatch;
  }

  private getSurvivors(): string[] {
    const state = this.network.state;
    if (!state) return [];

    return Array.from(state.players.entries())
      .filter(([sessionId, player]) => player.alive && player.inMatch && sessionId !== this.network.sessionId)
      .map(([sessionId]) => sessionId);
  }

  private pickInitialSpectateTarget(): void {
    const survivors = this.getSurvivors();
    this.spectateTargetId = survivors[0] ?? "";
    this.announceSpectateTarget();
  }

  /** Cycle through survivors; ignored while the local player is still alive. */
  private cycleSpectateTarget(direction: number): void {
    if (this.isLocalAlive()) return;

    const survivors = this.getSurvivors();
    if (survivors.length === 0) {
      this.spectateTargetId = "";
      this.announceSpectateTarget();
      return;
    }

    const current = survivors.indexOf(this.spectateTargetId);
    const next = (current + direction + survivors.length) % survivors.length;
    this.spectateTargetId = survivors[next]!;

    const view = this.playerViews.get(this.spectateTargetId);
    if (view) this.cameraController.snapTo(view.container.x, view.container.y);
    this.announceSpectateTarget();
  }

  private announceSpectateTarget(): void {
    const name = this.network.state?.players.get(this.spectateTargetId)?.name ?? "";
    this.hooks.onSpectateTargetChanged(name);
  }

  get spectatedName(): string {
    return this.network.state?.players.get(this.spectateTargetId)?.name ?? "";
  }

  // ---------------------------------------------------------------------------
  // Accessors used by the app shell (HUD / debug overlay)
  // ---------------------------------------------------------------------------

  getPredictionDebug(): { x: number; y: number; errorPx: number; pending: number } {
    return {
      x: this.prediction?.renderX ?? 0,
      y: this.prediction?.renderY ?? 0,
      errorPx: this.prediction?.getDebugInfo().lastErrorPx ?? 0,
      pending: this.prediction?.getDebugInfo().pendingInputs ?? 0,
    };
  }

  getPointerScreenPosition(): { x: number; y: number } {
    const pointer = this.input.activePointer;
    const scaleManager = this.scale;
    return {
      x: (pointer.x / scaleManager.gameSize.width) * scaleManager.displaySize.width + scaleManager.canvasBounds.x,
      y: (pointer.y / scaleManager.gameSize.height) * scaleManager.displaySize.height + scaleManager.canvasBounds.y,
    };
  }

  get projectileCount(): number {
    return this.projectileViews.size;
  }

  get crateCount(): number {
    return this.crateViews.size;
  }

  get powerUpCount(): number {
    return this.powerUpViews.size;
  }

  /** Tear everything down when leaving a room, so the scene can be reused. */
  teardown(): void {
    this.started = false;

    for (const view of this.playerViews.values()) view.destroy();
    this.playerViews.clear();
    this.remoteBuffers.clear();

    for (const view of this.projectileViews.values()) view.destroy();
    this.projectileViews.clear();

    this.arenaRenderer?.destroy();
    this.accumulatorMs = 0;
    this.wasAlive = false;
    this.spectateTargetId = "";
    void CAMERA;
  }
}
