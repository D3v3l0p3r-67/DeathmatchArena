import { clamp01, type BrainProfile } from "@deathmatch/shared";
import type { BrainAction } from "../Brain.js";
import type { BrainContext } from "../context.js";
import type { NpcAgent } from "../NpcAgent.js";

const State = {
  MOVE_TO: "MOVE_TO",
  HOLD: "HOLD",
} as const;

/**
 * Find somewhere better to be, and wait there.
 *
 * The action that gives a Camper a personality and everyone else somewhere to go
 * when there is nothing else worth doing. It scores low by design: it should win
 * when the alternatives are all bad, not instead of them.
 */
export const takePositionAction: BrainAction = {
  id: "takePosition",
  label: "Take position",

  score(context: BrainContext, profile: BrainProfile): number {
    if (!context.playing) return 0;

    // Holding a position only means anything if there is something to hold it
    // against. Without this a bot with nobody in mind stands in a corner for the
    // whole match, which reads as broken rather than as patient.
    if (context.enemies.length === 0) return 0;

    // Wanting to hold a spot is the opposite of wanting to charge.
    let score = (1 - profile.aggression) * 22 + profile.survival * 12;

    // Reloading somewhere quiet is better than reloading in the open.
    if (context.self.ammo < 0.3) score += 12;

    // Somebody is shooting at us: this is not the moment to admire the view.
    score -= context.danger * 40;
    score -= context.visibleEnemies.length * profile.aggression * 15;

    return score * clamp01(0.4 + profile.survival);
  },

  execute(agent: NpcAgent, context: BrainContext): void {
    agent.holdFire();

    const threat = context.enemies[0];
    if (!threat) {
      agent.setState(State.HOLD);
      agent.stopMoving();
      return;
    }

    agent.lookAt(threat.x, threat.y);

    // Already at a comfortable distance: stand and watch. Asking for a spot
    // above the current one instead was a reliable way to pick a goal with no
    // route to it, and a bot that keeps choosing unreachable goals paces.
    const room = Math.abs(context.self.x - threat.x);
    if (room >= agent.effectiveProfile.preferredDistance) {
      agent.setState(State.HOLD);
      agent.stopMoving();
      return;
    }

    agent.setState(State.MOVE_TO);
    const away = Math.sign(context.self.x - threat.x) || 1;
    agent.moveTo(context.self.x + away * 220, context.self.y);
  },
};
