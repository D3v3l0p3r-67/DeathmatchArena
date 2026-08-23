import { clamp01, isMelee, type BrainProfile } from "@deathmatch/shared";
import type { BrainAction } from "../Brain.js";
import type { BrainContext, PerceivedEnemy } from "../context.js";
import type { NpcAgent } from "../NpcAgent.js";

/**
 * Fight whoever the target selector settled on.
 *
 * The state machine the design asks for, and each state is one line of intent:
 * get to a useful range, hold the aim, shoot, and keep moving so a stationary
 * bot is never free damage.
 */
const State = {
  APPROACH: "APPROACH",
  AIM: "AIM",
  SHOOT: "SHOOT",
  REPOSITION: "REPOSITION",
} as const;

/** How far outside the preferred range still counts as close enough. */
const RANGE_TOLERANCE = 70;

export const attackAction: BrainAction = {
  id: "attack",
  label: "Attack",

  /**
   * Wanting to fight is aggression plus opportunity minus risk.
   *
   * A sum of weighted, normalised terms rather than a chain of conditions: it
   * can be tuned by moving a weight, and it composes with every other action's
   * score instead of pre-empting them.
   */
  score(context: BrainContext, profile: BrainProfile, agent: NpcAgent): number {
    const target = agent.target;
    // Something we cannot currently see is a chase, not an attack. So is
    // something we can see but cannot shoot: standing still trading nothing
    // through a wall is the one thing an attack must never become.
    if (!target || !target.visible || !target.shootable || !context.playing) return 0;

    let score = profile.aggression * 40;
    score += clamp01(1 - target.health) * profile.finishWeakEnemies * 30;
    score += context.weaponEffectiveness * 25;

    // Already being in the right place for the weapon we hold is worth something.
    const rangeError = Math.abs(target.distance - preferredRange(profile, context));
    score += clamp01(1 - rangeError / 500) * 10;

    score -= context.danger * profile.survival * 30;
    // No reach and no ammunition is not an attack, whatever the personality says.
    score -= (1 - context.weaponEffectiveness) * 20;

    return score;
  },

  execute(agent: NpcAgent, context: BrainContext): void {
    const target = agent.target;
    if (!target) {
      agent.setState(State.APPROACH);
      agent.holdFire();
      return;
    }

    agent.engage(target);

    const preferred = preferredRange(agent.effectiveProfile, context);
    const error = target.distance - preferred;

    if (error > RANGE_TOLERANCE) {
      agent.setState(State.APPROACH);
      agent.moveTo(target.x, target.y);
      return;
    }

    if (error < -RANGE_TOLERANCE) {
      // Too close for this weapon: back off rather than stand inside it.
      agent.setState(State.REPOSITION);
      const away = Math.sign(context.self.x - target.x) || 1;
      agent.moveTo(context.self.x + away * 180, context.self.y);
      return;
    }

    agent.setState(context.self.onGround ? State.SHOOT : State.AIM);
    strafe(agent, context, target);
  },

  onExit(agent: NpcAgent): void {
    agent.holdFire();
  },
};

/**
 * The range this bot wants to fight at, with this weapon.
 *
 * The profile says where the personality likes to be; the weapon has the final
 * say, because a chainsaw personality that prefers to keep its distance would
 * simply never hit anything. Read from the weapon's own numbers, so a weapon
 * added through configuration is handled without naming it.
 */
export function preferredRange(profile: BrainProfile, context: BrainContext): number {
  const weapon = context.self.weapon;
  if (isMelee(weapon)) return Math.min(profile.preferredDistance, weapon.range * 0.55);
  return Math.min(profile.preferredDistance, weapon.range * 0.75);
}

/**
 * Sidestep within the effective range.
 *
 * Reads as a bot aware it is being shot at, and costs nothing: it is one more
 * movement goal, a little to the side of where it already is.
 */
function strafe(agent: NpcAgent, context: BrainContext, target: PerceivedEnemy): void {
  const side = context.self.x < target.x ? -1 : 1;
  agent.moveTo(context.self.x + side * 90, context.self.y);
}
