import { DEFAULT_AUDIO_SETTINGS, type AudioSettings } from "../audio/AudioEngine.js";
import { DEFAULT_EFFECTS_SETTINGS, type EffectsSettings } from "../game/fx/effects.js";
import { query, toggleClass } from "./dom.js";

export interface GameSettings {
  audio: AudioSettings;
  effects: EffectsSettings;
}

export interface SettingsPanelHooks {
  onChange(settings: GameSettings): void;
  /** Play a sample so a volume change can be heard while dragging. */
  onPreview(): void;
}

const EFFECTS_STORAGE_KEY = "deathmatch-arena:effects";

/**
 * Audio and effects settings, opened from the menu or with `O` in game.
 *
 * Everything here is a player preference stored in their own browser — none of
 * it reaches the server, because none of it changes the game. Volumes, particle
 * density and screen shake are presentation, and presentation is the client's.
 */
export class SettingsPanel {
  private readonly root = query('[data-layer="settings"]');
  private open = false;

  constructor(
    private settings: GameSettings,
    private readonly hooks: SettingsPanelHooks,
  ) {
    this.bindSlider("setting-master", (value) => this.patchAudio({ master: value }), true);
    this.bindSlider("setting-combat", (value) => this.patchAudio({ combat: value }), true);
    this.bindSlider("setting-world", (value) => this.patchAudio({ world: value }), true);
    this.bindSlider("setting-interface", (value) => this.patchAudio({ interface: value }), true);
    this.bindSlider("setting-music", (value) => this.patchAudio({ music: value }), false);
    this.bindSlider("setting-particles", (value) => this.patchEffects({ particleIntensity: value }), false);
    this.bindSlider("setting-shake", (value) => this.patchEffects({ screenShake: value }), false);

    this.bindToggle("setting-mute", (checked) => this.patchAudio({ muted: checked }));
    this.bindToggle("setting-damage-numbers", (checked) => this.patchEffects({ damageNumbers: checked }));

    this.root.querySelector<HTMLElement>("[data-settings-close]")?.addEventListener("click", () => {
      this.setOpen(false);
    });

    // `O` for options, and Escape to close.
    window.addEventListener("keydown", (event) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.code === "KeyO" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        this.setOpen(!this.open);
      } else if (event.code === "Escape" && this.open) {
        this.setOpen(false);
      }
    });

    this.bindTabs();
    this.bindReset();
    this.renderControls();
    this.render();
  }

  /**
   * One group visible at a time.
   *
   * Audio, effects and controls in one column made the panel a scroll; a
   * player looking for the music slider should not have to hunt past screen
   * shake to find it.
   */
  private bindTabs(): void {
    const tabs = Array.from(document.querySelectorAll<HTMLElement>(".settings__tab"));
    const panels = Array.from(document.querySelectorAll<HTMLElement>("[data-tab-panel]"));

    const select = (wanted: string | undefined) => {
      for (const other of tabs) other.classList.toggle("is-selected", other.dataset.tab === wanted);
      for (const panel of panels) panel.hidden = panel.dataset.tabPanel !== wanted;
    };

    for (const tab of tabs) tab.addEventListener("click", () => select(tab.dataset.tab));
    // The markup only marks the default tab; without applying it here the
    // other panels stay visible underneath until something is clicked.
    select(tabs.find((tab) => tab.classList.contains("is-selected"))?.dataset.tab ?? tabs[0]?.dataset.tab);
  }

  /** Put every preference back where it started, in one press. */
  private bindReset(): void {
    document.getElementById("settings-reset")?.addEventListener("click", () => {
      this.settings = {
        audio: { ...DEFAULT_AUDIO_SETTINGS },
        effects: { ...DEFAULT_EFFECTS_SETTINGS },
      };
      saveEffectsSettings(this.settings.effects);
      this.hooks.onChange(this.getSettings());
      this.render();
    });
  }

  /**
   * The bindings, listed from one table.
   *
   * Written here rather than duplicated in the menu's hint line, so what the
   * panel promises and what `InputController` listens for cannot drift.
   */
  private renderControls(): void {
    const list = document.getElementById("controls-list");
    if (!list) return;

    const bindings: [string[], string][] = [
      [["A", "D"], "Move left and right"],
      [["Space", "W"], "Jump (twice to double jump)"],
      [["Mouse"], "Aim"],
      [["Left click"], "Fire"],
      [["Right click"], "Hold to charge a grenade, release to throw"],
      [["R"], "Reload"],
      [["A", "D"], "Switch who you watch once eliminated"],
      [["Esc"], "Pause a campaign level, or go back"],
      [["O"], "Settings"],
      [["F3"], "Performance overlay"],
      [["F9"], "Campaign debug keys"],
    ];

    list.replaceChildren();
    for (const [keys, description] of bindings) {
      const term = document.createElement("dt");
      for (const key of keys) {
        const kbd = document.createElement("kbd");
        kbd.textContent = key;
        term.appendChild(kbd);
      }
      const detail = document.createElement("dd");
      detail.textContent = description;
      list.append(term, detail);
    }
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    this.open = open;
    toggleClass(this.root, "is-active", open);
    if (open) this.render();
  }

  getSettings(): GameSettings {
    return { audio: { ...this.settings.audio }, effects: { ...this.settings.effects } };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private patchAudio(patch: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, audio: { ...this.settings.audio, ...patch } };
    this.hooks.onChange(this.getSettings());
    this.render();
  }

  private patchEffects(patch: Partial<EffectsSettings>): void {
    this.settings = { ...this.settings, effects: { ...this.settings.effects, ...patch } };
    saveEffectsSettings(this.settings.effects);
    this.hooks.onChange(this.getSettings());
    this.render();
  }

  /** Sliders carry 0..100 in the DOM and 0..1 in the model. */
  private bindSlider(id: string, apply: (value: number) => void, preview: boolean): void {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input) return;

    input.addEventListener("input", () => {
      apply(Number(input.value) / 100);
      if (preview) this.hooks.onPreview();
    });
  }

  private bindToggle(id: string, apply: (checked: boolean) => void): void {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input) return;
    input.addEventListener("change", () => apply(input.checked));
  }

  /** Push the model back into the controls, so the panel always shows truth. */
  private render(): void {
    setSlider("setting-master", this.settings.audio.master);
    setSlider("setting-combat", this.settings.audio.combat);
    setSlider("setting-world", this.settings.audio.world);
    setSlider("setting-interface", this.settings.audio.interface);
    setSlider("setting-music", this.settings.audio.music);
    setSlider("setting-particles", this.settings.effects.particleIntensity);
    setSlider("setting-shake", this.settings.effects.screenShake);

    setToggle("setting-mute", this.settings.audio.muted);
    setToggle("setting-damage-numbers", this.settings.effects.damageNumbers);

    setValueLabel("setting-master-value", this.settings.audio.master);
    setValueLabel("setting-combat-value", this.settings.audio.combat);
    setValueLabel("setting-world-value", this.settings.audio.world);
    setValueLabel("setting-interface-value", this.settings.audio.interface);
    setValueLabel("setting-music-value", this.settings.audio.music);
    setValueLabel("setting-particles-value", this.settings.effects.particleIntensity);
    setValueLabel("setting-shake-value", this.settings.effects.screenShake);

    // Muting greys the mixer out rather than hiding it, so the sliders keep
    // their meaning while they are inactive.
    toggleClass(this.root, "is-muted", this.settings.audio.muted);
  }
}

function setSlider(id: string, value: number): void {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (input) input.value = String(Math.round(value * 100));
}

function setToggle(id: string, checked: boolean): void {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (input) input.checked = checked;
}

function setValueLabel(id: string, value: number): void {
  const element = document.getElementById(id);
  if (element) element.textContent = `${Math.round(value * 100)}%`;
}

export function loadEffectsSettings(fallback: EffectsSettings): EffectsSettings {
  try {
    const raw = window.localStorage.getItem(EFFECTS_STORAGE_KEY);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<EffectsSettings>) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

function saveEffectsSettings(settings: EffectsSettings): void {
  try {
    window.localStorage.setItem(EFFECTS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable; the choice lasts this session.
  }
}
