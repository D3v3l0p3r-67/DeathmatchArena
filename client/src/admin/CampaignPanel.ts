/**
 * The campaign level editor: the balance overlay, level by level.
 *
 * Deliberately not a second arena editor. A campaign level's *structure* --
 * geometry, triggers, encounters, bosses -- is content and ships with the
 * game; what an operator retunes live is how hard the level is. So each level
 * gets a card of balance knobs: the level-layer tuning multipliers, the
 * lives, the starting grenades, the par time. An empty field means "the
 * shipped value", shown as the placeholder, and clearing a field is the
 * reset. Save stores the whole overlay; the game fetches it best-effort the
 * next time the campaign menu opens.
 */
import {
  CAMPAIGN_LEVELS,
  CAMPAIGN_LIVES,
  CAMPAIGN_OVERRIDE_LIMITS,
  type CampaignLevelDefinition,
  type CampaignLevelOverride,
  type CampaignOverrides,
} from "@deathmatch/shared";
import type { AdminApi } from "./AdminApi.js";

interface PanelHooks {
  notify(message: string, tone: "info" | "error" | "success"): void;
}

/** One editable knob: where it lives in the override, and what stands in for "unset". */
interface KnobSpec {
  label: string;
  hint: string;
  read(override: CampaignLevelOverride): number | undefined;
  write(override: CampaignLevelOverride, value: number | undefined): void;
  shipped(level: CampaignLevelDefinition): string;
  min: number;
  max: number;
  step: number;
}

const LIMITS = CAMPAIGN_OVERRIDE_LIMITS;

function tuningKnob(
  label: string,
  key: "moveSpeed" | "projectileSpeed" | "fireRate" | "reactionTime",
  hint: string,
): KnobSpec {
  return {
    label,
    hint,
    read: (override) => override.enemyTuning?.[key],
    write: (override, value) => {
      const tuning = { ...override.enemyTuning };
      if (value === undefined) delete tuning[key];
      else tuning[key] = value;
      if (Object.keys(tuning).length === 0) delete override.enemyTuning;
      else override.enemyTuning = tuning;
    },
    shipped: (level) => {
      const value = level.enemyTuning?.[key];
      return value === undefined ? "1" : String(value);
    },
    min: LIMITS.multiplier.min,
    max: LIMITS.multiplier.max,
    step: 0.05,
  };
}

const KNOBS: KnobSpec[] = [
  tuningKnob("Enemy move speed ×", "moveSpeed", "Level layer of the tuning hierarchy."),
  tuningKnob("Enemy projectile speed ×", "projectileSpeed", "Bullets, rockets and thrown grenades."),
  tuningKnob("Enemy fire rate ×", "fireRate", "Shots per second."),
  tuningKnob("Enemy reaction time ×", "reactionTime", "Above 1 reacts slower — easier."),
  {
    label: "Lives",
    hint: "Attempts per level; losing the last ends the run.",
    read: (override) => override.lives,
    write: (override, value) => {
      if (value === undefined) delete override.lives;
      else override.lives = value;
    },
    shipped: (level) => (level.respawnRule.kind === "lives" ? String(level.respawnRule.lives) : String(CAMPAIGN_LIVES)),
    min: LIMITS.lives.min,
    max: LIMITS.lives.max,
    step: 1,
  },
  {
    label: "Starting grenades",
    hint: "What the level hands the player at the door.",
    read: (override) => override.startingGrenades,
    write: (override, value) => {
      if (value === undefined) delete override.startingGrenades;
      else override.startingGrenades = value;
    },
    shipped: (level) => String(level.startingGrenades),
    min: LIMITS.startingGrenades.min,
    max: LIMITS.startingGrenades.max,
    step: 1,
  },
  {
    label: "Par time (s)",
    hint: "Full time bonus at or under this; none at twice it.",
    read: (override) => (override.parTimeMs === undefined ? undefined : override.parTimeMs / 1000),
    write: (override, value) => {
      if (value === undefined) delete override.parTimeMs;
      else override.parTimeMs = Math.round(value * 1000);
    },
    shipped: (level) => String(level.parTimeMs / 1000),
    min: LIMITS.parTimeMs.min / 1000,
    max: LIMITS.parTimeMs.max / 1000,
    step: 15,
  },
];

export class CampaignPanel {
  readonly element = document.createElement("section");
  private overrides: CampaignOverrides = {};
  private dirty = false;

  constructor(
    private readonly api: AdminApi,
    private readonly hooks: PanelHooks,
  ) {
    this.element.className = "campaign-panel";
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  async load(): Promise<void> {
    this.overrides = await this.api.loadCampaignLevels();
    this.dirty = false;
    this.render();
  }

  private render(): void {
    this.element.replaceChildren();

    const intro = document.createElement("p");
    intro.className = "panel-note";
    intro.textContent =
      "Balance overrides over the shipped campaign levels. An empty field keeps the shipped value " +
      "(shown greyed); a filled one overrides it for every player from their next level start. " +
      "Structure — geometry, triggers, encounters, bosses — stays content and is edited in the level data.";
    this.element.append(intro);

    for (const level of CAMPAIGN_LEVELS) {
      this.element.append(this.levelCard(level));
    }

    const actions = document.createElement("div");
    actions.className = "campaign-panel__actions";
    const save = document.createElement("button");
    save.className = "button button--primary";
    save.textContent = "Save all levels";
    save.addEventListener("click", () => void this.save());
    actions.append(save);
    this.element.append(actions);
  }

  private levelCard(level: CampaignLevelDefinition): HTMLElement {
    const card = document.createElement("article");
    card.className = "campaign-card";

    const heading = document.createElement("h3");
    heading.className = "campaign-card__title";
    heading.textContent = level.name;
    const id = document.createElement("span");
    id.className = "campaign-card__id";
    id.textContent = level.id;
    heading.append(id);
    card.append(heading);

    const grid = document.createElement("div");
    grid.className = "campaign-card__grid";

    for (const knob of KNOBS) {
      const field = document.createElement("label");
      field.className = "campaign-card__field";

      const caption = document.createElement("span");
      caption.className = "campaign-card__label";
      caption.textContent = knob.label;
      caption.title = knob.hint;

      const input = document.createElement("input");
      input.type = "number";
      input.className = "campaign-card__input";
      input.min = String(knob.min);
      input.max = String(knob.max);
      input.step = String(knob.step);
      input.placeholder = knob.shipped(level);
      const current = knob.read(this.overrides[level.id] ?? {});
      if (current !== undefined) input.value = String(current);

      input.addEventListener("input", () => {
        const override = { ...(this.overrides[level.id] ?? {}) };
        const parsed = input.value.trim() === "" ? undefined : Number(input.value);
        const value =
          parsed === undefined || !Number.isFinite(parsed)
            ? undefined
            : Math.min(knob.max, Math.max(knob.min, parsed));
        knob.write(override, value);
        if (Object.keys(override).length === 0) delete this.overrides[level.id];
        else this.overrides[level.id] = override;
        this.dirty = true;
      });

      field.append(caption, input);
      grid.append(field);
    }

    card.append(grid);
    return card;
  }

  private async save(): Promise<void> {
    try {
      this.overrides = await this.api.saveCampaignLevels(this.overrides);
      this.dirty = false;
      this.render();
      this.hooks.notify("Campaign levels saved. Players pick the changes up at their next level start.", "success");
    } catch (error) {
      this.hooks.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }
}
