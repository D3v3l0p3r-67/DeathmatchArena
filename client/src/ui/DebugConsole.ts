import type {
  DebugCommandResult,
  DebugCommandSpec,
  DebugConfigEntry,
  DebugParamSpec,
  DebugStatePayload,
} from "@deathmatch/shared";
import { query, setText, toggleClass } from "./dom.js";

export interface DebugConsoleHooks {
  runCommand(commandId: string, params: Record<string, unknown>): void;
}

/**
 * The debug window (Shift + D).
 *
 * Everything it shows comes from the server: the command catalogue, the
 * parameter forms, and the room's current tuning values. It ships no catalogue
 * of its own, so an unauthorized client cannot even enumerate what exists.
 *
 * `granted` here is a *rendering* concern only. The console refusing to open is
 * a convenience for the player, not a security control — every command is
 * checked again on the server, which is the only thing that decides anything.
 */
export class DebugConsole {
  private readonly root = query('[data-layer="debug-console"]');
  private readonly commandsRoot: HTMLElement;
  private readonly configRoot: HTMLElement;
  private readonly logRoot: HTMLElement;
  private readonly statusLabel: HTMLElement;
  private readonly roomLabel: HTMLElement;

  private granted = false;
  private open = false;

  /** Last value chosen per parameter, so a form does not reset on every refresh. */
  private readonly formState = new Map<string, string>();

  constructor(private readonly hooks: DebugConsoleHooks) {
    this.statusLabel = this.root.querySelector<HTMLElement>("[data-debug-status]")!;
    this.roomLabel = this.root.querySelector<HTMLElement>("[data-debug-room]")!;
    this.commandsRoot = this.root.querySelector<HTMLElement>("[data-debug-commands]")!;
    this.configRoot = this.root.querySelector<HTMLElement>("[data-debug-config]")!;
    this.logRoot = this.root.querySelector<HTMLElement>("[data-debug-log]")!;

    this.root.querySelector<HTMLElement>("[data-debug-close]")?.addEventListener("click", () => {
      this.setOpen(false);
    });
  }

