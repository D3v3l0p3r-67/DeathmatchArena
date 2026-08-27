import Phaser from "phaser";
import type { SyncedFlag } from "@deathmatch/shared";
import { TextureKeys } from "../TextureFactory.js";

/** A freshly spawned flag: the score-red the HUD uses for it. */
const SPAWNED_TINT = 0xff5f6d;
/** A dropped flag: amber, so lost score reads as loot with a fuse. */
const DROPPED_TINT = 0xffc65c;

/**
 * A flag waiting on the ground in Flag Hunt.
 *
 * Purely presentational: the server owns pickup, expiry and everything else.
 * Spawned and dropped flags share one texture and differ only in tint and how
 * urgently they animate — a dropped flag is about to expire, and blinks like it.
 */
export class FlagView {
  readonly container: Phaser.GameObjects.Container;

  constructor(
    private readonly scene: Phaser.Scene,
    readonly flag: SyncedFlag,
  ) {
    const tint = flag.dropped ? DROPPED_TINT : SPAWNED_TINT;

    const halo = scene.add.image(0, 6, TextureKeys.PowerUpOrb).setTint(tint).setAlpha(0.3).setScale(1.5);
    const banner = scene.add.image(0, -6, TextureKeys.Flag).setTint(tint);

    this.container = scene.add.container(flag.x, flag.y, [halo, banner]).setDepth(7);

    // Bob, like a power-up: it is a pickup and should read as one.
    scene.tweens.add({
      targets: this.container,
      y: flag.y - 7,
      duration: flag.dropped ? 650 : 1000,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
    scene.tweens.add({
      targets: halo,
      alpha: flag.dropped ? 0.55 : 0.12,
      scale: 1.9,
      duration: flag.dropped ? 450 : 900,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  destroy(): void {
    this.scene.tweens.killTweensOf(this.container);
    this.container.each((child: Phaser.GameObjects.GameObject) => this.scene.tweens.killTweensOf(child));
    this.container.destroy(true);
  }
}
