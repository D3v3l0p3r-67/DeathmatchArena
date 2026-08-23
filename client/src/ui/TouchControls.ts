/**
 * On-screen controls, for the devices that need them.
 *
 * Two decisions shape this file.
 *
 * **They appear only when they are wanted.** A phone gets them; a desktop never
 * sees them; a laptop with a touchscreen gets them the moment a finger arrives
 * and loses them again the moment a key is pressed. Permanently-visible thumb
 * pads on a machine with a keyboard are clutter, and a keyboard hint on a phone
 * is a lie -- so the last input actually used decides, rather than a guess made
 * at boot.
 *
 * **They are buttons, not painted onto the canvas.** A finger on a DOM button
 * never reaches the game's own pointer handling, which is exactly what makes
 * aiming and shooting at the same time work: the buttons take their touches, the
 * canvas takes the rest, and the browser keeps the two apart for free.
 *
 * Nothing here decides anything about the game. It produces the same intent a
 * keyboard produces, and the server trusts it exactly as little.
 */
import { requireElement, toggleClass } from "./dom.js";

/** What the controls are currently asking for. The same shape a key press has. */
export interface TouchIntent {
  left: boolean;
  right: boolean;
  jump: boolean;
  fire: boolean;
  reload: boolean;
  grenade: boolean;
}

export function emptyTouchIntent(): TouchIntent {
  return { left: false, right: false, jump: false, fire: false, reload: false, grenade: false };
}

export interface TouchControlsCallbacks {
  /** Called whenever what the player is asking for changes. */
  onIntent(intent: TouchIntent): void;
}

export class TouchControls {
  private readonly root = requireElement("touch-controls");
  private readonly intent = emptyTouchIntent();

  /**
   * Whether this device has shown it wants them.
   *
   * Starts true on anything with a coarse pointer, because a phone should not
   * have to be touched once before it can be played.
   */
  private wanted = hasTouchScreen();
  /** Whether the game is on screen at all; controls have no place in a menu. */
  private inMatch = false;

  constructor(private readonly callbacks: TouchControlsCallbacks) {
    this.bind("touch-left", "left");
    this.bind("touch-right", "right");
    this.bind("touch-jump", "jump");
    this.bind("touch-fire", "fire");
    this.bind("touch-reload", "reload");
    this.bind("touch-grenade", "grenade");

    // The modality switch, in both directions.
    window.addEventListener("touchstart", () => this.setWanted(true), { passive: true });
    window.addEventListener("keydown", () => this.setWanted(false));

    this.render();
  }

  /** Show or hide with the game itself. */
  setInMatch(inMatch: boolean): void {
    if (this.inMatch === inMatch) return;
    this.inMatch = inMatch;
    if (!inMatch) this.releaseAll();
    this.render();
  }

  get isVisible(): boolean {
    return this.wanted && this.inMatch;
  }

  private setWanted(wanted: boolean): void {
    if (this.wanted === wanted) return;
    this.wanted = wanted;
    if (!wanted) this.releaseAll();
    this.render();
  }

  private render(): void {
    this.root.hidden = !this.isVisible;
  }

  /**
   * Wire one button to one flag.
   *
   * Pointer events rather than touch events so the same code serves a stylus and
   * a mouse, and `setPointerCapture` so a finger that slides off the button
   * still releases it -- without that, dragging off a fire button leaves the
   * trigger held down for the rest of the match.
   */
  private bind(elementId: string, key: keyof TouchIntent): void {
    const button = requireElement<HTMLButtonElement>(elementId);

    const press = (event: PointerEvent) => {
      event.preventDefault();
      // Capture can be refused -- a pointer that is no longer active, a
      // synthetic event -- and a control that threw on press would be a control
      // that does nothing at all.
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        // Without capture, sliding off the button releases it early. Playable.
      }
      this.set(key, true);
      toggleClass(button, "is-held", true);
    };

    const release = (event: PointerEvent) => {
      event.preventDefault();
      try {
        if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
      } catch {
        // Already gone; the flag below is what actually matters.
      }
      this.set(key, false);
      toggleClass(button, "is-held", false);
    };

    button.addEventListener("pointerdown", press);
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    // Losing the window mid-press must not leave a button stuck.
    window.addEventListener("blur", () => {
      this.set(key, false);
      toggleClass(button, "is-held", false);
    });
  }

  private set(key: keyof TouchIntent, value: boolean): void {
    if (this.intent[key] === value) return;
    this.intent[key] = value;
    this.callbacks.onIntent({ ...this.intent });
  }

  private releaseAll(): void {
    let changed = false;
    for (const key of Object.keys(this.intent) as (keyof TouchIntent)[]) {
      if (!this.intent[key]) continue;
      this.intent[key] = false;
      changed = true;
    }
    for (const button of this.root.querySelectorAll(".touch__button")) {
      button.classList.remove("is-held");
    }
    if (changed) this.callbacks.onIntent({ ...this.intent });
  }
}

/**
 * Does this device have a touch screen at all?
 *
 * Two questions rather than one, because neither is reliable alone: a coarse
 * pointer covers phones and tablets, and `maxTouchPoints` catches the desktop
 * browsers that report a fine pointer for an attached mouse while still having a
 * touch screen.
 */
function hasTouchScreen(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  } catch {
    return false;
  }
}
