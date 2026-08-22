import {
  SurfaceType,
  trapRegistry,
  type ArenaDefinition,
  type ArenaIssue,
} from "@deathmatch/shared";
import type { AdminApi, ArenaSummary } from "./AdminApi.js";
import { ArenaEditor, type LayerVisibility, type Selection, type Tool } from "./ArenaEditor.js";
import { ArenaInspector } from "./ArenaInspector.js";
import { button, describe, emptyState } from "./ConfigPanel.js";

export interface ArenaPanelHooks {
  notify(message: string, tone: "info" | "error" | "success"): void;
}

const UNDO_DEPTH = 60;

/**
 * Arena management: the list, and the editor for whichever one is open.
 *
 * The panel owns everything the editor deliberately does not -- loading,
 * saving, validation, undo -- so that the editor stays a view over an arena and
 * nothing more.
 *
 * Validation runs against the server as edits are made, not only at save time.
 * The server is the authority either way; asking it continuously just means a
 * mistake is visible while it is still fresh in mind.
 */
export class ArenaPanel {
  private readonly root = document.createElement("div");
  private readonly listElement = document.createElement("div");
  private readonly workspace = document.createElement("div");

  private summaries: ArenaSummary[] = [];
  private editor: ArenaEditor | null = null;
  private inspector: ArenaInspector | null = null;
  private open: ArenaDefinition | null = null;
  private saved: string = "";
  private issues: ArenaIssue[] = [];

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private checkTimer = 0;

  /**
   * The toolbar controls whose enabled state changes as the arena is edited.
   *
   * Updated in place rather than by rebuilding the toolbar. Rebuilding is not
   * merely wasteful here: the name and dimension inputs fire `change` on blur,
   * so clicking "Save" would replace the button under the cursor and the click
   * would land on a detached node -- a button that has to be pressed twice.
   */
  private undoButton: HTMLButtonElement | null = null;
  private redoButton: HTMLButtonElement | null = null;
  private saveButton: HTMLButtonElement | null = null;

  constructor(
    private readonly api: AdminApi,
    private readonly hooks: ArenaPanelHooks,
  ) {
    this.root.className = "arenas";
    this.listElement.className = "arenas__list";
    this.workspace.className = "arenas__workspace";
    this.root.append(this.listElement, this.workspace);
  }

  get element(): HTMLElement {
    return this.root;
  }

  async load(): Promise<void> {
    this.summaries = await this.api.listArenas();
    this.renderList();
    if (!this.open) this.renderEmptyWorkspace();
  }

  /** True while an open arena has unsaved edits, so the shell can warn. */
  get isDirty(): boolean {
    return this.open !== null && JSON.stringify(this.open) !== this.saved;
  }

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------

  private renderList(): void {
    this.listElement.replaceChildren();

    const header = document.createElement("header");
    header.className = "arenas__list-header";

    const title = document.createElement("h2");
    title.textContent = "Arenas";
    header.append(title, button("New", "primary small", () => void this.createArena()));
    this.listElement.append(header);

    if (this.summaries.length === 0) {
      this.listElement.append(emptyState("No arenas yet."));
      return;
    }

    for (const summary of this.summaries) {
      this.listElement.append(this.renderListRow(summary));
    }
  }

  private renderListRow(summary: ArenaSummary): HTMLElement {
    const row = document.createElement("article");
    row.className = "arena-card";
    row.classList.toggle("is-open", this.open?.id === summary.id);
    row.classList.toggle("is-disabled", !summary.enabled);

    const name = document.createElement("h3");
    name.className = "arena-card__name";
    name.textContent = summary.name;

    const id = document.createElement("code");
    id.className = "arena-card__id";
    id.textContent = summary.id;

    const facts = document.createElement("p");
    facts.className = "arena-card__facts";
    facts.textContent = [
      `${summary.width}×${summary.height}`,
      `${summary.elementCount} pieces`,
      `${summary.playerSpawnCount} spawns`,
      `${summary.trapCount} traps`,
    ].join(" · ");

    const actions = document.createElement("div");
    actions.className = "arena-card__actions";
    actions.append(
      button("Edit", "ghost small", () => void this.openArena(summary.id)),
      button(summary.enabled ? "Disable" : "Enable", "ghost small", () =>
        void this.setEnabled(summary, !summary.enabled),
      ),
      button("Duplicate", "ghost small", () => void this.duplicate(summary)),
      button("Delete", "danger small", () => void this.remove(summary)),
    );

    row.append(name, id, facts, actions);
    return row;
  }

  // -------------------------------------------------------------------------
  // List actions
  // -------------------------------------------------------------------------

