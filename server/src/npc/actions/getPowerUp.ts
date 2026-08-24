import { clamp01, getCrateConfig, type BrainProfile } from "@deathmatch/shared";
import type { BrainAction } from "../Brain.js";
import type { BrainContext } from "../context.js";
import type { NpcAgent } from "../NpcAgent.js";

/**
 * What to go for: something already on the ground, before a sealed crate.
 *
 * A revealed power-up is a known thing you walk onto; a crate is a guess behind
 * sixty points of armour. Taking whichever was *nearest* meant a bot would
 * shoot a crate open and then walk off to the next crate, leaving what it had
 * just won lying there -- which it did almost every time.
 */
function pick(context: BrainContext): BrainContext["items"][number] | undefined {
  return context.nearestPowerUp ?? context.items[0];
}

/** Close enough that shooting a crate is worth the ammunition. */
const BREAK_RANGE = 420;

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
    const item = pick(context);
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

    /*
     * And with nobody to fight, fetching is the best thing there is to do.
     *
     * Without this the score was a fraction of what wandering the arena
     * scores, so bots walked *past* crates for whole matches: they never
     * carried anything but the weapon they spawned with, and never healed. A
     * quiet moment is exactly when a person goes and opens the box.
     */
    if (context.visibleEnemies.length === 0 && context.danger < 0.3) {
      score += 55 * clamp01(1 - item.distance / 1400);
    }

    return score;
  },

  execute(agent: NpcAgent, context: BrainContext): void {
    const item = pick(context);
    if (!item) {
      agent.stopMoving();
      agent.holdFire();
      return;
    }

    agent.moveTo(item.x, item.y);

    if (item.kind === "crate") {
      // Shoot it open on the way in. The weapon system decides whether the shot
      // actually lands; the bot only points and pulls -- and for a long time it
      // only pointed, which is why bots never got a better weapon or a medkit
      // out of one in their lives.
      // In range *and* actually shootable: a crate on a platform above you is
      // not opened by firing into the platform, however long you hold it.
      const canBreak = item.distance < BREAK_RANGE && agent.canShootAt(item.x, item.y);
      agent.setState(canBreak ? State.BREAK_CRATE : State.MOVE_TO);
      // Half a crate, near enough: the shot only has to land somewhere on it.
      if (canBreak) agent.shootAt(item.x, item.y, getCrateConfig().width * 0.4);
      else agent.holdFire();
      return;
    }

    agent.setState(item.distance < 60 ? State.COLLECT : State.MOVE_TO);
    agent.holdFire();
  },

  onExit(agent: NpcAgent): void {
    agent.holdFire();
  },
};
