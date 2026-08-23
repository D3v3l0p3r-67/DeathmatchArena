import Phaser from "phaser";
import {
  CAMERA,
  getMatchConfig,
  MatchState,
  validatePlayerName,
  type MatchResultMessage,
  type MatchStateValue,
  getGrenadeConfig,
  type PowerUpCollectedPayload,
} from "@deathmatch/shared";
import { AudioEngine, DEFAULT_AUDIO_SETTINGS } from "./audio/AudioEngine.js";
import { SoundController } from "./audio/SoundController.js";
import { SoundId } from "./audio/sounds.js";
import { clientConfig } from "./config.js";
import { DEFAULT_EFFECTS_SETTINGS } from "./game/fx/effects.js";
import { SettingsPanel, loadEffectsSettings } from "./ui/SettingsPanel.js";
import { NetworkManager } from "./net/NetworkManager.js";
import { BootScene, BOOT_SCENE_KEY } from "./game/scenes/BootScene.js";
import { GameScene, GAME_SCENE_KEY } from "./game/scenes/GameScene.js";
import { DebugConsole } from "./ui/DebugConsole.js";
import { DebugOverlay } from "./ui/DebugOverlay.js";
import { HUD } from "./ui/HUD.js";
import { KillFeed } from "./ui/KillFeed.js";
import { UIManager } from "./ui/UIManager.js";

/** HUD text does not need to change 60 times a second. */
const HUD_UPDATE_INTERVAL_MS = 80;

/**
 * Application shell.
 *
 * Wires the three independent pieces together -- the Colyseus connection, the DOM
 * UI and the Phaser scene -- and owns the screen flow:
 *
 *   menu -> matchmaking -> lobby -> countdown -> game -> (death -> spectate) -> results
 *
 * Screen transitions follow the server's `matchState`, never a local guess.
 */
export class App {
  private readonly network = new NetworkManager();
  private readonly ui: UIManager;
  private readonly hud = new HUD();
  private readonly killFeed: KillFeed;
  private readonly audio = new AudioEngine();
  private readonly sound: SoundController;
  private readonly settings: SettingsPanel;

  private readonly debug = new DebugOverlay();
  private readonly debugConsole = new DebugConsole({
    runCommand: (commandId, params) => this.network.sendDebugCommand(commandId, params),
  });

  /**
   * Shift+D opens the debug console.
   *
   * The listener is always attached; the console itself ignores the key until
   * the server has granted this session access. Binding it conditionally would
   * only move the same check somewhere less obvious.
   */
  private bindDebugConsoleKey(): void {
    window.addEventListener("keydown", (event) => {
      if (!event.shiftKey || event.code !== "KeyD") return;
      if (event.target instanceof HTMLInputElement) return;
      event.preventDefault();
      this.debugConsole.toggle();
    });
  }

  private game: Phaser.Game | null = null;
  private gameScene: GameScene | null = null;

  private joining = false;
  private lastHudUpdate = 0;
  private resultsEndsAt = 0;
  private lastResult: MatchResultMessage | null = null;

  constructor() {
    this.killFeed = new KillFeed(() => this.network.sessionId);

    this.sound = new SoundController(this.audio, this.network);
    this.settings = new SettingsPanel(
      { audio: { ...DEFAULT_AUDIO_SETTINGS, ...this.audio.getSettings() }, effects: loadEffectsSettings(DEFAULT_EFFECTS_SETTINGS) },
      {
        onChange: (settings) => this.applySettings(settings),
        onPreview: () => this.audio.play(SoundId.UiClick),
      },
    );

    this.ui = new UIManager({
      onPlay: (name) => void this.handlePlay(name),
      onCancelMatchmaking: () => void this.returnToMenu(),
      onLeaveLobby: () => void this.returnToMenu(),
      onPlayAgain: () => this.handlePlayAgain(),
      onBackToMenu: () => void this.returnToMenu(),
    });

    this.restoreStoredName();
    this.subscribeToNetwork();
    this.sound.attach();
    this.bindDebugConsoleKey();
    this.bindSettingsButton();
    this.applySettings(this.settings.getSettings());
  }

