/**
 * How fast a campaign enemy is -- resolved in one place.
 *
 * "Fast" is several numbers: how it moves, how quickly its shots travel, how
 * often it fires, how long it takes to notice you. Every one of them wants
 * balancing at several altitudes at once -- the whole campaign, one difficulty,
 * one level, one enemy type, one placed instance -- and the moment those knobs
 * are applied in the systems themselves, the systems fill with mode checks and
 * the balance is spread across the codebase.
 *
 * So the layers are data and the product is computed here, once:
 *
 *     final = base (weapon/profile numbers)
 *           x game-mode layer   (GameConfig.campaign -- admin-editable)
 *           x difficulty layer  (CAMPAIGN_DIFFICULTIES[..].enemyTuning)
 *           x level layer       (CampaignLevelDefinition.enemyTuning)
 *           x enemy-type layer  (CampaignEnemyDefinition: speed, fireRate, ...)
 *           x instance layer    (CampaignEnemySpawn.tuning)
 *
 * The gameplay systems never see any of this. They read three *generic*
 * per-combatant scalars -- move, projectile and fire-rate multipliers on the
 * runtime, a reaction scale on the agent -- which default to 1 and are only
 * ever set to something else by the campaign's spawn path. Multiplayer runs at
 * exactly 1 everywhere.
 *
 * Detection range is the one absolute in the set: an instance overrides its
 * type, which overrides the brain profile's own sight.
 */

/** One layer's multipliers. Anything omitted means "leave it alone" (x1). */
export interface CampaignEnemyTuning {
  /** Scales walk/run speed -- rushers and fliers included, it is the same integrator. */
  moveSpeed?: number;
  /** Scales bullets, rockets and thrown grenades alike: everything the enemy launches. */
  projectileSpeed?: number;
  /** Scales shots per second; the fire interval divides by it. */
  fireRate?: number;
  /** Scales time-to-notice. Above 1 is *slower* to react, i.e. easier. */
  reactionTime?: number;
}

/** An instance may also pin the absolute knobs its type exposes. */
export interface CampaignEnemyInstanceTuning extends CampaignEnemyTuning {
  /** Absolute sight distance in pixels; overrides the type's. */
  detectionRange?: number;
}

/** The product of every layer: what the spawn path actually applies. */
export interface ResolvedEnemyTuning {
  moveSpeedMultiplier: number;
  projectileSpeedMultiplier: number;
  fireRateMultiplier: number;
  reactionTimeMultiplier: number;
  /** null: no override anywhere, the brain profile's own sight stands. */
  detectionRange: number | null;
}

export interface EnemyTuningLayers {
  /** The game-mode layer, from `GameConfig.campaign`. */
  campaign?: CampaignEnemyTuning;
  difficulty?: CampaignEnemyTuning;
  level?: CampaignEnemyTuning;
  type?: CampaignEnemyInstanceTuning;
  instance?: CampaignEnemyInstanceTuning;
}

/**
 * A multiplier is never allowed to hit zero: a frozen or unhittable enemy is
 * a content bug, and the floor turns it into "very slow" instead of "broken".
 */
const MIN_MULTIPLIER = 0.05;

function product(values: Array<number | undefined>): number {
  let result = 1;
  for (const value of values) {
    if (value !== undefined && Number.isFinite(value)) result *= value;
  }
  return Math.max(MIN_MULTIPLIER, result);
}

export function resolveEnemyTuning(layers: EnemyTuningLayers): ResolvedEnemyTuning {
  const stack = [layers.campaign, layers.difficulty, layers.level, layers.type, layers.instance];
  return {
    moveSpeedMultiplier: product(stack.map((layer) => layer?.moveSpeed)),
    projectileSpeedMultiplier: product(stack.map((layer) => layer?.projectileSpeed)),
    fireRateMultiplier: product(stack.map((layer) => layer?.fireRate)),
    reactionTimeMultiplier: product(stack.map((layer) => layer?.reactionTime)),
    detectionRange: layers.instance?.detectionRange ?? layers.type?.detectionRange ?? null,
  };
}

/**
 * The same product without the type layer.
 *
 * A boss phase writes its own speed -- "the Warden overcharges" *replaces* what
 * the Warden's type says about pace -- but it must still respect the campaign,
 * difficulty, level and instance layers, or a slowed-down tutorial would have a
 * full-speed boss in it.
 */
export function resolveEnvironmentTuning(
  layers: Omit<EnemyTuningLayers, "type">,
): ResolvedEnemyTuning {
  return resolveEnemyTuning(layers);
}
