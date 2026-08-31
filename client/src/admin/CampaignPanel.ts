/**
 * The campaign level editor.
 *
 * Mirrors the arena panel's shape: a list of levels, then an editor for one.
 * The editor holds one working document and shows it three ways -- a canvas
 * where everything placeable is draggable, a form for the level's scalar
 * fields, and the raw JSON for the parts no visual tool reaches (trigger
 * actions, wave composition, boss phases). All three edit the *same* object,
 * so switching views never loses work, and Save ships exactly what is on
 * screen. The server re-normalizes and re-validates on save and returns the
 * issues verbatim; this panel's job is to show them next to the button.
 */
import {
  CAMPAIGN_ENEMIES,
  getCampaignArena,
  listWeapons,
  normalizeCampaignLevel,
  type CampaignLevelDefinition,
  type CampaignZone,
} from "@deathmatch/shared";
import type { AdminApi, CampaignLevelSummary } from "./AdminApi.js";
import { CampaignLevelCanvas, type LevelObject } from "./CampaignLevelCanvas.js";

interface PanelHooks {
  notify(message: string, tone: "info" | "error" | "success"): void;
}

type View = "canvas" | "level" | "json";

export class CampaignPanel {
  readonly element = document.createElement("section");
  private summaries: CampaignLevelSummary[] = [];
  private doc: CampaignLevelDefinition | null = null;
  private canvas: CampaignLevelCanvas | null = null;
  private view: View = "canvas";
  private dirty = false;
  private issuesBox = document.createElement("ul");

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
    this.summaries = await this.api.listCampaignLevels();
    this.doc = null;
    this.canvas = null;
    this.dirty = false;
    this.renderList();
  }

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------

  private renderList(): void {
    this.element.replaceChildren();
    const intro = document.createElement("p");
    intro.className = "panel-note";
    intro.textContent =
      "Whole level documents, stored like arenas: an edited level shadows the shipped one and reaches " +
      "players at their next level start; Reset deletes the stored copy and the shipped level returns. " +
      "Arena geometry is edited in the Arenas tab — this edits the campaign layer on top of it.";
    this.element.append(intro);

    for (const summary of this.summaries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "campaign-row";
      const name = document.createElement("strong");
      name.textContent = summary.name;
      const meta = document.createElement("span");
      meta.className = "campaign-row__meta";
      meta.textContent = `${summary.id} · arena ${summary.arenaId}${summary.edited ? " · EDITED" : ""}`;
      row.append(name, meta);
      row.addEventListener("click", () => void this.open(summary.id));
      this.element.append(row);
    }
  }

  private async open(id: string): Promise<void> {
    const { level } = await this.api.getCampaignLevel(id);
    this.doc = level;
    this.dirty = false;
    this.view = "canvas";
    this.renderEditor();
  }

  // -------------------------------------------------------------------------
  // The editor
  // -------------------------------------------------------------------------

  private renderEditor(): void {
    const doc = this.doc;
    if (!doc) return;
    const arena = getCampaignArena(doc.arenaId);
    this.element.replaceChildren();

    // ---- toolbar ------------------------------------------------------------
    const toolbar = document.createElement("div");
    toolbar.className = "campaign-editor__toolbar";
    const back = this.button("← Levels", () => {
      if (this.dirty && !window.confirm("Discard unsaved changes?")) return;
      void this.load();
    });
    const title = document.createElement("strong");
    title.textContent = `${doc.name} (${doc.id})`;
    const tabs = document.createElement("div");
    tabs.className = "campaign-editor__tabs";
    for (const [view, label] of [
      ["canvas", "Canvas"],
      ["level", "Level"],
      ["json", "JSON"],
    ] as const) {
      const tab = this.button(label, () => {
        this.view = view;
        this.renderEditor();
      });
      tab.classList.toggle("is-active", this.view === view);
      tabs.append(tab);
    }
    const save = this.button("Save", () => void this.save());
    save.classList.add("button--primary");
    const reset = this.button("Reset to shipped", () => void this.reset());
    toolbar.append(back, title, tabs, save, reset);
    this.element.append(toolbar);

    this.issuesBox = document.createElement("ul");
    this.issuesBox.className = "campaign-editor__issues";
    this.element.append(this.issuesBox);

    // ---- the active view ----------------------------------------------------
    if (this.view === "canvas" && arena) {
      const split = document.createElement("div");
      split.className = "campaign-editor__split";
      const inspector = document.createElement("div");
      inspector.className = "campaign-editor__inspector";

      this.canvas = new CampaignLevelCanvas(doc, arena, {
        onSelect: (object) => this.renderInspector(inspector, object),
        onChanged: () => {
          this.dirty = true;
          this.renderInspector(inspector, this.canvas?.selected ?? null);
        },
      });
      split.append(this.canvas.element, inspector);
      this.element.append(split);
      this.renderInspector(inspector, null);
      requestAnimationFrame(() => this.canvas?.fit());
    } else if (this.view === "level") {
      this.element.append(this.levelForm(doc));
    } else if (this.view === "json") {
      this.element.append(this.jsonView(doc));
    } else if (!arena) {
      const missing = document.createElement("p");
      missing.textContent = `Arena ${doc.arenaId} is not a campaign arena; edit the JSON to point at one.`;
      this.element.append(missing);
    }
  }

  // -------------------------------------------------------------------------
  // Inspector (canvas view)
  // -------------------------------------------------------------------------

  private renderInspector(host: HTMLElement, object: LevelObject | null): void {
    host.replaceChildren();
    const doc = this.doc!;

    if (!object) {
      const hint = document.createElement("p");
      hint.className = "panel-note";
      hint.textContent =
        "Click anything to select it; drag to move. Zones select by their area, points by their dot. " +
        "Trigger actions, waves and boss phases are edited on the JSON tab.";
      host.append(hint);

      // Adding the three shapes with obvious homes.
      host.append(
        this.button("+ Checkpoint", () => {
          const id = this.freshId("cp", doc.checkpoints.map((entry) => entry.id));
          const centre = this.viewCentre();
          doc.checkpoints.push({ id, x: centre.x, y: centre.y, zone: { x: centre.x - 60, y: 0, width: 120, height: 1400 } });
          this.markChanged();
        }),
        this.button("+ Camera zone", () => {
          const id = this.freshId("zone", doc.cameraZones.map((entry) => entry.id));
          const centre = this.viewCentre();
          doc.cameraZones.push({ id, zone: { x: centre.x - 400, y: 0, width: 800, height: 1400 } });
          this.markChanged();
        }),
        this.button("+ Secret", () => {
          const id = this.freshId("s", doc.secrets.map((entry) => entry.id));
          const centre = this.viewCentre();
          doc.secrets.push({ id, zone: { x: centre.x - 60, y: centre.y - 60, width: 120, height: 120 }, points: 500 });
          this.markChanged();
        }),
      );
      return;
    }

    const heading = document.createElement("h3");
    heading.textContent = object.label;
    host.append(heading);

    const point = object.getPoint();
    host.append(
      this.numberField("x", point.x, (value) => {
        object.setPoint(value, object.getPoint().y);
        this.markChanged(object);
      }),
      this.numberField("y", point.y, (value) => {
        object.setPoint(object.getPoint().x, value);
        this.markChanged(object);
      }),
    );

    const zone = object.getZone?.();
    if (zone && object.setZone) {
      const setZone = (patch: Partial<CampaignZone>) => {
        object.setZone!({ ...object.getZone!(), ...patch });
        this.markChanged(object);
      };
      host.append(
        this.numberField("zone x", zone.x, (value) => setZone({ x: value })),
        this.numberField("zone y", zone.y, (value) => setZone({ y: value })),
        this.numberField("zone width", zone.width, (value) => setZone({ width: Math.max(1, value) })),
        this.numberField("zone height", zone.height, (value) => setZone({ height: Math.max(1, value) })),
      );
    }

    if (object.kind === "enemy") {
      const select = document.createElement("select");
      select.className = "campaign-card__input";
      for (const enemy of CAMPAIGN_ENEMIES) {
        const option = document.createElement("option");
        option.value = enemy.id;
        option.textContent = enemy.name;
        select.append(option);
      }
      const spawn = this.enemyByKey(object.key);
      if (spawn) select.value = spawn.type;
      select.addEventListener("change", () => {
        const target = this.enemyByKey(object.key);
        if (target) {
          target.type = select.value;
          this.markChanged(object);
        }
      });
      const field = document.createElement("label");
      field.className = "campaign-card__field";
      const caption = document.createElement("span");
      caption.className = "campaign-card__label";
      caption.textContent = "Enemy type";
      field.append(caption, select);
      host.append(field);
    }

    if (this.canDelete(object)) {
      host.append(
        this.button("Delete", () => {
          this.deleteObject(object);
          this.markChanged();
        }),
      );
    }
  }

  private enemyByKey(key: string) {
    const doc = this.doc!;
    const parts = key.split(":");
    if (parts[0] === "trigger") {
      const trigger = doc.triggers.find((entry) => entry.id === parts[1]);
      const action = trigger?.actions[Number(parts[3])];
      return action?.kind === "spawnEnemies" ? action.enemies[Number(parts[5])] : undefined;
    }
    if (parts[0] === "encounter") {
      const encounter = doc.encounters.find((entry) => entry.id === parts[1]);
      return encounter?.waves[Number(parts[3])]?.enemies[Number(parts[5])];
    }
    if (parts[0] === "bossPhase") {
      return doc.boss?.phases[Number(parts[1])]?.spawnAdds?.[Number(parts[3])];
    }
    return undefined;
  }

  private canDelete(object: LevelObject): boolean {
    return (
      object.kind === "checkpoint" ||
      object.kind === "cameraZone" ||
      object.kind === "secret" ||
      object.kind === "enemy"
    );
  }

  private deleteObject(object: LevelObject): void {
    const doc = this.doc!;
    const parts = object.key.split(":");
    if (object.kind === "checkpoint") {
      doc.checkpoints = doc.checkpoints.filter((entry) => entry.id !== parts[1]);
    } else if (object.kind === "cameraZone") {
      doc.cameraZones = doc.cameraZones.filter((entry) => entry.id !== parts[1]);
    } else if (object.kind === "secret") {
      doc.secrets = doc.secrets.filter((entry) => entry.id !== parts[1]);
    } else if (object.kind === "enemy") {
      if (parts[0] === "trigger") {
        const trigger = doc.triggers.find((entry) => entry.id === parts[1]);
        const action = trigger?.actions[Number(parts[3])];
        if (action?.kind === "spawnEnemies") action.enemies.splice(Number(parts[5]), 1);
      } else if (parts[0] === "encounter") {
        const encounter = doc.encounters.find((entry) => entry.id === parts[1]);
        encounter?.waves[Number(parts[3])]?.enemies.splice(Number(parts[5]), 1);
      } else if (parts[0] === "bossPhase") {
        doc.boss?.phases[Number(parts[1])]?.spawnAdds?.splice(Number(parts[3]), 1);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Level fields (form view)
  // -------------------------------------------------------------------------

  private levelForm(doc: CampaignLevelDefinition): HTMLElement {
    const grid = document.createElement("div");
    grid.className = "campaign-card__grid campaign-editor__form";

    grid.append(
      this.textField("Name", doc.name, (value) => {
        if (value) doc.name = value;
      }),
      this.selectField(
        "Starting weapon",
        listWeapons().map((weapon) => [weapon.id, weapon.name]),
        doc.startingWeapon,
        (value) => (doc.startingWeapon = value),
      ),
      this.numberField("Starting grenades", doc.startingGrenades, (value) => (doc.startingGrenades = Math.max(0, Math.round(value)))),
      this.numberField("Par time (s)", doc.parTimeMs / 1000, (value) => (doc.parTimeMs = Math.max(30, Math.round(value)) * 1000)),
      this.numberField(
        "Lives",
        doc.respawnRule.kind === "lives" ? doc.respawnRule.lives : 0,
        (value) => (doc.respawnRule = { kind: "lives", lives: Math.min(9, Math.max(1, Math.round(value))) }),
      ),
      this.numberField("Enemy move speed ×", doc.enemyTuning?.moveSpeed ?? 1, (value) => this.setTuning(doc, "moveSpeed", value)),
      this.numberField("Enemy projectile speed ×", doc.enemyTuning?.projectileSpeed ?? 1, (value) => this.setTuning(doc, "projectileSpeed", value)),
      this.numberField("Enemy fire rate ×", doc.enemyTuning?.fireRate ?? 1, (value) => this.setTuning(doc, "fireRate", value)),
      this.numberField("Enemy reaction time ×", doc.enemyTuning?.reactionTime ?? 1, (value) => this.setTuning(doc, "reactionTime", value)),
      this.textField("Next level id", doc.nextLevelId ?? "", (value) => {
        if (value) doc.nextLevelId = value;
        else delete doc.nextLevelId;
      }),
      this.textField("Music track id", doc.musicTrackId ?? "", (value) => {
        if (value) doc.musicTrackId = value;
        else delete doc.musicTrackId;
      }),
    );
    return grid;
  }

  private setTuning(doc: CampaignLevelDefinition, key: "moveSpeed" | "projectileSpeed" | "fireRate" | "reactionTime", value: number): void {
    const tuning = { ...doc.enemyTuning };
    if (value === 1) delete tuning[key];
    else tuning[key] = Math.min(5, Math.max(0.05, value));
    if (Object.keys(tuning).length === 0) delete doc.enemyTuning;
    else doc.enemyTuning = tuning;
  }

  // -------------------------------------------------------------------------
  // JSON view
  // -------------------------------------------------------------------------

  private jsonView(doc: CampaignLevelDefinition): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "campaign-editor__json";
    const area = document.createElement("textarea");
    area.className = "campaign-editor__jsonarea";
    area.value = JSON.stringify(doc, null, 2);
    area.spellcheck = false;

    const apply = this.button("Apply JSON", () => {
      try {
        const { level, issues } = normalizeCampaignLevel(JSON.parse(area.value));
        if (!level || issues.length > 0) {
          this.showIssues(issues.length > 0 ? issues : ["the document could not be read"]);
          return;
        }
        this.doc = level;
        this.dirty = true;
        this.showIssues([]);
        this.hooks.notify("JSON applied to the working copy. Save to store it.", "info");
        this.renderEditor();
      } catch (error) {
        this.showIssues([error instanceof Error ? error.message : String(error)]);
      }
    });
    apply.classList.add("button--primary");
    wrap.append(area, apply);
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Save / reset
  // -------------------------------------------------------------------------

  private async save(): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    try {
      const result = await this.api.saveCampaignLevel(doc.id, doc);
      if (!result.ok) {
        this.showIssues(result.issues);
        this.hooks.notify("The level was not saved; see the issues above.", "error");
        return;
      }
      this.doc = result.level ?? doc;
      this.dirty = false;
      this.showIssues([]);
      this.hooks.notify("Level saved. Players pick it up at their next level start.", "success");
      this.renderEditor();
    } catch (error) {
      this.hooks.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  private async reset(): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    if (!window.confirm("Delete the stored document and return to the shipped level?")) return;
    await this.api.resetCampaignLevel(doc.id);
    await this.open(doc.id);
    this.hooks.notify("Back to the shipped level.", "success");
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  private markChanged(reselect?: LevelObject): void {
    this.dirty = true;
    this.canvas?.refresh();
    if (reselect) this.canvas?.draw();
    else this.renderEditor();
  }

  private viewCentre(): { x: number; y: number } {
    // Good enough for "appears where I am looking": the arena's vertical
    // middle at whatever the canvas currently centres horizontally.
    const doc = this.doc!;
    const arena = getCampaignArena(doc.arenaId);
    return { x: (arena?.width ?? 2000) / 2, y: (arena?.height ?? 1200) / 2 };
  }

  private freshId(prefix: string, taken: string[]): string {
    for (let index = 1; ; index++) {
      const candidate = `${prefix}${index}`;
      if (!taken.includes(candidate)) return candidate;
    }
  }

  private showIssues(issues: string[]): void {
    this.issuesBox.replaceChildren(
      ...issues.map((issue) => {
        const item = document.createElement("li");
        item.textContent = issue;
        return item;
      }),
    );
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "button";
    element.textContent = label;
    element.addEventListener("click", onClick);
    return element;
  }

  private numberField(label: string, value: number, onChange: (value: number) => void): HTMLElement {
    const field = document.createElement("label");
    field.className = "campaign-card__field";
    const caption = document.createElement("span");
    caption.className = "campaign-card__label";
    caption.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.className = "campaign-card__input";
    input.value = String(value);
    input.addEventListener("change", () => {
      const parsed = Number(input.value);
      if (Number.isFinite(parsed)) {
        onChange(parsed);
        this.dirty = true;
        this.canvas?.refresh();
      }
    });
    field.append(caption, input);
    return field;
  }

  private textField(label: string, value: string, onChange: (value: string) => void): HTMLElement {
    const field = document.createElement("label");
    field.className = "campaign-card__field";
    const caption = document.createElement("span");
    caption.className = "campaign-card__label";
    caption.textContent = label;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "campaign-card__input";
    input.value = value;
    input.addEventListener("change", () => {
      onChange(input.value.trim());
      this.dirty = true;
    });
    field.append(caption, input);
    return field;
  }

  private selectField(
    label: string,
    options: [string, string][],
    value: string,
    onChange: (value: string) => void,
  ): HTMLElement {
    const field = document.createElement("label");
    field.className = "campaign-card__field";
    const caption = document.createElement("span");
    caption.className = "campaign-card__label";
    caption.textContent = label;
    const select = document.createElement("select");
    select.className = "campaign-card__input";
    for (const [id, name] of options) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = name;
      select.append(option);
    }
    select.value = value;
    select.addEventListener("change", () => {
      onChange(select.value);
      this.dirty = true;
    });
    field.append(caption, select);
    return field;
  }
}