  private async createArena(): Promise<void> {
    const name = window.prompt("Name the new arena", "New arena");
    if (name === null) return;

    await this.run(async () => {
      const result = await this.api.createArena(name, 3200, 1800);
      if (!result.ok || !result.arena) {
        this.hooks.notify(summariseIssues(result.issues), "error");
        return;
      }
      await this.load();
      await this.openArena(result.arena.id);
      this.hooks.notify(`Created "${result.arena.name}".`, "success");
    });
  }

  private async duplicate(summary: ArenaSummary): Promise<void> {
    await this.run(async () => {
      const result = await this.api.duplicateArena(summary.id);
      if (!result.ok || !result.arena) {
        this.hooks.notify(summariseIssues(result.issues), "error");
        return;
      }
      await this.load();
      this.hooks.notify(`Copied to "${result.arena.name}".`, "success");
    });
  }

  private async setEnabled(summary: ArenaSummary, enabled: boolean): Promise<void> {
    await this.run(async () => {
      const result = await this.api.setArenaEnabled(summary.id, enabled);
      if (!result.ok) {
        this.hooks.notify(summariseIssues(result.issues), "error");
        return;
      }
      await this.load();
      this.hooks.notify(`"${summary.name}" is now ${enabled ? "playable" : "disabled"}.`, "success");
    });
  }

  private async remove(summary: ArenaSummary): Promise<void> {
    if (!window.confirm(`Delete "${summary.name}"? This cannot be undone.`)) return;

    await this.run(async () => {
      const result = await this.api.deleteArena(summary.id);
      if (!result.ok) {
        this.hooks.notify(result.message, "error");
        return;
      }
      if (this.open?.id === summary.id) this.closeEditor();
      await this.load();
      this.hooks.notify(result.message, "success");
    });
  }

  // -------------------------------------------------------------------------
  // The editor
  // -------------------------------------------------------------------------

  private async openArena(id: string): Promise<void> {
    if (this.isDirty && !window.confirm("Discard unsaved changes to the open arena?")) return;

    await this.run(async () => {
      const arena = await this.api.loadArena(id);
      this.open = arena;
      this.saved = JSON.stringify(arena);
      this.undoStack = [];
      this.redoStack = [];
      this.issues = [];
      this.renderWorkspace();
      this.renderList();
    });
  }

  private closeEditor(): void {
    this.editor?.destroy();
    this.editor = null;
    this.inspector = null;
    this.open = null;
    this.saved = "";
    this.renderEmptyWorkspace();
  }

  private renderEmptyWorkspace(): void {
    this.workspace.replaceChildren(
      emptyState("Pick an arena to edit, or create one."),
    );
  }

  private renderWorkspace(): void {
    const arena = this.open;
    if (!arena) return;

    this.editor?.destroy();
    const editor = new ArenaEditor(arena, {
      onChange: (next, commit) => this.onEditorChange(next, commit),
      onSelectionChange: (selection) => this.onSelectionChange(selection),
      // Rebuilding the toolbar here is safe: a tool only ever changes from a
      // button press or a canvas interaction, never from leaving a text field.
      onToolChange: () => this.refreshToolbar(),
    });
    this.editor = editor;
    this.inspector = new ArenaInspector(editor);

    const stage = document.createElement("div");
    stage.className = "editor__stage";
    stage.append(editor.canvas);

    const layout = document.createElement("div");
    layout.className = "editor";
    layout.append(this.renderToolbar(), stage, this.inspector.element, this.renderIssues());

    // The editor frames itself once the canvas has been laid out and it knows how
    // big it actually is; there is nothing useful to do here before that.
    this.workspace.replaceChildren(layout);
  }

  private renderToolbar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "editor__toolbar";

    const arena = this.open;
    const editor = this.editor;
    if (!arena || !editor) return bar;

    // -- Identity ------------------------------------------------------------

    const identity = document.createElement("div");
    identity.className = "editor__identity";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "editor__name";
    nameInput.value = arena.name;
    nameInput.maxLength = 48;
    nameInput.addEventListener("change", () => {
      this.mutate((draft) => {
        draft.name = nameInput.value.trim() || draft.name;
      });
    });

    const idLabel = document.createElement("code");
    idLabel.className = "editor__id";
    idLabel.textContent = arena.id;
    idLabel.title = "The internal id. Fixed once created, because matches and links refer to it.";

    identity.append(nameInput, idLabel);

    // -- Placement tools -----------------------------------------------------

    const tools = document.createElement("div");
    tools.className = "editor__tools";
    tools.append(this.toolButton("Select", { kind: "select" }));

    for (const type of Object.values(SurfaceType)) {
      tools.append(this.toolButton(titleCase(type), { kind: "place", what: "element", elementType: type }));
    }
    tools.append(
      this.toolButton("Player spawn", { kind: "place", what: "playerSpawn" }),
      this.toolButton("Crate spawn", { kind: "place", what: "powerUpSpawn" }),
    );

