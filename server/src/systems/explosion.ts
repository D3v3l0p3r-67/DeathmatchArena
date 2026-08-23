/**
 * One blast, wherever it came from.
 *
 * A grenade and a rocket differ in how they arrive and in their numbers, not in
 * what happens when they go off — so this is the only place that decides who a
 * blast catches, how much it hurts them and how hard it throws them. Two copies
 * of that would drift, and the day they did, a rocket would quietly stop opening
 * crates or start ignoring the person who fired it.
 *
 * Nobody is immune to their own explosion. That is deliberate: it is what makes
 * firing a launcher at somebody standing next to you a decision.
 */
import {
  MatchState,
  PLAYER_HALF_HEIGHT,
  PLAYER_HALF_WIDTH,
  ServerMessage,
  clamp,
  distanceToBox,
  type ExplosionConfig,
  type ExplosionPayload,
  type GrenadeConfig,
} from "@deathmatch/shared";
import type { RoomContext } from "../rooms/RoomContext.js";

export interface Blast extends ExplosionConfig {
  /** Where it went off. */
  x: number;
  y: number;
  /** Who is credited with whatever it does. */
  ownerId: string;
  /** What the kill feed should say. */
  weaponId: string;
  /** Identifies the blast to the client, for the effect it draws. */
  id: string;
}

/**
 * Set one off.
 *
 * Always announced, even between matches: the client draws the blast from this
 * message, and an explosion nobody saw would be a projectile that simply
 * vanished. Damage, on the other hand, only happens in a live match.
 */
export function detonate(context: RoomContext, blast: Blast, now: number): void {
  const payload: ExplosionPayload = {
    id: blast.id,
    ownerId: blast.ownerId,
    x: blast.x,
    y: blast.y,
    radius: blast.radius,
  };
  context.broadcast(ServerMessage.EXPLOSION, payload);

  if (context.state.matchState !== MatchState.PLAYING) return;

  for (const player of Array.from(context.state.players.values())) {
    if (!player.alive || !player.inMatch) continue;

    const distance = distanceToBox(
      blast.x,
      blast.y,
      player.x,
      player.y,
      PLAYER_HALF_WIDTH,
      PLAYER_HALF_HEIGHT,
    );
    const damage = explosionDamageAt(distance, blast);
    if (damage <= 0) continue;

    context.applyDamage(player.sessionId, blast.ownerId, damage, player.x, player.y, blast.weaponId);

    // Thrown outwards from the blast, falling off with it -- so a near miss
    // shoves and a direct hit launches. A blast going off exactly underfoot has
    // no direction to push in, so it pushes straight up, which is what makes a
    // rocket jump possible.
    const awayX = player.x - blast.x;
    const awayY = player.y - blast.y;
    const spread = Math.hypot(awayX, awayY);
    const falloff = 1 - clamp(distance / Math.max(1, blast.radius), 0, 1);

    context.applyKnockback(
      player.sessionId,
      spread > 1 ? awayX : 0,
      spread > 1 ? awayY : -1,
      blast.knockbackForce * falloff,
    );
  }

  // Blasts open crates as readily as bullets do.
  for (const crate of Array.from(context.state.crates.values())) {
    const distance = distanceToBox(
      blast.x,
      blast.y,
      crate.x,
      crate.y,
      crate.width / 2,
      crate.height / 2,
    );
    const damage = explosionDamageAt(distance, blast);
    if (damage > 0) context.damageCrate(crate.id, damage, blast.ownerId, now);
  }
}

/**
 * Damage a blast deals at `distance`.
 *
 * Full damage at the centre, falling linearly to `minDamageMultiplier` at the
 * edge and nothing at all beyond it. Linear rather than quadratic because it is
 * a figure players have to be able to predict from experience.
 */
export function explosionDamageAt(distance: number, config: ExplosionConfig): number {
  const radius = Math.max(1, config.radius);
  if (distance > radius) return 0;

  const falloff = 1 - distance / radius;
  const multiplier = config.minDamageMultiplier + (1 - config.minDamageMultiplier) * falloff;
  return Math.round(config.damage * clamp(multiplier, 0, 1));
}

/**
 * A grenade's configuration, as a blast.
 *
 * Grenades name their fields for what they are (`explosionRadius`, `maxDamage`)
 * and have done since before rockets existed; renaming them would repoint every
 * stored admin override for the sake of tidiness.
 */
export function grenadeBlast(config: GrenadeConfig): ExplosionConfig {
  return {
    radius: config.explosionRadius,
    damage: config.maxDamage,
    minDamageMultiplier: config.minDamageMultiplier,
    knockbackForce: config.knockbackForce,
  };
}
