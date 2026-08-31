/**
 * Campaign level overrides: the admin's pencil over the shipped levels.
 *
 * A level ships as data in the bundle, and the campaign plays offline -- so an
 * administrator cannot edit the level itself the way they edit an arena. What
 * they edit instead is a small overlay, stored on the server and fetched
 * best-effort by the game: per level, the balance knobs worth turning without
 * a release. Everything not overridden keeps the shipped value, so a future
 * rebalance flows through untouched fields exactly as the game-config
 * overrides do.
 *
 * The shape is deliberately the *balance* surface, not the level's structure:
 * geometry, triggers, encounters and bosses stay content. What an operator
 * retunes live is how hard the level is.
 */
import type { CampaignEnemyTuning, CampaignLevelDefinition } from "./index.js";

export interface CampaignLevelOverride {
  /** Field-by-field over the level's own `enemyTuning`; absent fields keep the shipped value. */
  enemyTuning?: CampaignEnemyTuning;
  /** Replaces the respawn rule with `{ kind: "lives", lives }`. */
  lives?: number;
  startingGrenades?: number;
  parTimeMs?: number;
}

/** Keyed by level id. Unknown ids are stored but simply never match a level. */
export type CampaignOverrides = Record<string, CampaignLevelOverride>;

/** What the sanitizer holds each knob to. One table, shared by server and admin UI. */
export const CAMPAIGN_OVERRIDE_LIMITS = {
  multiplier: { min: 0.05, max: 5 },
  lives: { min: 1, max: 9 },
  startingGrenades: { min: 0, max: 20 },
  parTimeMs: { min: 30_000, max: 30 * 60_000 },
} as const;

const TUNING_KEYS = ["moveSpeed", "projectileSpeed", "fireRate", "reactionTime"] as const;

function clampNumber(value: unknown, min: number, max: number, integer = false): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const held = Math.min(max, Math.max(min, value));
  return integer ? Math.round(held) : held;
}

/**
 * Turn whatever arrived over the wire into overrides the game can trust.
 *
 * Everything unknown is dropped and everything numeric is clamped, so a typo
 * in the admin form -- or a hand-edited JSON body -- can make a level easier
 * or harder, but never broken: no zero speeds, no zero lives, no NaN anywhere.
 */
export function sanitizeCampaignOverrides(raw: unknown): CampaignOverrides {
  if (typeof raw !== "object" || raw === null) return {};
  const limits = CAMPAIGN_OVERRIDE_LIMITS;
  const clean: CampaignOverrides = {};

  for (const [levelId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const source = entry as Record<string, unknown>;
    const override: CampaignLevelOverride = {};

    if (typeof source.enemyTuning === "object" && source.enemyTuning !== null) {
      const tuning: CampaignEnemyTuning = {};
      for (const key of TUNING_KEYS) {
        const value = clampNumber(
          (source.enemyTuning as Record<string, unknown>)[key],
          limits.multiplier.min,
          limits.multiplier.max,
        );
        if (value !== undefined) tuning[key] = value;
      }
      if (Object.keys(tuning).length > 0) override.enemyTuning = tuning;
    }

    const lives = clampNumber(source.lives, limits.lives.min, limits.lives.max, true);
    if (lives !== undefined) override.lives = lives;
    const grenades = clampNumber(
      source.startingGrenades,
      limits.startingGrenades.min,
      limits.startingGrenades.max,
      true,
    );
    if (grenades !== undefined) override.startingGrenades = grenades;
    const parTimeMs = clampNumber(source.parTimeMs, limits.parTimeMs.min, limits.parTimeMs.max, true);
    if (parTimeMs !== undefined) override.parTimeMs = parTimeMs;

    if (Object.keys(override).length > 0) clean[levelId] = override;
  }
  return clean;
}

/**
 * The shipped level with an override laid over it. A new object -- the shipped
 * definition is module data and is never mutated.
 */
export function applyCampaignLevelOverride(
  level: CampaignLevelDefinition,
  override: CampaignLevelOverride | undefined,
): CampaignLevelDefinition {
  if (!override) return level;
  return {
    ...level,
    enemyTuning: override.enemyTuning
      ? { ...level.enemyTuning, ...override.enemyTuning }
      : level.enemyTuning,
    respawnRule: override.lives !== undefined ? { kind: "lives", lives: override.lives } : level.respawnRule,
    startingGrenades: override.startingGrenades ?? level.startingGrenades,
    parTimeMs: override.parTimeMs ?? level.parTimeMs,
  };
}