  private bindSettingsButton(): void {
    document.getElementById("menu-settings-button")?.addEventListener("click", () => {
      // Opening from a click is also a user gesture, which is the only moment a
      // browser lets audio start.
      void this.audio.resume();
      this.audio.play(SoundId.UiClick);
      this.settings.setOpen(true);
    });
  }

  /** Push preferences into the systems that act on them. */
  private applySettings(settings: ReturnType<SettingsPanel["getSettings"]>): void {
    this.audio.updateSettings(settings.audio);
    this.getGameScene()?.applyEffectsSettings(settings.effects);
  }

  start(): void {
    this.createGame();
    this.ui.showScreen("menu");
    this.ui.focusNameInput();
  }

  // ---------------------------------------------------------------------------
  // Phaser bootstrap
  // ---------------------------------------------------------------------------

  private createGame(): void {
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: "game-root",
      backgroundColor: "#0a0d14",
      // A fixed logical resolution scaled to the window keeps the field of view
      // identical for everyone -- important when the view is a competitive advantage.
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: CAMERA.VIEW_WIDTH,
        height: CAMERA.VIEW_HEIGHT,
      },
      render: {
        antialias: true,
        pixelArt: false,
        powerPreference: "high-performance",
      },
      // Physics is simulated by the shared deterministic code, not by Phaser.
      scene: [BootScene, GameScene],
      banner: false,
      audio: { noAudio: true },
    });

    this.game.events.once(Phaser.Core.Events.READY, () => {
      this.game?.events.on(Phaser.Core.Events.POST_STEP, () => this.onFrame());
    });
  }

  private getGameScene(): GameScene | null {
    if (this.gameScene) return this.gameScene;
    const scene = this.game?.scene.getScene(GAME_SCENE_KEY) as GameScene | undefined;
    this.gameScene = scene ?? null;
    return this.gameScene;
  }

  // ---------------------------------------------------------------------------
  // Matchmaking flow
  // ---------------------------------------------------------------------------

  private async handlePlay(rawName: string): Promise<void> {
    if (this.joining) return;

    // Browsers refuse to start audio until a user gesture; clicking Play is one,
    // so this is the moment the audio engine can come alive.
    await this.audio.resume();
    this.audio.play(SoundId.UiClick);

    // Validate locally for instant feedback; the server validates again and wins.
    const validation = validatePlayerName(rawName);
    if (!validation.valid) {
      this.ui.showNameError(validation.reason ?? "Please choose a different name.");
      return;
    }

    this.ui.clearNameError();
    this.ui.showConnectionError("");
    this.ui.setPlayButtonBusy(true);
    this.joining = true;

    this.ui.showScreen("matchmaking");
    this.ui.setMatchmakingStatus(`Connecting to ${clientConfig.serverUrl}`);

    try {
      window.localStorage.setItem(clientConfig.nameStorageKey, validation.name);
      const welcome = await this.network.join(validation.name);

      this.ui.setMatchmakingStatus(`Joined room ${welcome.roomId}`);
      this.beginGameScene();
      this.ui.showScreen("lobby");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not reach the server.";
      this.ui.showScreen("menu");
      this.ui.showConnectionError(`${message} Is the server running at ${clientConfig.serverUrl}?`);
    } finally {
      this.joining = false;
      this.ui.setPlayButtonBusy(false);
    }
  }

  private beginGameScene(): void {
    const scene = this.getGameScene();
    if (!scene) return;

    scene.begin(this.network, {
      onLocalDeath: () => this.handleLocalDeath(),
      onLocalRespawn: () => this.ui.setSpectating(false, "", 0),
      onSpectateTargetChanged: (name) => this.updateSpectatorBanner(name),
      onPowerUpCollected: (payload) => this.handlePowerUpCollected(payload),
    });
  }

  /**
   * Announce a pickup.
   *
   * The name comes from the server's payload rather than from a local lookup, so
   * a power-up added through configuration is announced correctly without a
   * client change.
   */
  private handlePowerUpCollected(payload: PowerUpCollectedPayload): void {
    const mine = payload.sessionId === this.network.sessionId;
    const who = mine
      ? "You picked up"
      : `${this.network.state?.players.get(payload.sessionId)?.name ?? "A player"} picked up`;
    this.ui.showNotice({ code: "INFO", message: `${who} ${payload.name}` }, mine ? 2600 : 1800);
  }

  private handlePlayAgain(): void {
    // The room recycles itself after the results delay; asking to requeue simply
    // tells the server we are ready, which cuts the wait short once everyone has.
    this.network.requestRequeue();
    this.ui.setResultsCountdown("Ready - waiting for the other players...");
  }

  private async returnToMenu(): Promise<void> {
    this.getGameScene()?.teardown();
    this.gameScene?.scene.restart();
    this.killFeed.clear();
    this.hud.setVisible(false);
    this.ui.setSpectating(false, "", 0);
    await this.network.leave();
    this.ui.showScreen("menu");
  }

  // ---------------------------------------------------------------------------
  // Network events
  // ---------------------------------------------------------------------------

  private subscribeToNetwork(): void {
    const events = this.network.events;

    events.on("connected", (welcome) => {
      this.ui.setName(welcome.name);
    });

    events.on("matchStateChanged", ({ matchState }) => this.onMatchStateChanged(matchState));

    events.on("countdownChanged", ({ seconds }) => {
      this.ui.updateCountdown(seconds);
    });

    events.on("kill", (event) => {
      this.killFeed.add(event, performance.now());
    });

    events.on("damage", (payload) => {
      if (payload.victimId === this.network.sessionId) this.hud.showDamageFlash();
      else if (payload.attackerId === this.network.sessionId) this.hud.showHitmarker();
    });

    events.on("matchResult", (result) => {
      this.lastResult = result;
      this.resultsEndsAt = performance.now() + getMatchConfig().resultsMs;
      this.hud.setVisible(false);
      this.ui.setSpectating(false, "", 0);
      this.ui.showResults(result, this.network.sessionId);
    });

    events.on("notice", (notice) => this.ui.showNotice(notice));

    // The server's verdict is the only thing that opens any debug tooling.
    events.on("debugState", (state) => {
      this.debug.setGranted(state.granted);
      this.debugConsole.applyState(state);
      if (state.granted) {
        this.ui.showNotice(
          { code: "INFO", message: `Debug access granted - Shift+D to open` },
          3500,
        );
      }
    });
    events.on("debugResult", (result) => this.debugConsole.appendResult(result));
    events.on("debugNpc", (payload) => this.debugConsole.renderNpcs(payload));

    events.on("disconnected", ({ code, reason }) => {
      this.getGameScene()?.teardown();
      this.hud.setVisible(false);
      this.ui.setSpectating(false, "", 0);
      this.ui.showScreen("menu");
      this.ui.showConnectionError(
        reason ? `Disconnected: ${reason}` : `Disconnected from the server (code ${code}).`,
      );
    });

    events.on("error", ({ message }) => this.ui.showConnectionError(message));
  }

  private onMatchStateChanged(matchState: MatchStateValue): void {
    switch (matchState) {
      case MatchState.WAITING:
        this.hud.setVisible(false);
        this.killFeed.clear();
        this.ui.setSpectating(false, "", 0);
        this.ui.showScreen("lobby");
        break;

      case MatchState.COUNTDOWN:
        this.hud.setVisible(false);
        this.ui.setSpectating(false, "", 0);
        this.ui.showScreen("countdown");
        break;

      case MatchState.PLAYING:
        this.hud.setVisible(true);
        // Nobody is spectating a match they are about to play; clearing here also
        // covers the case where the previous match's death arrived out of order.
        this.ui.setSpectating(false, "", 0);
        this.ui.showScreen("none");
        break;

      case MatchState.FINISHED:
        // The results screen is shown by the matchResult message, which carries
        // the standings. Nothing to do here.
        break;
    }
  }

  private handleLocalDeath(): void {
    // A player only ever spectates a match that is actually running. Between
    // matches the room clears `alive` for everyone, and that must not be
    // mistaken for an elimination.
    if (this.network.state?.matchState !== MatchState.PLAYING) return;

    const scene = this.getGameScene();
    const local = this.network.state.players.get(this.network.sessionId);
    this.ui.setSpectating(true, scene?.spectatedName ?? "", local?.placement ?? 0);
  }

  private updateSpectatorBanner(targetName: string): void {
    const local = this.network.state?.players.get(this.network.sessionId);
    if (!local || local.alive) return;
    this.ui.setSpectating(true, targetName, local.placement);
  }

  // ---------------------------------------------------------------------------
  // Per-frame UI updates
  // ---------------------------------------------------------------------------

  private onFrame(): void {
    const now = performance.now();

    this.killFeed.tick(now);
    this.hud.tick(now);
    this.updateResultsCountdown(now);

    if (now - this.lastHudUpdate < HUD_UPDATE_INTERVAL_MS) return;
    this.lastHudUpdate = now;

    this.updateListener();
    this.updateHud();
    this.updateDebugOverlay();
    this.updateLobby();
  }

  /** The audio listener follows the camera, so sound pans with the view. */
  private updateListener(): void {
    const centre = this.getGameScene()?.getCameraCentre();
    if (centre) this.audio.setListenerPosition(centre.x, centre.y);
  }

  private updateHud(): void {
    const state = this.network.state;
    if (!state) return;

    const player = state.players.get(this.network.sessionId) ?? null;
    this.hud.update({
      player,
      matchState: state.matchState,
      aliveCount: state.aliveCount,
      totalPlayers: state.startingPlayerCount || state.playerCount,
      shrinkCountdownSeconds: state.shrinkCountdownSeconds,
      shrinking: state.shrinking,
      grenadeCharge: this.getGameScene()?.getGrenadeChargeProgress(grenadeMaxChargeMs()) ?? 0,
    });

    const scene = this.getGameScene();
    if (scene && state.matchState === MatchState.PLAYING) {
      const pointer = scene.getPointerScreenPosition();
      this.hud.setCrosshairPosition(pointer.x, pointer.y);
    }
  }

  private updateDebugOverlay(): void {
    if (!this.debug.isVisible) return;

    const scene = this.getGameScene();
    const prediction = scene?.getPredictionDebug();
    const state = this.network.state;

    this.debug.update({
      fps: this.game?.loop.actualFps ?? 0,
      ping: this.network.ping,
      x: prediction?.x ?? 0,
      y: prediction?.y ?? 0,
      predictionErrorPx: prediction?.errorPx ?? 0,
      pendingInputs: prediction?.pending ?? 0,
      roomId: this.network.roomId,
      sessionId: this.network.sessionId,
      playerCount: state?.players.size ?? 0,
      projectileCount: scene?.projectileCount ?? 0,
      crateCount: scene?.crateCount ?? 0,
      powerUpCount: scene?.powerUpCount ?? 0,
      grenadeCount: scene?.grenadeCount ?? 0,
      trapCount: scene?.trapCount ?? 0,
      activeTrapCount: scene?.activeTrapCount ?? 0,
    });
  }

  private updateLobby(): void {
    const state = this.network.state;
    if (!state || this.ui.currentScreen !== "lobby") return;
    this.ui.updateLobby(state, this.network.sessionId);
  }

  private updateResultsCountdown(now: number): void {
    if (this.ui.currentScreen !== "results" || !this.lastResult) return;

    const remaining = Math.max(0, this.resultsEndsAt - now);
    this.ui.setResultsCountdown(
      remaining > 0
        ? `Next match starting in ${Math.ceil(remaining / 1000)}s...`
        : "Starting the next match...",
    );
  }

  private restoreStoredName(): void {
    const stored = window.localStorage.getItem(clientConfig.nameStorageKey);
    if (stored) this.ui.setName(stored);
  }
}

export { BOOT_SCENE_KEY };

/** The configured wind-up time the local power bar fills against. */
function grenadeMaxChargeMs(): number {
  return getGrenadeConfig().maxChargeMs;
}
