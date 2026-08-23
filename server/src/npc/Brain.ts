import { clamp01, type BrainProfile } from "@deathmatch/shared";
import type { BrainContext } from "./context.js";
import type { NpcAgent } from "./NpcAgent.js";

/**
 * One thing an NPC might want to do.
 *
 * Adding a behaviour means writing one of these and registering it. The brain
 * does not know what any of them are: it scores whatever is registered and runs
 * the winner, so a new action needs no change to the brain, the profiles, or the
 * debug console -- which is the whole reason this is a registry rather than a
 * switch.
 */
export interface BrainAction {
  id: string;
  /** Human-readable, for the debug console. */
  label: string;
  /**
   * How much this NPC wants to do this, roughly 0..100.
   *
   * Build it from normalised terms and profile weights. Resist the temptation to
   * write `if (health < 0.2) return 100` -- the same behaviour expressed as a
   * score composes with everything else, and can be tuned by moving a number.
   */
  score(context: BrainContext, profile: BrainProfile, agent: NpcAgent): number;
  /** Called every brain tick while this action is the chosen one. */
  execute(agent: NpcAgent, context: BrainContext): void;
  onEnter?(agent: NpcAgent, context: BrainContext): void;
  onExit?(agent: NpcAgent): void;
}

/** One action's score at one moment, for the debug console. */
export interface ScoreEntry {
  id: string;
  label: string;
  score: number;
  /** True for the action actually chosen. */
  chosen: boolean;
}

export interface Decision {
  action: BrainAction;
  scores: ScoreEntry[];
  /** True when this tick changed the action. */
  switched: boolean;
  previousId: string | null;
}

/**
 * Utility scoring, with the two things that stop it looking insane.
 *
 * A pure "pick the highest score every tick" brain oscillates: two actions whose
 * scores cross back and forth produce attack/retreat/attack/retreat several
 * times a second, which reads as a malfunctioning robot rather than a hesitant
 * opponent. Two mechanisms fix it, both profile-driven:
 *
 *   - the action already running gets a bonus, and a challenger must beat it by
 *     a threshold before anything changes;
 *   - an action cannot be replaced at all until it has had a minimum time to
 *     show what it was going to do.
 *
 * A small random spread on every score does the opposite job: it keeps two bots
 * with the same profile in the same situation from moving in lockstep.
 */
export class Brain {
  private readonly actions = new Map<string, BrainAction>();

  private current: BrainAction | null = null;
  private currentSince = 0;
  private lastScores: ScoreEntry[] = [];

  constructor(private readonly random: () => number) {}

  /** Register an action. Later registrations replace an id, so behaviour can be swapped. */
  registerAction(action: BrainAction): void {
    this.actions.set(action.id, action);
  }

  list(): readonly BrainAction[] {
    return Array.from(this.actions.values());
  }

  get currentAction(): BrainAction | null {
    return this.current;
  }

  get scores(): readonly ScoreEntry[] {
    return this.lastScores;
  }

  /**
   * Drop the current action.
   *
   * Takes the agent so the action's own `onExit` can run: an action that put the
   * bot into a state -- mid-throw, say -- has to be given the chance to undo it,
   * and the alternative to passing the agent here was a cast that turned a
   * missing argument into a crash at the first death.
   */
  reset(agent: NpcAgent): void {
    this.current?.onExit?.(agent);
    this.current = null;
    this.currentSince = 0;
    this.lastScores = [];
  }

  /**
   * Score everything, decide, and report what happened.
   *
   * Does not execute anything -- the agent does that, so the brain stays a pure
   * decision function that a test can drive without a room.
   */
  decide(context: BrainContext, profile: BrainProfile, agent: NpcAgent, now: number): Decision {
    const noise = Math.max(0, profile.decisionNoise);
    const entries: { action: BrainAction; score: number }[] = [];

    for (const action of this.actions.values()) {
      let score = action.score(context, profile, agent);
      if (!Number.isFinite(score)) score = 0;

      // A little jitter, so identical bots in identical situations diverge.
      if (noise > 0) score += (this.random() * 2 - 1) * noise;

      // Commitment: what we are already doing counts for a bit more.
      if (this.current && action.id === this.current.id) score += profile.currentActionBonus;

      entries.push({ action, score });
    }

    entries.sort((a, b) => b.score - a.score);
    const best = entries[0];
    const previous = this.current;

    let chosen = previous;
    let switched = false;

    if (!best) {
      this.lastScores = [];
      return { action: previous as BrainAction, scores: [], switched: false, previousId: previous?.id ?? null };
    }

    if (!previous) {
      chosen = best.action;
      switched = true;
    } else if (best.action.id !== previous.id) {
      const settled = now - this.currentSince >= profile.minimumActionMs;
      const currentScore = entries.find((entry) => entry.action.id === previous.id)?.score ?? 0;
      // The bonus is already inside `currentScore`; the threshold is the extra
      // margin a challenger must clear on top of it.
      if (settled && best.score > currentScore + profile.actionSwitchThreshold) {
        chosen = best.action;
        switched = true;
      }
    }

    if (switched && chosen) {
      previous?.onExit?.(agent);
      this.current = chosen;
      this.currentSince = now;
      chosen.onEnter?.(agent, context);
    }

    this.lastScores = entries.map((entry) => ({
      id: entry.action.id,
      label: entry.action.label,
      score: entry.score,
      chosen: entry.action.id === this.current?.id,
    }));

    return {
      action: this.current!,
      scores: this.lastScores,
      switched,
      previousId: previous?.id ?? null,
    };
  }
}

/**
 * The personality, bent by the situation.
 *
 * A profile is who an NPC is; this is who they are *right now*. An aggressive
 * bot at 15% health should still be the most aggressive thing in the room, but
 * not as aggressive as it was at full health -- and expressing that here, once,
 * keeps every action's scoring free of "except when hurt" clauses.
 */
export function deriveEffectiveProfile(base: BrainProfile, context: BrainContext): BrainProfile {
  const health = context.self.health;
  const armed = context.weaponEffectiveness;
  const outnumbered = clamp01((context.visibleEnemies.length - 1) * 0.3);

  // Being hurt pulls aggression down and survival up, in proportion.
  const hurt = 1 - health;
  const aggression = clamp01(base.aggression * (1 - hurt * 0.55) + armed * 0.15);
  const survival = clamp01(base.survival * (1 + hurt * 0.6) + outnumbered * 0.2);

  return {
    ...base,
    aggression,
    survival,
    // A bad weapon makes going to fetch a better one more interesting, and being
    // hurt makes a medkit more interesting; both are the same appetite.
    powerupInterest: clamp01(base.powerupInterest * (1 + (1 - armed) * 0.5 + hurt * 0.6)),
  };
}
