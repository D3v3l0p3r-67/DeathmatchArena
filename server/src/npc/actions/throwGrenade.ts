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
/** Beyond this a throw is a wish rather than a plan, in px. */
const MAX_THROW_DISTANCE = 900;
/** A sighting older than this is not worth a grenade, in ms. */
const STALE_MEMORY_MS = 1800;
/** Vertical separation at which a flat shot starts to be the wrong tool, in px. */
const LEVEL_SEPARATION = 90;

/** How many other enemies are close enough to the target to share the blast. */
function clustered(context: BrainContext, target: { sessionId: string; x: number; y: number }): number {
  let count = 0;
  for (const enemy of context.visibleEnemies) {
    if (enemy.sessionId === target.sessionId) continue;
    if (Math.hypot(enemy.x - target.x, enemy.y - target.y) <= context.explosionRadius) count++;
  }
  return count;
}

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
    if (target.distance > MAX_THROW_DISTANCE) return 0;

    // A sighting this old is a guess, and a grenade is too expensive to spend on
    // one. Fresh but out of sight, on the other hand, is the best reason there
    // is to throw: it is the one shot that goes where a bullet cannot.
    const freshness = clamp01(1 - target.ageMs / STALE_MEMORY_MS);
    if (!target.visible && freshness <= 0) return 0;

    // And the throw has to get away. Distance to the target says nothing about
    // the ledge overhead or the crate at knee height, and a grenade that hits
    // one of those comes straight back down on the thrower -- which is where
    // nearly all the damage bots did to themselves used to come from.
    const lead = 0.35;
    if (!agent.canLobAt(target.x + target.velocityX * lead, target.y + target.velocityY * lead)) {
      return 0;
    }

    let score = profile.grenadeUsage * 55;

    // What a grenade is actually *for*. Three situations, each of them something
    // the rifle in its hands cannot do:
    //   - they are behind something,
    if (!target.visible) score += 34 * freshness;
    //   - they are on another level, where a flat shot never reaches,
    const drop = Math.abs(target.y - context.self.y);
    if (drop > LEVEL_SEPARATION) score += clamp01(drop / 320) * 22;
    //   - or there are several of them standing together.
    score += Math.min(clustered(context, target), 3) * 22;

    score += clamp01(1 - target.health) * profile.finishWeakEnemies * 15;

    // Grenades are also for when shooting is not working: a bot with a good
    // angle and a good weapon should just shoot.
    score += (1 - context.weaponEffectiveness) * 25;

    // The last one is worth keeping for a moment that deserves it.
    if (context.self.grenades <= 1) score *= 0.75;

    score -= context.danger * profile.survival * 20;
    return score;
  },

  execute(agent: NpcAgent, _context: BrainContext): void {
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
