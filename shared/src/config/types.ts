/**
 * The configuration data model.
 *
 * These interfaces describe *data*, never behaviour. Gameplay systems read them
 * and act accordingly; they never branch on a specific id. That is what allows a
 * future administration interface to add a weapon, retune a power-up or move a
 * spawn point without a code change — and why every value a designer might want
 * to touch lives here rather than inline in a system.
 *
 * Everything is expressed in plain JSON-compatible types on purpose: the whole
 * config could arrive from a database or an HTTP API instead of `defaults.ts`.
 */

/** Every configurable value is one of these three primitives. */
export type ConfigValue = number | boolean | string;

/**
 * How a weapon delivers damage.
 *
 * `ranged` spawns projectiles the server simulates; `melee` resolves an instant
 * contact test around the attacker. The type selects which optional config block
 * is required — see `WeaponDefinition`.
 */
export const WeaponType = {
  RANGED: "ranged",
  MELEE: "melee",
} as const;

export type WeaponTypeValue = (typeof WeaponType)[keyof typeof WeaponType];

/**
 * Distance-based damage scaling, applied to every projectile hit.
 *
 * Damage is full up to `startDistance`, then falls linearly to
 * `damage * minMultiplier` at `endDistance` and stays there. A shotgun sets a
 * short start and a low multiplier; a rifle can leave this `null` for flat damage.
 */
export interface DamageFalloff {
  startDistance: number;
  endDistance: number;
  /** 0..1 — the fraction of base damage left at and beyond `endDistance`. */
  minMultiplier: number;
}

/** Projectile-weapon specifics. Required when `type` is `ranged`. */
/**
 * A blast, wherever it comes from.
 *
 * Shared between grenades and explosive projectiles so a rocket and a grenade
 * are the same physics with different numbers -- and so tuning one does not
 * quietly leave the other behaving differently.
 */
export interface ExplosionConfig {
  /** How far the blast reaches, in px. */
  radius: number;
  /** Damage at the very centre. */
  damage: number;
  /** Fraction of that damage still dealt at the outer edge. */
  minDamageMultiplier: number;
  /** How hard the blast throws whoever it catches, at the centre. */
  knockbackForce: number;
}

export interface RangedWeaponConfig {
  /** Muzzle velocity in px/s. */
  bulletSpeed: number;
  /** Maximum random cone deviation in radians, applied per pellet by the server. */
  spread: number;
  /** Projectiles per trigger pull. Shotguns fire several; rifles fire one. */
  pellets: number;
  falloff: DamageFalloff | null;
  /**
   * Detonate on impact rather than simply hitting.
   *
   * Null for anything that fires bullets. When set, the projectile's own damage
   * is never applied directly: the blast is the weapon, and it catches the
   * shooter too if they were careless about where they aimed.
   */
  explosion: ExplosionConfig | null;
  /** Cosmetic only — the client picks a projectile tint and size from this. */
  projectileStyle: {
    color: number;
    radius: number;
    trailLength: number;
  };
}

/**
 * One rectangle of a weapon's drawn shape, in texture space.
 *
 * Rectangles rather than a sprite for the same reason the arena is rectangles:
 * it is data, so a weapon added through configuration arrives with a look
 * instead of a missing texture — and a shotgun's pump or a chainsaw's bar can be
 * moved without opening an image editor.
 */
export interface WeaponSilhouettePart {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Overrides the weapon's base colour, for a wooden stock or a steel bar. */
  color?: number;
  alpha?: number;
}

/**
 * How a weapon looks in someone's hands.
 *
 * Purely cosmetic, and the whole point of it is that it is visible *to other
 * players*: at a glance across the arena you can tell whether the figure running
 * at you is carrying a rifle or a chainsaw, which is information a shooter owes
 * you.
 */
