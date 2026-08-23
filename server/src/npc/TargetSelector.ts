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
export class TargetSelector {
  /** Score every known enemy, best first. */
  rank(context: BrainContext, profile: BrainProfile, sightRange: number): TargetScore[] {
    return context.enemies
      .map((enemy) => this.scoreTarget(enemy, context, profile, sightRange))
      .sort((a, b) => b.score - a.score);
  }

  /** The one worth fighting, or null when nothing is. */
  pick(context: BrainContext, profile: BrainProfile, sightRange: number): PerceivedEnemy | null {
    return this.rank(context, profile, sightRange)[0]?.enemy ?? null;
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

    const terms = {
      closeness: closeness * 30,
      wounded: wounded * 35,
      engaged: engaged * 20,
      weaponReach: inWeaponRange * 15,
      // Sticking with the current target is worth a little, so a bot does not
      // swap victims every time two enemies trade places.
      commitment: 0,
    };

    const score = (terms.closeness + terms.wounded + terms.engaged + terms.weaponReach) * freshness;

    return { enemy, score, terms: { ...terms, freshness } };
  }
}
