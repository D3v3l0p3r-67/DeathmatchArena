import type { BrainProfile } from "@deathmatch/shared";
import type { BrainAction } from "../Brain.js";
import type { BrainContext } from "../context.js";
import type { NpcAgent } from "../NpcAgent.js";

const State = {
  CLEAR_BLAST: "CLEAR_BLAST",
  CLEAR_TRAP: "CLEAR_TRAP",
} as const;

/**
 * Get out of the way.
 *
 * The design calls these emergency actions, and the temptation is to special-case
 * them above the utility system. They are not special-cased: a grenade at your
 * feet simply produces a score no ordinary action can reach, which means it
 * still competes -- a Berserker with a kill one shot away will occasionally eat
 * the grenade, and that is a personality rather than a bug.
 */
export const dodgeAction: BrainAction = {
  id: "dodge",
  label: "Dodge",

  score(context: BrainContext, profile: BrainProfile): number {
    if (!context.playing) return 0;

    // The design's own formula, plus traps and the closing walls on the same terms.
    const blast = context.grenadeDanger * profile.dodgeSkill * 100;
    const trap = context.trapDanger * profile.dodgeSkill * 85;
    const walls = context.wallDanger * profile.survival * 90;

    return Math.max(blast, trap, walls);
  },

  execute(agent: NpcAgent, context: BrainContext): void {
    agent.holdFire();

    const grenade = context.grenades[0];
    const trap = context.traps.find((candidate) => candidate.hot);

    // Whichever is worse decides which way to run.
    const fromGrenade = grenade ? grenade.threat : 0;
    const fromTrap = trap ? trap.threat : 0;

    if (fromGrenade >= fromTrap && grenade) {
      agent.setState(State.CLEAR_BLAST);
      // Far enough to be outside the blast, not so far that it abandons the fight.
      const clearance = context.explosionRadius + 70;
      const away = Math.sign(context.self.x - grenade.x) || 1;
      agent.moveTo(context.self.x + away * clearance, context.self.y);
      return;
    }

    if (trap) {
      agent.setState(State.CLEAR_TRAP);
      const centre = trap.x + trap.width / 2;
      const away = Math.sign(context.self.x - centre) || 1;
      agent.moveTo(context.self.x + away * (trap.width + 140), context.self.y);
      return;
    }

    // Only the walls left: head for the middle of what is still playable.
    agent.setState(State.CLEAR_TRAP);
    agent.moveTo(context.safeCentreX, context.self.y);
  },
};
