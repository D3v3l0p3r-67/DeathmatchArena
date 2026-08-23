import {
  MatchState,
  PLAYER_HALF_HEIGHT,
  TrapPhase,
  angleDelta,
  clamp01,
  distance as distanceBetween,
  isMelee,
  usesAmmo,
  type BrainProfile,
} from "@deathmatch/shared";
import type { RoomContext } from "../rooms/RoomContext.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";
import type { PlayerRuntime } from "../rooms/PlayerRuntime.js";
import type {
  BrainContext,
  PerceivedEnemy,
  PerceivedGrenade,
  PerceivedItem,
  PerceivedTrap,
  SelfContext,
} from "./context.js";
import type { Memory } from "./Memory.js";

/** Beyond this many pixels a grenade is somebody else's problem. */
const GRENADE_ALARM_RADIUS = 320;
/**
 * How near a trap has to be before it is worth steering around.
 *
 * Comfortably further than a bot can travel in the time it takes to notice and
 * stop: at running speed 220px was about two thirds of a second, which is how
 * bots ended up walking into spikes they had every right to have seen coming.
 */
const TRAP_ALARM_RADIUS = 460;
/** Within this, a trap is frightening rather than merely noted. */
const TRAP_FEAR_RADIUS = 220;
/** How near a closing wall has to be before it counts as pressure. */
const WALL_ALARM_DISTANCE = 260;

/**
 * Turns the room into what one NPC can sense.
 *
 * This class is the honesty boundary of the whole NPC system. The server has
 * perfect information; everything downstream of here does not, because this is
 * the only place that reads the room and it deliberately throws most of it away:
 * an enemy behind a wall is not in the result, one out of sight range is not in
 * the result, and what is left carries the distances and angles a player could
 * work out for themselves.
 *
 * Runs at the configured perception rate rather than every tick -- eight times a
 * second is faster than a person reacts, and a raycast per enemy at 60Hz per bot
 * is exactly the kind of cost that stops a server hosting a dozen of them.
 */
export class Perception {
  constructor(private readonly context: RoomContext) {}

  build(
    self: PlayerState,
    runtime: PlayerRuntime,
    memory: Memory,
    profile: BrainProfile,
    now: number,
  ): BrainContext {
    const state = this.context.state;
    const playing = state.matchState === MatchState.PLAYING;
    const sightRange = this.context.config.getNpcConfig().sightRange;

    const selfContext = this.describeSelf(self, runtime);
    const visible = this.lookForEnemies(self, sightRange, now);

    // Anything seen is worth remembering; anything remembered but not seen is
    // worth acting on for a while longer.
    for (const enemy of visible) memory.see(enemy, now);
    const enemies = this.mergeMemories(self, visible, memory, profile, now);

    const grenades = this.senseGrenades(self, now);
    const traps = this.senseTraps(self);
    const items = this.senseItems(self, sightRange);

    const nearestEnemy = enemies[0] ?? null;
    const grenadeDanger = grenades.reduce((worst, grenade) => Math.max(worst, grenade.threat), 0);
    const trapDanger = traps.reduce((worst, trap) => Math.max(worst, trap.threat), 0);
    const wallDanger = this.senseWalls(self);

    // Enemies pointing at us are a threat in their own right, and the closer
    // they are the more of one.
    const aimedAt = enemies.reduce(
      (worst, enemy) =>
        Math.max(worst, enemy.visible ? enemy.facingUs * clamp01(1 - enemy.distance / sightRange) : 0),
      0,
    );

    return {
      now,
      self: selfContext,
      enemies,
      visibleEnemies: enemies.filter((enemy) => enemy.visible),
      nearestEnemy,
      items,
      nearestPowerUp: items.find((item) => item.kind === "powerup") ?? items[0] ?? null,
      nearestWeaponPickup: this.findWeaponPickup(items),
      grenades,
      traps,
      grenadeDanger,
      trapDanger,
      wallDanger,
      danger: clamp01(
        Math.max(grenadeDanger, trapDanger, wallDanger, aimedAt * 0.8) +
          // Being outnumbered is its own kind of danger.
          clamp01((enemies.filter((enemy) => enemy.visible).length - 1) * 0.15),
      ),
      weaponEffectiveness: this.rateWeapon(selfContext, nearestEnemy),
      enemyVulnerability: nearestEnemy ? clamp01(1 - nearestEnemy.health) : 0,
      playing,
      safeCentreX: (state.shrinkLeft + state.shrinkRight) / 2,
      explosionRadius: this.context.config.getGrenadeConfig().explosionRadius,
    };
  }