export interface WeaponSilhouette {
  /** Texture size. Parts are drawn inside this box. */
  length: number;
  height: number;
  /**
   * Where the hand holds it, in texture pixels. This is the rotation pivot, so
   * for a ranged weapon `length - gripX` should be about the muzzle offset --
   * otherwise the muzzle flash detaches from the barrel.
   */
  gripX: number;
  gripY: number;
  /** Base colour for parts that do not name their own. */
  color: number;
  parts: WeaponSilhouettePart[];
}

/** Contact-weapon specifics. Required when `type` is `melee`. */
export interface MeleeWeaponConfig {
  /**
   * Half-angle of the damage arc around the aim direction, in degrees.
   * The target must be inside this cone *and* within the weapon's range.
   */
  arcDegrees: number;
  /** Minimum time between swings, in milliseconds. */
  attackIntervalMs: number;
}

/**
 * A weapon, fully described by data.
 *
 * `damage`, `range`, `fireRate`, `magazineSize` and `reloadTime` are common to
 * every weapon so an admin form can present them uniformly; the `ranged` and
 * `melee` blocks carry what only one kind needs.
 */
export interface WeaponDefinition {
  /** Stable internal id (e.g. "shotgun"). Never shown to players. */
  id: string;
  /** Display name, shown in the HUD and kill feed. Free to change at any time. */
  name: string;
  type: WeaponTypeValue;
  /** Disabled weapons cannot be granted or spawned, but stay in the catalogue. */
  enabled: boolean;
  /** Base damage per projectile hit, or per melee contact. */
  damage: number;
  /** Ranged: maximum projectile travel. Melee: contact distance. Both in px. */
  range: number;
  /** Shots per minute. Ignored by melee weapons, which use `attackIntervalMs`. */
  fireRate: number;
  /** 0 means the weapon needs no ammunition (melee). */
  magazineSize: number;
  /** Reload duration in ms. Irrelevant when `magazineSize` is 0. */
  reloadTime: number;
  /** Holding the trigger keeps firing. */
  automatic: boolean;
  /**
   * How hard a hit shoves the person it lands on.
   *
   * Measured in "impulses" -- one unit is `KNOCKBACK_IMPULSE` px/s added along
   * the projectile's direction of travel. Applied per *hit*, so a nine-pellet
   * shotgun blast at contact range delivers nine of them; set the per-pellet
   * figure accordingly rather than the figure you want for a full hit.
   */
  knockbackForce: number;
  /**
   * How hard firing shoves the person who pulled the trigger, backwards.
   *
   * Deliberately a separate number from `knockbackForce`: a weapon that throws
   * people across the room need not also throw its owner, and an automatic
   * applies its recoil several times a second.
   */
  recoilForce: number;
  /**
   * What carrying this weapon does to the player's top running speed.
   *
   * 1 is no effect, and every weapon ships at 1 so the mechanism is in place
   * without changing how anything currently plays. Below 1 is a weapon you
   * lug; above 1 is one you can run with. It multiplies with a speed power-up
   * rather than replacing it -- see `MovementState.weaponSpeedMultiplier`.
   *
   * Reload time is *also* weapon-driven, and always has been: `reloadTime`
   * above is per weapon, and `getReloadDurationMs` scales it by how much of the
   * magazine is actually missing.
   */
  moveSpeedMultiplier: number;
  ranged: RangedWeaponConfig | null;
  melee: MeleeWeaponConfig | null;
  /**
   * How it is drawn in a player's hands. Cosmetic, and like `projectileStyle`
   * it is a shape rather than a scalar, so it is not an admin form field.
   */
  silhouette: WeaponSilhouette;
}

/**
 * What a power-up does when picked up.
 *
 * Each value maps to exactly one applier registered by the server's power-up
 * system, so adding a *weapon* power-up is pure data. Adding a genuinely new kind
 * of effect is the one case that also needs an applier.
 */
export const PowerUpType = {
  WEAPON: "weapon",
  HEALTH: "health",
  SPEED: "speed",
  GRENADE: "grenade",
} as const;

export type PowerUpTypeValue = (typeof PowerUpType)[keyof typeof PowerUpType];

