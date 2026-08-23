import { clamp01, type BrainProfile } from "@deathmatch/shared";
import type { BrainAction } from "../Brain.js";
import type { BrainContext } from "../context.js";
import type { NpcAgent } from "../NpcAgent.js";

const State = {
  SWEEP: "SWEEP",
  INVESTIGATE: "INVESTIGATE",
} as const;

/**
 * Go and find somebody.
 *
 * The fallback that keeps an arena from filling up with bots standing still. It
 * has two modes: walk to the last place anyone was seen, or -- with nothing
 * remembered at all -- wander, which is the only place in the system where a bot
 * does something for no reason other than that doing nothing is worse.
 */
export const searchEnemyAction: BrainAction = {
  id: "searchEnemy",
  label: "Search",

  score(context: BrainContext, profile: BrainProfile): number {
    if (!context.playing) return 0;

    // Only interesting when there is nobody to see.
    if (context.visibleEnemies.length > 0) return 0;

    let score = 18 + profile.aggression * 18;

    // A remembered enemy is a lead worth following.
    const remembered = context.enemies[0];
    if (remembered) {
      score += clamp01(1 - remembered.ageMs / Math.max(1, profile.memoryDurationMs)) * 20;
    }

    score -= context.danger * profile.survival * 25;
    return score;
  },

  execute(agent: NpcAgent, context: BrainContext): void {
    agent.holdFire();

    const lead = context.enemies[0];
    if (lead) {
      agent.setState(State.INVESTIGATE);
      agent.moveTo(lead.x, lead.y);
      agent.lookAt(lead.x, lead.y);
      return;
    }

    agent.setState(State.SWEEP);

    // Somewhere else in the arena, chosen from the navigation graph. Walking a
    // fixed distance left or right instead keeps a bot in the corner it spawned
    // in -- and an arena of bots that never leave their corners never fights.
    // Re-picked only on arrival or when the goal was abandoned as unreachable.
    // Re-picking whenever progress stalls sounds sensible and is not: the
    // movement controller stalls briefly every time it backs up for a jump, and
    // a bot that chooses a new destination each time never goes anywhere.
    const goal = agent.movement.goal;
    const arrived = goal && Math.hypot(goal.x - context.self.x, goal.y - context.self.y) < 120;

    if (!goal || arrived) {
      const destination = agent.movement.wanderTarget(
        agent.random,
        context.self.x,
        context.self.y,
        context.now,
      );
      if (destination) agent.moveTo(destination.x, destination.y);
    }
  },
};
