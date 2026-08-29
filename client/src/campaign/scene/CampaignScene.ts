/**
 * The single-player stage.
 *
 * Renders a `CampaignDirector`'s local simulation with the same building
 * blocks the multiplayer scene uses -- the arena renderer, the entity views,
 * the effects system, the input controller, the camera. There is no network
 * anywhere below this: the director owns the world, this scene draws it and
 * feeds it the player's buttons.
 *
 * Views are kept in step by diffing the simulation state every frame rather
 * than by subscription: the state lives in this process, the maps are small,
 * and a diff is simpler than teaching the schema to broadcast to itself.
 */
import Phaser from "phaser";
import {
  MatchState,
  ServerMessage,
  damp,
  CAMPAIGN_ENEMIES,
  getCampaignEnemy,
  getGrenadeConfig,
  getPowerUp,
  type CampaignZone,
  type CrateDestroyedPayload,
  type DamagePayload,
  type ExplosionPayload,
  type KillPayload,
  type MeleeSwingPayload,
  type PowerUpCollectedPayload,
  type SyncedCrate,
  type SyncedGrenade,
  type SyncedPlayer,
  type SyncedPowerUp,
  type SyncedProjectile,
  type SyncedTrap,
} from "@deathmatch/shared";
import { ArenaRenderer } from "../../game/ArenaRenderer.js";
import { CameraController } from "../../game/CameraController.js";
import { EffectsSystem } from "../../game/EffectsSystem.js";
import { InputController } from "../../game/InputController.js";
import { generateWeaponTextures } from "../../game/TextureFactory.js";
import { CrateView } from "../../game/entities/CrateView.js";
import { GrenadeView } from "../../game/entities/GrenadeView.js";
import { PlayerView } from "../../game/entities/PlayerView.js";
import { ViewMap } from "../../game/entities/ViewMap.js";
import { PowerUpView } from "../../game/entities/PowerUpView.js";
import { ProjectileView } from "../../game/entities/ProjectileView.js";
import { TrapView } from "../../game/entities/TrapView.js";
import type { CampaignDirector } from "../core/CampaignDirector.js";
import { LOCAL_PLAYER_ID } from "../sim/LocalMatch.js";

export const CAMPAIGN_SCENE_KEY = "CampaignScene";

/**
 * How quickly the camera's limits close on a new lock, per second.
 *
 * Roughly half a second to settle: fast enough that a fight feels framed the
 * moment it starts, slow enough to read as a camera move rather than a cut.
 */
const CAMERA_BOUNDS_SMOOTHING = 0.0005;

/** What the scene reports up to the app shell (sounds, HUD flashes). */
export interface CampaignSceneEvents {
  onDamage(payload: DamagePayload): void;
  onProjectileSpawned(weaponId: string, x: number, y: number, ownerIsLocal: boolean): void;
  onExplosion(payload: ExplosionPayload): void;
  onPowerUpCollected(payload: PowerUpCollectedPayload): void;
}

export class CampaignScene extends Phaser.Scene {
  private director: CampaignDirector | null = null;
  private hooks: CampaignSceneEvents | null = null;

  private arenaRenderer?: ArenaRenderer;
  private cameraController?: CameraController;
  private inputController?: InputController;
  private effects?: EffectsSystem;

  private readonly playerViews = new ViewMap<SyncedPlayer, PlayerView>();
  private readonly projectileViews = new ViewMap<SyncedProjectile, ProjectileView>();
  private readonly crateViews = new ViewMap<SyncedCrate, CrateView>();
  private readonly powerUpViews = new ViewMap<SyncedPowerUp, PowerUpView>();
  private readonly grenadeViews = new ViewMap<SyncedGrenade, GrenadeView>();
  private readonly trapViews = new ViewMap<SyncedTrap, TrapView>();

  private readonly unsubscribes: (() => void)[] = [];
  /** Real time of the last update; Phaser's smoothed delta under-reports on a
   *  struggling machine, and the simulation must track the wall clock. */
  private lastUpdateAt = 0;

  /*
   * Camera limits, eased rather than set.
   *
   * Locking a zone by writing `setBounds` straight in re-clamps the camera on
   * the spot, which reads as a cut: the arena jumps sideways the instant a
   * fight starts. Holding a current and a target rectangle and closing the gap
   * every frame turns the same lock into a move the eye can follow.
   */
  private readonly bounds = { x: 0, y: 0, width: 0, height: 0 };
  private readonly targetBounds = { x: 0, y: 0, width: 0, height: 0 };
  private zoneOverlay: Phaser.GameObjects.Graphics | null = null;
  private debugZones = false;
  /** While paused the world is frozen but still drawn. */
  private paused = false;

