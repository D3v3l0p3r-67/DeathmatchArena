import {
  ConfigFieldType,
  SurfaceType,
  TrapActivation,
  trapRegistry,
  type ArenaElement,
  type ArenaSpawnPoint,
  type ConfigValue,
  type TrapDefinition,
} from "@deathmatch/shared";
import type { ArenaEditor, Selection } from "./ArenaEditor.js";
import { createControl, type ControlSpec } from "./controls.js";
import { button, emptyState } from "./ConfigPanel.js";

/** The trap overrides an editor can set, and the range each is held to. */
const TRAP_OVERRIDES: { key: keyof TrapDefinition; label: string; min: number; max: number; step: number; description: string }[] = [
  { key: "damage", label: "Damage", min: 0, max: 1000, step: 1, description: "Per activation, or per second for a trap that burns." },
  { key: "activationDelayMs", label: "Activation delay (ms)", min: 0, max: 20000, step: 50, description: "The warning before it becomes dangerous." },
  { key: "activeDurationMs", label: "Active duration (ms)", min: 0, max: 60000, step: 50, description: "How long it stays dangerous. 0 means it never switches off." },
  { key: "cooldownMs", label: "Cooldown (ms)", min: 0, max: 120000, step: 50, description: "Rest before it can trigger again." },
  { key: "moveSpeed", label: "Movement speed (px/s)", min: 0, max: 2000, step: 10, description: "How fast it travels, if it travels." },
  { key: "triggerRadius", label: "Trigger radius (px)", min: 0, max: 1500, step: 5, description: "How near a player must come to set it off." },
];

/**
 * The properties of whatever is selected.
 *
 * Two halves, and the split is deliberate. The fixed part -- position, size,
 * which layer a piece of geometry belongs to -- is written out, because it is
 * the same for every arena and always will be. The trap parameters are
 * *generated* from the trap type's own metadata, so a hazard registered by a
 * deployment gets a full editor here without this file knowing it exists.
 */
export class ArenaInspector {
  private readonly root = document.createElement("aside");

  constructor(private readonly editor: ArenaEditor) {
    this.root.className = "inspector";
    this.render(null);
  }

  get element(): HTMLElement {
    return this.root;
  }

  render(selection: Selection | null): void {
    this.root.replaceChildren();

    if (!selection) {
      this.root.append(
        heading("Nothing selected"),
        emptyState("Click something on the map, or pick a tool and click to place one."),
      );
      return;
    }

    const arena = this.editor.getArena();

    switch (selection.kind) {
      case "element": {
        const element = arena.elements.find((item) => item.id === selection.id);
        if (element) this.renderElement(element);
        return;
      }
      case "trap": {
        const trap = arena.traps.find((item) => item.id === selection.id);
        if (trap) this.renderTrap(trap);
        return;
      }
      default: {
        const list = selection.kind === "playerSpawn" ? arena.playerSpawns : arena.powerUpSpawns;
        const spawn = list.find((item) => item.id === selection.id);
        if (spawn) this.renderSpawn(spawn, selection.kind === "playerSpawn");
      }
    }
  }

  // -------------------------------------------------------------------------

  private renderElement(element: ArenaElement): void {
    this.root.append(heading("Geometry"), identity(element.id));

    this.root.append(
      this.field(
        {
          key: "type",
          label: "Layer",
          type: ConfigFieldType.SELECT,
          description: "Purely how it is drawn and grouped -- every layer collides identically.",
          options: Object.values(SurfaceType).map((type) => ({ value: type, label: titleCase(type) })),
        },
        element.type,
        (value) => this.editor.updateSelected({ type: value }),
      ),
    );

    this.appendBoxFields(element);
    this.appendObjectActions();
  }

  private renderSpawn(spawn: ArenaSpawnPoint, isPlayer: boolean): void {
    this.root.append(
      heading(isPlayer ? "Player spawn" : "Power-up spawn"),
      identity(spawn.id),
      note(
        isPlayer
          ? "Players are distributed across the enabled spawn points at the start of a match."
          : "Crates appear on the enabled points, one crate per point at a time.",
      ),
    );

    this.root.append(
      this.field(
        {
          key: "x",
          label: "X",
          type: ConfigFieldType.NUMBER,
          step: 1,
          description: "The centre of whatever spawns here.",
        },
        spawn.x,
        (value) => this.editor.updateSelected({ x: Number(value) }),
      ),
      this.field(
        { key: "y", label: "Y", type: ConfigFieldType.NUMBER, step: 1, description: "" },
        spawn.y,
        (value) => this.editor.updateSelected({ y: Number(value) }),
      ),
      this.field(
        {
          key: "enabled",
          label: "Enabled",
          type: ConfigFieldType.BOOLEAN,
          description: "A disabled point is kept but never used.",
        },
        spawn.enabled,
        (value) => this.editor.updateSelected({ enabled: value === true }),
      ),
    );

    this.appendObjectActions();
  }