interface PowerUpDefinitionBase {
  /** Stable internal id (e.g. "health-50"). */
  id: string;
  /** Display name, shown in the pickup toast. */
  name: string;
  /** Disabled power-ups never spawn. Kept in the catalogue so they can return. */
  enabled: boolean;
  /**
   * Relative likelihood of being chosen as a crate's contents. Weights are
   * compared against each other, so they need not sum to anything in particular;
   * a weight of 0 means "never spawn" just as `enabled: false` does.
   */
  spawnWeight: number;
  /** Cosmetic tint used by the client for the floating pickup. */
  color: number;
}

/** Grants a weapon. The weapon itself is configured in the weapon catalogue. */
export interface WeaponPowerUp extends PowerUpDefinitionBase {
  type: typeof PowerUpType.WEAPON;
  /** Id of the weapon to equip. Must exist in the weapon catalogue. */
  weaponId: string;
}

/** Restores a percentage of the player's maximum health. */
export interface HealthPowerUp extends PowerUpDefinitionBase {
  type: typeof PowerUpType.HEALTH;
  /** 0..1 — fraction of *maximum* health restored, never exceeding the maximum. */
  restoreFraction: number;
}

/** Temporarily multiplies movement speed. */
export interface SpeedPowerUp extends PowerUpDefinitionBase {
  type: typeof PowerUpType.SPEED;
  speedMultiplier: number;
  durationMs: number;
}

/** Hands over grenades, up to the carrying limit. */
export interface GrenadePowerUp extends PowerUpDefinitionBase {
  type: typeof PowerUpType.GRENADE;
  /** How many grenades this pickup grants. */
  amount: number;
}

export type PowerUpDefinition =
  | WeaponPowerUp
  | HealthPowerUp
  | SpeedPowerUp
  | GrenadePowerUp;

/** The breakable container power-ups arrive in. */
export interface CrateConfig {
  /** Hit points a crate absorbs before breaking open. */
  health: number;
  width: number;
  height: number;
  /**
   * How long an untouched crate stays in the arena before it is removed, freeing
   * its spawn point. 0 disables expiry.
   */
  lifetimeMs: number;

  /**
   * Whether a crate is a physical object at all.
   *
   * Off means it hangs wherever it landed and nothing moves it, which is how
   * crates behaved before this existed. On, it falls, slides, is shoved by
   * anyone who walks into it, is nudged by gunfire, and can be pushed off a
   * ledge -- which turns a crate from scenery into something you can play with,
   * and occasionally into something you destroy by accident.
   */
  physicsEnabled: boolean;
  /** Downward acceleration, px/s². */
  gravity: number;
  /** Terminal velocity for a falling crate, px/s. */
  maxFallSpeed: number;
  /** How quickly a shoved crate stops once it is resting, px/s². */
  groundFriction: number;
  /** The same in the air. Low, so a crate knocked off a ledge keeps its arc. */
  airFriction: number;
  /**
   * Top speed a player walking into a crate can push it at, px/s.
   *
   * A speed rather than a force: a crate should move with you at a believable
   * pace whatever you are carrying, and shoving is not supposed to be a way of
   * launching one across the arena.
   */
  pushSpeed: number;
  /** How hard a single hit shoves a crate along the shot's direction, px/s. */
  shotImpulse: number;
  /**
   * How far a crate must fall before landing hurts it, in px.
   *
   * Below this a drop is free, so nudging one off a step does not quietly
   * destroy it. 0 means any fall at all does damage.
   */
  fallDamageMinDrop: number;
  /** Damage per 100px of fall beyond `fallDamageMinDrop`. */
  fallDamagePer100px: number;
}