  constructor() {
    super({ key: CAMPAIGN_SCENE_KEY });
  }

  create(): void {
    this.cameras.main.setBackgroundColor(0x0a0d14);
  }

  /** Called by the app shell once a director has a level loaded. */
  begin(director: CampaignDirector, hooks: CampaignSceneEvents): void {
    this.end();
    this.director = director;
    this.hooks = hooks;

    const arena = director.match.arena;
    generateWeaponTextures(this);
    this.arenaRenderer = new ArenaRenderer(this, arena);
    this.cameraController = new CameraController(this, arena);
    this.inputController = new InputController(this);
    this.inputController.setEnabled(true);
    this.effects = new EffectsSystem(this);

    Object.assign(this.bounds, { x: 0, y: 0, width: arena.width, height: arena.height });
    Object.assign(this.targetBounds, this.bounds);
    this.cameras.main.setBounds(0, 0, arena.width, arena.height);
    this.lastUpdateAt = 0;
    this.cameraController.snapTo(director.player()?.x ?? arena.width / 2, director.player()?.y ?? arena.height / 2);

    this.subscribe(director);
  }

  /** Tear the stage down; safe to call twice. */
  end(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;

    for (const views of [
      this.playerViews,
      this.projectileViews,
      this.crateViews,
      this.powerUpViews,
      this.grenadeViews,
      this.trapViews,
    ]) {
      views.destroyAll();
    }

    this.zoneOverlay?.destroy();
    this.zoneOverlay = null;
    this.arenaRenderer?.destroy();
    this.arenaRenderer = undefined;
    this.inputController?.setEnabled(false);
    this.inputController = undefined;
    this.effects = undefined;
    this.cameraController = undefined;
    this.director = null;
    this.hooks = null;
  }