    // Straight from the registry, so a trap type registered by a deployment is
    // placeable here without this file listing it.
    const trapSelect = document.createElement("select");
    trapSelect.className = "editor__trap-picker";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Place a trap…";
    trapSelect.append(placeholder);
    for (const type of trapRegistry.list()) {
      const option = document.createElement("option");
      option.value = type.id;
      option.textContent = type.label;
      trapSelect.append(option);
    }
    trapSelect.addEventListener("change", () => {
      const trapType = trapSelect.value;
      if (!trapType) return;
      // Cleared before the tool is set, so the picker reads "Place a trap…"
      // again -- but read first, or the tool would be given an empty type.
      trapSelect.value = "";
      editor.setTool({ kind: "place", what: "trap", trapType });
    });
    tools.append(trapSelect);

    // -- View ----------------------------------------------------------------

    const view = document.createElement("div");
    view.className = "editor__view";

    const layers: [keyof LayerVisibility, string][] = [
      ["geometry", "Geometry"],
      ["playerSpawns", "Player spawns"],
      ["powerUpSpawns", "Crate spawns"],
      ["traps", "Traps"],
    ];
    for (const [key, label] of layers) {
      const toggle = document.createElement("label");
      toggle.className = "editor__layer";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = editor.getLayers()[key];
      input.addEventListener("change", () => {
        editor.setLayers({ ...editor.getLayers(), [key]: input.checked });
      });
      toggle.append(input, document.createTextNode(label));
      view.append(toggle);
    }

    const snap = document.createElement("label");
    snap.className = "editor__snap";
    const snapInput = document.createElement("input");
    snapInput.type = "number";
    snapInput.min = "1";
    snapInput.max = "100";
    snapInput.step = "1";
    snapInput.value = String(editor.getSnap());
    snapInput.addEventListener("change", () => editor.setSnap(Number(snapInput.value)));
    snap.append(document.createTextNode("Snap"), snapInput);
    view.append(snap, button("Fit", "ghost small", () => editor.frameAll()));

    // -- Dimensions and saving ----------------------------------------------

    const size = document.createElement("div");
    size.className = "editor__size";
    size.append(
      this.dimensionInput("Width", arena.width, (value) => this.mutate((draft) => void (draft.width = value))),
      this.dimensionInput("Height", arena.height, (value) => this.mutate((draft) => void (draft.height = value))),
    );

    const actions = document.createElement("div");
    actions.className = "editor__actions";

    const undo = button("Undo", "ghost small", () => this.undo());
    const redo = button("Redo", "ghost small", () => this.redo());
    const save = button("Save changes", "primary", () => void this.save());

    this.undoButton = undo;
    this.redoButton = redo;
    this.saveButton = save;
    this.updateActions();

    actions.append(undo, redo, button("Close", "ghost small", () => this.tryClose()), save);

