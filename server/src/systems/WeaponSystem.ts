import {
  PLAYER,
  ServerMessage,
  getDefaultWeaponId,
  getFireIntervalMs,
  getMeleeArcRadians,
  getWeapon,
  isMelee,
  usesAmmo,
  type InputCommand,
  type MeleeSwingPayload,
  type WeaponDefinition,
} from "@deathmatch/shared";
import type { PlayerRuntime } from "../rooms/PlayerRuntime.js";
import type { RoomContext } from "../rooms/RoomContext.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";
import type { CollisionSystem } from "./CollisionSystem.js";
import type { ProjectileSystem } from "./ProjectileSystem.js";

/**
 * Weapon handling: ammunition, cooldowns, reloads, shot spawning and melee contact.
 *
 * Everything a client could lie about is decided here:
 *   - is the player alive?
 *   - has the fire-rate cooldown elapsed?
 *   - is there ammunition in the magazine?
 *   - is a reload in progress?
 *   - for melee: is anyone actually within reach?
 *
 * The client's `fire` bit is a *request*. This system decides what happens, and
 * behaviour comes entirely from the weapon definition -- so adding a weapon is a
 * config change, not a change here.
 */
export class WeaponSystem {
  constructor(
    private readonly context: RoomContext,
    private readonly projectiles: ProjectileSystem,
    private readonly collision: CollisionSystem,
  ) {}

  /** Give a player a weapon and fill the magazine. Used at spawn and on pickup. */
  equip(player: PlayerState, runtime: PlayerRuntime, weaponId: string = getDefaultWeaponId()): void {
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
    if (input.reload && !runtime.lastInput.reload && usesAmmo(weapon)) {
      this.tryStartReload(player, runtime, weapon, now);
    }

    if (!input.fire) return;
    // Semi-automatic weapons require a fresh trigger pull.
    if (!weapon.automatic && runtime.lastInput.fire) return;

    if (isMelee(weapon)) {
      this.tryMelee(player, runtime, weapon, input.aimAngle, now);
    } else {
      this.tryFire(player, runtime, weapon, input.aimAngle, now);
    }
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
    if (!usesAmmo(weapon)) return false;
    if (player.ammo >= weapon.magazineSize) return false;

    player.reloading = true;
    runtime.reloadEndsAt = now + weapon.reloadTime;
    return true;
  }

  // -------------------------------------------------------------------------
  // Ranged
  // -------------------------------------------------------------------------

  private tryFire(
    player: PlayerState,
    runtime: PlayerRuntime,
    weapon: WeaponDefinition,
    aimAngle: number,
    now: number,
  ): boolean {
    if (player.reloading) return false;

    const ammoLimited = usesAmmo(weapon);
    if (ammoLimited && player.ammo <= 0) {
      // Empty magazine: start reloading instead of firing.
      this.tryStartReload(player, runtime, weapon, now);
      return false;
    }

    // Fire-rate is enforced against the server clock, not against anything the client sent.
    if (now - runtime.lastShotAt < getFireIntervalMs(weapon)) return false;

    runtime.lastShotAt = now;
    if (ammoLimited) player.ammo -= 1;

    const origin = getMuzzlePosition(player, aimAngle);
    const pellets = Math.max(1, weapon.ranged?.pellets ?? 1);
    const spread = weapon.ranged?.spread ?? 0;

    // A shotgun is simply a weapon whose definition asks for several pellets --
    // there is no shotgun-specific branch anywhere in this system.
    for (let pellet = 0; pellet < pellets; pellet++) {
      const deviation = (this.context.random() * 2 - 1) * spread;
      this.projectiles.spawn(player.sessionId, weapon, origin.x, origin.y, aimAngle + deviation, now);
    }

    if (ammoLimited && player.ammo === 0) this.tryStartReload(player, runtime, weapon, now);
    return true;
  }

  // -------------------------------------------------------------------------
  // Melee
  // -------------------------------------------------------------------------

  /**
   * Resolve a melee swing.
   *
   * No projectile is created: the server tests, from its own positions, whether
   * anything is inside the weapon's arc and within its contact range. The client
   * only ever said "I swung" -- it cannot name a victim, and a swing into empty
   * air simply hits nothing.
   */
  private tryMelee(
    player: PlayerState,
    runtime: PlayerRuntime,
    weapon: WeaponDefinition,
    aimAngle: number,
    now: number,
  ): boolean {
    if (now - runtime.lastShotAt < getFireIntervalMs(weapon)) return false;
    runtime.lastShotAt = now;

    const origin = { x: player.x, y: player.y + PLAYER.AIM_ORIGIN_Y };
    const halfArc = getMeleeArcRadians(weapon) / 2;

    const targets = this.collision.findMeleeTargets(
      origin.x,
      origin.y,
      aimAngle,
      weapon.range,
      halfArc,
      this.context.state.players.values(),
      player.sessionId,
    );

    for (const target of targets) {
      this.context.applyDamage(
        target.sessionId,
        player.sessionId,
        weapon.damage,
        target.x,
        target.y,
        weapon.id,
      );
    }

    // Melee opens crates too, otherwise a chainsaw player could never take one.
    const crates = this.collision.findMeleeCrates(
      origin.x,
      origin.y,
      aimAngle,
      weapon.range,
      halfArc,
      this.context.state.crates.values(),
    );
    for (const crate of crates) {
      this.context.damageCrate(crate.id, weapon.damage, player.sessionId, now);
    }

    const payload: MeleeSwingPayload = {
      sessionId: player.sessionId,
      weaponId: weapon.id,
      aimAngle,
      connected: targets.length > 0 || crates.length > 0,
    };
    this.context.broadcast(ServerMessage.MELEE_SWING, payload);

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