/** How often crates appear, and how long their contents linger. */
export interface PowerUpSpawnConfig {
  /** Interval between spawn attempts, in ms. */
  intervalMs: number;
  /** Upper bound on crates present at once, regardless of free spawn points. */
  maxActiveCrates: number;
  /** How long a revealed power-up waits to be collected before vanishing. */
  revealedLifetimeMs: number;
  /** Distance in px at which a player collects a revealed power-up. */
  pickupRadius: number;
  /** Delay after the match starts before the first spawn attempt. */
  firstSpawnDelayMs: number;
  /**
   * How long the arena is warned before a crate lands, in ms.
   *
   * The point is that a crate should never simply appear: the place it is about
   * to land is marked, the marking builds, and only then does it arrive -- so
   * contesting one is a decision somebody had time to make. 0 spawns crates with
   * no warning at all.
   */
  warningMs: number;
}

/**
 * Grenades: how many you carry, how hard you can throw one, and what it does.
 *
 * Everything the server needs to validate a throw and resolve an explosion. The
 * client never supplies a velocity, a hit or a damage number -- it only holds a
 * button, and the server measures how long.
 */
export interface GrenadeConfig {
  enabled: boolean;
  /** Grenades every player is issued at the start of a match. */
  startingCount: number;
  /** Hard cap on how many a player may carry. */
  maxCount: number;

  /** Throw speed at no charge, in px/s. */
  minThrowSpeed: number;
  /** Throw speed at full charge, in px/s. */
  maxThrowSpeed: number;
  /** How long the button must be held to reach `maxThrowSpeed`, in ms. */
  maxChargeMs: number;

  /** Downward acceleration on a thrown grenade, in px/s². */
  gravity: number;
  /** Fraction of the impact velocity kept when bouncing off geometry, 0..1. */
  bounciness: number;
  /** Fraction of the sliding velocity kept on contact, 0..1. Lower stops sooner. */
  friction: number;
  /** Collision radius of the grenade itself, in px. */
  radius: number;

  /** Time from leaving the hand to detonation, in ms. */
  fuseMs: number;
  /** Everything within this distance of the blast takes damage, in px. */
  explosionRadius: number;
  /** Damage at the very centre of the blast. */
  maxDamage: number;
  /**
   * 0..1 — the fraction of `maxDamage` still dealt at the edge of the radius.
   * Damage falls linearly from the centre outwards to this floor.
   */
  minDamageMultiplier: number;
  /**
   * How hard the blast throws whoever it catches, radiating from the centre.
   *
   * Falls off with distance like the damage does, so a near miss shoves you and
   * a direct hit launches you.
   */
  knockbackForce: number;
}

/**
 * The closing walls that end a stalling match.
 *
 * After `startAfterMs` of play the arena's left and right edges advance towards
 * each other, squeezing the survivors together until someone wins.
 */
export interface ArenaShrinkConfig {
  enabled: boolean;
  /** Play time before the walls start moving, in ms. */
  startAfterMs: number;
  /** How fast each wall advances, in px per second. Both sides move at once. */
  speedPerSecond: number;
  /** The walls stop once the gap between them reaches this width, in px. */
  minWidth: number;
  /**
   * Damage per second to a player the walls are pressing against.
   *
   * Without it a player wedged between a closing wall and solid geometry would
   * simply stop, and the match could stall exactly where the shrink was meant to
   * end it.
   */
  crushDamagePerSecond: number;
}

/**
 * Where the health and ammunition bars are drawn.
 *
 * The same two numbers, in one of two places. Over the player they sit where
 * you are already looking -- at your own character, in the fight -- and they
 * are legible for *everybody*, which is the point: a bar over somebody's head
 * says whether they are hurt and whether they are out, and both are things a
 * shooter owes you. In the HUD they are precise and always in the same corner,
 * but only ever about you, and only where you are not looking.
 *
 * Both may be on at once; both off leaves the numbers nowhere, which is a
 * legitimate thing to configure and nothing here prevents.
 */
export interface GaugesConfig {
  /** Health and ammunition bars above every player's head. */
  overPlayer: boolean;
  /** The same two gauges in the corner panel, for the local player only. */
  inHud: boolean;
}

/**
 * The corner minimap.
 *
 * Purely a presentation convenience: every position it can show is already in
 * the state each client receives (a player's `x`/`y`, a power-up's), so this
 * decides what gets *drawn*, never what gets *sent*. Switching it off costs
 * nothing on the wire, and turning it on reveals nothing a client could not
 * already compute for itself from state it already has.
 */
