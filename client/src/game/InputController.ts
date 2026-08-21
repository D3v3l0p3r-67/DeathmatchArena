import Phaser from "phaser";
import { createInputCommand, type InputCommand } from "@deathmatch/shared";

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
      if (!pointer.leftButtonDown()) return;
      this.firing = true;
      this.firePressedSinceSample = true;
    });
    scene.input.on(Phaser.Input.Events.POINTER_UP, (pointer: Phaser.Input.Pointer) => {
      if (pointer.leftButtonReleased()) this.firing = false;
    });

    // Losing focus mid-fire would otherwise leave the trigger stuck down.
    scene.game.events.on(Phaser.Core.Events.BLUR, () => this.releaseAll());
    window.addEventListener("blur", () => this.releaseAll());

    // Right-click is used for nothing, but its menu would interrupt aiming.
    scene.game.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
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

    command.moveLeft = this.isDown("left") || this.isDown("leftArrow");
    command.moveRight = this.isDown("right") || this.isDown("rightArrow");
    command.jump =
      this.jumpPressedSinceSample || this.isDown("jump") || this.isDown("jumpAlt") || this.isDown("jumpUp");
    command.fire = this.firing || this.firePressedSinceSample;
    command.reload = this.reloadPressedSinceSample || this.isDown("reload");
    command.aimAngle = this.aimAngle;

    this.clearStickyFlags();
    return command;
  }

  private clearStickyFlags(): void {
    this.jumpPressedSinceSample = false;
    this.reloadPressedSinceSample = false;
    this.firePressedSinceSample = false;
  }

  private releaseAll(): void {
    this.firing = false;
    this.clearStickyFlags();
  }

  private isDown(key: string): boolean {
    return this.keys[key]?.isDown ?? false;
  }
}
