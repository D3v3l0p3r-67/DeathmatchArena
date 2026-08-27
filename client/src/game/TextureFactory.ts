import Phaser from "phaser";
import { PLAYER, listWeapons, type WeaponDefinition } from "@deathmatch/shared";

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
  /** Fallback for a weapon with no silhouette; real ones get a key of their own. */
  Weapon: "weapon",
  Bullet: "bullet",
  BulletGlow: "bullet-glow",
  Spark: "spark",
  MuzzleFlash: "muzzle-flash",
  Pixel: "pixel",
  Crate: "crate",
  PowerUpOrb: "power-up-orb",
  MeleeArc: "melee-arc",
  Grenade: "grenade",
  Flag: "flag",
  Crown: "crown",
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
  createCrate(scene);
  createPowerUpOrb(scene);
  createMeleeArc(scene);
  createGrenade(scene);
  createFlag(scene);
  createCrown(scene);
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

/** Texture key for one weapon's silhouette. */
export function weaponTextureKey(weaponId: string): string {
  return `weapon:${weaponId}`;
}

/**
 * Draw every configured weapon.
 *
 * Separate from the placeholder textures because it cannot run at boot: weapons
 * are administered data and arrive with the welcome message, so this runs once
 * the room's configuration is known -- and again if it changes underneath us.
 */
export function generateWeaponTextures(scene: Phaser.Scene): void {
  for (const weapon of listWeapons()) {
    drawWeapon(scene, weapon);
  }
}

function drawWeapon(scene: Phaser.Scene, weapon: WeaponDefinition): void {
  const key = weaponTextureKey(weapon.id);
  const shape = weapon.silhouette;
  if (!shape || shape.length <= 0 || shape.height <= 0) return;

  // Regenerated rather than skipped, so retuning a weapon's look takes effect
  // without a reload.
  if (scene.textures.exists(key)) scene.textures.remove(key);

  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  for (const part of shape.parts) {
    graphics.fillStyle(part.color ?? shape.color, part.alpha ?? 1);
    graphics.fillRect(part.x, part.y, part.width, part.height);
  }

  graphics.generateTexture(key, shape.length, shape.height);
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

/** White so the crate can be tinted as it takes damage. */
function createCrate(scene: Phaser.Scene): void {
  const size = 44;
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);

  graphics.fillStyle(0xffffff, 1);
  graphics.fillRoundedRect(0, 0, size, size, 5);

  // Plank seams and corner braces, so a crate reads as a crate at a glance.
  graphics.fillStyle(0x000000, 0.24);
  graphics.fillRect(0, size / 2 - 2, size, 4);
  graphics.fillRect(size / 2 - 2, 0, 4, size);
  graphics.fillStyle(0x000000, 0.16);
  graphics.fillRect(0, 0, size, 4);
  graphics.fillRect(0, size - 4, size, 4);

  graphics.generateTexture(TextureKeys.Crate, size, size);
  graphics.destroy();
}

/** Tinted per power-up definition, so one texture serves every kind. */
function createPowerUpOrb(scene: Phaser.Scene): void {
  const size = 34;
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);

  graphics.fillStyle(0xffffff, 0.18);
  graphics.fillCircle(size / 2, size / 2, size / 2);
  graphics.fillStyle(0xffffff, 0.55);
  graphics.fillCircle(size / 2, size / 2, size / 2 - 5);
  graphics.fillStyle(0xffffff, 1);
  graphics.fillCircle(size / 2, size / 2, size / 2 - 10);

  graphics.generateTexture(TextureKeys.PowerUpOrb, size, size);
  graphics.destroy();
}

/** A soft wedge used to show where a melee swing reached. */
function createMeleeArc(scene: Phaser.Scene): void {
  const size = 96;
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);

  graphics.fillStyle(0xffffff, 0.5);
  graphics.slice(0, size / 2, size, Phaser.Math.DegToRad(-38), Phaser.Math.DegToRad(38), false);
  graphics.fillPath();

  graphics.generateTexture(TextureKeys.MeleeArc, size, size);
  graphics.destroy();
}

/** A stubby cylinder with a lever, so it reads as a grenade at a glance. */
function createGrenade(scene: Phaser.Scene): void {
  const size = 18;
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);

  graphics.fillStyle(0x4d7c3f, 1);
  graphics.fillRoundedRect(3, 2, 12, 14, 4);
  graphics.fillStyle(0x2f4d27, 1);
  graphics.fillRect(3, 8, 12, 2);
  // The lever.
  graphics.fillStyle(0xc9c9c9, 1);
  graphics.fillRect(13, 0, 4, 6);

  graphics.generateTexture(TextureKeys.Grenade, size, size);
  graphics.destroy();
}

/** A pole and pennant, white so Flag Hunt can tint spawned and dropped apart. */
function createFlag(scene: Phaser.Scene): void {
  const width = 22;
  const height = 30;
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);

  // The pole.
  graphics.fillStyle(0xd8dde6, 1);
  graphics.fillRect(2, 0, 3, height);
  graphics.fillStyle(0xffffff, 1);
  graphics.fillCircle(3.5, 2, 2.5);
  // The pennant, a triangle off the top of the pole.
  graphics.fillTriangle(5, 2, width, 8, 5, 15);

  graphics.generateTexture(TextureKeys.Flag, width, height);
  graphics.destroy();
}

/** Three points and a band — the leader's crown, tinted gold where it is drawn. */
function createCrown(scene: Phaser.Scene): void {
  const width = 22;
  const height = 14;
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);

  graphics.fillStyle(0xffffff, 1);
  // The band.
  graphics.fillRect(1, height - 5, width - 2, 5);
  // Three spikes, the middle one tallest.
  graphics.fillTriangle(1, height - 5, 5.5, height - 5, 3, 4);
  graphics.fillTriangle(8, height - 5, 14, height - 5, 11, 0);
  graphics.fillTriangle(16.5, height - 5, 21, height - 5, 19, 4);

  graphics.generateTexture(TextureKeys.Crown, width, height);
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