export interface MinimapConfig {
  /** Off means the panel never appears, whatever the two switches below say. */
  enabled: boolean;
  showPlayers: boolean;
  showPowerUps: boolean;
  /**
   * How far from the local player (or, while spectating, whoever is being
   * watched) something must be to earn a dot, in world px. 0 means no limit --
   * the whole arena is shown regardless of distance.
   */
  radius: number;
}

/**
 * The player character: how it moves, how much it can take.
 *
 * These used to be compile-time constants, and they are the values client
 * prediction and the server simulation must agree on *exactly*. They live here
 * so an administrator can retune them, and the server hands its effective values
 * to every client on join -- so both sides still step the same integrator with
 * the same numbers, and prediction stays exact.
 *
 * Times are milliseconds and speeds are pixels per second throughout, because an
 * admin form is a poor place to explain what "0.09" means.
 */
export interface PlayerConfig {
  maxHealth: number;
  /** Top horizontal running speed, px/s. Power-ups multiply this. */
  moveSpeed: number;
  /** How quickly the top speed is reached on the ground, px/s². */
  groundAcceleration: number;
  /** The same in mid-air. Lower makes air control feel floatier. */
  airAcceleration: number;
  /** Deceleration with no input, px/s². */
  groundFriction: number;
  airFriction: number;
  /** Downward acceleration, px/s². */
  gravity: number;
  /** Terminal velocity, px/s. */
  maxFallSpeed: number;
  /**
   * Upward launch speed of a jump, px/s.
   *
   * Positive here and negated by the integrator: "how hard you jump" is a
   * friendlier thing to type into a form than a negative velocity.
   */
  jumpVelocity: number;
  /** Total jumps between touching the ground. 1 is a plain jump, 2 adds the air jump. */
  maxJumps: number;
  /** Mid-air jumps are scaled by this, so the second one can be weaker. */
  airJumpMultiplier: number;
  /** Releasing jump early cuts the remaining ascent to this fraction. */
  jumpCutMultiplier: number;
  /** Grace period after walking off a ledge during which a jump still counts, ms. */
  coyoteTimeMs: number;
  /** A jump pressed this long before landing is remembered and fires on touchdown, ms. */
  jumpBufferMs: number;
  /**
   * The most any single impulse may add to a player's speed, px/s.
   *
   * The safety valve on knockback. Without it a weapon tuned to an absurd figure
   * -- or a shotgun landing every pellet at point-blank range -- launches
   * somebody clean across the arena, and physics that can be broken by a
   * configuration value is not really configurable.
   */
  maxKnockbackSpeed: number;
  /**
   * How quickly a shove bleeds away, per second.
   *
   * Knockback deliberately does not decay through the ordinary friction figures:
   * ground friction is 3200px/s², which erases a rifle's shove inside two frames
   * and about half a pixel of travel -- landing a hit then looks like nothing
   * happened at all. While a shove is live the horizontal speed decays by this
   * fraction of itself each second instead, which makes the distance travelled
   * proportional to the impulse: roughly `speed / knockbackDamping` pixels.
   */
  knockbackDamping: number;
  /**
   * How long a shove keeps its own decay before normal friction resumes, ms.
   */
  knockbackRecoveryMs: number;
  /**
   * How much of a shove is turned into lift when it lands on someone standing,
   * as a fraction of the impulse.
   *
   * A purely horizontal push against the floor is fought by friction and by the
   * victim's own footing. Taking them off their feet is what makes a hit read as
   * a hit -- and it is what a shotgun blast should do anyway.
   */
  knockbackLift: number;
}

