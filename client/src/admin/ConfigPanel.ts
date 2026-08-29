import type { ConfigValue } from "@deathmatch/shared";
import type { AdminApi, ConfigField, ConfigSnapshot } from "./AdminApi.js";
import { createControl } from "./controls.js";

export interface ConfigPanelHooks {
  /** Report progress, a refusal or a success to the shell's status line. */
  notify(message: string, tone: "info" | "error" | "success"): void;
}

/**
 * The game configuration editor.
 *
 * Not one line of this knows what a shotgun is. It receives a list of described
 * values from the server, groups them by the categories those descriptions
 * declare, and renders a control per type. Adding a weapon, a power-up or a
 * whole new section of settings changes what appears here without changing
 * anything here -- which was the point of describing the configuration in the
 * first place.
 *
 * Edits are collected and sent together. A batch is applied all or nothing on
 * the server, so a form with five changes cannot end up half applied.
 */
export class ConfigPanel {
  private readonly root = document.createElement("div");
  private snapshot: ConfigSnapshot = { categories: [], fields: [] };
  private pending = new Map<string, ConfigValue>();
  private activeCategory = "";

  /**
   * The header controls whose state changes as fields are edited.
   *
   * Held so they can be updated in place. Rebuilding the header instead would
   * be a real bug rather than mere waste: leaving a number field fires `change`
   * on blur, so clicking "Apply" replaces the button under the cursor and the
   * click lands on a node that is no longer in the document -- the classic
   * button that needs pressing twice.
   */
  private saveButton: HTMLButtonElement | null = null;
  private resetCategoryButton: HTMLButtonElement | null = null;

  constructor(
    private readonly api: AdminApi,
    private readonly hooks: ConfigPanelHooks,
  ) {
    this.root.className = "config";
  }

  get element(): HTMLElement {
    return this.root;
  }

  async load(): Promise<void> {
    this.snapshot = await this.api.loadConfig();
    this.pending.clear();
    if (!this.snapshot.categories.some((entry) => entry.category === this.activeCategory)) {
      this.activeCategory = this.snapshot.categories[0]?.category ?? "";
    }
    this.render();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    this.root.replaceChildren(this.renderSidebar(), this.renderBody());
  }

  /**
   * Bring the header's buttons up to date without replacing them.
   *
   * Editing a field changes exactly two things: that row's state and the save
   * button's count. Both are updated in place -- see `saveButton` for why
   * rebuilding would break the next click.
   */
  private updateHeaderState(): void {
    const count = this.pending.size;
    if (this.saveButton) {
      this.saveButton.textContent =
        count === 0 ? "No changes" : `Apply ${count} change${count === 1 ? "" : "s"}`;
      this.saveButton.disabled = count === 0;
    }
    if (this.resetCategoryButton) {
      this.resetCategoryButton.disabled = !this.categoryIsModified(this.activeCategory);
    }
  }

  private renderSidebar(): HTMLElement {
    const nav = document.createElement("nav");
    nav.className = "config__nav";

    for (const { category } of this.snapshot.categories) {
      const navButton = document.createElement("button");
      navButton.type = "button";
      navButton.className = "config__nav-item";
      navButton.textContent = category;
      navButton.classList.toggle("is-active", category === this.activeCategory);

      // A dot rather than a count: the useful question is "has anything here been
      // changed from the default", not how many things.
      if (this.categoryIsModified(category)) navButton.classList.add("is-modified");

      navButton.addEventListener("click", () => {
        this.activeCategory = category;
        this.render();
      });
      nav.append(navButton);
    }

    return nav;
  }

  private renderBody(): HTMLElement {
    const body = document.createElement("div");
    body.className = "config__body";

    const entry = this.snapshot.categories.find((candidate) => candidate.category === this.activeCategory);
    if (!entry) {
      body.append(emptyState("No settings to show."));
      return body;
    }

    body.append(this.renderCategoryHeader(entry.category));

    for (const subcategory of entry.subcategories) {
      body.append(this.renderSection(entry.category, subcategory));
    }

    return body;
  }

  private renderCategoryHeader(category: string): HTMLElement {
    const header = document.createElement("header");
    header.className = "config__header";

    const title = document.createElement("h2");
    title.textContent = category;

    const actions = document.createElement("div");
    actions.className = "config__header-actions";

    const reset = button("Reset category", "ghost", () => {
      void this.reset({ category }, `Reset ${category} to defaults`);
    });
    reset.disabled = !this.categoryIsModified(category);
    this.resetCategoryButton = reset;

    actions.append(reset, this.renderSaveButton());
    header.append(title, actions);
    return header;
  }