  get isGranted(): boolean {
    return this.granted;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Apply the server's verdict.
   *
   * A refusal closes the window and drops the catalogue, so a grant that lapses
   * cannot leave a usable-looking console behind.
   */
  applyState(state: DebugStatePayload): void {
    this.granted = state.granted;

    if (!state.granted) {
      this.commandsRoot.replaceChildren();
      this.configRoot.replaceChildren();
      this.setOpen(false);
      return;
    }

    setText(this.roomLabel, state.roomId);
    setText(this.statusLabel, state.reason || "Authorized");
    this.renderCommands(state.commands);
    this.renderConfig(state.config);
  }

  /** Shift+D. Does nothing at all without a server grant. */
  toggle(): void {
    if (!this.granted) return;
    this.setOpen(!this.open);
  }

  setOpen(open: boolean): void {
    this.open = open && this.granted;
    toggleClass(this.root, "is-active", this.open);
  }

  appendResult(result: DebugCommandResult): void {
    const line = document.createElement("div");
    line.className = `debug-console__log-line ${result.ok ? "is-ok" : "is-error"}`;
    line.textContent = result.message;
    this.logRoot.prepend(line);

    // Keep the log short; this is a scratchpad, not a record.
    while (this.logRoot.childElementCount > 12) this.logRoot.lastElementChild?.remove();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private renderCommands(commands: DebugCommandSpec[]): void {
    const byCategory = new Map<string, DebugCommandSpec[]>();
    for (const command of commands) {
      const bucket = byCategory.get(command.category) ?? [];
      bucket.push(command);
      byCategory.set(command.category, bucket);
    }

    const fragment = document.createDocumentFragment();
    for (const [category, group] of byCategory) {
      const section = document.createElement("section");
      section.className = "debug-console__group";

      const heading = document.createElement("h3");
      heading.textContent = category;
      section.append(heading);

      for (const command of group) section.append(this.renderCommand(command));
      fragment.append(section);
    }

    this.commandsRoot.replaceChildren(fragment);
  }

  private renderCommand(command: DebugCommandSpec): HTMLElement {
    const row = document.createElement("div");
    row.className = "debug-console__command";

    const label = document.createElement("div");
    label.className = "debug-console__command-label";
    label.textContent = command.label;
    label.title = command.description;
    row.append(label);

    const inputs = document.createElement("div");
    inputs.className = "debug-console__inputs";

    const readers: (() => [string, unknown])[] = [];
    for (const param of command.params) {
      const { element, read } = this.renderParam(command.id, param);
      inputs.append(element);
      readers.push(read);
    }
    row.append(inputs);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "debug-console__run";
    button.textContent = "Run";
    button.addEventListener("click", () => {
      const params: Record<string, unknown> = {};
      for (const read of readers) {
        const [key, value] = read();
        params[key] = value;
      }
      this.hooks.runCommand(command.id, params);
    });
    row.append(button);

    return row;
  }

  /** Build one input from its spec, remembering what was last selected. */
  private renderParam(
    commandId: string,
    param: DebugParamSpec,
  ): { element: HTMLElement; read: () => [string, unknown] } {
    const stateKey = `${commandId}.${param.key}`;
    const wrapper = document.createElement("label");
    wrapper.className = "debug-console__field";

    const caption = document.createElement("span");
    caption.textContent = param.label;
    wrapper.append(caption);

    if (param.type === "select") {
      const select = document.createElement("select");
      // An empty first option lets a select mean "unspecified" where that is
      // meaningful, such as crate contents.
      if (param.hint) {
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = param.hint;
        select.append(blank);
      }
      for (const option of param.options ?? []) {
        const element = document.createElement("option");
        element.value = option.value;
        element.textContent = option.label;
        select.append(element);
      }
      select.value = this.formState.get(stateKey) ?? String(param.defaultValue ?? select.value ?? "");
      select.addEventListener("change", () => this.formState.set(stateKey, select.value));
      wrapper.append(select);
      return { element: wrapper, read: () => [param.key, select.value] };
    }

    if (param.type === "boolean") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = (this.formState.get(stateKey) ?? String(param.defaultValue ?? "")) === "true";
      input.addEventListener("change", () => this.formState.set(stateKey, String(input.checked)));
      wrapper.append(input);
      return { element: wrapper, read: () => [param.key, input.checked] };
    }

    const input = document.createElement("input");
    input.type = param.type === "number" ? "number" : "text";
    if (param.min !== undefined) input.min = String(param.min);
    if (param.max !== undefined) input.max = String(param.max);
    if (param.step !== undefined) input.step = String(param.step);
    input.value = this.formState.get(stateKey) ?? String(param.defaultValue ?? "");
    input.addEventListener("input", () => this.formState.set(stateKey, input.value));
    wrapper.append(input);

    return {
      element: wrapper,
      read: () => [param.key, param.type === "number" ? Number(input.value) : input.value],
    };
  }

  /**
   * Room-scoped tuning values.
   *
   * The same parameters the administration interface offers, with the same
   * limits -- both are rendered from one description on the server. The
   * difference is what a change means: here it applies to this room until it
   * closes, and is never stored.
   *
   * Grouped and collapsed, because "the same parameters" now means well over a
   * hundred of them, and a flat list of that is not a console.
   */
  private renderConfig(entries: DebugConfigEntry[]): void {
    const fragment = document.createDocumentFragment();
    let currentGroup = "";
    let body: HTMLElement | null = null;

    for (const entry of entries) {
      const group = `${entry.category} / ${entry.subcategory}`;
      if (group !== currentGroup) {
        currentGroup = group;
        const section = document.createElement("details");
        section.className = "debug-console__config-group";
        // Open whatever has been retuned, so a room override is never hidden.
        section.open = entries.some(
          (candidate) =>
            candidate.overridden &&
            `${candidate.category} / ${candidate.subcategory}` === group,
        );

        const summary = document.createElement("summary");
        summary.textContent = group;
        section.append(summary);

        body = document.createElement("div");
        section.append(body);
        fragment.append(section);
      }

      body?.append(this.renderConfigRow(entry));
    }

    this.configRoot.replaceChildren(fragment);
  }

  private renderConfigRow(entry: DebugConfigEntry): HTMLElement {
    const row = document.createElement("div");
    row.className = "debug-console__config-row";
    toggleClass(row, "is-overridden", entry.overridden);

    const label = document.createElement("span");
    label.className = "debug-console__config-label";
    label.textContent = entry.label;
    label.title = entry.path;
    row.append(label);

    // Values are sent as text whatever their type; the server coerces each one
    // against its own description, so the console never has to.
    const send = (value: string) => this.hooks.runCommand("set-config", { path: entry.path, value });

    if (typeof entry.value === "boolean") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = entry.value;
      input.disabled = !entry.editable;
      input.addEventListener("change", () => send(String(input.checked)));
      row.append(input);
    } else if (entry.options) {
      const select = document.createElement("select");
      select.disabled = !entry.editable;
      for (const option of entry.options) {
        const element = document.createElement("option");
        element.value = option.value;
        element.textContent = option.label;
        select.append(element);
      }
      select.value = String(entry.value);
      select.addEventListener("change", () => send(select.value));
      row.append(select);
    } else if (typeof entry.value === "string") {
      const input = document.createElement("input");
      input.type = "text";
      input.value = entry.value;
      input.disabled = !entry.editable;
      input.addEventListener("change", () => send(input.value));
      row.append(input);
    } else {
      const input = document.createElement("input");
      input.type = "number";
      input.value = String(entry.value);
      input.disabled = !entry.editable;
      if (entry.min !== undefined) input.min = String(entry.min);
      if (entry.max !== undefined) input.max = String(entry.max);
      if (entry.step !== undefined) input.step = String(entry.step);
      input.addEventListener("change", () => send(input.value));
      row.append(input);
    }

    return row;
  }
}