/** Match pacing and size. */
export interface MatchConfig {
  /**
   * The fewest players a match may start with, host or no host.
   *
   * Two: one of them has to have somebody to fight. The room does not wait to
   * reach `maxPlayers` -- the host decides when to begin.
   */
  minPlayers: number;
  /** Hard cap on players in one match. */
  maxPlayers: number;
  countdownMs: number;
  /** How long the results screen stays up before the room recycles. */
  resultsMs: number;
  /** Safety valve: a match can never run longer than this. */
  maxDurationMs: number;
}

/**
 * Default trap behaviour.
 *
 * Every trap placed in an arena inherits these; a trap may override any of them
 * individually (see `TrapDefinition`), which is how one arena ends up with
 * faster crushers than another without needing its own copy of the whole set.
 */
export interface TrapConfig {
  /** Master switch. Off means no trap in any arena ever activates. */
  enabled: boolean;
  /** Damage per activation, or per second for a continuously damaging trap. */
  damage: number;
  /** Delay between being triggered and becoming dangerous, ms. */
  activationDelayMs: number;
  /** How long a trap stays dangerous once active, ms. 0 means indefinitely. */
  activeDurationMs: number;
  /** Rest period after an activation before the trap can trigger again, ms. */
  cooldownMs: number;
  /** Speed of a trap that moves, px/s. */
  moveSpeed: number;
  /** How near a player must come to set off a proximity trap, px. */
  triggerRadius: number;
}

/**
 * One NPC personality, expressed entirely as numbers.
 *
 * There is deliberately no `AggressiveNpc` class anywhere. Every NPC runs the
 * same brain and differs only by this record, which is what makes a new
 * personality a data entry rather than a subclass -- and what lets one be tuned
 * live while watching it play.
 *
 * Everything is 0..1 unless the name says otherwise, so the utility scores stay
 * comparable and a designer never has to guess what scale a field is on.
 */
export interface BrainProfile {
  /** Stable internal id. */
  id: string;
  /** Display name, shown in the debug console and on the bot's own label. */
  name: string;

  /** How much it wants to fight at all. */
  aggression: number;
  /** How much it values staying alive. Weighs against aggression under fire. */
  survival: number;
  /** How much it detours for power-ups and crates. */
  powerupInterest: number;
  /** How readily it reaches for a grenade. */
  grenadeUsage: number;
  /** How strongly a wounded enemy pulls it in. */
  finishWeakEnemies: number;
  /** How long it keeps chasing something it can no longer see. */
  chasePersistence: number;

  /** The range it tries to fight at, in px. A shotgun profile wants this small. */
  preferredDistance: number;

  /** 0 is hopeless, 1 is perfect. Drives aim error, not damage. */
  aimSkill: number;
  /** How well it leads a moving target. */
  predictionSkill: number;
  /** How well it gets out of the way of a grenade. */
  dodgeSkill: number;
  /** Delay between seeing something and acting on it, in ms. */
  reactionTimeMs: number;

  /** How long an enemy stays remembered after leaving sight, in ms. */
  memoryDurationMs: number;

  /**
   * Decision stability, in score points.
   *
   * `currentActionBonus` is added to whatever it is already doing and
   * `actionSwitchThreshold` is how much better an alternative must be before it
   * switches. Between them they stop the attack/retreat/attack flicker that an
   * unsmoothed utility system produces.
   */
  currentActionBonus: number;
  actionSwitchThreshold: number;
  /** Minimum time an action runs before it may be replaced, in ms. */
  minimumActionMs: number;
  /** Random spread added to every score, in points. Small on purpose. */
  decisionNoise: number;
}

/**
 * One rung of the bot difficulty ladder.
 *
 * Difficulty is deliberately *not* a set of alternative personalities: a
 * Berserker is a Berserker at every level, and what changes is how well it plays.
 * That split is why these are mostly multipliers -- they scale whatever the
 * profile asked for rather than replacing it, so tuning a personality still means
 * tuning one place.
 *
 * It is also deliberately not "less health, less damage". A weaker bot reacts
 * later, aims worse, reads movement worse, dodges worse, thinks less often and
 * picks its fights worse. It is still playing the same game with the same
 * weapons -- it is simply not as good at it.
 */
