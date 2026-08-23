import Phaser from "phaser";
import type { SyncedPendingCrate } from "@deathmatch/shared";
import { TextureKeys } from "../TextureFactory.js";

/** The crate's own colour, so the warning plainly belongs to what arrives. */
const WARNING_COLOR = 0xc9a227;
/** How fast the ring pulses at the start and at the moment of landing, in Hz. */
const PULSE_START_HZ = 1.4;
const PULSE_END_HZ = 7;

/**
 * The mark left where a crate is about to land.
 *
 * A ring on the ground that tightens onto the landing spot, with a shadow and a
 * glow building underneath it. Round, and only round: an arrow above the spot
 * was tried and read as an icon stuck to the crate rather than as a warning
 * about the ground. All of it builds as the moment approaches -- the pulse
 * quickens from a slow beat to an urgent one -- so the arena can be read at a
 * glance rather than counted.
 *
 * Entirely presentational. It has no body, blocks nothing, and gives away only
 * the place: the contents stay secret exactly as they do for a sealed crate.
 */
export class CrateWarningView {
  readonly container: Phaser.GameObjects.Container;

  private readonly ring: Phaser.GameObjects.Arc;
  private readonly ground: Phaser.GameObjects.Ellipse;
  private readonly glow: Phaser.GameObjects.Image;

  private progress = 0;
  private pulse = 0;

  constructor(scene: Phaser.Scene, warning: SyncedPendingCrate) {
    const size = Math.max(warning.width, warning.height);

    // The ring starts wide and closes onto the spot, which reads as "here, soon"
    // far more clearly than something that simply grows.
    this.ring = scene.add.circle(0, 0, size * 2.2, WARNING_COLOR, 0).setStrokeStyle(3, WARNING_COLOR, 0.9);

    this.ground = scene.add
      .ellipse(0, warning.height / 2, size * 1.5, size * 0.5, WARNING_COLOR, 0.18)
      .setBlendMode(Phaser.BlendModes.ADD);

    this.glow = scene.add
      .image(0, 0, TextureKeys.BulletGlow)
      .setTint(WARNING_COLOR)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(size / 14);

    this.container = scene.add
      .container(warning.x, warning.y, [this.ground, this.ring, this.glow])
      // Under the players and projectiles: a warning must never hide the fight.
      .setDepth(3);

    this.refresh(warning);
  }

  /** Take the authoritative position and progress. */
  refresh(warning: SyncedPendingCrate): void {
    this.container.setPosition(warning.x, warning.y);
    this.progress = Math.min(1, Math.max(0, warning.progress));
  }

  /**
   * Advance the pulse.
   *
   * Driven at frame rate off a progress value that arrives at the patch rate, so
   * the flashing is smooth even though the countdown behind it is not.
   */
  render(deltaSeconds: number): void {
    const eased = this.progress * this.progress;
    const rate = PULSE_START_HZ + (PULSE_END_HZ - PULSE_START_HZ) * eased;

    this.pulse = (this.pulse + deltaSeconds * rate) % 1;
    // Sharp on, soft off: a sawtooth reads as a beat, a sine reads as a shimmer.
    const beat = 1 - this.pulse;

    // The ring closes from wide to the crate's own footprint.
    this.ring.setScale(1 - 0.62 * eased);
    this.ring.setStrokeStyle(2 + 3 * eased, WARNING_COLOR, 0.35 + 0.65 * beat);

    this.ground.setAlpha(0.12 + 0.5 * eased * (0.5 + 0.5 * beat));
    this.ground.setScale(0.6 + 0.5 * eased);

    this.glow.setAlpha(0.1 + 0.55 * eased * beat);
    this.glow.setScale((0.6 + 0.7 * eased) * (0.9 + 0.2 * beat));
  }

  destroy(): void {
    this.container.destroy(true);
  }
}
