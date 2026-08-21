import Phaser from "phaser";
import { generatePlaceholderTextures } from "../TextureFactory.js";
import { GAME_SCENE_KEY } from "./GameScene.js";

export const BOOT_SCENE_KEY = "BootScene";

/**
 * Generates placeholder art and hands over to the game scene.
 *
 * Kept separate so that swapping generated textures for real asset loading later
 * touches only this scene.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: BOOT_SCENE_KEY });
  }

  create(): void {
    generatePlaceholderTextures(this);
    this.scene.start(GAME_SCENE_KEY);
  }
}
