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
import type { BossStatus } from "../campaign/core/BossDirector.js";
import { query, requireElement, setText, toggleClass } from "./dom.js";

export interface CampaignUiCallbacks {
  onStart(levelId: string, difficulty: CampaignDifficultyId, resume: boolean): void;
  onBack(): void;
  onRetry(): void;
  onExitToMenu(): void;
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
  private readonly deathDetail = requireElement("camp-death-detail");
  private readonly debugHint = requireElement("camp-debug");

  private readonly resultsEyebrow = requireElement("camp-results-eyebrow");
  private readonly resultsRank = requireElement("camp-results-rank");

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

    this.buildDifficultyOptions();
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

      const name = document.createElement("span");
      name.className = "campaign-levels__name";
      name.textContent = `${index + 1}. ${level.name}`;

      const recordText = document.createElement("span");
      recordText.className = "campaign-levels__record";
      recordText.textContent = record?.completed
        ? `best ${record.bestScore.toLocaleString()}`
        : unlocked
          ? "available"
          : "locked";

      const rank = document.createElement("span");
      rank.className = "campaign-levels__rank";
      rank.textContent = record?.bestRank ?? "";

      row.append(name, recordText, rank);
      if (unlocked) {
        row.addEventListener("click", () => {
          this.selectedLevelId = level.id;
          for (const sibling of this.levelList.children) sibling.classList.remove("is-selected");
          row.classList.add("is-selected");
          this.continueButton.hidden = resumableLevelId !== level.id;
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

  private buildDifficultyOptions(): void {
    this.difficultyOptions.replaceChildren();
    for (const difficulty of CAMPAIGN_DIFFICULTIES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "difficulty-option";
      if (difficulty.id === this.selectedDifficulty) button.classList.add("is-preferred");

      const label = document.createElement("span");
      label.textContent = difficulty.name;
      button.append(label);
      button.addEventListener("click", () => {
        this.selectedDifficulty = difficulty.id;
        for (const sibling of this.difficultyOptions.children) sibling.classList.remove("is-preferred");
        button.classList.add("is-preferred");
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
    setText(
      this.deathDetail,
      livesLeft === null
        ? "Respawning at the last checkpoint…"
        : `${livesLeft} ${livesLeft === 1 ? "life" : "lives"} left…`,
    );
    this.death.hidden = false;
  }

  hideDeath(): void {
    this.death.hidden = true;
  }

  setDebugHint(visible: boolean): void {
    this.debugHint.hidden = !visible;
  }

  // -------------------------------------------------------------- results

  showResults(result: CampaignLevelResult | null): void {
    if (result) {
      setText(this.resultsEyebrow, "Level complete");
      setText(this.resultsRank, result.rank);
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
      setText(this.resultsEyebrow, "Level failed");
      setText(this.resultsRank, "✕");
      for (const id of ["camp-r-score", "camp-r-kills", "camp-r-deaths", "camp-r-secrets", "camp-r-time", "camp-r-accuracy"]) {
        setText(requireElement(id), "—");
      }
    }
  }
}
