/**
 * Every campaign-owned piece of DOM: the level select, the in-game overlay
 * (score, objective, boss bar, toasts, the death card) and the results panel.
 *
 * Kept out of `UIManager` on purpose -- multiplayer never touches any of
 * this, and the campaign never touches the lobby.
 */
import {
  CAMPAIGN_DIFFICULTIES,
  type CampaignDifficultyId,
  type CampaignLevelDefinition,
  type CampaignLevelResult,
  type CampaignProgress,
} from "@deathmatch/shared";
import { getCampaignArena, type CampaignInterlude } from "@deathmatch/shared";
import { drawArenaThumbnail } from "./arenaThumbnail.js";
import type { BossStatus } from "../campaign/core/BossDirector.js";
import { query, requireElement, setText, toggleClass } from "./dom.js";

export interface CampaignUiCallbacks {
  onStart(levelId: string, difficulty: CampaignDifficultyId, resume: boolean): void;
  onBack(): void;
  onRetry(): void;
  onExitToMenu(): void;
  /** The player accepted the next level from the results screen. */
  onNextLevel(): void;
  /** The briefing card was dismissed; play the level it introduced. */
  onBriefingDone(): void;
}

export class CampaignUI {
  private readonly layer = query('[data-layer="campaign"]');
  private readonly levelList = requireElement<HTMLUListElement>("campaign-levels");
  private readonly difficultyOptions = requireElement("campaign-difficulty");
  private readonly startButton = requireElement<HTMLButtonElement>("campaign-start");
  private readonly continueButton = requireElement<HTMLButtonElement>("campaign-continue");

  private readonly score = requireElement("camp-score");
  private readonly kills = requireElement("camp-kills");
  private readonly livesRow = requireElement("camp-lives-row");
  private readonly lives = requireElement("camp-lives");
  private readonly objective = requireElement("camp-objective");
  private readonly boss = requireElement("camp-boss");
  private readonly bossName = requireElement("camp-boss-name");
  private readonly bossFill = requireElement("camp-boss-fill");
  private readonly toastEl = requireElement("camp-toast");
  private readonly death = requireElement("camp-death");
  private readonly deathTitle = requireElement("camp-death-title");
  private readonly deathDetail = requireElement("camp-death-detail");
  private readonly debugHint = requireElement("camp-debug");

  private readonly resultsEyebrow = requireElement("camp-results-eyebrow");
  private readonly resultsRank = requireElement("camp-results-rank");
  private readonly nextButton = requireElement<HTMLButtonElement>("camp-next");
  private readonly runTotal = requireElement("camp-run-total");

  private readonly difficultyNote = requireElement("campaign-difficulty-note");
  private readonly rankScale = requireElement("camp-rank-scale");
  private readonly briefEyebrow = requireElement("brief-eyebrow");
  private readonly briefLoadout = requireElement("brief-loadout");
  private readonly newBest = requireElement("camp-new-best");
  private readonly briefTitle = requireElement("brief-title");
  private readonly briefLines = requireElement("brief-lines");

  /** Cancels a briefing's own auto-advance if the player is quicker. */
  private briefTimer = 0;

  private selectedLevelId = "";
  private selectedDifficulty: CampaignDifficultyId = "normal";
  private toastTimer = 0;

  constructor(callbacks: CampaignUiCallbacks) {
    requireElement("campaign-back").addEventListener("click", () => callbacks.onBack());
    this.startButton.addEventListener("click", () => {
      if (this.selectedLevelId) callbacks.onStart(this.selectedLevelId, this.selectedDifficulty, false);
    });
    this.continueButton.addEventListener("click", () => {
      if (this.selectedLevelId) callbacks.onStart(this.selectedLevelId, this.selectedDifficulty, true);
    });
    requireElement("camp-retry").addEventListener("click", () => callbacks.onRetry());
    requireElement("camp-to-menu").addEventListener("click", () => callbacks.onExitToMenu());
    this.nextButton.addEventListener("click", () => callbacks.onNextLevel());
    requireElement("brief-begin").addEventListener("click", () => {
      window.clearTimeout(this.briefTimer);
      callbacks.onBriefingDone();
    });

    this.buildDifficultyOptions();
    this.describeDifficulty();
    this.buildRankScale();
  }

  /** The S-A-B-C-D ladder, so a rank means something at a glance. */
  private buildRankScale(): void {
    this.rankScale.replaceChildren();
    for (const rank of ["S", "A", "B", "C", "D"]) {
      const item = document.createElement("li");
      item.textContent = rank;
      item.dataset.rank = rank;
      this.rankScale.appendChild(item);
    }
  }

  // ----------------------------------------------------------- level select

