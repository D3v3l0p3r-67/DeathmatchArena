import Phaser from "phaser";
import {
  CAMERA,
  getMatchConfig,
  MatchState,
  validatePlayerName,
  type MatchResultMessage,
  type MatchStateValue,
  getGrenadeConfig,
  getNpcConfig,
  type PlayerCareer,
  type PowerUpCollectedPayload,
} from "@deathmatch/shared";
import { AudioEngine, DEFAULT_AUDIO_SETTINGS } from "./audio/AudioEngine.js";
import { SoundController } from "./audio/SoundController.js";
import { SoundId } from "./audio/sounds.js";
import { clientConfig } from "./config.js";
import { DEFAULT_EFFECTS_SETTINGS, FINALE } from "./game/fx/effects.js";
import { SettingsPanel, loadEffectsSettings } from "./ui/SettingsPanel.js";
import { NetworkManager } from "./net/NetworkManager.js";
import { BootScene, BOOT_SCENE_KEY } from "./game/scenes/BootScene.js";
import { GameScene, GAME_SCENE_KEY } from "./game/scenes/GameScene.js";
import { DebugConsole } from "./ui/DebugConsole.js";
import { DebugOverlay } from "./ui/DebugOverlay.js";
import { HUD } from "./ui/HUD.js";
import { KillFeed } from "./ui/KillFeed.js";
import { TouchControls } from "./ui/TouchControls.js";
import { UIManager } from "./ui/UIManager.js";

/** HUD text does not need to change 60 times a second. */
const HUD_UPDATE_INTERVAL_MS = 80;

/**
 * Where this player's own record is kept locally.
 *
 * A cache, not the truth: the server sends the real one on joining and after
 * every match. It exists so the menu can show a returning player their record
 * before they have joined anything, which is exactly where they want to see it.
 */
const CAREER_KEY = "deathmatch-arena:career";

/** How long to wait between attempts to get a held seat back. */
const RECONNECT_RETRY_MS = 1200;