  private renderTrap(trap: TrapDefinition): void {
    const type = trapRegistry.get(trap.type);

    this.root.append(heading(type?.label ?? trap.type), identity(trap.id));
    if (type) this.root.append(note(type.description));

    this.root.append(
      this.field(
        {
          key: "enabled",
          label: "Enabled",
          type: ConfigFieldType.BOOLEAN,
          description: "A disabled trap is kept in the arena but never built or triggered.",
        },
        trap.enabled,
        (value) => this.editor.updateSelected({ enabled: value === true }),
      ),
      this.field(
        {
          key: "activation",
          label: "Activation",
          type: ConfigFieldType.SELECT,
          description: "What sets it off.",
          options: [
            { value: TrapActivation.ALWAYS, label: "Always dangerous" },
            { value: TrapActivation.PERIODIC, label: "Cycles on its own" },
            { value: TrapActivation.PROXIMITY, label: "A player comes near" },
            { value: TrapActivation.CONTACT, label: "A player touches it" },
          ],
        },
        trap.activation,
        (value) => this.editor.updateSelected({ activation: String(value) }),
      ),
    );

    this.appendBoxFields(trap);

    // -- Overrides ----------------------------------------------------------

    this.root.append(subheading("Behaviour"));
    this.root.append(
      note("Unchecked values follow the global trap defaults, so retuning traps in Game Configuration reaches this one."),
    );

    for (const override of TRAP_OVERRIDES) {
      this.root.append(this.renderOverride(trap, override));
    }

    // -- Type parameters ----------------------------------------------------

    if (type && type.params.length > 0) {
      this.root.append(subheading("Parameters"));
      for (const param of type.params) {
        const value = trap.params?.[param.key] ?? param.defaultValue;
        this.root.append(
          this.field(param, value, (next) => {
            this.editor.updateSelected({ params: { ...trap.params, [param.key]: next } });
          }),
        );
      }
    }

    this.appendObjectActions();
  }

  /**
   * One inherited value, with a switch that says whether it is inherited.
   *
   * `null` means "use the global default", and it has to be visibly different
   * from a number that happens to equal the default -- otherwise nobody could
   * tell whether a trap will follow a future rebalance or ignore it.
   */
  private renderOverride(
    trap: TrapDefinition,
    override: (typeof TRAP_OVERRIDES)[number],
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "field field--override";

    const current = trap[override.key] as number | null;
    const overridden = current !== null && current !== undefined;

    const label = document.createElement("div");
    label.className = "field__label";

    const toggleLabel = document.createElement("label");
    toggleLabel.className = "field__inherit";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = overridden;
    toggle.addEventListener("change", () => {
      // Switching an override on starts from the value it was inheriting, so the
      // trap does not change behaviour just by being made explicit.
      this.editor.updateSelected({ [override.key]: toggle.checked ? inheritedGuess(override) : null });
      this.render(this.editor.getSelection());
    });
    toggleLabel.append(toggle, document.createTextNode("Override"));

    const name = document.createElement("span");
    name.className = "field__name";
    name.textContent = override.label;

    const description = document.createElement("p");
    description.className = "field__description";
    description.textContent = override.description;

    label.append(name, toggleLabel, description);

    const control = document.createElement("div");
    control.className = "field__control";

    if (overridden) {
      control.append(
        createControl(
          {
            key: String(override.key),
            label: override.label,
            type: ConfigFieldType.NUMBER,
            min: override.min,
            max: override.max,
            step: override.step,
          },
          current,
          { onChange: (value) => this.editor.updateSelected({ [override.key]: Number(value) }) },
        ),
      );
    } else {
      const inherited = document.createElement("span");
      inherited.className = "field__inherited";
      inherited.textContent = "Inherited from Game Configuration → Traps";
      control.append(inherited);
    }

    row.append(label, control);
    return row;
  }

  private appendBoxFields(box: { x: number; y: number; width: number; height: number }): void {
    const specs: [keyof typeof box, string, number][] = [
      ["x", "X", 1],
      ["y", "Y", 1],
      ["width", "Width", 1],
      ["height", "Height", 1],
    ];

    for (const [key, label, step] of specs) {
      this.root.append(
        this.field(
          { key, label, type: ConfigFieldType.NUMBER, step, min: key === "width" || key === "height" ? 4 : undefined },
          box[key],
          (value) => this.editor.updateSelected({ [key]: Number(value) }),
        ),
      );
    }
  }

  private appendObjectActions(): void {
    const actions = document.createElement("div");
    actions.className = "inspector__actions";
    actions.append(
      button("Duplicate", "ghost small", () => this.editor.duplicateSelected()),
      button("Delete", "danger small", () => this.editor.deleteSelected()),
    );
    this.root.append(actions);
  }

  /** One labelled control, using the same renderer the configuration editor uses. */
  private field(
    spec: ControlSpec,
    value: ConfigValue,
    onChange: (value: ConfigValue) => void,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "field";

    const label = document.createElement("div");
    label.className = "field__label";

    const name = document.createElement("span");
    name.className = "field__name";
    name.textContent = spec.label;
    label.append(name);

    if (spec.description) {
      const description = document.createElement("p");
      description.className = "field__description";
      description.textContent = spec.description;
      label.append(description);
    }

    const control = document.createElement("div");
    control.className = "field__control";
    control.append(createControl(spec, value, { onChange }));

    row.append(label, control);
    return row;
  }
}

// ---------------------------------------------------------------------------

/**
 * A starting point when an override is switched on.
 *
 * The genuinely correct answer is the current global default, which the editor
 * does not have -- it edits arenas, not configuration. The midpoint of the
 * allowed range is a defensible stand-in that is always in range, and the
 * operator immediately sees the number and changes it.
 */
function inheritedGuess(override: (typeof TRAP_OVERRIDES)[number]): number {
  const midpoint = (override.min + override.max) / 2;
  return Math.round(Math.min(midpoint, override.min + override.step * 20));
}

function heading(text: string): HTMLElement {
  const element = document.createElement("h2");
  element.className = "inspector__title";
  element.textContent = text;
  return element;
}

function subheading(text: string): HTMLElement {
  const element = document.createElement("h3");
  element.className = "inspector__subtitle";
  element.textContent = text;
  return element;
}

function identity(id: string): HTMLElement {
  const element = document.createElement("code");
  element.className = "inspector__id";
  element.textContent = id;
  return element;
}

function note(text: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "inspector__note";
  element.textContent = text;
  return element;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
