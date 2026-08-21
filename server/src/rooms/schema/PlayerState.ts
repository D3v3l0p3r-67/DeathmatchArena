import { Schema, type } from "@colyseus/schema";
import { PHYSICS, PLAYER, getDefaultWeaponId, type SyncedPlayer } from "@deathmatch/shared";

/**
 * Everything about a player that clients need in order to render the match.
 *
 * Deliberately narrow: input queues, weapon cooldowns, reload deadlines and
 * anti-cheat budgets live in `PlayerRuntime` on the server and are never sent.
 *
 * Numeric widths are chosen for bandwidth: positions are float32 (sub-millipixel
 * precision over a 3200px arena) and counters are the smallest integer that fits.
 */
export class PlayerState extends Schema implements SyncedPlayer {
  /** Colyseus session id -- the only true player identifier. */
  @type("string") sessionId = "";

  /** Server-validated display name. Never used as an identifier. */
  @type("string") name = "";

  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") velocityX = 0;
  @type("float32") velocityY = 0;

  /** Aim direction in world space, radians. */
  @type("float32") aimAngle = 0;

  /** -1 = facing left, 1 = facing right. */
  @type("int8") facing = 1;

  @type("uint8") health: number = PLAYER.MAX_HEALTH;
  @type("boolean") alive = false;
  @type("boolean") onGround = false;

  @type("uint8") kills = 0;
  @type("uint8") deaths = 0;

  @type("uint16") ammo = 0;
  @type("boolean") reloading = false;
  @type("string") weaponId = getDefaultWeaponId();

  /**
   * Movement speed multiplier from an active power-up effect; 1 when none.
   *
   * Synchronised because the client's prediction has to run with the same cap the
   * server used, or a boosted player would fight their own reconciliation.
   */
  @type("float32") speedMultiplier = 1;

  /**
   * Whole seconds left on the active speed effect, 0 when none.
   * Whole seconds so this changes at most once per second instead of every patch.
   */
  @type("uint8") boostSeconds = 0;

  /**
   * Jumps left before landing.
   *
   * Synchronised for the same reason as position: the client replays pending
   * inputs on top of server truth, and starting that replay with a stale jump
   * allowance would predict a jump the server never granted.
   */
  @type("uint8") jumpsRemaining: number = PHYSICS.MAX_JUMPS;

  /** Grenades left to throw. Only the server ever changes this. */
  @type("uint8") grenades = 0;

  /**
   * True while the player is winding up a throw.
   *
   * Synchronised so other clients can show the wind-up; the local charge bar is
   * drawn from the client's own press time for smoothness, but the strength that
   * actually matters is measured here on the server.
   */
  @type("boolean") chargingGrenade = false;

  /**
   * Sequence number of the last input this player's state includes.
   * The client replays everything after it to reconcile its prediction.
   */
  @type("uint32") lastProcessedInput = 0;

  /** False while the socket is gone but the seat is still reserved for reconnection. */
  @type("boolean") connected = true;

  /** Final placement once eliminated (1 = winner). 0 while still playing. */
  @type("uint8") placement = 0;

  /** True once the player has been spawned into the current match. */
  @type("boolean") inMatch = false;
}