  // -------------------------------------------------------------------------
  // Self
  // -------------------------------------------------------------------------

  private describeSelf(self: PlayerState, runtime: PlayerRuntime): SelfContext {
    const weapon = this.context.config.getWeapon(self.weaponId);
    const maxHealth = this.context.config.getPlayerConfig().maxHealth;

    return {
      x: self.x,
      y: self.y,
      velocityX: runtime.movement.velocityX,
      velocityY: runtime.movement.velocityY,
      onGround: runtime.movement.onGround,
      jumpsRemaining: runtime.movement.jumpsRemaining,
      health: clamp01(self.health / Math.max(1, maxHealth)),
      // A weapon with no magazine is never short of ammunition, so it reports
      // full rather than empty -- otherwise a chainsaw would look desperate.
      ammo: usesAmmo(weapon) ? clamp01(self.ammo / Math.max(1, weapon.magazineSize)) : 1,
      reloading: self.reloading,
      grenades: self.grenades,
      weapon,
    };
  }

  // -------------------------------------------------------------------------
  // Enemies
  // -------------------------------------------------------------------------

  /**
   * Everyone in sight: alive, in the match, within range, and with nothing
   * solid in the way.
   */
  private lookForEnemies(self: PlayerState, sightRange: number, now: number): PerceivedEnemy[] {
    const maxHealth = this.context.config.getPlayerConfig().maxHealth;
    const seen: PerceivedEnemy[] = [];

    for (const other of this.context.state.players.values()) {
      if (other.sessionId === self.sessionId) continue;
      if (!other.alive || !other.inMatch) continue;

      const distance = distanceBetween(self.x, self.y, other.x, other.y);
      if (distance > sightRange) continue;
      if (!this.hasLineOfSight(self, other)) continue;

      const angle = Math.atan2(other.y - self.y, other.x - self.x);
      // How nearly their aim points back at us: 1 is dead on, 0 is away.
      const towardsUs = Math.atan2(self.y - other.y, self.x - other.x);
      const facingUs = clamp01(1 - Math.abs(angleDelta(other.aimAngle, towardsUs)) / Math.PI);

      seen.push({
        sessionId: other.sessionId,
        name: other.name,
        x: other.x,
        y: other.y,
        velocityX: other.velocityX,
        velocityY: other.velocityY,
        health: clamp01(other.health / Math.max(1, maxHealth)),
        weaponId: other.weaponId,
        distance,
        angle,
        visible: true,
        ageMs: 0,
        facingUs,
      });
    }

    void now;
    return seen;
  }

  /**
   * Can we see them?
   *
   * Three rays -- head, chest and knees -- rather than one. A single
   * centre-to-centre ray is brittle in a level built out of ledges: a crate at
   * shin height hides a player who is plainly visible, and bots stop being able
   * to find each other at all. Any one ray getting through counts as seeing,
   * which is both cheaper and closer to what a person can make out.
   *
   * Still cheap: this runs eight times a second per enemy, not per frame.
   */
  private hasLineOfSight(self: PlayerState, other: PlayerState): boolean {
    const offsets = [-PLAYER_HALF_HEIGHT * 0.7, 0, PLAYER_HALF_HEIGHT * 0.7];

    for (const offset of offsets) {
      if (this.rayReaches(self.x, self.y + offset, other.x, other.y + offset)) return true;
    }
    return false;
  }

