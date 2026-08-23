import type { BrainProfile } from "@deathmatch/shared";
import type { BrainAction } from "../Brain.js";
import type { BrainContext } from "../context.js";
import type { NpcAgent } from "../NpcAgent.js";

const State = {
  BREAK_OFF: "BREAK_OFF",
  COVER: "COVER",
} as const;

/** How far to run before reassessing. */
const RETREAT_DISTANCE = 420;

/**
 * Get out of a fight that is going badly.
 *
 * The design's own example: low health times danger times how much this
 * personality values its own life. Written that way deliberately -- a `if
 * (health < 20) retreat()` rule cannot express a Berserker who ignores it or a
 * Coward who leaves early, and both fall out of the same expression here.
 */
export const retreatAction: BrainAction = {
  id: "retreat",
  label: "Retreat",

  score(context: BrainContext, profile: BrainProfile): number {
    if (!context.playing) return 0;

    const lowHealth = 1 - context.self.health;
    let score = lowHealth * context.danger * profile.survival * 100;

    // Being out of ammunition in front of somebody is its own reason to leave.
    if (context.visibleEnemies.length > 0 && context.self.ammo <= 0) {
      score += profile.survival * 30;
    }

    // Nothing to run from.
    if (context.visibleEnemies.length === 0 && context.grenadeDanger < 0.2) score *= 0.3;

    // Reluctance to give up a fight we are winning.
    score -= context.enemyVulnerability * profile.aggression * 20;

    return score;
  },

  execute(agent: NpcAgent, context: BrainContext): void {
    const threat = context.visibleEnemies[0] ?? agent.target;

    if (!threat) {
      // No visible threat: put distance between us and the trouble anyway, then
      // let something else win the next decision.
      agent.setState(State.COVER);
      agent.stopMoving();
      agent.holdFire();
      return;
    }

    agent.setState(State.BREAK_OFF);

    const away = Math.sign(context.self.x - threat.x) || 1;
    agent.moveTo(context.self.x + away * RETREAT_DISTANCE, context.self.y);

    // Fire while withdrawing if the weapon still reaches; a retreat is not a rout.
    if (threat.visible && context.weaponEffectiveness > 0.35) agent.engage(threat);
    else agent.trackTarget(threat);
  },

  onExit(agent: NpcAgent): void {
    agent.holdFire();
  },
};
