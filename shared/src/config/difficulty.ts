/**
 * Bot difficulty.
 *
 * The rule this file exists to enforce: **personality and skill are separate
 * things**. A brain profile says what a bot *wants* -- how aggressive it is,
 * what range it likes, how interested it is in power-ups. A difficulty level
 * says how well it manages to do any of it. Multiplying one by the other is what
 * lets twelve personalities and five skill levels cover sixty kinds of opponent
 * without a single extra profile being written.
 *
 * Skill is one half of it. The other is how hard a bot is to kill and how hard
 * it hits: an easier bot takes more damage from every hit and lands less with
 * its own (`scaleBotDamage`). Those two are kept apart from the skill
 * multipliers on purpose -- one describes how well a bot plays, the other how
 * much its mistakes cost -- and neither touches the weapon catalogue, because a
 * rifle has to mean one thing whoever is holding it.
 *
 * A level-1 bot, then, is not a different fighter with a different gun: it is a
 * worse player -- slower to react, wilder with its aim, poorer at reading
 * movement -- who is also softer and hits lighter. A level-5 bot plays the
 * profile as written and trades a weapon's full damage in both directions,
 * while still aiming through the same imperfect-aim machinery as every other
 * level: very good, never perfect.
 */
import type { BotDifficultyLevel, BrainProfile, NpcConfig } from "./types.js";

/** The lowest and highest rung a player may pick. */
export const MIN_BOT_DIFFICULTY = 1;
export const MAX_BOT_DIFFICULTY = 5;

/**
 * The level with this number, or the closest thing to it.
 *
 * Never returns null, for the same reason `getWeapon` does not: a configuration
 * missing a rung should still give a bot a difficulty rather than stop it from
 * playing.
 */
export function getBotDifficulty(config: NpcConfig, level: number): BotDifficultyLevel {
  const wanted = clampDifficulty(level, config);
  const exact = config.difficulties.find((entry) => entry.level === wanted);
  if (exact) return exact;

  // Nearest rung by number, so a gap in the ladder degrades rather than breaks.
  let nearest: BotDifficultyLevel | null = null;
  for (const entry of config.difficulties) {
    if (!nearest || Math.abs(entry.level - wanted) < Math.abs(nearest.level - wanted)) {
      nearest = entry;
    }
  }
  return nearest ?? NEUTRAL_DIFFICULTY;
}

/** Round and clamp a requested level to one the ladder can serve. */
export function clampDifficulty(level: number, config?: NpcConfig): number {
  const levels = config?.difficulties.map((entry) => entry.level) ?? [];
  const min = levels.length > 0 ? Math.min(...levels) : MIN_BOT_DIFFICULTY;
  const max = levels.length > 0 ? Math.max(...levels) : MAX_BOT_DIFFICULTY;
  if (!Number.isFinite(level)) return Math.min(max, Math.max(min, MIN_BOT_DIFFICULTY + 2));
  return Math.min(max, Math.max(min, Math.round(level)));
}

/**
 * How many bots a lobby may be asked for.
 *
 * One place is always a person's: a lobby of bots playing among themselves is a
 * server burning a tick on a fight nobody is in.
 */
export function clampBotCount(count: number, config: NpcConfig, maxPlayers: number): number {
  if (!Number.isFinite(count)) return 0;
  const ceiling = Math.max(0, Math.min(config.maxBots, Math.max(0, maxPlayers - 1)));
  return Math.min(ceiling, Math.max(0, Math.round(count)));
}

/**
 * Bend a personality to a skill level.
 *
 * Everything scaled here is something a *player* varies in: how fast you react,
 * how steady your aim is, how well you lead a moving target, how reliably you
 * get out of the way, how consistent your decisions are and how often you
 * reconsider them. The wants -- aggression, survival, preferred distance,
 * appetite for grenades and power-ups -- are left exactly as the profile wrote
 * them, because those are who the bot is, not how good it is.
 */
export function applyBotDifficulty(
  profile: BrainProfile,
  difficulty: BotDifficultyLevel,
): BrainProfile {
  return {
    ...profile,
    aimSkill: clamp01(profile.aimSkill * difficulty.aimSkillMultiplier),
    predictionSkill: clamp01(profile.predictionSkill * difficulty.predictionSkillMultiplier),
    dodgeSkill: clamp01(profile.dodgeSkill * difficulty.dodgeSkillMultiplier),
    reactionTimeMs: Math.max(0, profile.reactionTimeMs * difficulty.reactionTimeMultiplier),
    decisionNoise: Math.max(0, profile.decisionNoise * difficulty.decisionNoiseMultiplier),
  };
}


/**
 * How much damage actually lands, once the difficulty of whoever is involved is
 * taken into account.
 *
 * Both sides can apply at once, and that is deliberate: a level-1 bot shooting a
 * level-5 bot deals its 60% into a target that takes 100%, while the same shot
 * the other way is a full-strength hit into somebody who takes 150% of it. Each
 * multiplier is read from the bot it belongs to, never from its target, so a
 * difficulty always describes the bot wearing it.
 *
 * Two cases are not what they look like:
 *
 *   - **The arena hurting somebody** -- a trap, the closing walls -- has no
 *     attacker, and takes the environmental multiplier, which is 1 by default.
 *     Those are the deaths a bot is supposed to avoid by playing better.
 *   - **A bot blowing itself up** is one bot, appearing on both sides of the
 *     same hit. It takes the damage it took, not the damage it dealt: applying
 *     both would multiply a mistake by itself for no reason anyone could read
 *     off the settings.
 *
 * A human is never scaled in either direction, whoever they are fighting.
 */
export function scaleBotDamage(
  amount: number,
  attacker: BotDifficultyLevel | null,
  victim: BotDifficultyLevel | null,
  environmental = false,
): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  if (environmental) {
    return victim ? amount * multiplier(victim.environmentalDamageTakenMultiplier) : amount;
  }

  let scaled = amount;
  // Self-inflicted: the same bot on both sides, counted once, as taken damage.
  if (attacker && attacker !== victim) scaled *= multiplier(attacker.damageDealtMultiplier);
  if (victim) scaled *= multiplier(victim.damageTakenMultiplier);
  return scaled;
}

/** A multiplier the configuration cannot make nonsensical. */
function multiplier(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 1;
  return Math.min(value, MAX_DAMAGE_MULTIPLIER);
}

/** Ten times a weapon's damage is already absurd; beyond it is a typo. */
export const MAX_DAMAGE_MULTIPLIER = 10;

/** Used when a configuration has no ladder at all: changes nothing. */
const NEUTRAL_DIFFICULTY: BotDifficultyLevel = {
  level: 3,
  name: "Normal",
  reactionTimeMultiplier: 1,
  aimSkillMultiplier: 1,
  predictionSkillMultiplier: 1,
  dodgeSkillMultiplier: 1,
  decisionNoiseMultiplier: 1,
  decisionIntervalMultiplier: 1,
  damageTakenMultiplier: 1,
  damageDealtMultiplier: 1,
  environmentalDamageTakenMultiplier: 1,
  grenadeAccuracy: 1,
  navigationSkill: 1,
  targetSelectionSkill: 1,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