  /** True when nothing solid stands between the two points. */
  private rayReaches(x0: number, y0: number, x1: number, y1: number): boolean {
    const hit = this.context.world.raycast(x0, y0, x1, y1);
    if (!hit) return true;

    const blocked = distanceBetween(x0, y0, hit.x, hit.y);
    return blocked >= distanceBetween(x0, y0, x1, y1) - 1;
  }

  /**
   * Fold memories of the unseen in among the seen.
   *
   * A remembered enemy is reported at their last known position, marked
   * invisible and aged -- so an action can decide for itself whether a
   * two-second-old sighting is worth walking to.
   */
  private mergeMemories(
    self: PlayerState,
    visible: PerceivedEnemy[],
    memory: Memory,
    profile: BrainProfile,
    now: number,
  ): PerceivedEnemy[] {
    const result = [...visible];
    const seenIds = new Set(visible.map((enemy) => enemy.sessionId));

    for (const entry of memory.recall(now, profile.memoryDurationMs)) {
      if (seenIds.has(entry.enemyId)) continue;

      // Someone who left the match is not worth remembering.
      const player = this.context.state.players.get(entry.enemyId);
      if (!player || !player.alive || !player.inMatch) {
        memory.forget(entry.enemyId);
        continue;
      }

      const distance = distanceBetween(self.x, self.y, entry.lastSeenX, entry.lastSeenY);
      result.push({
        sessionId: entry.enemyId,
        name: entry.name,
        x: entry.lastSeenX,
        y: entry.lastSeenY,
        velocityX: entry.lastSeenVelocityX,
        velocityY: entry.lastSeenVelocityY,
        health: entry.lastSeenHealth,
        weaponId: entry.lastSeenWeaponId,
        distance,
        angle: Math.atan2(entry.lastSeenY - self.y, entry.lastSeenX - self.x),
        visible: false,
        ageMs: now - entry.lastSeenAt,
        facingUs: 0,
      });
    }

    return result.sort((a, b) => a.distance - b.distance);
  }

  // -------------------------------------------------------------------------
  // The world
  // -------------------------------------------------------------------------

  /**
   * Grenades, and how alarming each one is.
   *
   * Threat rises as it gets closer and as the fuse runs down, because a grenade
   * that has just landed at your feet is a different problem from one that is
   * about to go off across the room.
   */
  private senseGrenades(self: PlayerState, now: number): PerceivedGrenade[] {
    const config = this.context.config.getGrenadeConfig();
    const grenades: PerceivedGrenade[] = [];

    for (const grenade of this.context.state.grenades.values()) {
      const distance = distanceBetween(self.x, self.y, grenade.x, grenade.y);
      if (distance > GRENADE_ALARM_RADIUS + config.explosionRadius) continue;

      const proximity = clamp01(1 - distance / Math.max(1, config.explosionRadius * 1.4));
      // Whole seconds is all the state carries, so treat anything at or below
      // one second as imminent.
      const urgency = clamp01(1 - (grenade.fuseSeconds - 1) / 3);

      grenades.push({
        id: grenade.id,
        ownerId: grenade.ownerId,
        x: grenade.x,
        y: grenade.y,
        distance,
        fuseSeconds: grenade.fuseSeconds,
        threat: clamp01(proximity * (0.5 + 0.5 * urgency)),
      });
    }

    void now;
    return grenades.sort((a, b) => b.threat - a.threat);
  }

