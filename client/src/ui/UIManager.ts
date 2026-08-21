import {
  MatchState,
  type MatchResultMessage,
  type MatchStateValue,
  type NoticePayload,
  type SyncedGameState,
} from "@deathmatch/shared";
import { query, requireElement, setText, toggleClass } from "./dom.js";

export type ScreenName = "menu" | "matchmaking" | "lobby" | "countdown" | "results" | "none";

export interface UICallbacks {
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
    requireElement("play-again").addEventListener("click", () => this.callbacks.onPlayAgain());
    requireElement("back-to-menu").addEventListener("click", () => this.callbacks.onBackToMenu());

    this.nameInput.addEventListener("input", () => this.clearNameError());
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

    const missing = Math.max(0, state.minPlayersToStart - state.playerCount);
    setText(
      this.lobbyHint,
      missing > 0
        ? `Waiting for ${missing} more player${missing === 1 ? "" : "s"}...`
        : "Enough players - starting soon",
    );

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