function loadCareer(): PlayerCareer | null {
  try {
    const raw = window.localStorage.getItem(CAREER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlayerCareer>;
    if (!Number.isFinite(parsed.matches)) return null;
    return {
      matches: Number(parsed.matches),
      wins: Number(parsed.wins ?? 0),
      kills: Number(parsed.kills ?? 0),
      deaths: Number(parsed.deaths ?? 0),
      bestPlacement: Number(parsed.bestPlacement ?? 0),
    };
  } catch {
    return null;
  }
}

function saveCareer(career: PlayerCareer): void {
  try {
    window.localStorage.setItem(CAREER_KEY, JSON.stringify(career));
  } catch {
    // Blocked storage: the server still knows, and will say so on the next join.
  }
}

/** Where the last bot setup is remembered between sessions. */
const BOT_PREFERENCE_KEY = "deathmatch-arena:bots";

interface BotPreference {
  /** The rung this player last added a bot at. */
  difficulty: number;
}

/**
 * The difficulty this player last added a bot at.
 *
 * Falls back to the shipped default, and treats anything unreadable as absent:
 * a corrupt entry should mean "no preference", never a broken lobby. It only
 * marks a rung in the picker -- bots are never added on somebody's behalf.
 */
function loadBotPreference(): BotPreference {
  const fallback: BotPreference = { difficulty: getNpcConfig().defaultDifficulty };

  try {
    const raw = window.localStorage.getItem(BOT_PREFERENCE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<BotPreference>;
    return {
      difficulty: Number.isFinite(parsed.difficulty)
        ? Number(parsed.difficulty)
        : fallback.difficulty,
    };
  } catch {
    return fallback;
  }
}

function saveBotPreference(preference: BotPreference): void {
  try {
    window.localStorage.setItem(BOT_PREFERENCE_KEY, JSON.stringify(preference));
  } catch {
    // Private browsing or blocked storage: the choice still holds this session.
  }
}

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
  /**
   * A result held back while the final kill plays out.
   *
   * The server calls the match the moment the last player dies, which is exactly
   * when the arena is at its most worth watching. The standings wait for the
   * scene to say the finale is over.
   */
  private pendingResult: MatchResultMessage | null = null;

  /** Whether this player has already asked for the next match. */
  private requeueRequested = false;
  /** When the server will stop holding our seat; 0 when nothing is being held. */
  private reconnectDeadline = 0;
  private reconnectTimer = 0;
  /** On-screen controls, shown only on a device that has asked for them. */
  private touch!: TouchControls;
  /** The rung this player last added a bot at, remembered between sessions. */
  private botPreference = loadBotPreference();

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
      // Asking only. The server decides whether the lobby is in a state where
      // this means anything.
      onStartMatch: () => this.network.requestStart(),
      onAddBot: (difficulty) => {
        // Remembered so the picker marks the rung this player reached for last.
        this.botPreference = { difficulty };
        saveBotPreference(this.botPreference);
        this.ui.setPreferredDifficulty(difficulty);
        this.network.addBot(difficulty);
      },
      onRemoveBot: (sessionId) => this.network.removeBot(sessionId),
      onPlayAgain: () => this.handlePlayAgain(),
      onBackToMenu: () => void this.returnToMenu(),
    });

    this.touch = new TouchControls({
      onIntent: (intent) => this.getGameScene()?.setTouchIntent(intent),
    });

    this.restoreStoredName();
    const remembered = loadCareer();
    if (remembered) this.ui.showCareer(remembered);
    this.ui.setPreferredDifficulty(this.botPreference.difficulty);
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
      onCrateIncoming: (warning) => this.audio.playAt(SoundId.CrateIncoming, warning.x, warning.y, 0.8),
      onFinaleComplete: () => {
        if (this.pendingResult) this.showResults(this.pendingResult);
      },
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
    // tells the server we are ready, which cuts the wait short once everybody
    // has. Remembered rather than written straight to the screen: the countdown
    // is redrawn every frame and would have overwritten it immediately, which is
    // what made a working button look like a broken one.
    this.requeueRequested = true;
    this.ui.setPlayAgainReady(true);
    this.network.requestRequeue();
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
      // Held only while the scene is actually playing a finale; if the match
      // ended some other way -- the clock running out, everyone leaving -- there
      // is nothing to wait for and the standings go up immediately.
      if (!this.getGameScene()?.isPlayingFinale()) {
        this.showResults(result);
        return;
      }

      this.pendingResult = result;
      // A backstop: the scene normally reports the finale finished, but if it is
      // torn down mid-animation -- a disconnect, a tab that lost its context --
      // nothing would ever put the standings up.
      window.setTimeout(() => {
        if (this.pendingResult === result) this.showResults(result);
      }, FINALE.resultsAfterMs + 500);
    });

    events.on("notice", (notice) => this.ui.showNotice(notice));
    // Their own record, sent on joining and again after every match they finish.
    events.on("career", (career) => {
      saveCareer(career);
      this.ui.showCareer(career);
    });

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

    events.on("connectionLost", ({ secondsLeft }) => this.beginReconnecting(secondsLeft));
    events.on("reconnected", () => {
      this.stopReconnecting();
      this.ui.showNotice({ code: "INFO", message: "Reconnected." }, 2200);
    });

    events.on("disconnected", ({ code, reason }) => {
      this.stopReconnecting();
      this.getGameScene()?.teardown();
      this.hud.setVisible(false);
      this.ui.setSpectating(false, "", 0);
      this.ui.showScreen("menu");
      this.ui.showConnectionError(
        reason ? `Disconnected: ${reason}` : `Disconnected from the server (code ${code}).`,
      );
    });

    events.on("error", ({ message }) => {
      // While the seat is being held, the banner is the whole story: a raw
      // transport error behind it would be the client contradicting itself.
      if (this.reconnectDeadline > 0) return;
      this.ui.showConnectionError(message);
    });
  }

  private onMatchStateChanged(matchState: MatchStateValue): void {
    // The on-screen controls belong to the match, not to the menus: they follow
    // the HUD exactly.
    this.touch.setInMatch(matchState === MatchState.PLAYING);

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

  /** Put the standings up and start their countdown. */
  private showResults(result: MatchResultMessage): void {
    this.pendingResult = null;
    this.requeueRequested = false;
    this.ui.setPlayAgainReady(false);
    this.lastResult = result;
    this.resultsEndsAt = performance.now() + getMatchConfig().resultsMs;
    this.hud.setVisible(false);
    this.ui.setSpectating(false, "", 0);
    this.ui.showResults(result, this.network.sessionId);
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

  /**
   * Keep asking for the seat back until the server stops holding it.
   *
   * The scene is deliberately left standing: the match is still running, and a
   * player who comes back in three seconds should find it where they left it
   * rather than a menu they have to fight their way out of.
   */
  private beginReconnecting(secondsLeft: number): void {
    if (this.reconnectDeadline > 0) return;

    this.reconnectDeadline = performance.now() + secondsLeft * 1000;
    this.ui.showConnectionError("");
    this.ui.showReconnecting(secondsLeft);

    const attempt = async () => {
      if (this.reconnectDeadline === 0) return;

      const remaining = (this.reconnectDeadline - performance.now()) / 1000;
      if (remaining <= 0) {
        // The server has let the seat go; from here it is an ordinary
        // disconnection and the menu is the honest place to be.
        this.stopReconnecting();
        this.network.abandonReconnection();
        this.getGameScene()?.teardown();
        this.hud.setVisible(false);
        this.ui.setSpectating(false, "", 0);
        this.ui.showScreen("menu");
        this.ui.showConnectionError("Connection lost. Your place was held as long as it could be.");
        return;
      }

      this.ui.showReconnecting(remaining);
      if (await this.network.attemptReconnect()) return;

      this.reconnectTimer = window.setTimeout(() => void attempt(), RECONNECT_RETRY_MS);
    };

    this.reconnectTimer = window.setTimeout(() => void attempt(), RECONNECT_RETRY_MS);
  }

  private stopReconnecting(): void {
    this.reconnectDeadline = 0;
    if (this.reconnectTimer !== 0) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    this.ui.hideReconnecting();
  }

  private updateResultsCountdown(now: number): void {
    if (this.ui.currentScreen !== "results" || !this.lastResult) return;

    const remaining = Math.max(0, this.resultsEndsAt - now);
    const seconds = Math.ceil(remaining / 1000);

    this.ui.setResultsCountdown(
      remaining <= 0
        ? "Starting the next match..."
        : this.requeueRequested
          ? `Ready - waiting for the others (${seconds}s)`
          : `Next match starting in ${seconds}s...`,
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
