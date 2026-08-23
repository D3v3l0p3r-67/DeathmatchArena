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
  /** The host would like to begin, with whoever is in the room. */
  onStartMatch(): void;
  /** The host asked for another bot at this difficulty. */
  onAddBot(difficulty: number): void;
  /** The host asked for this bot to go. */
  onRemoveBot(sessionId: string): void;
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

  private readonly roomName = requireElement("lobby-room-name");
  private readonly addBotButton = requireElement<HTMLButtonElement>("add-bot");
  private readonly botPicker = requireElement("bot-picker");
  private readonly botPickerOptions = requireElement("bot-picker-options");
  private readonly startButton = requireElement<HTMLButtonElement>("start-match");

  /** Whether this client owns the room, from the last patch. */
  private isHost = false;

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
    this.startButton.addEventListener("click", () => this.callbacks.onStartMatch());
    requireElement("play-again").addEventListener("click", () => this.callbacks.onPlayAgain());
    requireElement("back-to-menu").addEventListener("click", () => this.callbacks.onBackToMenu());

    this.nameInput.addEventListener("input", () => this.clearNameError());
    this.buildBotPicker();
  }

  // --------------------------------------------------------------- adding bots

  /**
   * Build the difficulty picker once.
   *
   * Generated from the ladder's own bounds rather than written out in the
   * markup, so a sixth rung added to the configuration turns up here without an
   * edit. Choosing a rung adds the bot -- there is no separate confirmation,
   * because picking one *is* the confirmation.
   */
  private buildBotPicker(): void {
    this.addBotButton.addEventListener("click", () => this.toggleBotPicker(true));
    requireElement("bot-picker-cancel").addEventListener("click", () => this.toggleBotPicker(false));

    for (let level = MIN_BOT_DIFFICULTY; level <= MAX_BOT_DIFFICULTY; level++) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "difficulty-option";
      button.dataset.level = String(level);

      const number = document.createElement("b");
      number.textContent = String(level);
      const label = document.createElement("span");
      label.textContent = DIFFICULTY_NAMES[level] ?? `Level ${level}`;

      button.append(number, label);
      button.addEventListener("click", () => {
        this.toggleBotPicker(false);
        this.callbacks.onAddBot(level);
      });
      this.botPickerOptions.appendChild(button);
    }
  }

  private toggleBotPicker(open: boolean): void {
    toggleClass(this.botPicker, "is-active", open);
  }

  /**
   * Mark the rung this player last used.
   *
   * The only thing remembered between sessions: a bot is never added on
   * somebody's behalf, so all a preference can do is say which one they reached
   * for last time.
   */
  setPreferredDifficulty(level: number): void {
    for (const option of this.botPickerOptions.children) {
      const value = Number((option as HTMLElement).dataset.level);
      option.classList.toggle("is-preferred", value === level);
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
    this.isHost = state.hostId === localSessionId;

    setText(this.roomName, state.roomName || "Room");
    setText(this.lobbyCount, `Players: ${state.playerCount} / ${state.maxPlayers}`);

    // No countdown to a full room and no number to reach: the room stays open
    // until its host starts it, so all there is to say is that it is open.
    setText(
      this.lobbyHint,
      this.isHost
        ? state.canStart
          ? "Waiting for players... start whenever you like"
          : "Waiting for players... add a bot to start on your own"
        : "Waiting for players... the host decides when to start",
    );

    this.addBotButton.disabled = !this.isHost || state.playerCount >= state.maxPlayers;
    this.addBotButton.hidden = !this.isHost;
    this.startButton.disabled = !this.isHost || !state.canStart;
    this.startButton.hidden = !this.isHost;
    if (!this.isHost) this.toggleBotPicker(false);

    this.renderRoster(state, localSessionId);
  }

  /**
   * Draw the room's line-up.
   *
   * Bots share the list with everybody else -- they are playing the same match
   * -- but say what they are and how good they are, and the host gets a button
   * to send one away again.
   *
   * Rebuilt only when something actually changed: this runs on every patch, and
   * replacing the list under the cursor would swallow the click that is halfway
   * through happening.
   */
  private renderRoster(state: SyncedGameState, localSessionId: string): void {
    const signature = Array.from(state.players.values())
      .map((player) => `${player.name}:${player.botDifficulty}`)
      .join("|") + `:${this.isHost}:${state.hostId}`;

    if (this.lobbyPlayers.dataset.signature === signature) return;
    this.lobbyPlayers.dataset.signature = signature;

    this.lobbyPlayers.replaceChildren();
    for (const [sessionId, player] of state.players) {
      const item = document.createElement("li");
      if (sessionId === localSessionId) item.classList.add("is-you");
      if (player.bot) item.classList.add("is-bot");

      const dot = document.createElement("span");
      dot.className = "dot";

      const label = document.createElement("span");
      label.className = "player-name";
      label.textContent = player.bot
        ? `${player.name} - ${player.botDifficultyName}`
        : sessionId === localSessionId
          ? `${player.name} (you)`
          : player.name;

      item.append(dot, label);

      if (player.bot) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "Bot";
        item.append(badge);
      } else if (sessionId === state.hostId) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "Host";
        item.append(badge);
      }

      if (player.bot && this.isHost) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "player-remove";
        remove.title = `Remove ${player.name}`;
        remove.setAttribute("aria-label", `Remove ${player.name}`);
        remove.textContent = "x";
        remove.addEventListener("click", () => this.callbacks.onRemoveBot(sessionId));
        item.append(remove);
      }

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

/**
 * What each rung is called, for the picker.
 *
 * Written here rather than read from the ladder because the picker is built
 * once, before any room state has arrived. The server's own names ride on each
 * bot, so what the list shows is always the configuration's.
 */
const DIFFICULTY_NAMES: Record<number, string> = {
  1: "Very Easy",
  2: "Easy",
  3: "Normal",
  4: "Hard",
  5: "Very Hard",
};