  override update(): void {
    const director = this.director;
    if (!director || !this.inputController) return;

    // Real elapsed time, not Phaser's smoothed delta: on a struggling machine
    // the smoothed value under-reports and the whole world would slow down.
    const nowMs = performance.now();
    const deltaMs = this.lastUpdateAt === 0 ? 1000 / 60 : Math.min(250, nowMs - this.lastUpdateAt);
    this.lastUpdateAt = nowMs;

    // Paused: keep drawing what is there, advance nothing. The clock is
    // re-based above, so unpausing does not hand the simulation the whole
    // time the menu was open.
    if (this.paused) {
      this.syncViews();
      return;
    }

    // Buttons in, one tick of the world out -- once per fixed step, so a slow
    // frame that simulates several ticks still moves at full speed.
    director.update(deltaMs, () => {
      if (director.isOver()) return;
      const player = director.player();
      if (!player?.alive || !this.inputController) return;
      this.inputController.updateAim(player.x, player.y);
      director.match.applyInput(this.inputController.sample());
    });

    this.syncViews();

    // A dead body is thrown and faded by its own animation; without this it
    // simply stood there until the corpse sweep removed it seconds later.
    const deltaSeconds = deltaMs / 1000;
    for (const view of this.playerViews.values()) view.tickDeath(deltaSeconds);

    this.updateCameraBounds(deltaSeconds);
    this.followPlayer(deltaSeconds);
    if (this.debugZones) this.drawZoneOverlay();
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  /** null returns to plain follow across the whole arena. */
  setCameraLock(zone: CampaignZone | null): void {
    const arena = this.director?.match.arena;
    if (!arena) return;
    Object.assign(
      this.targetBounds,
      zone ? zone : { x: 0, y: 0, width: arena.width, height: arena.height },
    );
  }

  /** Close the gap to the wanted limits, then hand them to the camera. */
  private updateCameraBounds(deltaSeconds: number): void {
    const close = (from: number, to: number) => damp(from, to, CAMERA_BOUNDS_SMOOTHING, deltaSeconds);
    this.bounds.x = close(this.bounds.x, this.targetBounds.x);
    this.bounds.y = close(this.bounds.y, this.targetBounds.y);
    this.bounds.width = close(this.bounds.width, this.targetBounds.width);
    this.bounds.height = close(this.bounds.height, this.targetBounds.height);
    this.cameras.main.setBounds(this.bounds.x, this.bounds.y, this.bounds.width, this.bounds.height);
  }

  shake(intensity: number): void {
    this.cameraController?.shake(260, intensity);
  }

  /**
   * The pointer in real screen (CSS) pixels, for the DOM crosshair.
   *
   * Phaser reports the pointer in the game's logical 1280x720 units; the
   * canvas is FIT-scaled to the window, so those must be mapped through the
   * scale manager or the crosshair drifts away from the mouse everywhere but
   * the canvas origin -- the same transform the multiplayer scene does.
   */
  getPointerScreenPosition(): { x: number; y: number } {
    const pointer = this.input.activePointer;
    const scale = this.scale;
    return {
      x: (pointer.x / scale.gameSize.width) * scale.displaySize.width + scale.canvasBounds.x,
      y: (pointer.y / scale.gameSize.height) * scale.displaySize.height + scale.canvasBounds.y,
    };
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.inputController?.setEnabled(!paused);
  }

  setDebugZones(enabled: boolean): void {
    this.debugZones = enabled;
    if (!enabled) {
      this.zoneOverlay?.destroy();
      this.zoneOverlay = null;
    }
  }

  private followPlayer(deltaSeconds: number): void {
    const player = this.director?.player();
    if (!player || !this.cameraController) return;
    this.cameraController.follow(player.x, player.y, player.aimAngle, deltaSeconds);
  }

  // -------------------------------------------------------------------------
  // View sync (diff against the local state each frame)
  // -------------------------------------------------------------------------

  private syncViews(): void {
    const director = this.director!;
    const state = director.match.state;
    const now = performance.now();
    const deltaSeconds = this.game.loop.delta / 1000;

    // Players (the local one and every enemy).
    this.playerViews.sync(
      state.players,
      (player, sessionId) => {
        const isLocal = sessionId === LOCAL_PLAYER_ID;
        const enemyType = isLocal ? null : this.enemyTypeFor(player.name);
        const view = new PlayerView(this, sessionId, player.name, isLocal, enemyType?.color);
        // Read from state rather than from the definition: the size the shot
        // test uses is the size that gets drawn, by construction.
        if (player.bodyScale !== 1) view.setBodyScale(player.bodyScale);
        return view;
      },
      (view, player, sessionId) => {
        view.setName(player.name);
        view.apply(
          {
            x: player.x,
            y: player.y,
            aimAngle: player.aimAngle,
            facing: player.facing as 1 | -1,
            alive: player.alive && player.inMatch,
            onGround: player.onGround,
            health: player.health,
            maxHealth: player.maxHealth,
            speedX: player.velocityX,
            matchLive: state.matchState === MatchState.PLAYING,
            ammo: player.ammo,
            reloading: player.reloading,
            weaponId: player.weaponId,
            grenades: player.grenades,
          },
          deltaSeconds,
        );

        /*
         * The wind-up indicator, the same arrow multiplayer draws and for the
         * same reason: a grenade you cannot aim is a grenade you throw at the
         * ceiling. Read from this client's own button rather than from the
         * simulation, so it grows at frame rate -- and here that is not even a
         * shortcut, because in single player this client *is* the simulation.
         */
        if (sessionId === LOCAL_PLAYER_ID) {
          view.setThrowCharge(this.inputController?.chargeProgress(getGrenadeConfig().maxChargeMs) ?? 0);
        }
      },
    );

    // Projectiles: fed the live object, rendered at it exactly.
    this.projectileViews.sync(
      state.projectiles,
      (projectile) => {
        this.hooks?.onProjectileSpawned(
          projectile.weaponId,
          projectile.x,
          projectile.y,
          projectile.ownerId === LOCAL_PLAYER_ID,
        );
        return new ProjectileView(this, projectile, now);
      },
      (view) => {
        view.syncFromServer(now);
        view.render(now);
      },
    );

    // Crates. `refresh` only aims the view at the authoritative position --
    // `render` is what actually moves it, and without that call a crate stayed
    // drawn wherever it first appeared while the simulation carried it off:
    // shots then flew through the picture of a crate that was no longer there.
    this.crateViews.sync(
      state.crates,
      (crate) => new CrateView(this, crate),
      (view, crate) => {
        view.refresh(crate);
        view.render(deltaSeconds);
      },
    );

    // Revealed power-ups.
    this.powerUpViews.sync(
      state.powerUps,
      (powerUp) => new PowerUpView(this, powerUp),
      (view, powerUp) => view.refresh(powerUp),
    );

    this.grenadeViews.sync(
      state.grenades,
      (grenade) => new GrenadeView(this, grenade, now),
      (view, grenade) => {
        view.syncFromServer(grenade, now);
        view.render(now, deltaSeconds, grenade.fuseSeconds);
      },
    );

    this.trapViews.sync(
      state.traps,
      (trap) => new TrapView(this, trap),
      (view, trap) => view.refresh(trap),
    );
  }

  /** Enemy display names map back to their catalogue entry for colours. */
  private enemyTypeFor(name: string) {
    const type = getCampaignEnemy(name.toLowerCase());
    if (type) return type;
    const boss = this.director?.levelDefinition().boss;
    if (boss && name === boss.name) return getCampaignEnemy(boss.enemyType);
    // The catalogue itself, not a copy of its ids: a list written here would
    // quietly stop matching the day an enemy type is added.
    return CAMPAIGN_ENEMIES.find((entry) => entry.name === name) ?? null;
  }

  // -------------------------------------------------------------------------
  // Effects from the simulation's own events
  // -------------------------------------------------------------------------

  private subscribe(director: CampaignDirector): void {
    const events = director.match.events;
    const on = (type: string, handler: (payload: never) => void) => {
      this.unsubscribes.push(events.on(type, handler as (payload: unknown) => void));
    };

    on(ServerMessage.DAMAGE, (payload: DamagePayload) => {
      const mine = payload.attackerId === LOCAL_PLAYER_ID && payload.victimId !== LOCAL_PLAYER_ID;
      const taken = payload.victimId === LOCAL_PLAYER_ID;
      this.effects?.damageNumber(payload.x, payload.y - 20, payload.amount, payload.fatal, mine ? "mine" : taken ? "taken" : "other");
      if (taken) this.cameraController?.shake(120, 0.004);
      this.hooks?.onDamage(payload);
    });

    on(ServerMessage.KILL, (payload: KillPayload) => {
      const view = this.playerViews.get(payload.victimId);
      if (view) this.effects?.deathBurst(view.container.x, view.container.y, view.colorValue);
    });

    on(ServerMessage.EXPLOSION, (payload: ExplosionPayload) => {
      this.effects?.burst("explosion", payload.x, payload.y);
      this.cameraController?.shake(200, 0.008);
      this.hooks?.onExplosion(payload);
    });

    on(ServerMessage.MELEE_SWING, (payload: MeleeSwingPayload) => {
      const swinger = director.match.state.players.get(payload.sessionId);
      if (swinger && payload.connected) {
        this.effects?.burst("fleshImpact", swinger.x, swinger.y, payload.aimAngle);
      }
    });

    on(ServerMessage.CRATE_DESTROYED, (payload: CrateDestroyedPayload) => {
      this.effects?.burst("crateBreak", payload.x, payload.y);
    });

    on(ServerMessage.POWERUP_COLLECTED, (payload: PowerUpCollectedPayload) => {
      const color = getPowerUp(payload.powerUpId)?.color ?? 0xffffff;
      this.effects?.tintedBurst("pickup", payload.x, payload.y, color);
      this.hooks?.onPowerUpCollected(payload);
    });

    this.unsubscribes.push(
      director.ui.on("cameraLock", ({ zoneId }) => {
        const zone = zoneId
          ? director.levelDefinition().cameraZones.find((candidate) => candidate.id === zoneId)?.zone ?? null
          : null;
        this.setCameraLock(zone);
      }),
    );
    this.unsubscribes.push(director.ui.on("shake", ({ intensity }) => this.shake(intensity)));
  }

  // -------------------------------------------------------------------------
  // Debug overlay: zones drawn over the world
  // -------------------------------------------------------------------------

  private drawZoneOverlay(): void {
    const director = this.director;
    if (!director) return;
    if (!this.zoneOverlay) this.zoneOverlay = this.add.graphics().setDepth(40);

    const level = director.levelDefinition();
    const overlay = this.zoneOverlay;
    overlay.clear();

    const draw = (zone: CampaignZone, color: number) => {
      overlay.lineStyle(2, color, 0.8);
      overlay.strokeRect(zone.x, zone.y, zone.width, zone.height);
    };

    for (const trigger of level.triggers) {
      if (trigger.when.kind === "enterZone") draw(trigger.when.zone, 0x38bdf8);
    }
    for (const checkpoint of level.checkpoints) draw(checkpoint.zone, 0x52e08a);
    for (const secret of level.secrets) draw(secret.zone, 0xffd75e);
    for (const cameraZone of level.cameraZones) draw(cameraZone.zone, 0xb39ddb);
  }
}
