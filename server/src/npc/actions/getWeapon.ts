import { clamp01, type BrainProfile } from "@deathmatch/shared";
import type { BrainAction } from "../Brain.js";
import type { BrainContext } from "../context.js";
import type { NpcAgent } from "../NpcAgent.js";

const State = {
  MOVE_TO: "MOVE_TO",
  COLLECT: "COLLECT",
} as const;

/**
 * Go and get a better weapon.
 *
 * Separate from fetching a power-up because the reason is different: this one
 * is driven by how badly the weapon in hand is serving the fight in front of us,
 * not by appetite. A bot holding a shotgun in a long corridor should want a
 * rifle more than it wants a medkit.
 */
export const getWeaponAction: BrainAction = {
  id: "getWeapon",
  label: "Get weapon",

  score(context: BrainContext, profile: BrainProfile): number {
    const pickup = context.nearestWeaponPickup;
    if (!pickup || !context.playing) return 0;

    const closeness = clamp01(1 - pickup.distance / 900);
    // The worse the current weapon suits us, the more this matters.
    const need = 1 - context.weaponEffectiveness;

    let score = need * 45 * closeness;
    score += profile.powerupInterest * 15 * closeness;
    score -= context.danger * profile.survival * 35;

    // Nothing to fight is the moment to go and get a better gun, for the same
    // reason a person would: it is free now and it will not be later.
    if (context.visibleEnemies.length === 0 && context.danger < 0.3) {
      score += 45 * clamp01(1 - pickup.distance / 1400);
    }

    return score;
  },

  execute(agent: NpcAgent, context: BrainContext): void {
    const pickup = context.nearestWeaponPickup;
    if (!pickup) {
      agent.stopMoving();
      return;
    }

    agent.setState(pickup.distance < 60 ? State.COLLECT : State.MOVE_TO);
    agent.moveTo(pickup.x, pickup.y);
    agent.holdFire();
  },
};
