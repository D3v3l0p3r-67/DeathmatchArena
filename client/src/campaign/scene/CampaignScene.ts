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
  getCampaignEnemy,
  getPowerUp,
  type CampaignZone,
  type CrateDestroyedPayload,
  type DamagePayload,
  type ExplosionPayload,
  type KillPayload,
  type MeleeSwingPayload,
  type PowerUpCollectedPayload,
} from "@deathmatch/shared";
import { ArenaRenderer } from "../../game/ArenaRenderer.js";
import { CameraController } from "../../game/CameraController.js";
import { EffectsSystem } from "../../game/EffectsSystem.js";
import { InputController } from "../../game/InputController.js";
import { generateWeaponTextures } from "../../game/TextureFactory.js";
import { CrateView } from "../../game/entities/CrateView.js";
import { GrenadeView } from "../../game/entities/GrenadeView.js";
import { PlayerView } from "../../game/entities/PlayerView.js";
import { PowerUpView } from "../../game/entities/PowerUpView.js";
import { ProjectileView } from "../../game/entities/ProjectileView.js";
import { TrapView } from "../../game/entities/TrapView.js";
import type { CampaignDirector } from "../core/CampaignDirector.js";
import { LOCAL_PLAYER_ID } from "../sim/LocalMatch.js";

export const CAMPAIGN_SCENE_KEY = "CampaignScene";

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

  private readonly playerViews = new Map<string, PlayerView>();
  private readonly projectileViews = new Map<string, ProjectileView>();
  private readonly crateViews = new Map<string, CrateView>();
  private readonly powerUpViews = new Map<string, PowerUpView>();
  private readonly grenadeViews = new Map<string, GrenadeView>();
  private readonly trapViews = new Map<string, TrapView>();

  private readonly unsubscribes: (() => void)[] = [];
  /** Real time of the last update; Phaser's smoothed delta under-reports on a
   *  struggling machine, and the simulation must track the wall clock. */
  private lastUpdateAt = 0;
  private zoneOverlay: Phaser.GameObjects.Graphics | null = null;
  private debugZones = false;

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
    ] as Map<string, { destroy(): void }>[]) {
      for (const view of views.values()) view.destroy();
      views.clear();
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
    this.followPlayer(deltaMs / 1000);
    if (this.debugZones) this.drawZoneOverlay();
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  /** null returns to plain follow across the whole arena. */
  setCameraLock(zone: CampaignZone | null): void {
    const arena = this.director?.match.arena;
    if (!arena) return;
    if (zone) this.cameras.main.setBounds(zone.x, zone.y, zone.width, zone.height);
    else this.cameras.main.setBounds(0, 0, arena.width, arena.height);
  }

  shake(intensity: number): void {
    this.cameraController?.shake(260, intensity);
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

    // Players (the local one and every enemy).
    for (const [sessionId, player] of state.players) {
      let view = this.playerViews.get(sessionId);
      if (!view) {
        const isLocal = sessionId === LOCAL_PLAYER_ID;
        const enemyType = isLocal ? null : this.enemyTypeFor(player.name);
        view = new PlayerView(this, sessionId, player.name, isLocal, enemyType?.color);
        if (enemyType?.bodyScale) view.setBodyScale(enemyType.bodyScale);
        this.playerViews.set(sessionId, view);
      }
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
          speedX: player.velocityX,
          matchLive: state.matchState === MatchState.PLAYING,
          ammo: player.ammo,
          reloading: player.reloading,
          weaponId: player.weaponId,
          grenades: player.grenades,
        },
        this.game.loop.delta / 1000,
      );
    }
    for (const [sessionId, view] of this.playerViews) {
      if (state.players.has(sessionId)) continue;
      view.destroy();
      this.playerViews.delete(sessionId);
    }

    // Projectiles: fed the live object, rendered at it exactly.
    for (const [id, projectile] of state.projectiles) {
      let view = this.projectileViews.get(id);
      if (!view) {
        view = new ProjectileView(this, projectile, now);
        this.projectileViews.set(id, view);
        this.hooks?.onProjectileSpawned(
          projectile.weaponId,
          projectile.x,
          projectile.y,
          projectile.ownerId === LOCAL_PLAYER_ID,
        );
      }
      view.syncFromServer(now);
      view.render(now);
    }
    for (const [id, view] of this.projectileViews) {
      if (state.projectiles.has(id)) continue;
      view.destroy();
      this.projectileViews.delete(id);
    }

    // Crates.
    for (const [id, crate] of state.crates) {
      let view = this.crateViews.get(id);
      if (!view) {
        view = new CrateView(this, crate);
        this.crateViews.set(id, view);
      }
      view.refresh(crate);
    }
    for (const [id, view] of this.crateViews) {
      if (state.crates.has(id)) continue;
      view.destroy();
      this.crateViews.delete(id);
    }

    // Revealed power-ups.
    for (const [id, powerUp] of state.powerUps) {
      let view = this.powerUpViews.get(id);
      if (!view) {
        view = new PowerUpView(this, powerUp);
        this.powerUpViews.set(id, view);
      }
      view.refresh(powerUp);
    }
    for (const [id, view] of this.powerUpViews) {
      if (state.powerUps.has(id)) continue;
      view.destroy();
      this.powerUpViews.delete(id);
    }

    // Grenades.
    for (const [id, grenade] of state.grenades) {
      let view = this.grenadeViews.get(id);
      if (!view) {
        view = new GrenadeView(this, grenade, now);
        this.grenadeViews.set(id, view);
      }
      view.syncFromServer(grenade, now);
      view.render(now, this.game.loop.delta / 1000, grenade.fuseSeconds);
    }
    for (const [id, view] of this.grenadeViews) {
      if (state.grenades.has(id)) continue;
      view.destroy();
      this.grenadeViews.delete(id);
    }

    // Traps.
    for (const [id, trap] of state.traps) {
      let view = this.trapViews.get(id);
      if (!view) {
        view = new TrapView(this, trap);
        this.trapViews.set(id, view);
      }
      view.refresh(trap);
    }
  }

  /** Enemy display names map back to their catalogue entry for colours. */
  private enemyTypeFor(name: string) {
    const type = getCampaignEnemy(name.toLowerCase());
    if (type) return type;
    const boss = this.director?.levelDefinition().boss;
    if (boss && name === boss.name) return getCampaignEnemy(boss.enemyType);
    // Catalogue names are capitalised versions of their ids.
    return (
      [...["soldier", "runner", "sniper", "grenadier", "heavy", "turret"]]
        .map((id) => getCampaignEnemy(id))
        .find((entry) => entry?.name === name) ?? null
    );
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