export interface BotDifficultyLevel {
  /** 1..5. The number a player picks. */
  level: number;
  /** "Very Easy" ... "Very Hard". */
  name: string;

  /** Scales the profile's reaction time. Above 1 is slower, i.e. worse. */
  reactionTimeMultiplier: number;
  /** Scales the profile's aim skill. Below 1 is worse. */
  aimSkillMultiplier: number;
  /** Scales how well it leads a moving target. */
  predictionSkillMultiplier: number;
  /** Scales how well it gets out of the way. */
  dodgeSkillMultiplier: number;

  /**
   * Scales the profile's decision noise. Above 1 is more erratic, i.e. worse.
   *
   * A multiplier rather than an absolute: a Trickster's jitter is part of who it
   * is, and a difficulty that overwrote it would quietly flatten the personality
   * it is supposed to leave alone.
   */
  decisionNoiseMultiplier: number;
  /** Scales how often it re-decides. Above 1 thinks less often, i.e. worse. */
  decisionIntervalMultiplier: number;

  /**
   * How much of a weapon's damage this bot actually takes, and deals.
   *
   * Deliberately separate from the skill multipliers above, and from the weapon
   * catalogue: an easier bot is a worse player *and* a softer one, but the
   * weapon's own damage never changes -- a rifle does what the rifle does, and
   * two systems that both wanted to own "how much does this hurt" would be
   * impossible to reason about. The multiplier is chosen by the *bot*, never by
   * whoever it is shooting at, so a bot's difficulty describes that bot alone.
   */
  damageTakenMultiplier: number;
  damageDealtMultiplier: number;
  /**
   * The same, for damage the arena does: traps, the closing walls, anything
   * with no attacker behind it.
   *
   * Its own setting, and 1 by default, because those are the deaths a bot is
   * meant to avoid by playing better rather than by being tougher -- softening
   * them would hide exactly the failure the AI work has been measuring.
   */
  environmentalDamageTakenMultiplier: number;

  /** How well it judges a grenade throw, 0..1. */
  grenadeAccuracy: number;
  /** How well it reads the arena: looking ahead, noticing it is stuck. 0..1. */
  navigationSkill: number;
  /** How reliably it fights the enemy actually worth fighting, 0..1. */
  targetSelectionSkill: number;
}

/**
 * NPCs: whether they play, how many, and how often they think.
 *
 * The thinking rates are here rather than hard-coded because they are the main
 * lever between "the arena feels alive" and "the server is doing nothing but
 * running bots".
 */
export interface NpcConfig {
  enabled: boolean;
  /** Hard cap on bots in one match, whatever the fill target says. */
  maxBots: number;
  /** How often a brain re-decides what it wants, in ms. */
  thinkIntervalMs: number;
  /** How often perception refreshes what a bot can sense, in ms. */
  perceptionIntervalMs: number;
  /** How far a bot can see, in px. Beyond this an enemy is simply not there. */
  sightRange: number;
  /** Names given to bots, cycled through. */
  names: string[];
  profiles: BrainProfile[];

  /** The rung the "add bot" picker starts on, 1..5. */
  defaultDifficulty: number;
  /** The difficulty ladder itself. Levels are matched by `level`. */
  difficulties: BotDifficultyLevel[];
}

/**
 * The complete tunable game configuration.
 *
 * Power-up spawn *points* are deliberately not here: they are part of a map's
 * geometry and live on the arena definition, so a new map brings its own.
 */
export interface GameConfig {
  player: PlayerConfig;
  match: MatchConfig;
  weapons: WeaponDefinition[];
  /** Weapon every player starts a match with. */
  defaultWeaponId: string;
  powerUps: PowerUpDefinition[];
  crate: CrateConfig;
  powerUpSpawning: PowerUpSpawnConfig;
  arenaShrink: ArenaShrinkConfig;
  grenades: GrenadeConfig;
  traps: TrapConfig;
  npc: NpcConfig;
  minimap: MinimapConfig;
  gauges: GaugesConfig;
}