  private renderSaveButton(): HTMLButtonElement {
    const count = this.pending.size;
    const save = button(
      count === 0 ? "No changes" : `Apply ${count} change${count === 1 ? "" : "s"}`,
      "primary",
      () => void this.save(),
    );
    save.disabled = count === 0;
    this.saveButton = save;
    return save;
  }

  private renderSection(category: string, subcategory: string): HTMLElement {
    const section = document.createElement("section");
    section.className = "config__section";

    const fields = this.snapshot.fields.filter(
      (field) => field.category === category && field.subcategory === subcategory,
    );

    const header = document.createElement("div");
    header.className = "config__section-header";

    const title = document.createElement("h3");
    title.textContent = subcategory;

    const reset = button("Reset section", "ghost small", () => {
      void this.reset({ category, subcategory }, `Reset ${category} / ${subcategory}`);
    });
    reset.disabled = !fields.some((field) => field.overridden);

    header.append(title, reset);
    section.append(header);

    for (const field of fields) section.append(this.renderField(field));
    return section;
  }

  private renderField(field: ConfigField): HTMLElement {
    const row = document.createElement("div");
    row.className = "field";
    if (field.overridden) row.classList.add("is-overridden");
    if (this.pending.has(field.key)) row.classList.add("is-pending");

    const label = document.createElement("div");
    label.className = "field__label";

    const name = document.createElement("span");
    name.className = "field__name";
    name.textContent = field.label;

    const key = document.createElement("code");
    key.className = "field__key";
    key.textContent = field.key;

    label.append(name, key);

    if (field.description) {
      const description = document.createElement("p");
      description.className = "field__description";
      description.textContent = field.description;
      label.append(description);
    }

    const control = createControl(
      field,
      this.pending.get(field.key) ?? field.value,
      {
        onChange: (value) => {
          // Setting a value back to what the server already has is not a change.
          if (value === field.value) this.pending.delete(field.key);
          else this.pending.set(field.key, value);

          row.classList.toggle("is-pending", this.pending.has(field.key));
          this.updateHeaderState();
        },
      },
    );

    const actions = document.createElement("div");
    actions.className = "field__actions";

    if (field.overridden) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "changed";
      badge.title = `Default: ${String(field.defaultValue)}`;
      actions.append(badge);

      actions.append(
        button("Reset", "ghost small", () => {
          void this.reset({ key: field.key }, `Reset ${field.label}`);
        }),
      );
    }

    const value = document.createElement("div");
    value.className = "field__control";
    value.append(control, actions);

    row.append(label, value);
    return row;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  private async save(): Promise<void> {
    if (this.pending.size === 0) return;
    const changes = Object.fromEntries(this.pending);

    try {
      const result = await this.api.saveConfig(changes);
      if (!result.ok) {
        // The server rejected the batch, so nothing was applied and the pending
        // edits stay put -- the operator can correct them rather than retype them.
        this.hooks.notify(result.issues.map((issue) => issue.message).join(" "), "error");
        return;
      }

      this.snapshot = { ...this.snapshot, fields: result.fields };
      this.pending.clear();
      this.render();
      this.hooks.notify("Saved. New matches will use these values.", "success");
    } catch (error) {
      this.hooks.notify(describe(error), "error");
    }
  }

  private async reset(
    scope: { key?: string; category?: string; subcategory?: string },
    description: string,
  ): Promise<void> {
    try {
      const result = await this.api.resetConfig(scope);
      if (!result.ok) {
        this.hooks.notify(result.issues.map((issue) => issue.message).join(" "), "error");
        return;
      }

      this.snapshot = { ...this.snapshot, fields: result.fields };
      // A reset supersedes any unsaved edit to the same value.
      for (const key of Object.keys(scope.key ? { [scope.key]: true } : {})) this.pending.delete(key);
      if (!scope.key) this.pending.clear();
      this.render();
      this.hooks.notify(`${description}.`, "success");
    } catch (error) {
      this.hooks.notify(describe(error), "error");
    }
  }

  private categoryIsModified(category: string): boolean {
    return this.snapshot.fields.some((field) => field.category === category && field.overridden);
  }
}

// ---------------------------------------------------------------------------

export function button(label: string, variant: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `button ${variant
    .split(" ")
    .map((name) => `button--${name}`)
    .join(" ")}`;
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

export function emptyState(message: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "empty";
  element.textContent = message;
  return element;
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
