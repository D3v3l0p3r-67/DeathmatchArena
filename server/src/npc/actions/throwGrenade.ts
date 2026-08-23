import { clamp01, type BrainProfile } from "@deathmatch/shared";
import type { BrainAction } from "../Brain.js";
import type { BrainContext } from "../context.js";
import type { NpcAgent } from "../NpcAgent.js";

const State = {
  SELECT_TARGET: "SELECT_TARGET",
  AIM: "AIM",
  THROW: "THROW",
  MOVE_AWAY: "MOVE_AWAY",
} as const;

/** Too close and the blast catches the thrower; the bot knows this. */
const SELF_BLAST_MARGIN = 40;

/**
 * Lob one.
 *
 * The bot has to decide it wants to throw *before* the combat controller works
 * out how hard -- charge time comes from the distance and the configured power
 * curve, and the server measures the hold. So this action's job is choosing the
 * moment and then standing still long enough to finish the wind-up.
 */
export const throwGrenadeAction: BrainAction = {
  id: "throwGrenade",
  label: "Throw grenade",

  score(context: BrainContext, profile: BrainProfile, agent: NpcAgent): number {
    if (!context.playing || context.self.grenades <= 0) return 0;

    const target = agent.target;
    if (!target) return 0;

    // Close enough to hit, far enough not to be caught by it. The radius comes
    // from the configuration, so retuning the blast moves the bots' judgement
    // with it rather than leaving them standing in their own explosions.
    if (target.distance < context.explosionRadius + SELF_BLAST_MARGIN) return 0;
    if (target.distance > 900) return 0;

    let score = profile.grenadeUsage * 45;
    score += clamp01(1 - target.health) * profile.finishWeakEnemies * 15;

    // Grenades are for when shooting is not working: a bot with a good angle and
    // a good weapon should just shoot.
    score += (1 - context.weaponEffectiveness) * 25;

    // Throwing at a memory is a waste of a grenade.
    if (!target.visible) score *= 0.35;

    score -= context.danger * profile.survival * 20;
    return score;
  },

  execute(agent: NpcAgent, context: BrainContext): void {
    const target = agent.target;
    if (!target) {
      agent.setState(State.SELECT_TARGET);
      agent.holdFire();
      return;
    }

    // Lead the throw by where they are going: a grenade is slow enough that it
    // matters, and the flight time is roughly the distance over the throw speed.
    const lead = 0.35;
    const aimX = target.x + target.velocityX * lead;
    const aimY = target.y + target.velocityY * lead;

    agent.setState(agent.combat.isThrowing ? State.THROW : State.AIM);
    agent.throwAt(aimX, aimY);

    // Stand still while winding up. A throw released mid-sprint goes wherever
    // the bot happened to be pointing.
    agent.stopMoving();

    if (!agent.combat.isThrowing) {
      agent.setState(State.MOVE_AWAY);
    }
  },

  onExit(agent: NpcAgent): void {
    agent.holdFire();
  },
};
