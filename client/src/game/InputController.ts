import Phaser from "phaser";
import { createInputCommand, type InputCommand } from "@deathmatch/shared";
import { emptyTouchIntent, type TouchIntent } from "../ui/TouchControls.js";

/**
 * Translates keyboard and mouse into `InputCommand`s.
 *
 * This is the only place that knows about key bindings, and it produces nothing
 * but intent -- no positions, no hit claims. Sampling is decoupled from the
 * simulation tick so a key tapped between two ticks is never dropped.
 */
export class InputController {
  private readonly keys: Record<string, Phaser.Input.Keyboard.Key>;

  private sequence = 0;

  /** Aim angle in world space, recomputed whenever the pointer or camera moves. */
  private aimAngle = 0;

  /** Sticky flags so a press that happens between ticks still registers. */
  private jumpPressedSinceSample = false;
  private reloadPressedSinceSample = false;
  private firePressedSinceSample = false;

  private firing = false;
  /**
   * What the on-screen controls are asking for.
   *
   * Merged with the keyboard rather than replacing it: a tablet with a keyboard
   * attached should answer to both, and the simulation cannot tell the
   * difference in any case.
   */
  private touch: TouchIntent = emptyTouchIntent();
  /** Set when the touch jump button goes down, cleared at the next sample. */
  private touchJumpPressed = false;
  /** True while the right mouse button is held, i.e. a grenade is winding up. */
  private chargingGrenade = false;
  /** When the wind-up began, for the local power bar. */
  private chargeStartedAt = 0;
  private enabled = true;

