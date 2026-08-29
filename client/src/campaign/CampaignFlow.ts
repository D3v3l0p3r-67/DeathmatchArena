/**
 * The single-player campaign, from the menu to the results screen.
 *
 * `App` is the shell: it owns the connection, the menus and the multiplayer
 * match. The campaign is a whole game of its own hanging off one button, and
 * for a while it lived inside the shell -- roughly two thirds of `App` was
 * campaign flow, which made both harder to read than either deserved.
 *
 * This owns the run: which level is being played, what has been cleared and
 * carried, the pause state, the scene lifecycle and the debug keys. It
 * coordinates rather than implements -- the simulation is `CampaignDirector`'s,
 * the drawing is `CampaignScene`'s, the screens are `CampaignUI`'s -- so it is
 * mostly a sequence of "when this happens, tell those three".
 */
import Phaser from "phaser";
import {
  CAMPAIGN_LEVELS,
  campaignChain,
  getCampaignArena,
  getCampaignLevel,
  getWeapon,
  loadGameConfig,
  type CampaignDifficultyId,
  type CampaignLevelDefinition,
  type CampaignRun,
} from "@deathmatch/shared";
import type { AudioEngine } from "../audio/AudioEngine.js";
import { SoundId } from "../audio/sounds.js";
import type { SoundController } from "../audio/SoundController.js";
import { clientConfig } from "../config.js";
import type { HUD } from "../ui/HUD.js";
import type { CampaignUI } from "../ui/CampaignUI.js";
import type { MenuNavigator } from "../ui/MenuNavigator.js";
import type { UIManager } from "../ui/UIManager.js";
import { toggleClass } from "../ui/dom.js";
import { CampaignDirector } from "./core/CampaignDirector.js";
import { HttpCampaignSync, SaveStore } from "./core/SaveStore.js";
import { buildCampaignConfig, LOCAL_PLAYER_ID } from "./sim/LocalMatch.js";
import { CampaignScene, CAMPAIGN_SCENE_KEY, type CampaignSceneEvents } from "./scene/CampaignScene.js";

/** How long the game-over card holds the screen before the results replace it. */
const GAME_OVER_HOLD_MS = 2000;

/** What the flow needs from the shell around it. */
export interface CampaignFlowDeps {
  ui: UIManager;
  campaignUi: CampaignUI;
  hud: HUD;
  audio: AudioEngine;
  sound: SoundController;
  navigator: MenuNavigator;
  /** Opened from the pause menu. */
  openSettings(): void;
  /** The Phaser game, which is created after this flow is. */
  game(): Phaser.Game | null;
  /** The name to play under. */
  playerName(): string;
}

export class CampaignFlow {
  private director: CampaignDirector | null = null;
  private save: SaveStore | null = null;
  /** The playthrough in progress: what has been cleared, scored and carried. */
  private run: CampaignRun | null = null;
  /** What to retry, and what difficulty a chained level inherits. */
  private lastStarted: { levelId: string; difficulty: CampaignDifficultyId } | null = null;
  /** The level a briefing card is introducing, played when it is dismissed. */
  private pendingLevelId: string | null = null;
  private paused = false;
  private debugArmed = false;
  /** The game-over card is up and the results are on their way. */
  private ending = false;

  constructor(private readonly deps: CampaignFlowDeps) {
    this.bindPauseMenu();
    this.bindDebugKeys();
  }

  // -------------------------------------------------------------------------
  // What the shell asks
  // -------------------------------------------------------------------------