  private senseTraps(self: PlayerState): PerceivedTrap[] {
    const traps: PerceivedTrap[] = [];

    for (const trap of this.context.state.traps.values()) {
      const centreX = trap.x + trap.width / 2;
      const centreY = trap.y + trap.height / 2;
      const distance = distanceBetween(self.x, self.y, centreX, centreY);
      if (distance > TRAP_ALARM_RADIUS + Math.max(trap.width, trap.height)) continue;

      // Arming counts as hot: the warning exists to be reacted to, and a bot
      // that only fled once it was already burning would waste it.
      const hot = trap.phase === TrapPhase.ACTIVE || trap.phase === TrapPhase.ARMING;
      // Seen from far off, felt only from near: the alarm radius decides what a
      // bot is aware of, and this decides how much of it is *fear*. Without the
      // split, widening the first would have bots cowering from scenery.
      const reach = TRAP_FEAR_RADIUS + Math.max(trap.width, trap.height);
      const proximity = clamp01(1 - distance / reach);

      traps.push({
        id: trap.id,
        x: trap.x,
        y: trap.y,
        width: trap.width,
        height: trap.height,
        distance,
        hot,
        threat: hot ? proximity : proximity * 0.2,
      });
    }

    return traps.sort((a, b) => b.threat - a.threat);
  }

  /** How hard the closing walls are pressing, 0 until they are actually near. */
  private senseWalls(self: PlayerState): number {
    const state = this.context.state;
    if (!state.shrinking) return 0;

    const room = Math.min(self.x - state.shrinkLeft, state.shrinkRight - self.x);
    return clamp01(1 - room / WALL_ALARM_DISTANCE);
  }

  /**
   * Crates and revealed power-ups within sight.
   *
   * A sealed crate reports no contents, because the server does not tell anyone
   * what is inside one -- a bot that knew would be cheating in exactly the way
   * the crate design exists to prevent.
   */
  private senseItems(self: PlayerState, sightRange: number): PerceivedItem[] {
    const items: PerceivedItem[] = [];

    for (const crate of this.context.state.crates.values()) {
      const distance = distanceBetween(self.x, self.y, crate.x, crate.y);
      if (distance > sightRange) continue;
      items.push({ id: crate.id, kind: "crate", powerUpId: null, x: crate.x, y: crate.y, distance });
    }

    for (const powerUp of this.context.state.powerUps.values()) {
      const distance = distanceBetween(self.x, self.y, powerUp.x, powerUp.y);
      if (distance > sightRange) continue;
      items.push({
        id: powerUp.id,
        kind: "powerup",
        powerUpId: powerUp.powerUpId,
        x: powerUp.x,
        y: powerUp.y,
        distance,
      });
    }

    return items.sort((a, b) => a.distance - b.distance);
  }

  /** The nearest revealed pickup that would actually change our weapon. */
  private findWeaponPickup(items: readonly PerceivedItem[]): PerceivedItem | null {
    for (const item of items) {
      if (!item.powerUpId) continue;
      const definition = this.context.config.getPowerUp(item.powerUpId);
      if (definition?.type === "weapon") return item;
    }
    return null;
  }

  /**
   * How well the weapon in our hands suits the fight in front of us.
   *
   * Derived from the weapon's own numbers rather than from its id, so a weapon
   * added through configuration is rated sensibly without a change here: a melee
   * weapon is only effective inside its reach, and a ranged one falls off with
   * its own falloff curve.
   */
  private rateWeapon(self: SelfContext, target: PerceivedEnemy | null): number {
    const weapon = self.weapon;
    if (!target) return self.ammo;

    if (isMelee(weapon)) {
      // Useless at range, decisive in contact.
      return clamp01(1 - (target.distance - weapon.range) / 260) * (self.health * 0.5 + 0.5);
    }

    if (target.distance > weapon.range) return 0;

    const falloff = weapon.ranged?.falloff;
    const reach = falloff
      ? clamp01(1 - (target.distance - falloff.startDistance) / Math.max(1, falloff.endDistance - falloff.startDistance)) *
          (1 - falloff.minMultiplier) +
        falloff.minMultiplier
      : 1;

    // No ammunition is the same as no weapon, whatever its statistics say.
    return clamp01(reach * (self.ammo > 0 ? 1 : 0.1));
  }
}
