import Phaser from "phaser";
import { TrapPhase, trapRegistry, type SyncedTrap } from "@deathmatch/shared";

/**
 * How each phase reads on screen.
 *
 * This is the whole reason a trap's phase is synchronised. A hazard that gives
 * no warning is not difficulty, it is a coin toss -- so `arming` is loud and
 * unmistakable, `active` is solid, and everything else recedes.
 */
const PHASE_STYLE: Record<string, { alpha: number; strokeAlpha: number; pulse: boolean }> = {
  [TrapPhase.IDLE]: { alpha: 0.28, strokeAlpha: 0.5, pulse: false },
  [TrapPhase.ARMING]: { alpha: 0.55, strokeAlpha: 1, pulse: true },
  [TrapPhase.ACTIVE]: { alpha: 0.92, strokeAlpha: 1, pulse: false },
  [TrapPhase.COOLDOWN]: { alpha: 0.35, strokeAlpha: 0.6, pulse: false },
};

const FALLBACK_COLOR = 0xef5350;

/**
 * A trap.
 *
 * Entirely presentational, like every other view here. Where the trap is, how
 * big it is and which phase it is in all arrive from the server; nothing drawn
 * here has any bearing on who gets hurt.
 *
 * Drawn as a shape rather than a sprite so that a trap type registered by a
 * deployment -- one this build has never heard of -- still renders as something
 * sensible instead of a missing texture.
 */
export class TrapView {
  readonly container: Phaser.GameObjects.Container;

  private readonly body: Phaser.GameObjects.Rectangle;
  private readonly glow: Phaser.GameObjects.Rectangle;
  private readonly color: number;
  private phase: string;
  private pulseTween: Phaser.Tweens.Tween | null = null;

  constructor(
    private readonly scene: Phaser.Scene,
    trap: SyncedTrap,
  ) {
    this.color = trapRegistry.get(trap.trapType)?.color ?? FALLBACK_COLOR;
    this.phase = trap.phase;

    this.glow = scene.add
      .rectangle(0, 0, trap.width + 10, trap.height + 10, this.color, 0.18)
      .setBlendMode(Phaser.BlendModes.ADD);

    this.body = scene.add
      .rectangle(0, 0, trap.width, trap.height, this.color, 0.9)
      .setStrokeStyle(2, lighten(this.color), 1);

    // Under the players and projectiles, over the arena geometry: a trap is part
    // of the level, and a player standing in one must stay visible.
    this.container = scene.add.container(centreX(trap), centreY(trap), [this.glow, this.body]).setDepth(4);

    this.applyPhase(trap.phase);
  }

  /** Mirror the authoritative trap state. */
  refresh(trap: SyncedTrap): void {
    this.container.setPosition(centreX(trap), centreY(trap));
    if (trap.phase !== this.phase) this.applyPhase(trap.phase);
  }

  private applyPhase(phase: string): void {
    this.phase = phase;
    const style = PHASE_STYLE[phase] ?? PHASE_STYLE[TrapPhase.IDLE]!;

    this.body.setFillStyle(this.color, style.alpha);
    this.body.setStrokeStyle(2, lighten(this.color), style.strokeAlpha);
    this.glow.setFillStyle(this.color, style.alpha * 0.25);

    this.pulseTween?.remove();
    this.pulseTween = null;

    if (!style.pulse) {
      this.glow.setScale(1);
      return;
    }

    // The warning: a fast throb for as long as the wind-up lasts.
    this.pulseTween = this.scene.tweens.add({
      targets: this.glow,
      scaleX: 1.35,
      scaleY: 1.35,
      alpha: { from: 0.5, to: 0.15 },
      duration: 220,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  destroy(): void {
    this.pulseTween?.remove();
    this.container.destroy(true);
  }
}

/** Traps are stored by their top-left corner; the view is centred. */
function centreX(trap: SyncedTrap): number {
  return trap.x + trap.width / 2;
}

function centreY(trap: SyncedTrap): number {
  return trap.y + trap.height / 2;
}

/** A brighter edge of the same hue, so the outline reads against the fill. */
function lighten(color: number): number {
  const r = Math.min(255, ((color >> 16) & 0xff) + 70);
  const g = Math.min(255, ((color >> 8) & 0xff) + 70);
  const b = Math.min(255, (color & 0xff) + 70);
  return (r << 16) | (g << 8) | b;
}