  get isRunning(): boolean {
    return this.director !== null;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** The live director, for anything that needs to read the run (music, HUD). */
  get current(): CampaignDirector | null {
    return this.director;
  }

  openSelect(): void {
    const save = this.saveStore();
    const chain = campaignChain();
    const checkpoint = chain.map((level) => save.loadCheckpoint(level.id)).find(Boolean) ?? null;
    this.deps.campaignUi.populate(chain, save.loadProgress(), checkpoint?.levelId ?? null);
    this.deps.ui.showScreen("campaign");
  }

  /**
   * Begin a level.
   *
   * `fresh` opens a new run: choosing a level by hand is a new attempt, while
   * taking the offered next level continues the one in progress.
   */
  start(levelId: string, difficulty: CampaignDifficultyId, resume: boolean, fresh = false): void {
    if (fresh) this.run = null;

    const level = CAMPAIGN_LEVELS.find((candidate) => candidate.id === levelId);
    const arena = level ? getCampaignArena(level.arenaId) : null;
    if (!level || !arena) return;

    // The whole simulation and every view reads the registry; single player
    // plays the defaults plus the campaign overrides, offline.
    loadGameConfig(buildCampaignConfig());

    const save = this.saveStore();
    const resumeSave = resume ? save.loadCheckpoint(levelId) : null;
    if (!resume) save.clearCheckpoint();

    const director = new CampaignDirector(level, arena, difficulty, { saveStore: save });
    this.director = director;
    this.lastStarted = { levelId, difficulty };
    this.debugArmed = false;
    this.paused = false;
    this.ending = false;

    if (!this.run || this.run.difficulty !== difficulty) {
      this.run = {
        startedLevelId: levelId,
        difficulty,
        clearedLevelIds: [],
        totalScore: 0,
        weaponId: level.startingWeapon,
        grenades: level.startingGrenades,
      };
    }
    const run = this.run;

    this.subscribe(director, level, run, save);

    this.withScene((scene) => scene.begin(director, this.sceneHooks()));
    director.start(resumeSave, this.deps.playerName() || "You", {
      weaponId: run.weaponId,
      grenades: run.grenades,
    });

    this.deps.ui.showScreen("none");
    this.deps.hud.setVisible(true);
    this.deps.hud.setCampaignMode(true);
    this.deps.campaignUi.setLayerActive(true);
    void this.deps.audio.resume();
  }

  /** Retry whatever was last played, as a fresh run. */
  retry(): void {
    if (!this.lastStarted) return;
    this.start(this.lastStarted.levelId, this.lastStarted.difficulty, false, true);
  }

  /**
   * Take the offered next level.
   *
   * The chain lives in the level data, so this only has to look up where the
   * finished level points. A level that opens with an interlude gets its card
   * first; one that does not begins straight away.
   */
  advance(): void {
    const from = this.lastStarted ? getCampaignLevel(this.lastStarted.levelId) : null;
    const next = from?.nextLevelId ? getCampaignLevel(from.nextLevelId) : null;
    if (!next) return;

    this.pendingLevelId = next.id;
    if (!next.interlude) {
      this.playPending();
      return;
    }

    // What the door lets through: only what this level's carryOver allows.
    const run = this.run;
    const chips: string[] = [];
    chips.push(getWeapon(run && next.carryOver?.weapon ? run.weaponId : next.startingWeapon).name);
    const grenades =
      run && next.carryOver?.grenades
        ? Math.max(run.grenades, next.startingGrenades)
        : next.startingGrenades;
    chips.push(`${grenades} grenades`);
    this.deps.campaignUi.setBriefingLoadout(chips);

    this.deps.campaignUi.showInterlude(next.interlude, () => this.playPending());
    this.deps.ui.showScreen("campaign-briefing");
  }

  /** Start whichever level a briefing was introducing. */
  playPending(): void {
    const levelId = this.pendingLevelId;
    if (!levelId) return;
    this.pendingLevelId = null;
    this.start(levelId, this.run?.difficulty ?? this.deps.campaignUi.difficulty, false);
  }

  /** Leave the level (or its results) and put the main menu back. */
  exit(): void {
    const manager = this.deps.game()?.scene;
    const scene = manager?.getScene(CAMPAIGN_SCENE_KEY) as CampaignScene | undefined;
    scene?.end();
    if (manager?.isActive(CAMPAIGN_SCENE_KEY)) manager.sleep(CAMPAIGN_SCENE_KEY);

    this.director = null;
    this.run = null;
    this.pendingLevelId = null;
    this.paused = false;
    this.ending = false;
    this.deps.campaignUi.hideDeath();
    this.deps.campaignUi.setLayerActive(false);
    this.deps.hud.setVisible(false);
    this.deps.hud.setCampaignMode(false);
    this.deps.ui.showScreen("menu");
  }

  /**
   * Freeze or resume the level.
   *
   * Escape used to drop the player straight out with no warning, which is a
   * fine way to lose a run to a stray key. It opens the pause menu instead.
   */
  setPaused(paused: boolean): void {
    // Nothing to pause once the run is over: the card is playing out and the
    // results are already scheduled.
    if (!this.director || this.ending) return;
    this.paused = paused;
    this.withScene((scene) => scene.setPaused(paused));

    const menu = document.getElementById("pause-menu");
    if (menu) toggleClass(menu, "is-active", paused);
    const level = document.getElementById("pause-level");
    if (level && paused) level.textContent = this.director.levelDefinition().name;

    this.deps.navigator.setEnabled(paused);
    if (paused) this.deps.navigator.focusFirst();
  }

  /**
   * Where the pointer is on screen, or null when no level is being drawn.
   *
   * The crosshair follows the mouse every rendered frame, and only the scene
   * knows where the camera has put it.
   */
  pointerScreenPosition(): { x: number; y: number } | null {
    const scene = this.deps.game()?.scene.getScene(CAMPAIGN_SCENE_KEY) as CampaignScene | undefined;
    if (!scene?.scene.isActive()) return null;
    return scene.getPointerScreenPosition();
  }

  /** The campaign's share of the per-frame UI work. */
  updateHud(): void {
    const director = this.director;
    if (!director) return;

    const player = director.player();
    const state = director.match.state;
    if (player) {
      this.deps.hud.update({
        player,
        matchState: state.matchState,
        aliveCount: director.match.aliveEnemies().length,
        totalPlayers: state.players.size - 1,
        shrinkCountdownSeconds: 0,
        shrinking: false,
        gameModeId: "campaign",
        matchClockSeconds: 0,
        suddenDeath: false,
        players: state.players,
        localSessionId: LOCAL_PLAYER_ID,
      });
    }

    this.deps.campaignUi.setStats(director.currentScore(), director.currentKills(), director.livesRemaining());
    this.deps.campaignUi.setBoss(director.bossStatus());
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The campaign's persistence: local first, with a fire-and-forget sync of
   * rare high-level events towards the server when one is reachable. Nothing
   * in the campaign ever waits for it.
   */
  private saveStore(): SaveStore {
    if (!this.save) {
      const httpBase = clientConfig.serverUrl.replace(/^ws/, "http");
      this.save = new SaveStore(new HttpCampaignSync(httpBase));
    }
    return this.save;
  }

  private subscribe(
    director: CampaignDirector,
    level: CampaignLevelDefinition,
    run: CampaignRun,
    save: SaveStore,
  ): void {
    const { campaignUi, hud, ui, audio } = this.deps;

    director.ui.on("message", ({ text, durationMs }) => campaignUi.toast(text, durationMs));
    director.ui.on("objective", ({ text }) => campaignUi.setObjective(text));
    director.ui.on("checkpoint", () => {
      campaignUi.toast("CHECKPOINT", 1800);
      audio.play(SoundId.UiClick);
    });
    director.ui.on("secretFound", ({ message }) => campaignUi.toast(message, 2500));
    director.ui.on("playerDied", ({ respawnInMs, livesLeft }) => {
      campaignUi.showDeath(livesLeft);
      window.setTimeout(() => campaignUi.hideDeath(), respawnInMs + 200);
    });

    director.ui.on("levelCompleted", ({ result }) => {
      // Fold the level into the run before anything is shown, so the results
      // screen and the next level both read the same numbers.
      const finishedWith = director.player();
      run.clearedLevelIds.push(level.id);
      run.totalScore += result.score;
      run.weaponId = finishedWith?.weaponId ?? run.weaponId;
      run.grenades = finishedWith?.grenades ?? run.grenades;

      // Was this the player's own record? Read before the save folds it in.
      const previousBest = save.loadProgress().levels[level.id]?.bestScore ?? 0;
      const next = level.nextLevelId ? getCampaignLevel(level.nextLevelId) : null;

      campaignUi.setNewBest(result.score > previousBest);
      campaignUi.setLayerActive(false);
      hud.setVisible(false);
      hud.setCampaignMode(false);
      campaignUi.showResults(result);
      campaignUi.setNextLevel(next?.name ?? null, run.clearedLevelIds.length > 1 ? run.totalScore : null);
      ui.showScreen("campaign-results");
    });

    director.ui.on("levelFailed", ({ summary }) => {
      /*
       * Held for a beat over the level itself. Swapping straight to the results
       * screen the frame the last life goes reads as a bug rather than as an
       * ending -- the player never sees what killed them.
       */
      this.ending = true;
      campaignUi.showGameOver();
      window.setTimeout(() => {
        this.ending = false;
        campaignUi.hideDeath();
        campaignUi.setLayerActive(false);
        hud.setVisible(false);
        hud.setCampaignMode(false);
        campaignUi.showFailure(summary);
        // A failed level ends the run: there is no next level to offer.
        campaignUi.setNextLevel(null, null);
        campaignUi.setNewBest(false);
        this.run = null;
        ui.showScreen("campaign-results");
      }, GAME_OVER_HOLD_MS);
    });
  }

  private sceneHooks(): CampaignSceneEvents {
    const { hud, audio, sound, campaignUi } = this.deps;
    return {
      onDamage: (payload) => {
        if (payload.victimId === LOCAL_PLAYER_ID) hud.showDamageFlash();
        else if (payload.attackerId === LOCAL_PLAYER_ID) hud.showHitmarker();
        if (payload.fatal) audio.playAt(SoundId.Death, payload.x, payload.y);
      },
      onProjectileSpawned: (weaponId, x, y) => sound.localShot(weaponId, x, y),
      onExplosion: (payload) => audio.playAt(SoundId.Explosion, payload.x, payload.y),
      onPowerUpCollected: (payload) => {
        if (payload.sessionId !== LOCAL_PLAYER_ID) return;
        campaignUi.toast(payload.name.toUpperCase(), 1500);
        audio.playAt(SoundId.PickupHealth, payload.x, payload.y);
      },
    };
  }

  /**
   * Run something on the campaign scene, starting it first if it has never
   * run. Phaser only auto-starts the first scene in the list, and a scene that
   * has not started has no systems to build views with.
   */
  private withScene(callback: (scene: CampaignScene) => void): void {
    const manager = this.deps.game()?.scene;
    if (!manager) return;
    const scene = manager.getScene(CAMPAIGN_SCENE_KEY) as CampaignScene;

    if (manager.isActive(CAMPAIGN_SCENE_KEY)) {
      callback(scene);
      return;
    }
    if (manager.isSleeping(CAMPAIGN_SCENE_KEY)) {
      manager.wake(CAMPAIGN_SCENE_KEY);
      callback(scene);
      return;
    }
    scene.events.once(Phaser.Scenes.Events.CREATE, () => callback(scene));
    manager.run(CAMPAIGN_SCENE_KEY);
  }

  private bindPauseMenu(): void {
    document.getElementById("pause-resume")?.addEventListener("click", () => this.setPaused(false));
    document.getElementById("pause-settings")?.addEventListener("click", () => this.deps.openSettings());
    document.getElementById("pause-restart")?.addEventListener("click", () => {
      this.setPaused(false);
      if (this.lastStarted) this.start(this.lastStarted.levelId, this.lastStarted.difficulty, true);
    });
    document.getElementById("pause-quit")?.addEventListener("click", () => {
      void (async () => {
        const leave = await this.deps.ui.confirm(
          "Quit to menu?",
          "The run ends here. Progress since your last checkpoint is lost.",
          "Quit",
        );
        if (!leave) return;
        this.setPaused(false);
        this.exit();
      })();
    });
  }

  /** F9 arms the level-building keys; Escape belongs to the shell's "back". */
  private bindDebugKeys(): void {
    window.addEventListener("keydown", (event) => {
      const director = this.director;
      if (!director) return;

      const scene = this.deps.game()?.scene.getScene(CAMPAIGN_SCENE_KEY) as CampaignScene | undefined;

      if (event.key === "F9") {
        this.debugArmed = !this.debugArmed;
        this.deps.campaignUi.setDebugHint(this.debugArmed);
        if (!this.debugArmed) scene?.setDebugZones(false);
        return;
      }
      if (!this.debugArmed) return;

      const key = event.key.toLowerCase();
      if (key === "g") {
        director.debugSetGodMode(!director.match.godMode);
        this.deps.campaignUi.toast(director.match.godMode ? "GOD MODE ON" : "GOD MODE OFF", 1500);
      } else if (key === "k") {
        director.debugKillAllEnemies();
        this.deps.campaignUi.toast("ENEMIES CLEARED", 1500);
      } else if (key === "z") {
        scene?.setDebugZones(true);
      } else if (key >= "1" && key <= "9") {
        const checkpoint = director.levelDefinition().checkpoints[Number(key) - 1];
        if (checkpoint) director.debugTeleport(checkpoint.x, checkpoint.y);
      }
    });
  }
}