  /**
   * (Re)build the level list. Levels unlock front to back: the first is
   * always playable, each further one once its predecessor is completed.
   */
  populate(
    levels: readonly CampaignLevelDefinition[],
    progress: CampaignProgress,
    resumableLevelId: string | null,
  ): void {
    this.levelList.replaceChildren();
    let previousCompleted = true;

    levels.forEach((level, index) => {
      const record = progress.levels[level.id];
      const unlocked = index === 0 || previousCompleted;
      previousCompleted = record?.completed ?? false;

      const row = document.createElement("li");
      row.className = "campaign-levels__row";
      if (!unlocked) row.classList.add("is-locked");
      // Focusable, so the whole list is reachable from a keyboard or a pad.
      if (unlocked) row.tabIndex = 0;

      const thumb = document.createElement("canvas");
      thumb.className = "campaign-levels__thumb";
      thumb.width = 120;
      thumb.height = 44;
      const arena = getCampaignArena(level.arenaId);
      if (arena) drawArenaThumbnail(thumb, arena);

      const text = document.createElement("div");
      text.className = "campaign-levels__text";

      const name = document.createElement("span");
      name.className = "campaign-levels__name";
      name.textContent = `${index + 1}. ${level.name}`;

      const recordText = document.createElement("span");
      recordText.className = "campaign-levels__record";
      if (!unlocked) {
        recordText.textContent = "Locked — finish the level before it";
      } else if (record?.completed) {
        // What the player actually did here, rather than the word "completed".
        const parts = [`Best ${record.bestScore.toLocaleString()}`];
        parts.push(`${record.secretsFound}/${level.secrets.length} secrets`);
        if (record.completedDifficulties.length > 0) {
          parts.push(record.completedDifficulties.join(", "));
        }
        recordText.textContent = parts.join(" · ");
      } else {
        const par = Math.round(level.parTimeMs / 60000);
        recordText.textContent = `Not yet cleared · par ${par} min · ${level.secrets.length} secrets`;
      }

      text.append(name, recordText);

      const rank = document.createElement("span");
      rank.className = "campaign-levels__rank";
      rank.textContent = record?.bestRank ?? (unlocked ? "" : "🔒");

      row.append(thumb, text, rank);
      if (unlocked) {
        const choose = () => {
          this.selectedLevelId = level.id;
          for (const sibling of this.levelList.children) sibling.classList.remove("is-selected");
          row.classList.add("is-selected");
          this.continueButton.hidden = resumableLevelId !== level.id;
        };
        row.addEventListener("click", choose);
        row.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            choose();
          }
        });
        if (this.selectedLevelId === "" || this.selectedLevelId === level.id) {
          this.selectedLevelId = level.id;
          row.classList.add("is-selected");
        }
      }
      this.levelList.appendChild(row);
    });

    this.continueButton.hidden = resumableLevelId !== this.selectedLevelId;
  }

  /** One line saying what the chosen difficulty actually changes. */
  private describeDifficulty(): void {
    const difficulty = CAMPAIGN_DIFFICULTIES.find((entry) => entry.id === this.selectedDifficulty);
    if (!difficulty) return;
    const skill =
      difficulty.skillShift === 0
        ? "enemies at their standard skill"
        : difficulty.skillShift > 0
          ? `enemies ${difficulty.skillShift} rung${difficulty.skillShift === 1 ? "" : "s"} sharper`
          : `enemies ${-difficulty.skillShift} rung${difficulty.skillShift === -1 ? "" : "s"} duller`;
    setText(
      this.difficultyNote,
      `${skill} · ${Math.round(difficulty.enemyHealthScale * 100)}% health · ` +
        `${Math.round(difficulty.scoreScale * 100)}% score`,
    );
  }

  private buildDifficultyOptions(): void {
    this.difficultyOptions.replaceChildren();
    for (const difficulty of CAMPAIGN_DIFFICULTIES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "difficulty-option difficulty-option--segment";
      if (difficulty.id === this.selectedDifficulty) button.classList.add("is-selected");

      const label = document.createElement("span");
      label.textContent = difficulty.name;
      button.append(label);
      button.addEventListener("click", () => {
        this.selectedDifficulty = difficulty.id;
        for (const sibling of this.difficultyOptions.children) sibling.classList.remove("is-selected");
        button.classList.add("is-selected");
        this.describeDifficulty();
      });
      this.difficultyOptions.appendChild(button);
    }
  }

  get difficulty(): CampaignDifficultyId {
    return this.selectedDifficulty;
  }

  get levelId(): string {
    return this.selectedLevelId;
  }

  // -------------------------------------------------------------- in-game

  setLayerActive(active: boolean): void {
    toggleClass(this.layer, "is-active", active);
    if (!active) {
      this.setBoss(null);
      this.hideDeath();
      this.toastEl.hidden = true;
      setText(this.objective, "");
      this.debugHint.hidden = true;
    }
  }

  setStats(score: number, kills: number, livesLeft: number | null): void {
    setText(this.score, score.toLocaleString());
    setText(this.kills, String(kills));
    this.livesRow.hidden = livesLeft === null;
    if (livesLeft !== null) setText(this.lives, String(livesLeft));
  }

  setObjective(text: string): void {
    setText(this.objective, text);
  }

  setBoss(status: BossStatus | null): void {
    this.boss.hidden = status === null;
    if (!status) return;
    setText(this.bossName, status.name.toUpperCase());
    (this.bossFill as HTMLElement).style.width = `${(status.health / Math.max(1, status.maxHealth)) * 100}%`;
  }

  toast(text: string, durationMs: number): void {
    setText(this.toastEl, text);
    this.toastEl.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.hidden = true;
    }, durationMs);
  }

  showDeath(livesLeft: number | null): void {
    setText(this.deathTitle, "You are down.");
    setText(
      this.deathDetail,
      livesLeft === null
        ? "Respawning at the last checkpoint…"
        : `${livesLeft} ${livesLeft === 1 ? "life" : "lives"} left · back to the last checkpoint…`,
    );
    toggleClass(this.death, "is-gameover", false);
    this.death.hidden = false;
  }

  /**
   * The last death, which is a different event: the run is over and no
   * checkpoint is coming. Held over the level for a moment before the results
   * take the screen, so the ending is read rather than skipped past.
   */
  showGameOver(): void {
    setText(this.deathTitle, "GAME OVER");
    setText(this.deathDetail, "Out of lives.");
    toggleClass(this.death, "is-gameover", true);
    this.death.hidden = false;
  }

  hideDeath(): void {
    this.death.hidden = true;
    toggleClass(this.death, "is-gameover", false);
  }

  setDebugHint(visible: boolean): void {
    this.debugHint.hidden = !visible;
  }

  // -------------------------------------------------------------- results

  /**
   * Show a level's opening card.
   *
   * `kind` is switched on rather than assumed, so a later `cutscene` or `shop`
   * interlude lands here as another branch instead of a rewrite.
   */
  /** What the player walks in carrying, shown on the briefing card. */
  setBriefingLoadout(entries: readonly string[]): void {
    this.briefLoadout.replaceChildren();
    for (const entry of entries) {
      const chip = document.createElement("span");
      chip.textContent = entry;
      this.briefLoadout.appendChild(chip);
    }
  }

  showInterlude(interlude: CampaignInterlude, onAutoAdvance: () => void): void {
    switch (interlude.kind) {
      case "briefing": {
        setText(this.briefEyebrow, interlude.eyebrow ?? "");
        setText(this.briefTitle, interlude.title);
        this.briefLines.replaceChildren();
        for (const line of interlude.lines) {
          const paragraph = document.createElement("p");
          paragraph.textContent = line;
          this.briefLines.appendChild(paragraph);
        }
        window.clearTimeout(this.briefTimer);
        if (interlude.autoAdvanceMs && interlude.autoAdvanceMs > 0) {
          this.briefTimer = window.setTimeout(onAutoAdvance, interlude.autoAdvanceMs);
        }
        return;
      }
    }
  }

  /** Say so when the score just beaten was the player's own record. */
  setNewBest(isBest: boolean): void {
    this.newBest.hidden = !isBest;
  }

  /** Offer the next level, and show what the run has scored so far. */
  setNextLevel(name: string | null, runTotal: number | null): void {
    this.nextButton.hidden = name === null;
    if (name) setText(this.nextButton, `Next: ${name}`);

    this.runTotal.hidden = runTotal === null;
    if (runTotal !== null) setText(this.runTotal, `Run total: ${runTotal.toLocaleString()}`);
  }

  private lightRankScale(earned: string | null): void {
    for (const item of this.rankScale.children) {
      const element = item as HTMLElement;
      element.classList.toggle("is-earned", earned !== null && element.dataset.rank === earned);
    }
  }

  showResults(result: CampaignLevelResult | null): void {
    if (result) {
      setText(this.resultsEyebrow, "Level complete");
      setText(this.resultsRank, result.rank);
      toggleClass(this.resultsRank, "is-failed", false);
      this.lightRankScale(result.rank);
      setText(requireElement("camp-r-score"), result.score.toLocaleString());
      setText(requireElement("camp-r-kills"), String(result.kills));
      setText(requireElement("camp-r-deaths"), String(result.deaths));
      setText(requireElement("camp-r-secrets"), `${result.secretsFound}/${result.secretsTotal}`);
      const totalSeconds = Math.round(result.timeMs / 1000);
      setText(
        requireElement("camp-r-time"),
        `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`,
      );
      setText(requireElement("camp-r-accuracy"), `${Math.round(result.accuracy * 100)}%`);
    } else {
      setText(this.resultsEyebrow, "Game over");
      setText(this.resultsRank, "✕");
      toggleClass(this.resultsRank, "is-failed", true);
      this.lightRankScale(null);
      for (const id of ["camp-r-score", "camp-r-kills", "camp-r-deaths", "camp-r-secrets", "camp-r-time", "camp-r-accuracy"]) {
        setText(requireElement(id), "—");
      }
    }
  }
}
