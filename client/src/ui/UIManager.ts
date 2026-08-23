import {
  MAX_BOT_DIFFICULTY,
  MIN_BOT_DIFFICULTY,
  MatchState,
  type MatchResultMessage,
  type MatchStateValue,
  type NoticePayload,
  type SyncedGameState,
} from "@deathmatch/shared";
import { query, requireElement, setText, toggleClass } from "./dom.js";

export type ScreenName = "menu" | "matchmaking" | "lobby" | "countdown" | "results" | "none";

export interface UICallbacks {
  /** The player would rather not wait for anyone else. */
  onStartNow(): void;
  /**
   * The lobby's bot settings were changed here. A request, not a decision: the
   * server clamps both values and everybody's controls follow what it says.
   */
  onBotsChanged(count: number, difficulty: number): void;
  onPlay(name: string): void;
  onCancelMatchmaking(): void;
  onLeaveLobby(): void;
  onPlayAgain(): void;
  onBackToMenu(): void;
}

/**
 * Owns every DOM screen and overlay.
 *
 * Screens are driven by the authoritative `matchState` rather than by local
 * guesses, so what the player sees always matches what the server believes.
 */
export class UIManager {
  private readonly screens = new Map<ScreenName, HTMLElement>();
  private readonly spectatorLayer = query('[data-layer="spectator"]');

  private readonly nameInput = requireElement<HTMLInputElement>("name-input");
  private readonly nameError = requireElement("name-error");
  private readonly connectionError = requireElement("connection-error");
  private readonly playButton = requireElement<HTMLButtonElement>("play-button");
  private readonly joinForm = requireElement<HTMLFormElement>("join-form");

  private readonly matchmakingStatus = requireElement("matchmaking-status");
  private readonly lobbyCount = requireElement("lobby-count");
  private readonly lobbyHint = requireElement("lobby-hint");
  private readonly lobbyPlayers = requireElement<HTMLUListElement>("lobby-players");
  private readonly lobbyHold = requireElement("lobby-hold");
  private readonly lobbyHoldTimer = requireElement("lobby-hold-timer");
  private readonly startNow = requireElement("start-now");

  private readonly botSetup = requireElement("bot-setup");
  private readonly botsValue = requireElement("bots-value");
  private readonly botsLess = requireElement<HTMLButtonElement>("bots-less");
  private readonly botsMore = requireElement<HTMLButtonElement>("bots-more");
  private readonly difficultyRow = requireElement("bot-difficulty-row");
  private readonly difficultyName = requireElement("bot-difficulty-name");
  private readonly difficultyButtons = requireElement("bot-difficulty");

  /**
   * What this client last asked for.
   *
   * The room state is the truth, and these are only what the buttons act on
   * between asking and being told. Without them, clicking "+" twice quickly
   * would send the same number twice: the second click would still be reading
   * the count from before the first one came back.
   */
  private wantedBots = 0;
  private wantedDifficulty = 3;

  private readonly countdownValue = requireElement("countdown-value");

  private readonly resultsWinner = requireElement("results-winner");
  private readonly resultsBody = requireElement<HTMLTableSectionElement>("results-body");
  private readonly resultsNext = requireElement("results-next");

  private readonly spectateTarget = requireElement("spectate-target");
  private readonly spectatePlacement = requireElement("spectate-placement");

  private readonly notices = requireElement("notices");

  private activeScreen: ScreenName = "none";

