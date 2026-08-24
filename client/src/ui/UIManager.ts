import {
  MAX_BOT_DIFFICULTY,
  type PlayerCareer,
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
  onSelectArena(arenaId: string): void;
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
  private readonly mapName = requireElement("lobby-map-name");
  private readonly changeMapButton = requireElement("change-map") as HTMLButtonElement;
  private readonly mapPicker = requireElement("map-picker");
  private readonly mapPickerOptions = requireElement("map-picker-options");
  private readonly lobbyPlayers = requireElement<HTMLUListElement>("lobby-players");

  private readonly roomName = requireElement("lobby-room-name");
  private readonly addBotButton = requireElement<HTMLButtonElement>("add-bot");
  private readonly botPicker = requireElement("bot-picker");
  private readonly botPickerOptions = requireElement("bot-picker-options");
  private readonly startButton = requireElement<HTMLButtonElement>("start-match");

  /** Whether this client owns the room, from the last patch. */
  private isHost = false;
  /** Arena id to display name, from the server's welcome. */
  private arenaNames = new Map<string, string>();

  private readonly countdownValue = requireElement("countdown-value");

  private readonly resultsWinner = requireElement("results-winner");
  private readonly resultsBody = requireElement<HTMLTableSectionElement>("results-body");
  private readonly resultsNext = requireElement("results-next");

  private readonly spectateTarget = requireElement("spectate-target");
  private readonly spectatePlacement = requireElement("spectate-placement");

  private readonly menuCareer = requireElement("menu-career");
  private readonly careerMatches = requireElement("career-matches");
  private readonly careerWins = requireElement("career-wins");
  private readonly careerKills = requireElement("career-kills");
  private readonly careerKd = requireElement("career-kd");
  private readonly resultsCareer = requireElement("results-career");
  private readonly playAgain = requireElement<HTMLButtonElement>("play-again");

  private readonly reconnect = requireElement("reconnect");
  private readonly reconnectTimer = requireElement("reconnect-timer");

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
    this.playAgain.addEventListener("click", () => this.callbacks.onPlayAgain());
    requireElement("back-to-menu").addEventListener("click", () => this.callbacks.onBackToMenu());

    this.nameInput.addEventListener("input", () => this.clearNameError());
    this.buildBotPicker();
    this.changeMapButton.addEventListener("click", () => this.toggleMapPicker(true));
    requireElement("map-picker-cancel").addEventListener("click", () => this.toggleMapPicker(false));
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

  /**
   * Learn what can be played.
   *
   * From the server's welcome rather than any client-side list, because an
   * administrator can add arenas after this client was built. Called once per
   * connection; the picker is rebuilt to match.
   */
  setArenaChoices(arenas: readonly { id: string; name: string }[]): void {
    this.arenaNames = new Map(arenas.map((arena) => [arena.id, arena.name]));

    this.mapPickerOptions.replaceChildren();
    for (const arena of arenas) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "difficulty-option";
      button.dataset.arena = arena.id;

      const label = document.createElement("span");
      label.textContent = arena.name;
      button.append(label);
      button.addEventListener("click", () => {
        this.toggleMapPicker(false);
        this.callbacks.onSelectArena(arena.id);
      });
      this.mapPickerOptions.appendChild(button);
    }
  }

  private toggleMapPicker(open: boolean): void {
    toggleClass(this.mapPicker, "is-active", open);
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

    // The map being played, by name. The host may change it; everyone sees it.
    setText(this.mapName, this.arenaNames.get(state.arenaId) ?? state.arenaId ?? "-");
    this.changeMapButton.hidden = !this.isHost || this.arenaNames.size < 2;

    this.addBotButton.disabled = !this.isHost || state.playerCount >= state.maxPlayers;
    this.addBotButton.hidden = !this.isHost;
    this.startButton.disabled = !this.isHost || !state.canStart;
    this.startButton.hidden = !this.isHost;
    if (!this.isHost) {
      this.toggleBotPicker(false);
      this.toggleMapPicker(false);
    }

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

  // ------------------------------------------------------------- reconnecting

  /**
   * "Hold on, your seat is still yours."
   *
   * A banner rather than a screen: the match is still running on the other side
   * of it, and throwing somebody back to the menu for a dropped packet -- while
   * the server is still holding their place -- would be the client giving up
   * before the server does.
   */
  showReconnecting(secondsLeft: number): void {
    this.reconnect.hidden = false;
    setText(this.reconnectTimer, `${Math.max(0, Math.ceil(secondsLeft))}s`);
  }

  hideReconnecting(): void {
    this.reconnect.hidden = true;
  }

  // ----------------------------------------------------------------- career

  /**
   * Show what this player has done here before.
   *
   * Hidden entirely until they have finished a match: a row of zeroes on a first
   * visit is noise, and it invites the reading that the game is keeping score of
   * you rather than for you.
   */
  showCareer(career: PlayerCareer): void {
    this.lastCareer = career;
    this.menuCareer.hidden = career.matches === 0;

    // The results screen may already be up: the standings and the updated record
    // are two messages, and nothing promises which arrives first.
    if (this.activeScreen === "results") this.renderCareerLine();
    if (career.matches === 0) return;

    setText(this.careerMatches, String(career.matches));
    setText(this.careerWins, String(career.wins));
    setText(this.careerKills, String(career.kills));
    // Deaths of zero would divide by nothing; a player who has never died has a
    // ratio equal to their kills, which is the answer they expect.
    setText(this.careerKd, (career.kills / Math.max(1, career.deaths)).toFixed(1));
  }

  /** The most recent record, for the line under the standings. */
  private lastCareer: PlayerCareer | null = null;

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

    this.renderCareerLine();
    this.showScreen("results");
  }

  /**
   * A line under the standings saying where this leaves them.
   *
   * The server sends the updated record with the result, so by the time this
   * runs the numbers already include the match just played.
   */
  private renderCareerLine(): void {
    const career = this.lastCareer;
    if (!career || career.matches === 0) {
      this.resultsCareer.textContent = "";
      return;
    }

    this.resultsCareer.replaceChildren(
      document.createTextNode("Career: "),
      strong(`${career.wins}`),
      document.createTextNode(` win${career.wins === 1 ? "" : "s"} from `),
      strong(`${career.matches}`),
      document.createTextNode(" · "),
      strong(`${career.kills}`),
      document.createTextNode(" kills"),
      document.createTextNode(career.bestPlacement > 0 ? " · best finish " : ""),
      career.bestPlacement > 0 ? strong(ordinal(career.bestPlacement)) : document.createTextNode(""),
    );
  }

  setResultsCountdown(message: string): void {
    setText(this.resultsNext, message);
  }

  /**
   * Mark the request as made.
   *
   * The button is the only thing that can say "I heard you" before the server
   * acts, and pressing it a second time achieves nothing.
   */
  setPlayAgainReady(ready: boolean): void {
    this.playAgain.disabled = ready;
    setText(this.playAgain, ready ? "Ready" : "Play again");
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


function strong(text: string): HTMLElement {
  const element = document.createElement("b");
  element.textContent = text;
  return element;
}

/** 1 -> "1st". Only ever used for a handful of small numbers. */
function ordinal(value: number): string {
  const suffix = value === 1 ? "st" : value === 2 ? "nd" : value === 3 ? "rd" : "th";
  return `${value}${suffix}`;
}
