import Phaser from "phaser";
import {
  CAMERA,
  FIXED_DELTA_MS,
  MatchState,
  PLAYER,
  getArena,
  getGrenadeConfig,
  getCollisionWorld,
  getPowerUp,
  type ArenaDefinition,
  type CollisionWorld,
  type CrateDestroyedPayload,
  type DamagePayload,
  type MeleeSwingPayload,
  type PowerUpCollectedPayload,
  type SyncedCrate,
  type SyncedPendingCrate,
  type ExplosionPayload,
  type SyncedGameState,
  type SyncedGrenade,
  type SyncedPlayer,
  type SyncedPowerUp,
  type SyncedProjectile,
  type SyncedTrap,
  TrapPhase,
  type KillPayload,
} from "@deathmatch/shared";
import type { NetworkManager } from "../../net/NetworkManager.js";
import { PredictionController } from "../../net/PredictionController.js";
import type { PredictedShot } from "../../net/LocalFireModel.js";
import { SnapshotBuffer } from "../../net/SnapshotBuffer.js";
import { ArenaRenderer } from "../ArenaRenderer.js";
import { CameraController } from "../CameraController.js";
import { EffectsSystem } from "../EffectsSystem.js";
import { InputController } from "../InputController.js";
import { ShrinkWallsView } from "../ShrinkWallsView.js";
import { generateWeaponTextures } from "../TextureFactory.js";
import { DEFAULT_EFFECTS_SETTINGS, FINALE, type EffectsSettings } from "../fx/effects.js";
import type { TouchIntent } from "../../ui/TouchControls.js";
import { CrateView } from "../entities/CrateView.js";
import { CrateWarningView } from "../entities/CrateWarningView.js";
import { GrenadeView } from "../entities/GrenadeView.js";
import { PlayerView } from "../entities/PlayerView.js";
import { PowerUpView } from "../entities/PowerUpView.js";
import { ProjectileView } from "../entities/ProjectileView.js";
import { TrapView } from "../entities/TrapView.js";

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
  /** A crate has been announced and is on its way to this spot. */
  onCrateIncoming(warning: SyncedPendingCrate): void;
  /**
   * The local player fired, as predicted by the client's fire model, with the
   * muzzle position the flash was drawn at. Fired on the tick of the trigger
   * pull -- the shell plays the shot sound here so the feedback is immediate
   * rather than a round trip away.
   */
  onLocalShot(shot: PredictedShot, muzzleX: number, muzzleY: number): void;
  /**
   * The kill that ended the match has finished playing out.
   *
   * The shell waits for this before putting the results screen up, so the last
   * kill of a match is something you watch rather than something a menu covers.
   */
  onFinaleComplete(): void;
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
  /** When each remote player was first seen winding up a grenade. */
  private readonly throwStartedAt = new Map<string, number>();
  private readonly remoteBuffers = new Map<string, SnapshotBuffer>();
  private readonly projectileViews = new Map<string, ProjectileView>();
  private readonly crateViews = new Map<string, CrateView>();
  private readonly warningViews = new Map<string, CrateWarningView>();
  private readonly trapViews = new Map<string, TrapView>();
  /** Last seen phase per trap, so the moment one goes off can be recognised. */
  private readonly trapPhases = new Map<string, string>();
  private readonly powerUpViews = new Map<string, PowerUpView>();
  private readonly grenadeViews = new Map<string, GrenadeView>();

  private accumulatorMs = 0;
  private started = false;

  /** Player preferences, applied to every effect this scene plays. */
  private effectsSettings: EffectsSettings = { ...DEFAULT_EFFECTS_SETTINGS };
  /**
   * How fast the presentation is running, as a fraction of real time.
   *
   * Rendering only: the prediction loop keeps stepping at its fixed rate, and
   * the match has already been decided on the server before any of this starts.
   */
  private timeScale = 1;
  /** When the finale began, in real time; 0 when no finale is running. */
  private finaleStartedAt = 0;
  /** Who died last, and who is left standing. Both drive the camera, not the game. */
  private finaleVictimId = "";
  private finaleWinnerId = "";
  /** Set once the camera has left the body for the winner. */
  private finaleFoundWinner = false;
  /** How many confetti waves have gone up so far. */
  private confettiWaves = 0;

  /** Previous per-player state, so movement events can be spotted in a patch. */
  private readonly wasOnGround = new Map<string, boolean>();
  private readonly lastJumps = new Map<string, number>();

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
    // The server sent this arena with the welcome; `getArena` is only the
    // fallback for the impossible case of rendering before the handshake.
    this.arena = this.network.arena ?? getArena(state?.arenaId ?? "");
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
    // Weapons are administered data and only arrive with the welcome message,
    // so their silhouettes cannot be drawn at boot with the rest of the art.
    generateWeaponTextures(this);

    this.arenaRenderer = new ArenaRenderer(this, this.arena);
    this.cameraController = new CameraController(this, this.arena);
    this.inputController = new InputController(this);
    this.effects = new EffectsSystem(this);
    this.effects.applySettings(this.effectsSettings);
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
    events.on("grenadeAdded", ({ grenade }) => this.addGrenadeView(grenade));
    events.on("grenadeRemoved", ({ grenade }) => this.removeGrenadeView(grenade));
    events.on("explosion", (payload) => this.onExplosion(payload));
    events.on("patch", ({ state, receivedAt }) => this.onPatch(state, receivedAt));
    events.on("damage", (payload) => this.onDamage(payload));
    events.on("kill", (payload) => this.onKill(payload));
    events.on("matchStateChanged", ({ matchState }) => this.onMatchStateChanged(matchState));
    // A debug command can retune a weapon mid-match, including how it looks.
    events.on("configChanged", () => generateWeaponTextures(this));
    events.on("arenaChanged", (arena) => this.onArenaChanged(arena));
  }

  /**
   * The room moved to a different arena for the next match.
   *
   * Only the pieces that describe geometry are rebuilt -- the drawing, the
   * camera's limits, the closing walls, the collision world and the prediction
   * that steps against it. Everything else (views, buffers, the HUD) is about
   * players and survives a change of scenery.
   *
   * Between matches by construction: the server only rotates while resetting the
   * room, so nothing is standing on the floor being replaced.
   */
  private onArenaChanged(arena: ArenaDefinition): void {
    this.arena = arena;
    this.world = getCollisionWorld(arena);

    this.arenaRenderer?.destroy();
    this.arenaRenderer = new ArenaRenderer(this, arena);
    this.cameraController.setArena(arena);
    this.shrinkWalls?.destroy();
    this.shrinkWalls = new ShrinkWallsView(this, arena);

    for (const view of this.trapViews.values()) view.destroy();
    this.trapViews.clear();
    this.trapPhases.clear();

    // Prediction steps against the world it was built with, so it needs a new
    // one rather than a new arena inside the old one.
    this.prediction = new PredictionController(this.world);
    const local = this.network.state?.players.get(this.network.sessionId);
    if (local) this.prediction.reset(local);

    const state = this.network.state;
    if (state) this.syncTraps(state);
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
    this.syncWarnings(state);
    for (const powerUp of state.powerUps.values()) this.addPowerUpView(powerUp);
    for (const grenade of state.grenades.values()) this.addGrenadeView(grenade);
    this.syncTraps(state);
  }

  // ---------------------------------------------------------------------------
  // Traps
  // ---------------------------------------------------------------------------

  /**
   * Keep the trap views in step with the state.
   *
   * Done from the patch rather than from add/remove events, because a room's
   * traps are built once from its arena and then simply move: there is no stream
   * of creations to subscribe to, only positions and phases that change.
   */
  private syncTraps(state: SyncedGameState): void {
    for (const [id, trap] of state.traps) {
      let view = this.trapViews.get(id);
      if (!view) {
        view = new TrapView(this, trap);
        this.trapViews.set(id, view);
      }
      view.refresh(trap);
      this.reactToTrapPhase(id, trap);
    }

    for (const [id, view] of this.trapViews) {
      if (state.traps.has(id)) continue;
      view.destroy();
      this.trapViews.delete(id);
      this.trapPhases.delete(id);
    }
  }

  /**
   * Keep the landing warnings in step with the state.
   *
   * Driven from the patch like the traps, and for the same reason: a warning is
   * a position and a progress that change, not a stream of events to subscribe
   * to. When one disappears the crate has landed, and the crate's own arrival
   * effect takes over.
   */
  private syncWarnings(state: SyncedGameState): void {
    for (const [id, warning] of state.pendingCrates) {
      let view = this.warningViews.get(id);
      if (!view) {
        view = new CrateWarningView(this, warning);
        this.warningViews.set(id, view);
        this.hooks.onCrateIncoming(warning);
      }
      view.refresh(warning);
    }

    for (const [id, view] of this.warningViews) {
      if (state.pendingCrates.has(id)) continue;
      view.destroy();
      this.warningViews.delete(id);
    }
  }

  /** A burst and a shake the moment a trap actually goes off. */
  private reactToTrapPhase(id: string, trap: SyncedTrap): void {
    const previous = this.trapPhases.get(id);
    this.trapPhases.set(id, trap.phase);
    if (previous === trap.phase || trap.phase !== TrapPhase.ACTIVE) return;
    // The first patch after joining is not an activation, just the current state.
    if (previous === undefined) return;

    const x = trap.x + trap.width / 2;
    const y = trap.y + trap.height / 2;
    this.effects.burst("trapFire", x, y);

    // Shaken only for a trap you could plausibly be standing in, so a hazard
    // cycling on the far side of the arena does not rattle the screen.
    const centre = this.getCameraCentre();
    if (!centre) return;
    const distance = Math.hypot(centre.x - x, centre.y - y);
    if (distance > 700) return;
    const shake = this.effects.shakeFor("trapFire", 1 - distance / 700);
    this.cameras.main.shake(shake.durationMs, shake.intensity);
  }

  // ---------------------------------------------------------------------------
  // Grenades
  // ---------------------------------------------------------------------------

  private addGrenadeView(grenade: SyncedGrenade): void {
    if (this.grenadeViews.has(grenade.id)) return;
    this.grenadeViews.set(grenade.id, new GrenadeView(this, grenade, performance.now()));
  }

  private removeGrenadeView(grenade: SyncedGrenade): void {
    this.grenadeViews.get(grenade.id)?.destroy();
    this.grenadeViews.delete(grenade.id);
  }

  /** The blast is already resolved; this only makes it visible. */
  private onExplosion(payload: ExplosionPayload): void {
    this.effects.explosion(payload.x, payload.y, payload.radius);

    // Shake harder the closer the blast was to whoever is being watched.
    const view = this.playerViews.get(this.spectateTargetId || this.network.sessionId);
    if (!view) return;
    const distance = Math.hypot(view.container.x - payload.x, view.container.y - payload.y);
    if (distance > payload.radius * 3) return;

    const strength = 1 - Math.min(1, distance / (payload.radius * 3));
    const near = this.effects.shakeFor("explosionNear", strength);
    const far = this.effects.shakeFor("explosionFar");
    this.cameraController.shake(near.durationMs, far.intensity + near.intensity);
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
    this.effects.burst("crateBreak", payload.x, payload.y);
    if (payload.destroyedBy === this.network.sessionId) {
      const shake = this.effects.shakeFor("crateBreak");
      this.cameraController.shake(shake.durationMs, shake.intensity);
    }
  }

  private onPowerUpCollected(payload: PowerUpCollectedPayload): void {
    const color = getPowerUp(payload.powerUpId)?.color ?? 0xffffff;
    this.effects.tintedBurst("pickup", payload.x, payload.y, color);
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
      const shake = this.effects.shakeFor("meleeConnect");
      this.cameraController.shake(shake.durationMs, shake.intensity);
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
    this.throwStartedAt.delete(sessionId);
    this.remoteBuffers.delete(sessionId);

    if (this.spectateTargetId === sessionId) this.cycleSpectateTarget(1);
  }

  private addProjectileView(projectile: SyncedProjectile): void {
    if (this.projectileViews.has(projectile.id)) return;

    const now = performance.now();
    this.projectileViews.set(projectile.id, new ProjectileView(this, projectile, now));

    // A new projectile is the only signal we need for a muzzle flash -- no extra
    // "shot fired" message has to cross the wire. Except for our own: those are
    // predicted, and their flash, kick and sound already played on the tick of
    // the trigger pull instead of a round trip later.
    if (projectile.ownerId === this.network.sessionId) return;

    const angle = Math.atan2(projectile.velocityY, projectile.velocityX);
    this.effects.muzzleFlash(projectile.x, projectile.y, angle, projectile.weaponId);
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

    this.spawnMovementEffects(state);

    for (const view of this.projectileViews.values()) view.syncFromServer(receivedAt);

    this.syncTraps(state);
    this.syncWarnings(state);

    for (const [id, view] of this.crateViews) {
      const crate = state.crates.get(id);
      if (crate) view.refresh(crate);
    }
    for (const [id, view] of this.powerUpViews) {
      const powerUp = state.powerUps.get(id);
      if (powerUp) view.refresh(powerUp);
    }
    for (const [id, view] of this.grenadeViews) {
      const grenade = state.grenades.get(id);
      if (!grenade) continue;
      if (view.detectBounce(grenade)) {
        this.effects.burst("grenadeBounce", grenade.x, grenade.y);
      }
      view.syncFromServer(grenade, receivedAt);
    }

    this.detectLocalDeath(state);
  }

  /**
   * Turn state changes into movement effects.
   *
   * Jumps and landings are never messages -- they are simply visible in the
   * patch, so the puffs and rings are derived here rather than costing bandwidth.
   */
  private spawnMovementEffects(state: SyncedGameState): void {
    for (const [sessionId, player] of state.players) {
      if (!player.inMatch || !player.alive) {
        this.wasOnGround.delete(sessionId);
        this.lastJumps.delete(sessionId);
        continue;
      }

      const wasGrounded = this.wasOnGround.get(sessionId);
      const previousJumps = this.lastJumps.get(sessionId);
      const feetY = player.y + PLAYER.HEIGHT / 2;

      // The jump allowance dropping is the jump; dropping it while airborne is
      // the mid-air one, which gets a ring of its own.
      if (previousJumps !== undefined && player.jumpsRemaining < previousJumps) {
        if (wasGrounded === false) {
          this.effects.burst("doubleJump", player.x, feetY);
          this.effects.ring(player.x, feetY, 0x9fe8ff, 46, 320);
        }
      }

      if (wasGrounded === false && player.onGround) {
        // Thrown sideways along the ground rather than straight up.
        this.effects.burst("landing", player.x, feetY, 0, 1);
        this.effects.burst("landing", player.x, feetY, Math.PI, 1);
      }

      this.wasOnGround.set(sessionId, player.onGround);
      this.lastJumps.set(sessionId, player.jumpsRemaining);
    }
  }

  private detectLocalDeath(state: SyncedGameState): void {
    const local = state.players.get(this.network.sessionId);
    if (!local) return;

    if (this.wasAlive && !local.alive) {
      // The burst belongs to `onKill`, which fires for every death including
      // this one; doing it here as well would double it up on the local player.
      this.inputController.setEnabled(false);
      const shake = this.effects.shakeFor("died");
      this.cameraController.shake(shake.durationMs, shake.intensity);
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
      const shake = this.effects.shakeFor("tookDamage");
      this.cameraController.shake(shake.durationMs, shake.intensity);
    }
    if (payload.attackerId === localId && payload.victimId !== localId) {
      this.effects.damageNumber(payload.x, payload.y - 20, payload.amount, payload.fatal);
    }
    this.effects.burst("fleshImpact", payload.x, payload.y, undefined, payload.fatal ? 1.6 : 1);
  }

  private onMatchStateChanged(matchState: string): void {
    if (matchState === MatchState.PLAYING) {
      this.inputController.setEnabled(true);
      this.cancelFinale();
      return;
    }

    // FINISHED arrives immediately after the kill that caused it, so it must not
    // cut the finale short; anything earlier in the cycle means a new match.
    if (matchState !== MatchState.FINISHED) this.cancelFinale();

    this.inputController.setEnabled(false);

    if (matchState === MatchState.FINISHED || matchState === MatchState.WAITING) {
      for (const view of this.projectileViews.values()) view.destroy();
      this.projectileViews.clear();
      for (const view of this.crateViews.values()) view.destroy();
      this.crateViews.clear();
      for (const view of this.powerUpViews.values()) view.destroy();
      this.powerUpViews.clear();
      for (const view of this.grenadeViews.values()) view.destroy();
      this.grenadeViews.clear();
    }
  }

  // ---------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------

  override update(_time: number, deltaMs: number): void {
    if (!this.started || !this.network.isConnected) return;

    const now = performance.now();
    // Simulation time and presentation time are separate. Everything that has
    // to stay in step with the server -- prediction, input, snapshots -- runs on
    // real time; only what is drawn is slowed down for the finale.
    const deltaSeconds = deltaMs / 1000;
    const scaledSeconds = deltaSeconds * this.updateTimeScale(now);

    this.updateAim();
    this.runFixedSteps(deltaMs, now);
    this.network.flushInput(now);

    this.prediction.update(deltaSeconds);
    this.renderLocalPlayer(deltaSeconds);
    this.renderRemotePlayers(now, deltaSeconds);
    for (const view of this.playerViews.values()) view.tickDeath(scaledSeconds);
    this.updateFinale(now, scaledSeconds);
    this.renderProjectiles(now);
    for (const view of this.warningViews.values()) view.render(deltaSeconds);
    this.renderGrenades(now, deltaSeconds);
    this.renderShrinkWalls(deltaSeconds);
    this.updateCamera(deltaSeconds);
  }

  /** Drop any running finale and put everything it touched back. */
  private cancelFinale(): void {
    if (this.finaleStartedAt === 0 && this.finaleWinnerId === "") return;

    this.finaleStartedAt = 0;
    this.finaleVictimId = "";
    this.finaleFoundWinner = false;
    this.confettiWaves = 0;
    this.setSceneTimeScale(1);
    this.cameraController?.resetZoom();

    if (this.finaleWinnerId) {
      this.playerViews.get(this.finaleWinnerId)?.setCelebrating(false);
      this.finaleWinnerId = "";
    }
  }

  /**
   * Who is left.
   *
   * The kill that ends a match leaves exactly one player alive, and the server
   * has not sent the finished state yet -- so the survivor is found here rather
   * than waited for. Falls back to the killer, which is the same person in every
   * case except a final death nobody scored.
   */
  private findSurvivor(victimId: string): string {
    const state = this.network.state;
    if (!state) return "";

    for (const [sessionId, player] of state.players) {
      if (sessionId === victimId) continue;
      if (player.alive && player.inMatch) return sessionId;
    }
    return "";
  }

  /** True while the last kill of a match is still playing out. */
  isPlayingFinale(): boolean {
    return this.finaleStartedAt !== 0;
  }

  /**
   * Advance the finale's time dilation and report the current scale.
   *
   * Driven from real time rather than from the scaled delta, or slowing time
   * down would also slow down the ramp that is meant to bring it back.
   */
  private updateTimeScale(now: number): number {
    if (this.finaleStartedAt === 0) return 1;

    const elapsed = now - this.finaleStartedAt;
    const { timeScale, easeInMs, holdMs, easeOutMs } = FINALE;
    let scale: number;

    if (elapsed < easeInMs) {
      scale = 1 - (1 - timeScale) * (elapsed / easeInMs);
    } else if (elapsed < easeInMs + holdMs) {
      scale = timeScale;
    } else {
      const progress = (elapsed - easeInMs - holdMs) / easeOutMs;
      if (progress >= 1) {
        this.finaleStartedAt = 0;
        this.setSceneTimeScale(1);
        return 1;
      }
      // Eased so the return to full speed settles rather than snapping.
      scale = timeScale + (1 - timeScale) * progress * progress;
    }

    this.setSceneTimeScale(scale);
    return scale;
  }

  /**
   * The finale, beat by beat.
   *
   * Everything here is presentation: the match was decided on the server before
   * any of it started, and nothing in this method can change who won. Run on
   * real time so the sequence keeps its own pace while the world it is watching
   * runs slowly.
   */
  private updateFinale(now: number, scaledSeconds: number): void {
    if (this.finaleStartedAt === 0) return;

    const elapsed = now - this.finaleStartedAt;

    // Beat two: leave the body and find whoever is still standing.
    if (!this.finaleFoundWinner && elapsed >= FINALE.winnerAtMs) {
      this.finaleFoundWinner = true;
      this.cameraController.zoomTo(FINALE.winnerZoom, FINALE.cameraEaseMs);
      this.playerViews.get(this.finaleWinnerId)?.setCelebrating(true);
    }

    if (this.finaleFoundWinner) {
      const winner = this.playerViews.get(this.finaleWinnerId);
      winner?.tickCelebration(scaledSeconds, FINALE.celebrateHop, FINALE.celebrateHz);

      // A wave of confetti every so often, so the screen keeps filling rather
      // than emptying while the winner is still bouncing.
      const due = Math.min(
        FINALE.confettiWaves,
        Math.floor((elapsed - FINALE.winnerAtMs) / FINALE.confettiGapMs) + 1,
      );
      while (this.confettiWaves < due) {
        this.confettiWaves++;
        this.effects.confetti(this.cameras.main.worldView, FINALE.confettiPerWave);
      }
    }
  }

  /**
   * Where the camera should be looking during the finale, if anywhere.
   *
   * The body first, then the winner. Returning null hands the camera back to
   * whatever it was following.
   */
  private finaleCameraTarget(): { x: number; y: number; aimAngle: number } | null {
    if (this.finaleStartedAt === 0) return null;

    const id = this.finaleFoundWinner ? this.finaleWinnerId : this.finaleVictimId;
    const view = this.playerViews.get(id);
    if (!view) return null;

    return { x: view.container.x, y: view.container.y, aimAngle: 0 };
  }

  /** Tweens and timers run on the same clock as the rendering. */
  private setSceneTimeScale(scale: number): void {
    if (Math.abs(this.timeScale - scale) < 0.001) return;
    this.timeScale = scale;
    this.tweens.timeScale = scale;
    this.time.timeScale = scale;
  }

  /**
   * Somebody was killed.
   *
   * Every kill gets its burst -- until now only the local player's own death
   * produced one, so a kill across the arena looked like a player quietly
   * disappearing. The one that ends the match also slows time down, and the
   * shell holds the results screen back until that has played out.
   */
  private onKill(payload: KillPayload): void {
    const view = this.playerViews.get(payload.victimId);
    if (view) this.effects.deathBurst(view.container.x, view.container.y, view.colorValue);

    if (!payload.endsMatch) return;

    this.finaleStartedAt = performance.now();
    this.finaleVictimId = payload.victimId;
    this.finaleWinnerId = this.findSurvivor(payload.victimId);
    this.finaleFoundWinner = false;
    this.confettiWaves = 0;

    const shake = this.effects.shakeFor("finalKill");
    this.cameraController.shake(shake.durationMs, shake.intensity);
    // Push in on the body: this is the moment the slow motion exists to show.
    this.cameraController.zoomTo(FINALE.victimZoom, FINALE.cameraEaseMs);

    // Real time, deliberately: `this.time` is dilated by the very effect being
    // waited on, so a scene timer here would stretch with it and the results
    // would arrive late by exactly however much time was slowed.
    window.setTimeout(() => this.hooks.onFinaleComplete(), FINALE.resultsAfterMs);
  }

  private renderGrenades(now: number, deltaSeconds: number): void {
    const state = this.network.state;
    if (!state) return;
    for (const [id, view] of this.grenadeViews) {
      view.render(now, deltaSeconds, state.grenades.get(id)?.fuseSeconds ?? 0);
    }
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
      const shot = this.prediction.predict(input);
      this.network.queueInput(input);
      if (shot) this.showLocalShot(shot);
    }

    if (ticks === MAX_TICKS_PER_FRAME) this.accumulatorMs = 0;

    // Whatever is left over is how far into the next step this frame sits. The
    // renderer uses it to place the player between two steps instead of on the
    // last one, which is the difference between a smooth jump and a stuttering
    // one on any display that is not exactly in step with the simulation.
    this.prediction.setStepProgress(this.accumulatorMs / FIXED_DELTA_MS);
    void now;
  }

  /**
   * Immediate muzzle feedback for a predicted shot.
   *
   * Drawn from the *rendered* position so the flash sits on the barrel being
   * drawn this frame, not on the simulation position half a step ahead of it.
   * The projectile-driven flash stacks once per pellet, so this stacks the same
   * way -- a shotgun's flash is as bright as the one everybody else sees.
   */
  private showLocalShot(shot: PredictedShot): void {
    const x = this.prediction.renderX + Math.cos(shot.aimAngle) * PLAYER.MUZZLE_OFFSET_X;
    const y =
      this.prediction.renderY + PLAYER.AIM_ORIGIN_Y + Math.sin(shot.aimAngle) * PLAYER.MUZZLE_OFFSET_X;

    for (let pellet = 0; pellet < shot.pellets; pellet++) {
      this.effects.muzzleFlash(x, y, shot.aimAngle, shot.weaponId);
    }

    const shake = this.effects.shakeFor(shot.pellets > 1 ? "ownShotgun" : "ownShot");
    this.cameraController.shake(shake.durationMs, shake.intensity);

    this.hooks.onLocalShot(shot, x, y);
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
        weaponId: player.weaponId,
        grenades: player.grenades,
      },
      deltaSeconds,
    );

    // Measured from this client's own press, so the arrow grows at frame rate
    // rather than in 20Hz steps. The server measures the same button over the
    // same ticks, so a full arrow really is a full-power throw.
    view.setThrowCharge(this.inputController.chargeProgress(getGrenadeConfig().maxChargeMs));
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
          weaponId: player.weaponId,
          grenades: player.grenades,
        },
        deltaSeconds,
      );
      view.setSpectated(sessionId === this.spectateTargetId && !this.isLocalAlive());
      view.setThrowCharge(this.remoteThrowCharge(sessionId, player.chargingGrenade, now));
    }
  }

  /**
   * How far along somebody else's wind-up is.
   *
   * Only the *fact* of a wind-up is synchronised, not its progress -- so this
   * times it from when the flag was first seen. It is an approximation by
   * construction (it starts a fraction of a patch late) and that is fine: this
   * is a warning to whoever can see them, not a number anybody acts on. What
   * decides the throw is the button held on the server.
   */
  private remoteThrowCharge(sessionId: string, charging: boolean, now: number): number {
    if (!charging) {
      this.throwStartedAt.delete(sessionId);
      return 0;
    }

    const startedAt = this.throwStartedAt.get(sessionId) ?? now;
    this.throwStartedAt.set(sessionId, startedAt);

    const maxCharge = Math.max(1, getGrenadeConfig().maxChargeMs);
    return Math.min(1, (now - startedAt) / maxCharge);
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
    // The finale takes the camera: for those few seconds it is showing the match
    // its ending rather than showing the player their own position.
    const finale = this.finaleCameraTarget();
    if (finale) return finale;

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

  get trapCount(): number {
    return this.trapViews.size;
  }

  /** How many traps are dangerous right now. Read from state, never inferred. */
  get activeTrapCount(): number {
    let count = 0;
    for (const phase of this.trapPhases.values()) {
      if (phase === TrapPhase.ACTIVE) count++;
    }
    return count;
  }

  get grenadeCount(): number {
    return this.grenadeViews.size;
  }

  /**
   * What the on-screen controls are asking for.
   *
   * Routed through the scene because the input controller belongs to it, and the
   * controls are DOM the shell owns -- neither should have to know the other
   * exists.
   */
  setTouchIntent(intent: TouchIntent): void {
    this.inputController?.setTouchIntent(intent);
  }

  /** Apply the player's effects preferences. Safe to call before `begin`. */
  applyEffectsSettings(settings: EffectsSettings): void {
    this.effectsSettings = { ...settings };
    this.effects?.applySettings(this.effectsSettings);
  }

  /** Where the camera is looking, used to place the audio listener. */
  getCameraCentre(): { x: number; y: number } | null {
    if (!this.started) return null;
    const camera = this.cameras.main;
    return { x: camera.worldView.centerX, y: camera.worldView.centerY };
  }

  /** Local wind-up progress, 0..1, for the HUD power bar. */
  getGrenadeChargeProgress(maxChargeMs: number): number {
    return this.inputController.chargeProgress(maxChargeMs);
  }

  /** Tear everything down when leaving a room, so the scene can be reused. */
  teardown(): void {
    this.started = false;

    for (const view of this.playerViews.values()) view.destroy();
    this.playerViews.clear();
    this.remoteBuffers.clear();

    for (const view of this.projectileViews.values()) view.destroy();
    this.projectileViews.clear();

    for (const view of this.warningViews.values()) view.destroy();
    this.warningViews.clear();
    for (const view of this.trapViews.values()) view.destroy();
    this.trapViews.clear();
    this.trapPhases.clear();
    this.arenaRenderer?.destroy();
    this.accumulatorMs = 0;
    this.wasAlive = false;
    this.cancelFinale();
    this.spectateTargetId = "";
    void CAMERA;
  }
}
