import { clamp01, type BrainProfile } from "@deathmatch/shared";
import type { BrainAction } from "../Brain.js";
import type { BrainContext } from "../context.js";
import type { NpcAgent } from "../NpcAgent.js";

const State = {
  PURSUE: "PURSUE",
  LAST_SEEN: "LAST_SEEN",
} as const;

/**
 * Close the distance on someone we know about but cannot shoot yet.
 *
 * Covers both halves of "I know where you went": an enemy in sight but out of
 * useful range, and one who has just broken line of sight. The second is what
 * memory exists for, and it decays -- a bot walks to where you disappeared,
 * looks for a moment, and eventually gives up.
 */
export const chaseAction: BrainAction = {
  id: "chase",
  label: "Chase",

  score(context: BrainContext, profile: BrainProfile, agent: NpcAgent): number {
    const target = agent.target;
    if (!target || !context.playing) return 0;

    let score = profile.aggression * 25 + profile.chasePersistence * 25;
    score += clamp01(1 - target.health) * profile.finishWeakEnemies * 20;

    // Chasing is for when we are not already in a position to shoot: the closer
    // and clearer the shot, the more attacking should win instead.
    if (target.visible) score -= context.weaponEffectiveness * 35;

    // A stale memory is worth less and less, in proportion to how stubborn we are.
    if (!target.visible) {
      score *= clamp01(1 - target.ageMs / Math.max(1, profile.memoryDurationMs));
    }

    score -= context.danger * profile.survival * 25;
    return score;
  },

  execute(agent: NpcAgent, _context: BrainContext): void {
    const target = agent.target;
    if (!target) {
      agent.stopMoving();
      return;
    }

    agent.moveTo(target.x, target.y);

    if (target.visible) {
      agent.setState(State.PURSUE);
      // Keep the gun on them on the way in, so arriving is not also aiming.
      agent.trackTarget(target);
      return;
    }

    // Out of sight: walk to where they were, watching the spot.
    agent.setState(State.LAST_SEEN);
    agent.lookAt(target.x, target.y);
  },

  onExit(agent: NpcAgent): void {
    agent.holdFire();
  },
};
