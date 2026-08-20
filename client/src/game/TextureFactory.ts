import Phaser from "phaser";
import { PLAYER } from "@deathmatch/shared";

/**
 * Placeholder art, generated at runtime.
 *
 * Everything the game draws goes through a texture key, so replacing these with a
 * real spritesheet later is a change to this file (plus an atlas load) and nothing
 * else -- gameplay code never draws primitives directly.
 */
export const TextureKeys = {
  PlayerBody: "player-body",
  PlayerVisor: "player-visor",
  PlayerShadow: "player-shadow",
  Weapon: "weapon",
  Bullet: "bullet",
  BulletGlow: "bullet-glow",
  Spark: "spark",
  MuzzleFlash: "muzzle-flash",
  Pixel: "pixel",
} as const;

export function generatePlaceholderTextures(scene: Phaser.Scene): void {
  createPlayerBody(scene);
  createPlayerVisor(scene);
  createPlayerShadow(scene);
  createWeapon(scene);
  createBullet(scene);
  createBulletGlow(scene);
  createSpark(scene);
  createMuzzleFlash(scene);
  createPixel(scene);
}

/** White so it can be tinted per player; the silhouette carries the identity. */
function createPlayerBody(scene: Phaser.Scene): void {
  const width = PLAYER.WIDTH;
  const height = PLAYER.HEIGHT;
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);

  graphics.fillStyle(0xffffff, 1);
  graphics.fillRoundedRect(0, 0, width, height, 6);
  // A darker foot band reads as "grounded" and gives the sprite a sense of weight.
  graphics.fillStyle(0x000000, 0.22);
  graphics.fillRect(0, height - 7, width, 7);

  graphics.generateTexture(TextureKeys.PlayerBody, width, height);
  graphics.destroy();
}

function createPlayerVisor(scene: Phaser.Scene): void {
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  graphics.fillStyle(0xffffff, 1);
  graphics.fillRoundedRect(0, 0, 14, 6, 3);
  graphics.generateTexture(TextureKeys.PlayerVisor, 14, 6);
  graphics.destroy();
}

function createPlayerShadow(scene: Phaser.Scene): void {
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  graphics.fillStyle(0x000000, 0.4);
  graphics.fillEllipse(22, 6, 44, 12);
  graphics.generateTexture(TextureKeys.PlayerShadow, 44, 12);
  graphics.destroy();
}

function createWeapon(scene: Phaser.Scene): void {
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  graphics.fillStyle(0xffffff, 1);
  graphics.fillRect(0, 3, 26, 6);
  graphics.fillRect(4, 9, 7, 5);
  graphics.fillStyle(0xffffff, 0.65);
  graphics.fillRect(20, 1, 6, 3);
  graphics.generateTexture(TextureKeys.Weapon, 26, 14);
  graphics.destroy();
}

function createBullet(scene: Phaser.Scene): void {
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  graphics.fillStyle(0xffffff, 1);
  graphics.fillCircle(5, 5, 4);
  graphics.generateTexture(TextureKeys.Bullet, 10, 10);
  graphics.destroy();
}

function createBulletGlow(scene: Phaser.Scene): void {
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  for (let radius = 12; radius > 0; radius -= 2) {
    graphics.fillStyle(0xffffff, 0.05);
    graphics.fillCircle(12, 12, radius);
  }
  graphics.generateTexture(TextureKeys.BulletGlow, 24, 24);
  graphics.destroy();
}

function createSpark(scene: Phaser.Scene): void {
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  graphics.fillStyle(0xffffff, 1);
  graphics.fillRect(0, 0, 4, 4);
  graphics.generateTexture(TextureKeys.Spark, 4, 4);
  graphics.destroy();
}

function createMuzzleFlash(scene: Phaser.Scene): void {
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  graphics.fillStyle(0xffffff, 0.95);
  graphics.fillTriangle(0, 9, 22, 2, 22, 16);
  graphics.fillStyle(0xffffff, 0.55);
  graphics.fillCircle(4, 9, 7);
  graphics.generateTexture(TextureKeys.MuzzleFlash, 24, 18);
  graphics.destroy();
}

function createPixel(scene: Phaser.Scene): void {
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  graphics.fillStyle(0xffffff, 1);
  graphics.fillRect(0, 0, 1, 1);
  graphics.generateTexture(TextureKeys.Pixel, 1, 1);
  graphics.destroy();
}

/**
 * Colour identity for players.
 *
 * The local player is always the same cyan so you can find yourself instantly;
 * everyone else gets a stable colour derived from their session id.
 */
export const LOCAL_PLAYER_COLOR = 0x37d0ff;

const REMOTE_PLAYER_COLORS = [
  0xff6b6b, 0xffa94d, 0xffd43b, 0xa9e34b, 0x69db7c, 0x38d9a9, 0xf783ac, 0xda77f2, 0xb197fc, 0xff8787,
];

export function getPlayerColor(sessionId: string, isLocal: boolean): number {
  if (isLocal) return LOCAL_PLAYER_COLOR;

  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0;
  }
  return REMOTE_PLAYER_COLORS[hash % REMOTE_PLAYER_COLORS.length]!;
}
