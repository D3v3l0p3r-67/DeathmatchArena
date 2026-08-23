import { clamp01, type BrainProfile } from "@deathmatch/shared";
import type { BrainAction } from "../Brain.js";
import type { BrainContext } from "../context.js";
import type { NpcAgent } from "../NpcAgent.js";

const State = {
  MOVE_TO: "MOVE_TO",
  BREAK_CRATE: "BREAK_CRATE",
  COLLECT: "COLLECT",
} as const;

/**
 * Go and get something.
 *
 * Covers both a revealed pickup and a crate that has to be shot open first,
 * because from the bot's point of view they are the same errand with an extra
 * step -- and it does not know what is in the crate, so it cannot cherry-pick.
 */
export const getPowerUpAction: BrainAction = {
  id: "getPowerUp",
  label: "Get power-up",

  score(context: BrainContext, profile: BrainProfile): number {
    const item = context.items[0];
    if (!item || !context.playing) return 0;

    // Closer is better, and interest is a personality trait.
    const closeness = clamp01(1 - item.distance / 900);
    let score = profile.powerupInterest * 45 * closeness;

    // Being hurt makes anything that might be a medkit far more interesting --
    // and the bot genuinely does not know whether it is one.
    score += (1 - context.self.health) * profile.powerupInterest * 35 * closeness;

    // Fetching things while being shot at is how bots die pointlessly.
    score -= context.danger * profile.survival * 40;
    score -= context.visibleEnemies.length > 0 ? profile.aggression * 15 : 0;

    return score;
  },

  execute(agent: NpcAgent, context: BrainContext): void {
    const item = context.items[0];
    if (!item) {
      agent.stopMoving();
      agent.holdFire();
      return;
    }

    agent.moveTo(item.x, item.y);

    if (item.kind === "crate") {
      // Shoot it open on the way in. The weapon system decides whether the shot
      // actually lands; the bot only points and pulls.
      agent.setState(item.distance < 500 ? State.BREAK_CRATE : State.MOVE_TO);
      agent.lookAt(item.x, item.y);
      return;
    }

    agent.setState(item.distance < 60 ? State.COLLECT : State.MOVE_TO);
    agent.holdFire();
  },

  onExit(agent: NpcAgent): void {
    agent.holdFire();
  },
};