  constructor(private readonly scene: Phaser.Scene) {
    const keyboard = scene.input.keyboard;
    if (!keyboard) throw new Error("Keyboard input is unavailable in this browser.");

    this.keys = keyboard.addKeys(
      {
        left: Phaser.Input.Keyboard.KeyCodes.A,
        leftArrow: Phaser.Input.Keyboard.KeyCodes.LEFT,
        right: Phaser.Input.Keyboard.KeyCodes.D,
        rightArrow: Phaser.Input.Keyboard.KeyCodes.RIGHT,
        jump: Phaser.Input.Keyboard.KeyCodes.SPACE,
        jumpAlt: Phaser.Input.Keyboard.KeyCodes.W,
        jumpUp: Phaser.Input.Keyboard.KeyCodes.UP,
        reload: Phaser.Input.Keyboard.KeyCodes.R,
      },
      false,
    ) as Record<string, Phaser.Input.Keyboard.Key>;

    // Space and the arrow keys scroll the page by default; the game needs them.
    keyboard.addCapture([
      Phaser.Input.Keyboard.KeyCodes.SPACE,
      Phaser.Input.Keyboard.KeyCodes.LEFT,
      Phaser.Input.Keyboard.KeyCodes.RIGHT,
      Phaser.Input.Keyboard.KeyCodes.UP,
      Phaser.Input.Keyboard.KeyCodes.DOWN,
    ]);

    this.keys.jump!.on("down", () => {
      this.jumpPressedSinceSample = true;
    });
    this.keys.jumpAlt!.on("down", () => {
      this.jumpPressedSinceSample = true;
    });
    this.keys.jumpUp!.on("down", () => {
      this.jumpPressedSinceSample = true;
    });
    this.keys.reload!.on("down", () => {
      this.reloadPressedSinceSample = true;
    });

    scene.input.on(Phaser.Input.Events.POINTER_DOWN, (pointer: Phaser.Input.Pointer) => {
      if (pointer.leftButtonDown()) {
        this.firing = true;
        this.firePressedSinceSample = true;
      }
      if (pointer.rightButtonDown() && !this.chargingGrenade) {
        this.chargingGrenade = true;
        this.chargeStartedAt = performance.now();
      }
    });
    scene.input.on(Phaser.Input.Events.POINTER_UP, (pointer: Phaser.Input.Pointer) => {
      if (pointer.leftButtonReleased()) this.firing = false;
      if (pointer.rightButtonReleased()) this.chargingGrenade = false;
    });

    // Losing focus mid-fire would otherwise leave the trigger stuck down.
    scene.game.events.on(Phaser.Core.Events.BLUR, () => this.releaseAll());
    window.addEventListener("blur", () => this.releaseAll());

    // Right-click is used for nothing, but its menu would interrupt aiming.
    scene.game.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  /**
   * Take the on-screen controls' current state.
   *
   * Jump and reload are latched the same way their keys are: a tap that happens
   * between two ticks still registers, which is the difference between a control
   * that works and one that feels broken.
   */
  setTouchIntent(intent: TouchIntent): void {
    if (intent.jump && !this.touch.jump) this.touchJumpPressed = true;
    if (intent.reload && !this.touch.reload) this.reloadPressedSinceSample = true;
    if (intent.fire && !this.touch.fire) this.firePressedSinceSample = true;

    // A wind-up starts when the button goes down and ends when it comes up, the
    // same as the right mouse button.
    if (intent.grenade && !this.touch.grenade) {
      this.chargingGrenade = true;
      this.chargeStartedAt = performance.now();
    }
    if (!intent.grenade && this.touch.grenade) this.chargingGrenade = false;

    this.touch = { ...intent };
  }

  /** Disable input while dead or between matches. */
  setEnabled(enabled: boolean): void {
    if (!enabled) this.releaseAll();
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get currentAimAngle(): number {
    return this.aimAngle;
  }

  get isChargingGrenade(): boolean {
    return this.chargingGrenade;
  }

  /**
   * How far the local wind-up has progressed, 0..1.
   *
   * Purely for the power bar: it is drawn from the client's own press time so it
   * moves smoothly at frame rate. The strength that actually decides the throw
   * is measured on the server, from the same button held over the same ticks.
   */
  chargeProgress(maxChargeMs: number): number {
    if (!this.chargingGrenade || maxChargeMs <= 0) return 0;
    return Math.min(1, (performance.now() - this.chargeStartedAt) / maxChargeMs);
  }

  /** World-space pointer position, recomputed from the camera every frame. */
  getPointerWorldPosition(): { x: number; y: number } {
    const pointer = this.scene.input.activePointer;
    const world = pointer.positionToCamera(this.scene.cameras.main) as Phaser.Math.Vector2;
    return { x: world.x, y: world.y };
  }

  /**
   * Update the aim angle from the pointer.
   * The client computes the angle; the server validates it and performs the shot.
   */
  updateAim(originX: number, originY: number): number {
    const pointer = this.getPointerWorldPosition();
    this.aimAngle = Math.atan2(pointer.y - originY, pointer.x - originX);
    return this.aimAngle;
  }

  /** Produce the command for one simulation tick and clear the sticky flags. */
  sample(): InputCommand {
    const command = createInputCommand(++this.sequence);
    if (!this.enabled) {
      this.clearStickyFlags();
      command.aimAngle = this.aimAngle;
      return command;
    }

    command.moveLeft = this.isDown("left") || this.isDown("leftArrow") || this.touch.left;
    command.moveRight = this.isDown("right") || this.isDown("rightArrow") || this.touch.right;
    command.jump =
      this.jumpPressedSinceSample ||
      this.touchJumpPressed ||
      this.touch.jump ||
      this.isDown("jump") ||
      this.isDown("jumpAlt") ||
      this.isDown("jumpUp");
    command.fire = this.firing || this.firePressedSinceSample || this.touch.fire;
    command.reload = this.reloadPressedSinceSample || this.isDown("reload") || this.touch.reload;
    command.chargeGrenade = this.chargingGrenade;
    command.aimAngle = this.aimAngle;

    this.clearStickyFlags();
    return command;
  }

  private clearStickyFlags(): void {
    this.touchJumpPressed = false;
    this.jumpPressedSinceSample = false;
    this.reloadPressedSinceSample = false;
    this.firePressedSinceSample = false;
  }

  private releaseAll(): void {
    this.firing = false;
    this.touch = emptyTouchIntent();
    // Losing focus mid-wind-up releases the button, which the server reads as a
    // throw at whatever charge had accumulated -- better than a stuck wind-up.
    this.chargingGrenade = false;
    this.clearStickyFlags();
  }

  private isDown(key: string): boolean {
    return this.keys[key]?.isDown ?? false;
  }
}
