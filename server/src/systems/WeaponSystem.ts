import {
  DEFAULT_WEAPON_ID,
  PLAYER,
  getFireIntervalMs,
  getWeapon,
  type InputCommand,
  type WeaponDefinition,
} from "@deathmatch/shared";
import type { PlayerRuntime } from "../rooms/PlayerRuntime.js";
import type { RoomContext } from "../rooms/RoomContext.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";
import type { ProjectileSystem } from "./ProjectileSystem.js";

/**
 * Weapon handling: ammunition, fire-rate cooldowns, reloads and shot spawning.
 *
 * Everything a client could lie about is decided here:
 *   - is the player alive?
 *   - has the fire-rate cooldown elapsed?
 *   - is there ammunition in the magazine?
 *   - is a reload in progress?
 *
 * The client's `fire` bit is a *request*. This system decides whether it happens.
 * Behaviour is entirely driven by the weapon definition, so adding a weapon means
 * adding data to `shared/game/weapons.ts` -- no changes here.
 */
export class WeaponSystem {
  constructor(
    private readonly context: RoomContext,
    private readonly projectiles: ProjectileSystem,
  ) {}

  /** Give a player a weapon and fill the magazine. Used at spawn (and later, pickups). */
  equip(player: PlayerState, runtime: PlayerRuntime, weaponId: string = DEFAULT_WEAPON_ID): void {
    const weapon = getWeapon(weaponId);
    player.weaponId = weapon.id;
    player.ammo = weapon.magazineSize;
    player.reloading = false;
    runtime.reloadEndsAt = 0;
    // Ready to fire immediately -- the cooldown is measured from the previous shot,
    // and there has not been one.
    runtime.lastShotAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * Resolve one input command's weapon intent.
   * Called from the movement loop so shots line up exactly with the tick that produced them.
   */
  processInput(player: PlayerState, runtime: PlayerRuntime, input: InputCommand, now: number): void {
    const weapon = getWeapon(player.weaponId);

    this.updateReload(player, runtime, weapon, now);

    if (!player.alive) return;

    // Reload on a fresh key press only, so holding R does not restart the reload.
    if (input.reload && !runtime.lastInput.reload) {
      this.tryStartReload(player, runtime, weapon, now);
    }

    if (!input.fire) return;
    // Semi-automatic weapons require a fresh trigger pull.
    if (!weapon.automatic && runtime.lastInput.fire) return;

    this.tryFire(player, runtime, weapon, input.aimAngle, now);
  }

  /** Finish a reload whose deadline has passed. */
  private updateReload(
    player: PlayerState,
    runtime: PlayerRuntime,
    weapon: WeaponDefinition,
    now: number,
  ): void {
    if (!player.reloading) return;
    if (now < runtime.reloadEndsAt) return;

    player.ammo = weapon.magazineSize;
    player.reloading = false;
    runtime.reloadEndsAt = 0;
  }

  private tryStartReload(
    player: PlayerState,
    runtime: PlayerRuntime,
    weapon: WeaponDefinition,
    now: number,
  ): boolean {
    if (player.reloading) return false;
    if (player.ammo >= weapon.magazineSize) return false;

    player.reloading = true;
    runtime.reloadEndsAt = now + weapon.reloadTime;
    return true;
  }

  private tryFire(
    player: PlayerState,
    runtime: PlayerRuntime,
    weapon: WeaponDefinition,
    aimAngle: number,
    now: number,
  ): boolean {
    if (player.reloading) return false;

    if (player.ammo <= 0) {
      // Empty magazine: start reloading instead of firing.
      this.tryStartReload(player, runtime, weapon, now);
      return false;
    }

    // Fire-rate is enforced against the server clock, not against anything the client sent.
    if (now - runtime.lastShotAt < getFireIntervalMs(weapon)) return false;

    runtime.lastShotAt = now;
    player.ammo -= 1;

    const origin = getMuzzlePosition(player, aimAngle);
    for (let pellet = 0; pellet < weapon.pellets; pellet++) {
      const deviation = (this.context.random() * 2 - 1) * weapon.spread;
      this.projectiles.spawn(player.sessionId, weapon, origin.x, origin.y, aimAngle + deviation, now);
    }

    if (player.ammo === 0) this.tryStartReload(player, runtime, weapon, now);
    return true;
  }
}

/**
 * World-space muzzle position for a given aim angle.
 *
 * Shared shape with the client's cosmetic muzzle flash, but the server's version is
 * the one bullets actually spawn from.
 */
export function getMuzzlePosition(player: PlayerState, aimAngle: number): { x: number; y: number } {
  const pivotX = player.x;
  const pivotY = player.y + PLAYER.AIM_ORIGIN_Y;
  return {
    x: pivotX + Math.cos(aimAngle) * PLAYER.MUZZLE_OFFSET_X,
    y: pivotY + Math.sin(aimAngle) * PLAYER.MUZZLE_OFFSET_X,
  };
}
