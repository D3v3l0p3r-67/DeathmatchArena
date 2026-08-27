import { clamp01, type BrainProfile } from "@deathmatch/shared";
import type { BrainContext, PerceivedEnemy } from "./context.js";

export interface TargetScore {
  enemy: PerceivedEnemy;
  score: number;
  /** What each term contributed, for the debug console. */
  terms: Record<string, number>;
}

/**
 * Which enemy to care about.
 *
 * Kept apart from *what to do* on purpose. A brain that picked the nearest
 * enemy and then decided how to fight them would produce a lobby full of bots
 * all converging on whoever is in the middle; scoring targets separately is what
 * makes a Hunter peel off after the wounded one and a Coward pick the target it
 * can most easily get away from.
 *
 * Everything here is normalised, weighted by the profile, and summed -- the same
 * shape as the action scoring, for the same reason: it can be tuned by moving
 * numbers rather than by rewriting conditions.
 */
/** How a bot's own competence bears on which enemy it settles for. */
export interface TargetPickOptions {
  /** 0..1. How reliably it acts on its own ranking. */
  skill?: number;
  /** The bot's seeded generator, so the choice stays reproducible. */
  random?: () => number;
  /** Who it is currently fighting, if anybody. */
  currentId?: string | null;
}

export class TargetSelector {
  /** Score every known enemy, best first. */
  rank(context: BrainContext, profile: BrainProfile, sightRange: number): TargetScore[] {
    return context.enemies
      .map((enemy) => this.scoreTarget(enemy, context, profile, sightRange))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * The one worth fighting, or null when nothing is.
   *
   * `skill` is how reliably this bot acts on its own ranking. Below 1 it often
   * stays on whoever it was already shooting at even when something better has
   * appeared -- which is what poor target selection actually looks like in a
   * fight. Modelled as reluctance to switch rather than as a random pick,
   * because re-rolling a target eight times a second reads as a broken bot
   * rather than a bad one.
   */
  pick(
    context: BrainContext,
    profile: BrainProfile,
    sightRange: number,
    options: TargetPickOptions = {},
  ): PerceivedEnemy | null {
    const ranked = this.rank(context, profile, sightRange);
    const best = ranked[0];
    if (!best) return null;

    const { skill = 1, random = Math.random, currentId = null } = options;
    if (!currentId || best.enemy.sessionId === currentId) return best.enemy;

    // Whoever it was fighting is gone or forgotten: nothing to stay loyal to.
    const current = ranked.find((entry) => entry.enemy.sessionId === currentId);
    if (!current) return best.enemy;

    return random() < clamp01(skill) ? best.enemy : current.enemy;
  }

  private scoreTarget(
    enemy: PerceivedEnemy,
    context: BrainContext,
    profile: BrainProfile,
    sightRange: number,
  ): TargetScore {
    const closeness = clamp01(1 - enemy.distance / Math.max(1, sightRange));

    // A wounded enemy is worth more, and how much more is the whole difference
    // between a Hunter and a Berserker.
    const wounded = clamp01(1 - enemy.health) * profile.finishWeakEnemies;

    // Someone already pointing at us is a fight whether we choose it or not.
    const engaged = enemy.facingUs * (0.4 + 0.6 * closeness);

    // A memory decays as a target: the older the sighting, the less it is worth
    // committing to, scaled by how stubborn this personality is.
    const freshness = enemy.visible
      ? 1
      : clamp01(1 - enemy.ageMs / Math.max(1, profile.memoryDurationMs)) * profile.chasePersistence;

    // Reachability: something we can actually bring our weapon to bear on.
    const inWeaponRange = clamp01(1 - enemy.distance / Math.max(1, context.self.weapon.range));

    // In Flag Hunt a target is also a purse: killing a carrier spills half
    // their flags at your feet, and killing the leader is how you stop losing.
    // Game sense scales it, so a rookie bot still just fights whoever is near.
    const bounty = context.flagHunt
      ? (clamp01(enemy.flagCount / 5) + (enemy.isLeader ? 0.5 : 0)) * context.gameSense
      : 0;

    const terms = {
      closeness: closeness * 30,
      wounded: wounded * 35,
      engaged: engaged * 20,
      weaponReach: inWeaponRange * 15,
      bounty: bounty * 30,
      // Sticking with the current target is worth a little, so a bot does not
      // swap victims every time two enemies trade places.
      commitment: 0,
    };

    const score =
      (terms.closeness + terms.wounded + terms.engaged + terms.weaponReach + terms.bounty) *
      freshness;

    return { enemy, score, terms: { ...terms, freshness } };
  }
}
