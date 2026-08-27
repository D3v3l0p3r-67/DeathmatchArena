import { clamp01, type BrainProfile } from "@deathmatch/shared";
import type { BrainAction } from "../Brain.js";
import type { BrainContext } from "../context.js";
import type { NpcAgent } from "../NpcAgent.js";

/**
 * Which flag to go for.
 *
 * Nearest wins, with one exception: a dropped flag close enough to matter
 * beats a spawned one slightly further away, because dropped flags expire in
 * seconds while spawned ones sit for most of a minute -- the errand with the
 * deadline comes first.
 */
function pick(context: BrainContext): BrainContext["flags"][number] | null {
  const nearest = context.nearestFlag;
  if (!nearest) return null;
  if (nearest.dropped) return nearest;

  const droppedNearby = context.flags.find(
    (flag) => flag.dropped && flag.distance < nearest.distance * 1.6,
  );
  return droppedNearby ?? nearest;
}

const State = {
  MOVE_TO: "MOVE_TO",
  COLLECT: "COLLECT",
} as const;

/**
 * Go and take a flag.
 *
 * In Flag Hunt this is what winning *is* -- kills only matter for what they
 * spill -- so the score runs on game sense: a rookie bot treats a flag as one
 * more shiny thing and keeps brawling, a master drops a fight it does not
 * need for a flag it does. In sudden death the flag is the match, and the
 * score says so.
 */
export const getFlagAction: BrainAction = {
  id: "getFlag",
  label: "Get flag",

  score(context: BrainContext, profile: BrainProfile): number {
    if (!context.playing || !context.flagHunt) return 0;
    const flag = pick(context);
    if (!flag) return 0;

    // How much of the mode this bot actually plays.
    const sense = 0.35 + 0.65 * context.gameSense;

    const closeness = clamp01(1 - flag.distance / 1400);
    let score = sense * (40 + 45 * closeness);

    // A dropped flag is somebody's lost score on a short fuse.
    if (flag.dropped) score += sense * 20;

    // Behind on the leaderboard, the flag matters more than the fight.
    if (context.leaderFlagCount > context.self.flagCount) {
      score += sense * clamp01((context.leaderFlagCount - context.self.flagCount) / 4) * 20;
    }

    // Walking onto a flag through gunfire is how a carrier becomes a donor.
    score -= context.danger * profile.survival * 35;
    score -= context.visibleEnemies.length > 0 ? profile.aggression * 10 : 0;

    // Sudden death: the next flag ends the match. Nothing else compares.
    if (context.suddenDeath) score = 90 + 10 * closeness;

    return score;
  },

  execute(agent: NpcAgent, context: BrainContext): void {
    const flag = pick(context);
    if (!flag) {
      agent.stopMoving();
      agent.holdFire();
      return;
    }

    agent.moveTo(flag.x, flag.y);
    agent.setState(flag.distance < 60 ? State.COLLECT : State.MOVE_TO);
    agent.holdFire();
  },

  onExit(agent: NpcAgent): void {
    agent.holdFire();
  },
};
