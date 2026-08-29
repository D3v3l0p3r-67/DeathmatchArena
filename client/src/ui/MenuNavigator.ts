/**
 * Keyboard and gamepad traversal for every menu.
 *
 * The menus were mouse-only, which is the single most obvious way a game
 * announces it is a prototype: a controller in your hands and a menu you
 * cannot move through. This walks whatever is currently on screen -- the
 * topmost modal if one is open, otherwise the active screen -- so nothing has
 * to register its own bindings and a new screen is navigable the moment it
 * exists.
 *
 * It deliberately drives *native focus* rather than a selection model of its
 * own: activation, `:focus-visible`, and screen readers then all work for
 * free, and a mouse and a controller can be used in the same breath without
 * fighting over which one owns the highlight.
 */

/** Everything a menu can land on. Order here is reading order. */
const FOCUSABLE = [
  "button:not([disabled]):not([hidden])",
  "input:not([disabled]):not([hidden])",
  "[tabindex]:not([tabindex='-1']):not([hidden])",
].join(",");

/** Buttons on a gamepad, by the standard mapping. */
const PAD = { south: 0, east: 1, up: 12, down: 13, left: 14, right: 15 } as const;
/** How long a held direction waits before repeating, and then how fast. */
const PAD_REPEAT_DELAY_MS = 380;
const PAD_REPEAT_MS = 120;

export interface MenuNavigatorHooks {
  /** Escape, or the pad's east button, with nothing else to close. */
  onBack(): void;
}

export class MenuNavigator {
  private padPressed = new Set<number>();
  private padHeldSince = new Map<number, number>();
  private padLastRepeat = new Map<number, number>();
  private enabled = true;

  constructor(private readonly hooks: MenuNavigatorHooks) {
    window.addEventListener("keydown", (event) => this.onKeyDown(event));
  }

  /** Off while a match is being played: there the keys are the game's. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Poll the gamepad. Called once a frame; does nothing without one attached.
   *
   * Polling rather than events because that is the only API a gamepad has, and
   * the repeat has to be timed here or holding a direction races through a
   * menu at frame rate.
   */
  pollGamepad(now: number): void {
    if (!this.enabled) return;
    const pads = navigator.getGamepads?.() ?? [];
    const pad = Array.from(pads).find((candidate) => candidate?.connected);
    if (!pad) return;

    const pressed = (index: number): boolean => pad.buttons[index]?.pressed === true;
    const axisUp = (pad.axes[1] ?? 0) < -0.6;
    const axisDown = (pad.axes[1] ?? 0) > 0.6;

    this.handlePadDirection(PAD.up, pressed(PAD.up) || axisUp, now, -1);
    this.handlePadDirection(PAD.down, pressed(PAD.down) || axisDown, now, 1);
    this.handlePadButton(PAD.south, pressed(PAD.south), () => this.activateFocused());
    this.handlePadButton(PAD.east, pressed(PAD.east), () => this.hooks.onBack());
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  private onKeyDown(event: KeyboardEvent): void {
    /*
     * Escape is not navigation, it is "back", and it has to work even while
     * the game owns the keys -- it is how a player reaches the pause menu.
     * Gating it behind `enabled` made Escape do nothing during a level, which
     * is precisely when it matters most.
     */
    if (event.key === "Escape") {
      event.preventDefault();
      this.hooks.onBack();
      return;
    }

    if (!this.enabled) return;

    const container = this.activeContainer();
    if (!container) return;

    /*
     * A range slider uses the arrows to change its value, so it keeps them.
     * A text field does not: trapping focus in the name box, with no way to
     * reach the buttons below it, is worse than losing nothing at all.
     */
    const target = event.target as HTMLElement | null;
    const isSlider = target?.tagName === "INPUT" && (target as HTMLInputElement).type === "range";

    switch (event.key) {
      case "ArrowDown":
        if (isSlider) return;
        event.preventDefault();
        this.move(container, 1);
        return;
      case "ArrowUp":
        if (isSlider) return;
        event.preventDefault();
        this.move(container, -1);
        return;
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Gamepad edges and repeats
  // -------------------------------------------------------------------------

  private handlePadButton(index: number, down: boolean, act: () => void): void {
    const was = this.padPressed.has(index);
    if (down && !was) {
      this.padPressed.add(index);
      act();
    } else if (!down && was) {
      this.padPressed.delete(index);
    }
  }

  private handlePadDirection(index: number, down: boolean, now: number, step: number): void {
    if (!down) {
      this.padPressed.delete(index);
      this.padHeldSince.delete(index);
      this.padLastRepeat.delete(index);
      return;
    }

    const container = this.activeContainer();
    if (!container) return;

    if (!this.padPressed.has(index)) {
      this.padPressed.add(index);
      this.padHeldSince.set(index, now);
      this.padLastRepeat.set(index, now);
      this.move(container, step);
      return;
    }

    const heldSince = this.padHeldSince.get(index) ?? now;
    const lastRepeat = this.padLastRepeat.get(index) ?? now;
    if (now - heldSince < PAD_REPEAT_DELAY_MS || now - lastRepeat < PAD_REPEAT_MS) return;

    this.padLastRepeat.set(index, now);
    this.move(container, step);
  }

  // -------------------------------------------------------------------------
  // Focus
  // -------------------------------------------------------------------------

  /**
   * What the player is looking at: the topmost open modal, or the active
   * screen. A modal being on top is the whole reason this is not just
   * "the active screen".
   */
  private activeContainer(): HTMLElement | null {
    const modals = Array.from(document.querySelectorAll<HTMLElement>(".modal.is-active"));
    if (modals.length > 0) return modals[modals.length - 1]!;
    return document.querySelector<HTMLElement>(".screen.is-active");
  }

  private items(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => element.offsetParent !== null,
    );
  }

  private move(container: HTMLElement, step: number): void {
    const items = this.items(container);
    if (items.length === 0) return;

    const current = items.indexOf(document.activeElement as HTMLElement);
    // Nothing focused yet: enter at the top going down, at the bottom going up.
    const next = current === -1 ? (step > 0 ? 0 : items.length - 1) : (current + step + items.length) % items.length;
    items[next]?.focus();
  }

  private activateFocused(): void {
    const focused = document.activeElement as HTMLElement | null;
    if (focused && typeof focused.click === "function") focused.click();
  }

  /** Put focus somewhere sensible when a screen opens. */
  focusFirst(): void {
    const container = this.activeContainer();
    if (!container) return;
    const items = this.items(container);
    items[0]?.focus();
  }
}