    bar.append(identity, tools, view, size, actions);
    return bar;
  }

  private toolButton(label: string, tool: Tool): HTMLButtonElement {
    const element = button(label, "tool small", () => this.editor?.setTool(tool));
    const current = this.editor?.getTool();
    if (current && sameTool(current, tool)) element.classList.add("is-active");
    return element;
  }

  private dimensionInput(label: string, value: number, onChange: (value: number) => void): HTMLElement {
    const wrapper = document.createElement("label");
    wrapper.className = "editor__dimension";
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(value);
    input.step = "10";
    input.addEventListener("change", () => {
      const numeric = Number(input.value);
      if (Number.isFinite(numeric)) onChange(numeric);
    });
    wrapper.append(document.createTextNode(label), input);
    return wrapper;
  }

  private renderIssues(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "editor__issues";

    if (this.issues.length === 0) {
      panel.append(emptyState("No problems found."));
      return panel;
    }

    for (const issue of this.issues) {
      const row = document.createElement("p");
      row.className = `issue issue--${issue.severity}`;
      row.textContent = issue.path ? `${issue.path}: ${issue.message}` : issue.message;
      panel.append(row);
    }
    return panel;
  }

  /** Bring the toolbar's state-bearing buttons up to date without replacing them. */
  private updateActions(): void {
    if (this.undoButton) this.undoButton.disabled = this.undoStack.length === 0;
    if (this.redoButton) this.redoButton.disabled = this.redoStack.length === 0;
    if (this.saveButton) {
      const blocked = this.issues.some((issue) => issue.severity === "error");
      this.saveButton.textContent = this.isDirty ? "Save changes" : "Saved";
      this.saveButton.disabled = !this.isDirty || blocked;
    }
  }

  /** Rebuild the toolbar. Only for a change of tool, which no input can trigger. */
  private refreshToolbar(): void {
    const layout = this.workspace.querySelector(".editor");
    const existing = layout?.querySelector(".editor__toolbar");
    if (layout && existing) layout.replaceChild(this.renderToolbar(), existing);
  }

  private refreshIssues(): void {
    const layout = this.workspace.querySelector(".editor");
    const existing = layout?.querySelector(".editor__issues");
    if (layout && existing) layout.replaceChild(this.renderIssues(), existing);
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  private onEditorChange(next: ArenaDefinition, commit: boolean): void {
    // Mid-drag changes are drawn by the editor and otherwise ignored. Adopting
    // them would destroy the undo entry: the snapshot taken at commit time is
    // the state *before* the change, and mid-drag updates would already have
    // overwritten it with the state after.
    if (!commit) return;

    this.pushUndo();
    this.open = next;
    this.updateActions();
    // A drag changes the numbers the inspector is showing, so it has to follow.
    this.inspector?.render(this.editor?.getSelection() ?? null);
    this.scheduleCheck();
  }

  private onSelectionChange(selection: Selection | null): void {
    this.inspector?.render(selection);
  }

  /** Change the arena outside the canvas -- name, dimensions -- through one path. */
  private mutate(change: (draft: ArenaDefinition) => void): void {
    if (!this.open || !this.editor) return;
    this.pushUndo();

    const draft = structuredClone(this.open);
    change(draft);
    this.open = draft;
    this.editor.setArena(draft, true);
    this.updateActions();
    this.scheduleCheck();
  }

  private pushUndo(): void {
    if (!this.open) return;
    this.undoStack.push(JSON.stringify(this.open));
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
    this.redoStack = [];
  }

  private undo(): void {
    const previous = this.undoStack.pop();
    if (!previous || !this.open || !this.editor) return;

    this.redoStack.push(JSON.stringify(this.open));
    this.open = JSON.parse(previous) as ArenaDefinition;
    this.editor.setArena(this.open, true);
    this.inspector?.render(this.editor.getSelection());
    this.updateActions();
    this.scheduleCheck();
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next || !this.open || !this.editor) return;

    this.undoStack.push(JSON.stringify(this.open));
    this.open = JSON.parse(next) as ArenaDefinition;
    this.editor.setArena(this.open, true);
    this.inspector?.render(this.editor.getSelection());
    this.updateActions();
    this.scheduleCheck();
  }

  /**
   * Ask the server what it thinks of the arena, shortly after editing stops.
   *
   * Debounced rather than immediate: dragging a platform would otherwise mean a
   * request per commit, and the answer is only interesting once the hand comes
   * off the mouse.
   */
  private scheduleCheck(): void {
    window.clearTimeout(this.checkTimer);
    this.checkTimer = window.setTimeout(() => void this.check(), 400);
  }

  private async check(): Promise<void> {
    const arena = this.open;
    if (!arena) return;

    try {
      const result = await this.api.checkArena(arena.id, arena);
      this.issues = result.issues;
      this.editor?.setIssues(result.issues);
      this.refreshIssues();
      this.updateActions();
    } catch {
      // A failed check is not worth interrupting an edit for; saving will say so.
    }
  }

  private async save(): Promise<void> {
    const arena = this.open;
    if (!arena) return;

    await this.run(async () => {
      const result = await this.api.saveArena(arena.id, arena);
      this.issues = result.issues;
      this.editor?.setIssues(result.issues);
      this.refreshIssues();

      if (!result.ok || !result.arena) {
        this.hooks.notify(summariseIssues(result.issues), "error");
        this.updateActions();
        return;
      }

      this.open = result.arena;
      this.saved = JSON.stringify(result.arena);
      this.editor?.setArena(result.arena, true);
      await this.load();
      this.updateActions();
      this.hooks.notify("Saved. New matches will use this arena.", "success");
    });
  }

  private tryClose(): void {
    if (this.isDirty && !window.confirm("Discard unsaved changes?")) return;
    this.closeEditor();
    this.renderList();
  }

  /** Run something that talks to the server, reporting failures once. */
  private async run(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.hooks.notify(describe(error), "error");
    }
  }
}

// ---------------------------------------------------------------------------

function sameTool(a: Tool, b: Tool): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "select" || b.kind === "select") return true;
  if (a.what !== b.what) return false;
  if (a.what === "element" && b.what === "element") return a.elementType === b.elementType;
  if (a.what === "trap" && b.what === "trap") return a.trapType === b.trapType;
  return true;
}

function summariseIssues(issues: readonly ArenaIssue[] | readonly { message: string }[]): string {
  const errors = issues.filter((issue) => !("severity" in issue) || issue.severity === "error");
  if (errors.length === 0) return "The server rejected the change.";
  return errors.map((issue) => issue.message).join(" ");
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