  constructor(private readonly callbacks: UICallbacks) {
    for (const element of document.querySelectorAll<HTMLElement>("[data-screen]")) {
      this.screens.set(element.dataset.screen as ScreenName, element);
    }

    this.joinForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.callbacks.onPlay(this.nameInput.value);
    });

    requireElement("cancel-matchmaking").addEventListener("click", () => this.callbacks.onCancelMatchmaking());
    requireElement("leave-lobby").addEventListener("click", () => this.callbacks.onLeaveLobby());
    this.startNow.addEventListener("click", () => this.callbacks.onStartNow());
    requireElement("play-again").addEventListener("click", () => this.callbacks.onPlayAgain());
    requireElement("back-to-menu").addEventListener("click", () => this.callbacks.onBackToMenu());

    this.nameInput.addEventListener("input", () => this.clearNameError());
    this.buildBotControls();
  }

  // ---------------------------------------------------------------- bot setup

  /**
   * Wire the bot controls once.
   *
   * The difficulty buttons are built from the ladder's own bounds rather than
   * written out in the markup, so a sixth rung added to the configuration turns
   * up here without an edit.
   */
  private buildBotControls(): void {
    this.botsLess.addEventListener("click", () => this.requestBots(this.wantedBots - 1));
    this.botsMore.addEventListener("click", () => this.requestBots(this.wantedBots + 1));

    for (let level = MIN_BOT_DIFFICULTY; level <= MAX_BOT_DIFFICULTY; level++) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "difficulty__button";
      button.dataset.level = String(level);
      button.textContent = String(level);
      button.addEventListener("click", () => this.requestDifficulty(level));
      this.difficultyButtons.appendChild(button);
    }
  }

  /** Ask for a different number of bots. The server decides what it gets. */
  private requestBots(count: number): void {
    const wanted = Math.max(0, Math.min(this.maxBots, Math.round(count)));
    if (wanted === this.wantedBots) return;
    this.wantedBots = wanted;
    this.renderBotSetup();
    this.callbacks.onBotsChanged(wanted, this.wantedDifficulty);
  }

  private requestDifficulty(level: number): void {
    if (level === this.wantedDifficulty) return;
    this.wantedDifficulty = level;
    this.renderBotSetup();
    this.callbacks.onBotsChanged(this.wantedBots, level);
  }

  /** The ceiling the server last published. */
  private maxBots = 0;

  /**
   * Take the server's word for the lobby's settings.
   *
   * Everyone waiting plays the same match, so the settings belong to the room
   * rather than to a client: somebody else changing them moves these controls
   * here too, and a value this client asked for that the server would not give
   * is corrected on the next patch.
   */
  private syncBotSetup(state: SyncedGameState): void {
    this.maxBots = state.maxBots;
    this.wantedBots = Math.min(state.botCount, state.maxBots);
    this.wantedDifficulty = state.botDifficulty;
    setText(this.difficultyName, state.botDifficultyName);
    this.renderBotSetup();
  }

  /**
   * Paint the controls.
   *
   * Called both when this client changes something -- so the buttons respond
   * without waiting for a round trip -- and from every patch, which is what
   * corrects them when the server disagrees or somebody else changes the
   * setting.
   */
  private renderBotSetup(): void {
    setText(this.botsValue, String(this.wantedBots));
    this.botsLess.disabled = this.wantedBots <= 0;
    this.botsMore.disabled = this.wantedBots >= this.maxBots;

    // A room that cannot seat a bot at all has nothing to configure.
    toggleClass(this.botSetup, "is-hidden", this.maxBots <= 0);
    toggleClass(this.difficultyRow, "is-active", this.wantedBots > 0);

    for (const button of this.difficultyButtons.children) {
      const level = Number((button as HTMLElement).dataset.level);
      button.classList.toggle("is-selected", level === this.wantedDifficulty);
    }
  }

  // ------------------------------------------------------------------ screens

  showScreen(screen: ScreenName): void {
    if (this.activeScreen === screen) return;
    this.activeScreen = screen;

    for (const [name, element] of this.screens) {
      toggleClass(element, "is-active", name === screen);
    }
  }

  get currentScreen(): ScreenName {
    return this.activeScreen;
  }

  // ------------------------------------------------------------------- menu

  getStoredName(): string {
    return this.nameInput.value;
  }

  setName(name: string): void {
    this.nameInput.value = name;
  }

  focusNameInput(): void {
    this.nameInput.focus();
    this.nameInput.select();
  }

  showNameError(message: string): void {
    setText(this.nameError, message);
    toggleClass(this.nameInput, "is-invalid", true);
  }

  clearNameError(): void {
    setText(this.nameError, "");
    toggleClass(this.nameInput, "is-invalid", false);
  }

  showConnectionError(message: string): void {
    setText(this.connectionError, message);
  }

  setPlayButtonBusy(busy: boolean): void {
    this.playButton.disabled = busy;
    setText(this.playButton, busy ? "Connecting..." : "Play");
  }

  setMatchmakingStatus(status: string): void {
    setText(this.matchmakingStatus, status);
  }

  // ------------------------------------------------------------------ lobby

  updateLobby(state: SyncedGameState, localSessionId: string): void {
    setText(this.lobbyCount, `Players: ${state.playerCount} / ${state.maxPlayers}`);
    this.syncBotSetup(state);

    const people = countPeople(state);
    const expected = Math.min(state.maxPlayers, people + state.botCount);
    const missing = Math.max(0, expected - state.playerCount);

    setText(
      this.lobbyHint,
      // With no bots asked for, an opponent has to be a person -- so say that
      // rather than counting towards a roster nobody is going to fill.
      state.botCount === 0
        ? people < 2
          ? "Waiting for another player - or add a bot"
          : "Ready - starting soon"
        : missing > 0
          ? `${missing} place${missing === 1 ? "" : "s"} open - bots will take what is left`
          : "Ready - starting soon",
    );

    // Both come from the server: it decides how long the places stay open and
    // whether skipping the wait is currently a thing that can happen.
    toggleClass(this.lobbyHold, "is-active", state.canStartNow);
    if (state.canStartNow) {
      setText(this.lobbyHoldTimer, formatWait(state.botFillSeconds));
      // Says what pressing it will actually do, which depends on whether any
      // bots were asked for.
      setText(this.startNow, state.botCount > 0 ? "Start now with bots" : "Start now");
    }

    // Rebuild only when the roster actually changed; this runs on every patch.
    const names = Array.from(state.players.values()).map((player) => player.name);
    const signature = names.join("|");
    if (this.lobbyPlayers.dataset.signature === signature) return;
    this.lobbyPlayers.dataset.signature = signature;

    this.lobbyPlayers.replaceChildren();
    for (const [sessionId, player] of state.players) {
      const item = document.createElement("li");
      if (sessionId === localSessionId) item.classList.add("is-you");

      const dot = document.createElement("span");
      dot.className = "dot";
      const label = document.createElement("span");
      label.textContent = sessionId === localSessionId ? `${player.name} (you)` : player.name;

      item.append(dot, label);
      this.lobbyPlayers.appendChild(item);
    }
  }

  // -------------------------------------------------------------- countdown

  updateCountdown(seconds: number): void {
    const label = seconds <= 0 ? "GO" : String(seconds);
    if (this.countdownValue.textContent === label) return;

    setText(this.countdownValue, label);
    toggleClass(this.countdownValue, "is-go", seconds <= 0);

    // Restart the pop animation for each new number.
    this.countdownValue.style.animation = "none";
    void this.countdownValue.offsetWidth;
    this.countdownValue.style.animation = "";
  }

  // -------------------------------------------------------------- spectator

  setSpectating(active: boolean, targetName: string, placement: number): void {
    toggleClass(this.spectatorLayer, "is-active", active);
    if (!active) return;

    setText(this.spectateTarget, targetName || "nobody");
    setText(this.spectatePlacement, placement > 0 ? `#${placement}` : "-");
  }

  // ---------------------------------------------------------------- results

  showResults(result: MatchResultMessage, localSessionId: string): void {
    setText(this.resultsWinner, result.winnerName || "No winner");

    this.resultsBody.replaceChildren();
    for (const standing of result.standings) {
      const row = document.createElement("tr");
      if (standing.sessionId === localSessionId) row.classList.add("is-you");
      if (standing.placement === 1) row.classList.add("is-winner");

      const placement = document.createElement("td");
      placement.textContent = standing.placement === 1 ? "1st" : `${standing.placement}`;
      const name = document.createElement("td");
      name.textContent = standing.name;
      const kills = document.createElement("td");
      kills.textContent = String(standing.kills);

      row.append(placement, name, kills);
      this.resultsBody.appendChild(row);
    }

    this.showScreen("results");
  }

  setResultsCountdown(message: string): void {
    setText(this.resultsNext, message);
  }

  // ---------------------------------------------------------------- notices

  showNotice(notice: NoticePayload, ttlMs = 4000): void {
    const element = document.createElement("div");
    element.textContent = notice.message;
    this.notices.appendChild(element);
    window.setTimeout(() => element.remove(), ttlMs);
  }

  /** Map the authoritative match state onto the right screen. */
  screenForMatchState(matchState: MatchStateValue, localIsSpectating: boolean): ScreenName {
    switch (matchState) {
      case MatchState.WAITING:
        return "lobby";
      case MatchState.COUNTDOWN:
        return "countdown";
      case MatchState.PLAYING:
        return "none";
      case MatchState.FINISHED:
        return "results";
      default:
        void localIsSpectating;
        return "none";
    }
  }
}

/** How many of the players in a lobby are people. */
function countPeople(state: SyncedGameState): number {
  let people = 0;
  for (const player of state.players.values()) {
    if (!player.bot) people++;
  }
  return people;
}

/** `m:ss`, so a minute-long wait reads as a minute rather than as 60. */
function formatWait(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  return minutes > 0 ? `${minutes}:${String(safe % 60).padStart(2, "0")}` : `${safe}s`;
}
