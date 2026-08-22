import { ConfigFieldType, type ConfigFieldOption, type ConfigValue } from "@deathmatch/shared";

/**
 * Everything a control needs in order to exist.
 *
 * Deliberately *not* `ConfigFieldDefinition`: trap parameters carry the same
 * shape without the category grouping, and both are rendered by the same code.
 * That is the whole point of describing values with metadata -- one renderer,
 * however many places the values come from.
 */
export interface ControlSpec {
  key: string;
  label: string;
  type: string;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly ConfigFieldOption[];
  editable?: boolean;
}

export interface ControlHooks {
  /** Called on every settled change, never mid-keystroke for a number. */
  onChange(value: ConfigValue): void;
}

/**
 * Build the input for one described value.
 *
 * Nothing here knows what any particular setting means. Given "a number between
 * 0 and 500, step 1" it makes the control for that, and a new setting on the
 * server appears in the interface without a line changing here.
 */
export function createControl(spec: ControlSpec, value: ConfigValue, hooks: ControlHooks): HTMLElement {
  const editable = spec.editable !== false;

  switch (spec.type) {
    case ConfigFieldType.BOOLEAN:
      return booleanControl(spec, value === true, editable, hooks);

    case ConfigFieldType.SELECT:
      return selectControl(spec, String(value), editable, hooks);

    case ConfigFieldType.STRING:
      return textControl(spec, String(value), editable, hooks);

    case ConfigFieldType.PERCENTAGE:
      return percentageControl(spec, Number(value), editable, hooks);

    default:
      return numberControl(spec, Number(value), editable, hooks);
  }
}

function booleanControl(
  spec: ControlSpec,
  value: boolean,
  editable: boolean,
  hooks: ControlHooks,
): HTMLElement {
  const wrapper = document.createElement("label");
  wrapper.className = "control control--toggle";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = value;
  input.disabled = !editable;
  input.addEventListener("change", () => hooks.onChange(input.checked));

  const state = document.createElement("span");
  state.className = "control__state";
  state.textContent = value ? "On" : "Off";
  input.addEventListener("change", () => {
    state.textContent = input.checked ? "On" : "Off";
  });

  wrapper.append(input, state);
  return wrapper;
}

function selectControl(
  spec: ControlSpec,
  value: string,
  editable: boolean,
  hooks: ControlHooks,
): HTMLElement {
  const select = document.createElement("select");
  select.className = "control control--select";
  select.disabled = !editable;

  for (const option of spec.options ?? []) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    select.append(element);
  }

  // A stored value that is no longer offered still has to be visible, or the
  // control would silently claim the setting is something it is not.
  if (!Array.from(select.options).some((option) => option.value === value)) {
    const orphan = document.createElement("option");
    orphan.value = value;
    orphan.textContent = `${value} (unavailable)`;
    select.append(orphan);
  }

  select.value = value;
  select.addEventListener("change", () => hooks.onChange(select.value));
  return select;
}

function textControl(
  spec: ControlSpec,
  value: string,
  editable: boolean,
  hooks: ControlHooks,
): HTMLElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "control control--text";
  input.value = value;
  input.maxLength = 64;
  input.disabled = !editable;
  input.addEventListener("change", () => hooks.onChange(input.value));
  return input;
}

/**
 * A number, with a slider when the range is known.
 *
 * The slider is for finding a feel; the box is for typing an exact value. Both
 * exist because tuning needs one and reproducing a value needs the other.
 */
function numberControl(
  spec: ControlSpec,
  value: number,
  editable: boolean,
  hooks: ControlHooks,
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "control control--number";

  const box = document.createElement("input");
  box.type = "number";
  box.className = "control__box";
  box.value = String(value);
  box.disabled = !editable;
  if (spec.min !== undefined) box.min = String(spec.min);
  if (spec.max !== undefined) box.max = String(spec.max);
  if (spec.step !== undefined) box.step = String(spec.step);

  const bounded = spec.min !== undefined && spec.max !== undefined;
  let slider: HTMLInputElement | null = null;

  if (bounded) {
    slider = document.createElement("input");
    slider.type = "range";
    slider.className = "control__slider";
    slider.min = String(spec.min);
    slider.max = String(spec.max);
    slider.step = String(spec.step ?? 1);
    slider.value = String(value);
    slider.disabled = !editable;

    // Dragging updates the box live but only commits on release, so a drag is
    // one change rather than a hundred.
    slider.addEventListener("input", () => {
      box.value = slider!.value;
    });
    slider.addEventListener("change", () => hooks.onChange(Number(slider!.value)));
    wrapper.append(slider);
  }

  box.addEventListener("change", () => {
    const numeric = Number(box.value);
    if (!Number.isFinite(numeric)) {
      box.value = String(value);
      return;
    }
    if (slider) slider.value = box.value;
    hooks.onChange(numeric);
  });

  wrapper.append(box);
  return wrapper;
}

/** Stored 0..1, shown as a percentage, because 0.45 is not a thing anyone means. */
function percentageControl(
  spec: ControlSpec,
  value: number,
  editable: boolean,
  hooks: ControlHooks,
): HTMLElement {
  const max = spec.max ?? 1;
  const wrapper = document.createElement("div");
  wrapper.className = "control control--number";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "control__slider";
  slider.min = String(Math.round((spec.min ?? 0) * 100));
  slider.max = String(Math.round(max * 100));
  slider.step = "1";
  slider.value = String(Math.round(value * 100));
  slider.disabled = !editable;

  const box = document.createElement("input");
  box.type = "number";
  box.className = "control__box";
  box.value = String(Math.round(value * 100));
  box.min = slider.min;
  box.max = slider.max;
  box.step = "1";
  box.disabled = !editable;

  const suffix = document.createElement("span");
  suffix.className = "control__suffix";
  suffix.textContent = "%";

  slider.addEventListener("input", () => {
    box.value = slider.value;
  });
  slider.addEventListener("change", () => hooks.onChange(Number(slider.value) / 100));
  box.addEventListener("change", () => {
    const numeric = Number(box.value);
    if (!Number.isFinite(numeric)) {
      box.value = slider.value;
      return;
    }
    slider.value = box.value;
    hooks.onChange(numeric / 100);
  });

  wrapper.append(slider, box, suffix);
  return wrapper;
}

/** Format a value the way its control shows it, for read-only display. */
export function formatValue(spec: ControlSpec, value: ConfigValue): string {
  if (spec.type === ConfigFieldType.PERCENTAGE) return `${Math.round(Number(value) * 100)}%`;
  if (spec.type === ConfigFieldType.BOOLEAN) return value ? "On" : "Off";
  if (spec.type === ConfigFieldType.SELECT) {
    const option = spec.options?.find((candidate) => candidate.value === value);
    return option?.label ?? String(value);
  }
  return String(value);
}
