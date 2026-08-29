/**
 * The NPC brain.
 *
 * Two properties are worth defending here above all others.
 *
 * The first is that a bot only knows what it could plausibly sense. Perception
 * is the one place with access to the room, and several of these check that it
 * throws the right things away -- an enemy behind a wall, a crate's contents,
 * somebody out of sight range.
 *
 * The second is that behaviour comes out of *scores*, not conditions. The tests
 * therefore drive the scoring directly with hand-built contexts: a retreat that
 * only happens below twenty health would pass a "does it retreat" test and still
 * be the wrong design.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  CollisionWorld,
  createInputCommand,
  createMovementState,
  stepPlayerMovement,
  FIXED_DELTA,
  PLAYER_HALF_HEIGHT,
  PLAYER_HALF_WIDTH,
  DEFAULT_GAME_CONFIG,
  MAX_BOT_DIFFICULTY,
  MIN_BOT_DIFFICULTY,
  MatchState,
  ROCKET_LAUNCHER_ID,
  TrapActivation,
  applyBotDifficulty,
  createRandom,
  getBotDifficulty,
  cloneConfig,
  getGameConfig,
  clamp01,
  createEmptyArena,
  getNpcConfig,
  getGrenadeConfig,
  getPlayerConfig,
  getWeapon,
  listBrainProfiles,
  type BrainProfile,
} from "@deathmatch/shared";
import { clock, createHarness, type Harness } from "./harness.js";
import { MAX_HEALTH } from "./helpers.js";

const { Brain, deriveEffectiveProfile } = await import("../server/src/npc/Brain.js");
const { Memory } = await import("../server/src/npc/Memory.js");
const { Perception } = await import("../server/src/npc/Perception.js");
const { TargetSelector } = await import("../server/src/npc/TargetSelector.js");
const { CombatController } = await import("../server/src/npc/CombatController.js");
const { NavGraph } = await import("../server/src/npc/Navigation.js");
const { MovementController } = await import("../server/src/npc/MovementController.js");
const { throwAngleFor, throwClearance, throwSpeedFor } = await import("../server/src/npc/throwArc.js");
const actions = await import("../server/src/npc/actions/index.js");

type BrainContext = import("../server/src/npc/context.js").BrainContext;
type PerceivedEnemy = import("../server/src/npc/context.js").PerceivedEnemy;

function profile(overrides: Partial<BrainProfile> = {}): BrainProfile {
  const base = DEFAULT_GAME_CONFIG.npc.profiles.find((entry) => entry.id === "balanced")!;
  return { ...base, ...overrides };
}

/** A context with nothing happening, for tests that only care about one term. */
function emptyContext(overrides: Partial<BrainContext> = {}): BrainContext {
  return {
    now: 0,
    self: {
      x: 500,
      y: 500,
      velocityX: 0,
      velocityY: 0,
      onGround: true,
      jumpsRemaining: 2,
      health: 1,
      ammo: 1,
      reloading: false,
      grenades: 3,
      weapon: getWeapon("assault-rifle"),
      flagCount: 0,
    },
    enemies: [],
    visibleEnemies: [],
    nearestEnemy: null,
    items: [],
    nearestPowerUp: null,
    nearestWeaponPickup: null,
    grenades: [],
    traps: [],
    grenadeDanger: 0,
    trapDanger: 0,
    wallDanger: 0,
    danger: 0,
    weaponEffectiveness: 1,
    enemyVulnerability: 0,
    playing: true,
    flagHunt: false,
    suddenDeath: false,
    flags: [],
    nearestFlag: null,
    leaderFlagCount: 0,
    gameSense: 0.5,
    safeCentreX: 1600,
    explosionRadius: 190,
    ...overrides,
  };
}

function enemy(overrides: Partial<PerceivedEnemy> = {}): PerceivedEnemy {
  return {
    sessionId: "e1",
    name: "Enemy",
    x: 800,
    y: 500,
    velocityX: 0,
    velocityY: 0,
    health: 1,
    weaponId: "assault-rifle",
    distance: 300,
    angle: 0,
    visible: true,
    // Seen and shootable unless a test says otherwise: the interesting cases
    // set one without the other.
    shootable: true,
    ageMs: 0,
    facingUs: 0,
    flagCount: 0,
    isLeader: false,
    ...overrides,
  };
}

/** A stand-in agent: the actions only ever ask it for the chosen target. */
function agentWith(target: PerceivedEnemy | null, profileOverride?: BrainProfile) {
  return {
    target,
    effectiveProfile: profileOverride ?? profile(),
    // Whether a throw would clear the geometry is about the arena, and is
    // tested against a real one below; scoring tests are about the decision.
    canLobAt: () => true,
  } as never;
}

// ---------------------------------------------------------------------------

describe("brain profiles", () => {
  it("ships the twelve personalities the design asks for", () => {
    const ids = listBrainProfiles().map((entry) => entry.id);
    for (const expected of [
      "aggressive", "defensive", "rusher", "hunter", "opportunist", "collector",
      "grenadier", "camper", "trickster", "coward", "berserker", "balanced",
    ]) {
      assert.ok(ids.includes(expected), `missing profile ${expected}`);
    }
  });

  it("keeps every weighting inside the range the scoring assumes", () => {
    // A weight above 1 quietly swamps every other term it is added to, and the
    // bug looks like a personality rather than a bug.
    const unit: (keyof BrainProfile)[] = [
      "aggression", "survival", "powerupInterest", "grenadeUsage",
      "finishWeakEnemies", "chasePersistence", "aimSkill", "predictionSkill", "dodgeSkill",
    ];

    for (const entry of listBrainProfiles()) {
      for (const key of unit) {
        const value = entry[key] as number;
        assert.ok(value >= 0 && value <= 1, `${entry.id}.${String(key)} is ${value}, outside 0..1`);
      }
      assert.ok(entry.preferredDistance > 0, `${entry.id} has no preferred distance`);
      assert.ok(entry.reactionTimeMs >= 0);
      assert.ok(entry.memoryDurationMs >= 0);
    }
  });

  it("gives no two personalities the same numbers", () => {
    const seen = new Map<string, string>();
    for (const entry of listBrainProfiles()) {
      const { id, name, ...weights } = entry;
      void name;
      const signature = JSON.stringify(weights);
      const twin = seen.get(signature);
      assert.equal(twin, undefined, `${id} is identical to ${twin}`);
      seen.set(signature, id);
    }
  });
});

describe("effective profile", () => {
  it("makes a hurt bot value its life more and the fight less", () => {
    const base = profile({ aggression: 0.9, survival: 0.3 });
    const healthy = deriveEffectiveProfile(base, emptyContext());
    const hurt = deriveEffectiveProfile(base, emptyContext({ self: { ...emptyContext().self, health: 0.15 } }));

    assert.ok(hurt.aggression < healthy.aggression, "aggression should fall when hurt");
    assert.ok(hurt.survival > healthy.survival, "survival should rise when hurt");
  });

  it("leaves the most aggressive personality still the most aggressive", () => {
    // Being hurt is a modifier, not a personality transplant.
    const hurtContext = emptyContext({ self: { ...emptyContext().self, health: 0.15 } });
    const berserker = deriveEffectiveProfile(profile({ aggression: 1, survival: 0.05 }), hurtContext);
    const coward = deriveEffectiveProfile(profile({ aggression: 0.2, survival: 0.98 }), hurtContext);

    assert.ok(berserker.aggression > coward.aggression);
  });

  it("makes a bad weapon and a low health bar both raise the appetite for pickups", () => {
    const base = profile({ powerupInterest: 0.5 });
    const comfortable = deriveEffectiveProfile(base, emptyContext());
    const desperate = deriveEffectiveProfile(
      base,
      emptyContext({ weaponEffectiveness: 0, self: { ...emptyContext().self, health: 0.2 } }),
    );

    assert.ok(desperate.powerupInterest > comfortable.powerupInterest);
  });
});

describe("action scoring", () => {
  it("scores retreating from the terms the design specifies", () => {
    // low health * danger * survival, and nothing else pretending to be a rule.
    const safe = actions.retreatAction.score(emptyContext(), profile(), agentWith(null));
    const cornered = actions.retreatAction.score(
      emptyContext({
        self: { ...emptyContext().self, health: 0.15 },
        danger: 0.9,
        visibleEnemies: [enemy()],
        enemies: [enemy()],
      }),
      profile({ survival: 0.9 }),
      agentWith(enemy()),
    );

    assert.ok(cornered > safe + 30, `expected a much higher retreat score, got ${cornered} vs ${safe}`);
  });

  it("lets personality decide when to run, from the same situation", () => {
    const situation = emptyContext({
      self: { ...emptyContext().self, health: 0.25 },
      danger: 0.7,
      visibleEnemies: [enemy()],
      enemies: [enemy()],
    });

    const coward = actions.retreatAction.score(situation, profile({ survival: 0.98, aggression: 0.2 }), agentWith(enemy()));
    const berserker = actions.retreatAction.score(situation, profile({ survival: 0.05, aggression: 1 }), agentWith(enemy()));

    assert.ok(coward > berserker * 3, "a coward should want out far more than a berserker");
  });

  it("will not attack something it cannot see", () => {
    const remembered = enemy({ visible: false, ageMs: 900 });
    const context = emptyContext({ enemies: [remembered], visibleEnemies: [] });

    assert.equal(actions.attackAction.score(context, profile(), agentWith(remembered)), 0);
    assert.ok(actions.chaseAction.score(context, profile(), agentWith(remembered)) > 0, "but it should chase");
  });

  it("loses interest in a memory as it goes stale", () => {
    const fresh = enemy({ visible: false, ageMs: 200 });
    const stale = enemy({ visible: false, ageMs: 2800 });
    const p = profile({ memoryDurationMs: 3000 });

    const freshScore = actions.chaseAction.score(emptyContext({ enemies: [fresh] }), p, agentWith(fresh));
    const staleScore = actions.chaseAction.score(emptyContext({ enemies: [stale] }), p, agentWith(stale));

    assert.ok(freshScore > staleScore, "a fresher lead should be worth more");
  });

  it("treats a grenade at its feet as the design's dodge formula", () => {
    const context = emptyContext({ grenadeDanger: 0.95 });
    const skilled = actions.dodgeAction.score(context, profile({ dodgeSkill: 0.9 }), agentWith(null));
    const clumsy = actions.dodgeAction.score(context, profile({ dodgeSkill: 0.2 }), agentWith(null));

    assert.ok(skilled > clumsy, "dodge skill should decide how strongly it wants out");
    assert.ok(skilled > 80, "a live grenade should out-score ordinary business");
  });

  it("never throws a grenade close enough to catch itself", () => {
    const near = enemy({ distance: 120 });
    const far = enemy({ distance: 500 });
    const p = profile({ grenadeUsage: 1 });

    assert.equal(actions.throwGrenadeAction.score(emptyContext({ enemies: [near] }), p, agentWith(near)), 0);
    assert.ok(actions.throwGrenadeAction.score(emptyContext({ enemies: [far] }), p, agentWith(far)) > 0);
  });

  it("just shoots when shooting is the better answer", () => {
    // A grenade that out-scored a clean shot would be a bot that never fires.
    const target = enemy({ distance: 420, visible: true });
    const context = emptyContext({ enemies: [target], visibleEnemies: [target], weaponEffectiveness: 1 });
    const p = profile({ grenadeUsage: 0.7 });

    const shoot = actions.attackAction.score(context, p, agentWith(target));
    const lob = actions.throwGrenadeAction.score(context, p, agentWith(target));

    assert.ok(shoot > lob, `expected shooting to win, ${shoot} vs ${lob}`);
  });

  it("reaches for one when the target has just gone behind cover", () => {
    // The one shot a rifle does not have. Attack scores nothing here, so the
    // comparison that matters is against giving chase.
    const hidden = enemy({ distance: 420, visible: false, ageMs: 250 });
    const context = emptyContext({ enemies: [hidden], visibleEnemies: [] });
    const p = profile({ grenadeUsage: 0.7 });

    const lob = actions.throwGrenadeAction.score(context, p, agentWith(hidden));
    const chase = actions.chaseAction.score(context, p, agentWith(hidden));

    assert.equal(actions.attackAction.score(context, p, agentWith(hidden)), 0);
    assert.ok(lob > chase, `expected the grenade to win, ${lob} vs ${chase}`);
  });

  it("reaches for one when two enemies are standing together", () => {
    const target = enemy({ sessionId: "e1", x: 900, distance: 420 });
    const friend = enemy({ sessionId: "e2", x: 960, distance: 470 });
    const alone = emptyContext({ enemies: [target], visibleEnemies: [target] });
    const crowd = emptyContext({
      enemies: [target, friend],
      visibleEnemies: [target, friend],
    });
    const p = profile({ grenadeUsage: 0.7 });

    const one = actions.throwGrenadeAction.score(alone, p, agentWith(target));
    const two = actions.throwGrenadeAction.score(crowd, p, agentWith(target));

    assert.ok(two > one + 10, `a cluster should be worth throwing at, ${two} vs ${one}`);
    assert.ok(
      two > actions.attackAction.score(crowd, p, agentWith(target)),
      "and worth more than shooting one of them",
    );
  });

  it("will not spend a grenade on a stale memory", () => {
    const stale = enemy({ distance: 500, visible: false, ageMs: 4000 });
    const context = emptyContext({ enemies: [stale], visibleEnemies: [] });

    assert.equal(actions.throwGrenadeAction.score(context, profile({ grenadeUsage: 1 }), agentWith(stale)), 0);
  });

  it("holds on to its last one a little harder", () => {
    const target = enemy({ distance: 500 });
    const p = profile({ grenadeUsage: 0.8 });
    const context = (grenades: number) =>
      emptyContext({ self: { ...emptyContext().self, grenades }, enemies: [target], visibleEnemies: [target] });

    const plenty = actions.throwGrenadeAction.score(context(3), p, agentWith(target));
    const last = actions.throwGrenadeAction.score(context(1), p, agentWith(target));

    assert.ok(last < plenty, `expected more hesitation with one left, ${last} vs ${plenty}`);
    assert.ok(last > 0, "but not a refusal");
  });

  it("will not throw a grenade it does not have", () => {
    const target = enemy({ distance: 500 });
    const context = emptyContext({ self: { ...emptyContext().self, grenades: 0 }, enemies: [target] });
    assert.equal(actions.throwGrenadeAction.score(context, profile({ grenadeUsage: 1 }), agentWith(target)), 0);
  });

  it("wants a better weapon in proportion to how badly the current one fits", () => {
    const pickup = { id: "p1", kind: "powerup" as const, powerUpId: "weapon-shotgun", x: 600, y: 500, distance: 200 };
    const armed = actions.getWeaponAction.score(
      emptyContext({ nearestWeaponPickup: pickup, weaponEffectiveness: 1 }),
      profile(),
      agentWith(null),
    );
    const outgunned = actions.getWeaponAction.score(
      emptyContext({ nearestWeaponPickup: pickup, weaponEffectiveness: 0 }),
      profile(),
      agentWith(null),
    );

    assert.ok(outgunned > armed);
  });

  it("only searches when there is nobody to see", () => {
    const visible = emptyContext({ visibleEnemies: [enemy()], enemies: [enemy()] });
    assert.equal(actions.searchEnemyAction.score(visible, profile(), agentWith(enemy())), 0);
    assert.ok(actions.searchEnemyAction.score(emptyContext(), profile(), agentWith(null)) > 0);
  });

  it("does nothing at all between matches", () => {
    const idle = emptyContext({ playing: false, enemies: [enemy()], visibleEnemies: [enemy()], grenadeDanger: 1 });
    for (const action of [
      actions.attackAction, actions.chaseAction, actions.retreatAction, actions.dodgeAction,
      actions.getPowerUpAction, actions.getWeaponAction, actions.throwGrenadeAction,
      actions.takePositionAction, actions.searchEnemyAction,
    ]) {
      assert.equal(action.score(idle, profile(), agentWith(enemy())), 0, `${action.id} scored outside a match`);
    }
  });
});

describe("the brain", () => {
  const steady = () => 0.5;

  function brainWith(scores: Record<string, number>) {
    const brain = new Brain(steady);
    for (const [id, score] of Object.entries(scores)) {
      brain.registerAction({ id, label: id, score: () => score, execute: () => {} });
    }
    return brain;
  }

  it("runs whatever is registered, and nothing it was not told about", () => {
    const brain = brainWith({ alpha: 10, beta: 40 });
    assert.deepEqual(brain.list().map((action) => action.id).sort(), ["alpha", "beta"]);

    const decision = brain.decide(emptyContext(), profile(), agentWith(null), 0);
    assert.equal(decision.action.id, "beta");
  });

  it("picks up an action registered later without any other change", () => {
    const brain = brainWith({ alpha: 10 });
    brain.registerAction({ id: "gamma", label: "gamma", score: () => 90, execute: () => {} });

    assert.equal(brain.decide(emptyContext(), profile(), agentWith(null), 0).action.id, "gamma");
  });

  it("holds an action for its minimum time, however tempting the alternative", () => {
    const brain = new Brain(steady);
    let betaScore = 0;
    brain.registerAction({ id: "alpha", label: "alpha", score: () => 50, execute: () => {} });
    brain.registerAction({ id: "beta", label: "beta", score: () => betaScore, execute: () => {} });

    const p = profile({ minimumActionMs: 800, actionSwitchThreshold: 5, currentActionBonus: 0, decisionNoise: 0 });
    assert.equal(brain.decide(emptyContext(), p, agentWith(null), 0).action.id, "alpha");

    betaScore = 500;
    assert.equal(
      brain.decide(emptyContext(), p, agentWith(null), 400).action.id,
      "alpha",
      "too soon to change its mind",
    );
    assert.equal(brain.decide(emptyContext(), p, agentWith(null), 900).action.id, "beta");
  });

  it("does not swap for an alternative that is barely better", () => {
    // The flicker this prevents -- attack, retreat, attack, retreat -- is the
    // single most recognisable failure of an unsmoothed utility system.
    const brain = new Brain(steady);
    brain.registerAction({ id: "alpha", label: "alpha", score: () => 50, execute: () => {} });
    brain.registerAction({ id: "beta", label: "beta", score: () => 56, execute: () => {} });

    const p = profile({ minimumActionMs: 0, actionSwitchThreshold: 10, currentActionBonus: 5, decisionNoise: 0 });
    assert.equal(brain.decide(emptyContext(), p, agentWith(null), 0).action.id, "beta", "beta leads at the start");

    // Now alpha is the incumbent, and beta's six-point lead is not enough.
    const held = new Brain(steady);
    held.registerAction({ id: "alpha", label: "alpha", score: () => 50, execute: () => {} });
    assert.equal(held.decide(emptyContext(), p, agentWith(null), 0).action.id, "alpha");
    held.registerAction({ id: "beta", label: "beta", score: () => 56, execute: () => {} });
    assert.equal(held.decide(emptyContext(), p, agentWith(null), 1000).action.id, "alpha");
  });

  it("lets an action clean up when it is dropped", () => {
    // A bot dies mid-action several times a match, and the exit hook runs every
    // time. Anything less than a real agent here is a crash waiting for the
    // first death.
    const brain = new Brain(steady);
    let exited: unknown = "never called";
    brain.registerAction({
      id: "alpha",
      label: "alpha",
      score: () => 50,
      execute: () => {},
      onExit: (agent) => {
        exited = agent;
      },
    });

    const agent = agentWith(null);
    brain.decide(emptyContext(), profile(), agent, 0);
    brain.reset(agent);

    assert.equal(exited, agent, "the exit hook must be handed the agent it belongs to");
    assert.equal(brain.currentAction, null);
  });

  it("reports every score, so a console can show why the winner won", () => {
    const brain = brainWith({ alpha: 10, beta: 40 });
    const decision = brain.decide(emptyContext(), profile({ decisionNoise: 0 }), agentWith(null), 0);

    assert.equal(decision.scores.length, 2);
    assert.equal(decision.scores.filter((entry) => entry.chosen).length, 1);
  });

  it("separates two identical bots with noise, without making either stupid", () => {
    let counter = 0;
    const varied = () => ((counter++ * 0.37) % 1);

    const brain = new Brain(varied);
    brain.registerAction({ id: "alpha", label: "alpha", score: () => 50, execute: () => {} });
    brain.registerAction({ id: "nonsense", label: "nonsense", score: () => 5, execute: () => {} });

    // Noise of 8 points cannot bridge a 45-point gap, however it falls.
    const p = profile({ decisionNoise: 8, minimumActionMs: 0, actionSwitchThreshold: 0, currentActionBonus: 0 });
    for (let i = 0; i < 50; i++) {
      assert.equal(brain.decide(emptyContext(), p, agentWith(null), i * 100).action.id, "alpha");
    }
  });
});

describe("memory", () => {
  it("remembers where somebody went, and forgets in its own time", () => {
    const memory = new Memory();
    memory.see(enemy({ x: 900, y: 400 }), 1000);

    assert.equal(memory.recall(2000, 3000).length, 1, "still remembered");
    assert.equal(memory.recall(2000, 3000)[0]!.lastSeenX, 900);
    assert.equal(memory.recall(5000, 3000).length, 0, "forgotten once it is stale");
  });

  it("gives a longer memory to the personality configured for one", () => {
    const memory = new Memory();
    memory.see(enemy(), 0);

    const hunter = listBrainProfiles().find((entry) => entry.id === "hunter")!;
    const berserker = listBrainProfiles().find((entry) => entry.id === "berserker")!;

    assert.ok(hunter.memoryDurationMs > berserker.memoryDurationMs);
    assert.equal(memory.recall(2000, berserker.memoryDurationMs).length, 0);

    memory.see(enemy(), 0);
    assert.equal(memory.recall(2000, hunter.memoryDurationMs).length, 1);
  });

  it("overwrites rather than accumulating", () => {
    const memory = new Memory();
    memory.see(enemy({ x: 100 }), 0);
    memory.see(enemy({ x: 700 }), 500);

    assert.equal(memory.size, 1);
    assert.equal(memory.get("e1")?.lastSeenX, 700);
  });
});

describe("hearing the fight", () => {
  it("a bullet in earshot leaves a lead at the bullet, not at the shooter", () => {
    const memory = new Memory();
    memory.hear("e1", "Enemy", 500, 300, 1000);

    const remembered = memory.recall(2000, 10000);
    assert.equal(remembered.length, 1);
    assert.equal(remembered[0]!.lastSeenX, 500, "the lead is where the sound was");
  });

  it("never overwrites a fresh sighting with a vague sound", () => {
    // Seeing somebody pins them exactly; the bullet they fired a moment later
    // must not smear that knowledge back along its own flight path.
    const memory = new Memory();
    memory.see(enemy({ sessionId: "e1", x: 800, y: 500 }), 1000);
    memory.hear("e1", "Enemy", 300, 300, 1200);

    const remembered = memory.recall(1300, 10000);
    assert.equal(remembered[0]!.lastSeenX, 800, "the sighting outranks the sound");
  });

  it("does update knowledge that has gone stale", () => {
    const memory = new Memory();
    memory.see(enemy({ sessionId: "e1", x: 800, y: 500 }), 1000);
    memory.hear("e1", "Enemy", 300, 300, 5000);

    const remembered = memory.recall(5100, 10000);
    assert.equal(remembered[0]!.lastSeenX, 300, "old knowledge yields to a new sound");
  });
});

describe("target selection", () => {
  const selector = new TargetSelector();

  it("does not simply pick the nearest", () => {
    const near = enemy({ sessionId: "near", distance: 200, health: 1 });
    const wounded = enemy({ sessionId: "wounded", distance: 420, health: 0.12 });
    const context = emptyContext({ enemies: [near, wounded], visibleEnemies: [near, wounded] });

    const hunter = listBrainProfiles().find((entry) => entry.id === "hunter")!;
    assert.equal(selector.pick(context, hunter, 1100)?.sessionId, "wounded");
  });

  it("picks a different enemy for a personality that ignores the wounded", () => {
    // The same two enemies, and the choice genuinely flips: one personality is
    // drawn to the hurt one across the room, the other takes what is in front
    // of it. This is the behaviour separating targeting from acting buys.
    const near = enemy({ sessionId: "near", distance: 200, health: 1 });
    const wounded = enemy({ sessionId: "wounded", distance: 700, health: 0.2 });
    const context = emptyContext({ enemies: [near, wounded], visibleEnemies: [near, wounded] });

    const hunter = listBrainProfiles().find((entry) => entry.id === "hunter")!;
    const coward = listBrainProfiles().find((entry) => entry.id === "coward")!;

    assert.equal(selector.pick(context, hunter, 1100)?.sessionId, "wounded");
    assert.equal(selector.pick(context, coward, 1100)?.sessionId, "near");
  });

  it("weighs a wounded enemy more heavily for the personality built to", () => {
    const near = enemy({ sessionId: "near", distance: 200, health: 1 });
    const wounded = enemy({ sessionId: "wounded", distance: 700, health: 0.2 });
    const context = emptyContext({ enemies: [near, wounded], visibleEnemies: [near, wounded] });

    const gap = (entry: BrainProfile) => {
      const ranked = selector.rank(context, entry, 1100);
      const woundedScore = ranked.find((row) => row.enemy.sessionId === "wounded")!.score;
      const nearScore = ranked.find((row) => row.enemy.sessionId === "near")!.score;
      return woundedScore - nearScore;
    };

    const hunter = listBrainProfiles().find((entry) => entry.id === "hunter")!;
    const rusher = listBrainProfiles().find((entry) => entry.id === "rusher")!;

    assert.ok(gap(hunter) > gap(rusher), "a hunter should be pulled harder towards the wounded one");
  });

  it("prefers somebody it can see to somebody it only remembers", () => {
    const seen = enemy({ sessionId: "seen", distance: 500 });
    const remembered = enemy({ sessionId: "gone", distance: 480, visible: false, ageMs: 2000 });
    const context = emptyContext({ enemies: [seen, remembered], visibleEnemies: [seen] });

    assert.equal(selector.pick(context, profile(), 1100)?.sessionId, "seen");
  });

  it("has nothing to pick when nothing is known", () => {
    assert.equal(selector.pick(emptyContext(), profile(), 1100), null);
  });
});

describe("navigation", () => {
  it("finds standing room on the shipped arena", () => {
    const harness = createHarness();
    const graph = new NavGraph(harness.arena, harness.context.world, getPlayerConfig());

    assert.ok(graph.size > 50, `expected a useful graph, got ${graph.size} nodes`);
  });

  it("routes between two platforms", () => {
    const harness = createHarness();
    const graph = new NavGraph(harness.arena, harness.context.world, getPlayerConfig());

    const from = graph.nearest(300, 1700);
    const to = graph.nearest(2900, 1600);
    const path = graph.findPath(from, to);

    assert.ok(path.length > 1, "expected a route across the arena");
    assert.equal(path[0], from);
    assert.equal(path.at(-1), to);
  });

  it("only links jumps the configured movement can actually make", () => {
    // Halving the jump strength has to narrow the graph, or bots keep trying
    // gaps they can no longer clear.
    const arena = createEmptyArena("nav-test", "Nav Test", 2000, 1400);
    // A staircase of ledges, each a little higher than the last.
    for (let i = 0; i < 6; i++) {
      arena.elements.push({
        id: `step-${i}`,
        type: "platform",
        x: 200 + i * 260,
        y: 1200 - i * 90,
        width: 200,
        height: 20,
      });
    }

    const world = new CollisionWorld(arena);
    const strong = new NavGraph(arena, world, { ...getPlayerConfig(), jumpVelocity: 900 });
    const weak = new NavGraph(arena, world, { ...getPlayerConfig(), jumpVelocity: 260 });

    const countJumps = (graph: InstanceType<typeof NavGraph>) =>
      graph.links.flat().filter((link) => link.kind === "jump").length;

    assert.ok(countJumps(strong) > countJumps(weak), "a weaker jump should mean fewer jump links");
  });

  it("walks around the spikes rather than through them", () => {
    // A corridor with a strip of spikes across the middle and a clear detour
    // above it. Both routes exist; only one of them hurts.
    const arena = createEmptyArena("hazard-test", "Hazard Test", 2400, 1400);
    arena.elements.push(
      { id: "floor", type: "floor", x: 100, y: 1200, width: 2200, height: 40 },
      { id: "ledge", type: "platform", x: 800, y: 1010, width: 900, height: 20 },
    );
    // Wider than a jump can clear, so going over the ledge is the only way
    // across that does not involve standing in it.
    arena.traps.push({
      id: "spikes",
      type: "spikes",
      x: 900,
      y: 1160,
      width: 700,
      height: 40,
      enabled: true,
      activation: TrapActivation.ALWAYS,
      damage: null,
      activationDelayMs: null,
      activeDurationMs: null,
      cooldownMs: null,
      moveSpeed: null,
      triggerRadius: null,
      params: {},
    });

    const world = new CollisionWorld(arena);
    const graph = new NavGraph(arena, world, getPlayerConfig());

    const from = graph.nearest(300, 1160);
    const to = graph.nearest(2100, 1160);
    const path = graph.findPath(from, to);
    assert.ok(path.length > 1, "expected a route at all");

    // Not one step of it stands where the spikes can reach.
    const through = path.filter((index) => graph.nodes[index]!.hazardous);
    assert.deepEqual(through, [], "the route should not stand in the spikes");

    // And it is genuinely a detour: without the spikes the same trip is a walk
    // straight along the floor, and with them it leaves that floor to get past.
    const clear = createEmptyArena("hazard-test", "Hazard Test", 2400, 1400);
    clear.elements.push(...arena.elements);
    const clearGraph = new NavGraph(clear, new CollisionWorld(clear), getPlayerConfig());
    const clearPath = clearGraph.findPath(
      clearGraph.nearest(300, 1160),
      clearGraph.nearest(2100, 1160),
    );

    const stayedOnTheFloor = (g: InstanceType<typeof NavGraph>, route: number[]) =>
      route.every((index) => g.nodes[index]!.surfaceId === "floor");

    assert.ok(stayedOnTheFloor(clearGraph, clearPath), "without spikes it is a straight walk");
    assert.equal(stayedOnTheFloor(graph, path), false, "with them it should go around");
  });

  it("still goes through when there is no way round", () => {
    // A cost, not a wall: an arena is allowed to put the only route through a
    // fire vent, and a bot that refused to move would be worse than one that
    // takes the risk.
    const arena = createEmptyArena("only-way", "Only Way", 2000, 1400);
    arena.elements.push({ id: "floor", type: "floor", x: 100, y: 1200, width: 1800, height: 40 });
    arena.traps.push({
      id: "fire",
      type: "fire",
      x: 900,
      y: 1160,
      width: 200,
      height: 40,
      enabled: true,
      activation: TrapActivation.ALWAYS,
      damage: null,
      activationDelayMs: null,
      activeDurationMs: null,
      cooldownMs: null,
      moveSpeed: null,
      triggerRadius: null,
      params: {},
    });

    const graph = new NavGraph(arena, new CollisionWorld(arena), getPlayerConfig());
    const path = graph.findPath(graph.nearest(300, 1160), graph.nearest(1700, 1160));

    assert.ok(path.length > 1, "a dangerous route still beats no route");
  });

  it("costs a hazardous step without forbidding it", () => {
    const arena = createEmptyArena("cost", "Cost", 2000, 1400);
    arena.elements.push({ id: "floor", type: "floor", x: 100, y: 1200, width: 1800, height: 40 });

    /** The cheapest way to step along the floor, whatever else the shell has. */
    const cheapestFloorStep = (graph: InstanceType<typeof NavGraph>) => {
      let best = Infinity;
      graph.nodes.forEach((node, index) => {
        if (node.surfaceId !== "floor") return;
        for (const link of graph.links[index] ?? []) {
          if (graph.nodes[link.to]!.surfaceId !== "floor") continue;
          best = Math.min(best, link.cost);
        }
      });
      return best;
    };

    const safe = new NavGraph(arena, new CollisionWorld(arena), getPlayerConfig());
    const cheapest = cheapestFloorStep(safe);

    arena.traps.push({
      id: "spikes",
      type: "spikes",
      x: 100,
      y: 1160,
      width: 1800,
      height: 40,
      enabled: true,
      activation: TrapActivation.ALWAYS,
      damage: null,
      activationDelayMs: null,
      activeDurationMs: null,
      cooldownMs: null,
      moveSpeed: null,
      triggerRadius: null,
      params: {},
    });

    const risky = new NavGraph(arena, new CollisionWorld(arena), getPlayerConfig());
    const dearest = cheapestFloorStep(risky);

    assert.ok(risky.links.flat().length > 0, "the links should still exist");
    assert.ok(dearest > cheapest + 500, `a hazard should cost real detour, ${cheapest} -> ${dearest}`);
  });

  it("ignores a trap that is switched off", () => {
    const arena = createEmptyArena("disabled", "Disabled", 2000, 1400);
    arena.elements.push({ id: "floor", type: "floor", x: 100, y: 1200, width: 1800, height: 40 });
    arena.traps.push({
      id: "spikes",
      type: "spikes",
      x: 900,
      y: 1160,
      width: 200,
      height: 40,
      enabled: false,
      activation: TrapActivation.ALWAYS,
      damage: null,
      activationDelayMs: null,
      activeDurationMs: null,
      cooldownMs: null,
      moveSpeed: null,
      triggerRadius: null,
      params: {},
    });

    const graph = new NavGraph(arena, new CollisionWorld(arena), getPlayerConfig());
    assert.equal(graph.nodes.some((node) => node.hazardous), false);
  });

  it("returns nothing rather than a wrong answer when there is no route", () => {
    const arena = createEmptyArena("empty", "Empty");
    const graph = new NavGraph(arena, new CollisionWorld(arena), getPlayerConfig());
    assert.deepEqual(graph.findPath(-1, 4), []);
  });
});

describe("perception", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  function perceive(selfId: string, memory = new Memory(), now = 0) {
    const perception = new Perception(harness.context);
    const self = harness.state.players.get(selfId)!;
    const runtime = harness.runtimes.get(selfId)!;
    return perception.build(self, runtime, memory, profile(), now, 0.8);
  }

  it("sees an enemy standing in the open", () => {
    harness.addPlayer("bot", 600, 1700);
    harness.addPlayer("target", 800, 1700);

    const context = perceive("bot");
    assert.equal(context.visibleEnemies.length, 1);
    assert.equal(context.nearestEnemy?.sessionId, "target");
    assert.ok(context.nearestEnemy!.distance > 0);
  });

  it("notices a hazard well before it is standing in one", () => {
    // Perception's job is to see it coming. At 220px and running speed a bot had
    // about two thirds of a second to notice, decide and stop -- which is how
    // they ended up walking into spikes they had every right to have seen.
    const arena = createEmptyArena("hazard", "Hazard");
    arena.traps = [
      {
        id: "spikes",
        type: "spikes",
        x: 1000,
        y: 1690,
        width: 120,
        height: 40,
        enabled: true,
        activation: TrapActivation.ALWAYS,
        damage: null,
        activationDelayMs: null,
        activeDurationMs: null,
        cooldownMs: null,
        moveSpeed: null,
        triggerRadius: null,
        params: {},
      },
    ];
    harness.loadTraps(arena);
    harness.stepTraps(0.05, 0);

    harness.addPlayer("bot", 620, 1700);
    const seen = perceive("bot");

    assert.equal(seen.traps.length, 1, "a hazard 400px ahead should be noticed");
  });

  it("is not frightened of a hazard it is merely aware of", () => {
    // Seeing further must not turn scenery into panic: what a bot knows about
    // and what it is afraid of are two different radii.
    const arena = createEmptyArena("hazard", "Hazard");
    const trap = {
      id: "spikes",
      type: "spikes",
      x: 1000,
      y: 1690,
      width: 120,
      height: 40,
      enabled: true,
      activation: TrapActivation.ALWAYS,
      damage: null,
      activationDelayMs: null,
      activeDurationMs: null,
      cooldownMs: null,
      moveSpeed: null,
      triggerRadius: null,
      params: {},
    };
    arena.traps = [trap];
    harness.loadTraps(arena);
    harness.stepTraps(0.05, 0);

    harness.addPlayer("far", 620, 1700);
    harness.addPlayer("near", 1060, 1700);

    const distant = perceive("far").trapDanger;
    const close = perceive("near").trapDanger;

    assert.ok(close > distant * 3, `standing on it should be the frightening one, ${close} vs ${distant}`);
    assert.ok(distant < 0.25, "and a hazard across the room should barely register");
  });

  it("does not see through a wall", () => {
    // The Foundry has a tall wall at x=820 running from y=1260 down to the floor.
    harness.addPlayer("bot", 700, 1700);
    harness.addPlayer("target", 950, 1700);

    assert.equal(perceive("bot").visibleEnemies.length, 0, "a wall should hide them");
  });

  it("does not see past its own sight range", () => {
    harness.addPlayer("bot", 200, 1700);
    harness.addPlayer("target", 200 + getNpcConfig().sightRange + 400, 1700);

    assert.equal(perceive("bot").visibleEnemies.length, 0);
  });

  it("ignores the dead", () => {
    harness.addPlayer("bot", 600, 1700);
    const target = harness.addPlayer("target", 800, 1700);
    target.alive = false;

    assert.equal(perceive("bot").visibleEnemies.length, 0);
  });

  it("keeps an enemy in mind after they break line of sight", () => {
    harness.addPlayer("bot", 700, 1700);
    const target = harness.addPlayer("target", 760, 1700);
    const memory = new Memory();

    assert.equal(perceive("bot", memory, 0).visibleEnemies.length, 1);

    // Behind the wall now.
    target.x = 950;
    const later = perceive("bot", memory, 500);

    assert.equal(later.visibleEnemies.length, 0, "no longer seen");
    assert.equal(later.enemies.length, 1, "but still known about");
    assert.equal(later.enemies[0]!.visible, false);
    assert.equal(later.enemies[0]!.x, 760, "remembered where they were, not where they are");
  });

  it("never learns what is inside a crate", () => {
    // The whole point of a crate is that nobody can see through it; a bot that
    // could would be cheating in exactly the way the design forbids.
    harness.addPlayer("bot", 600, 1700);
    const spawned = harness.powerUps.debugSpawnCrate(null, 0);
    assert.ok(spawned, "expected a crate to spawn");

    const crates = perceive("bot").items.filter((item) => item.kind === "crate");
    for (const crate of crates) assert.equal(crate.powerUpId, null);
  });

  it("raises the alarm for a grenade nearby and ignores one far away", () => {
    const bot = harness.addPlayer("bot", 600, 1700);
    harness.addPlayer("thrower", 700, 1700);

    const near = perceive("bot");
    assert.equal(near.grenadeDanger, 0, "nothing thrown yet");

    // Drop one at the bot's feet through the real system.
    const runtime = harness.runtimes.get("thrower")!;
    const thrower = harness.state.players.get("thrower")!;
    thrower.grenades = 1;
    harness.grenades.processInput(thrower, runtime, throwInput(true, Math.PI), 0);
    runtime.lastInput.chargeGrenade = true;
    harness.grenades.processInput(thrower, runtime, throwInput(false, Math.PI), 50);

    assert.ok(harness.state.grenades.size > 0, "expected a grenade in flight");
    assert.ok(perceive("bot").grenadeDanger > 0, "a grenade at your feet should register");
    void bot;
  });

  it("reports its own condition normalised", () => {
    const bot = harness.addPlayer("bot", 600, 1700);
    bot.health = MAX_HEALTH / 2;

    const context = perceive("bot");
    assert.ok(Math.abs(context.self.health - 0.5) < 0.01);
    assert.equal(clamp01(context.self.ammo), context.self.ammo);
  });

  it("rates a melee weapon as useless at range and decisive up close", () => {
    // Both on the open floor left of the Foundry's tall wall, so line of sight
    // is not what is being measured here.
    const bot = harness.addPlayer("bot", 200, 1700);
    harness.weapons.equip(bot, harness.runtimes.get("bot")!, "chainsaw");
    const other = harness.addPlayer("other", 700, 1700);

    assert.ok(perceive("bot").visibleEnemies.length === 1, "expected a clear line of sight");
    assert.ok(perceive("bot").weaponEffectiveness < 0.2, "a chainsaw across the room is no use");

    other.x = 240;
    assert.ok(perceive("bot").weaponEffectiveness > 0.4, "and lethal in contact");
  });
});

/** One input command shaped for the grenade system. */
function throwInput(charging: boolean, aimAngle: number) {
  return {
    seq: charging ? 1 : 2,
    moveLeft: false,
    moveRight: false,
    jump: false,
    fire: false,
    reload: false,
    chargeGrenade: charging,
    aimAngle,
  };
}

/** Just enough of a player to place one; the harness owns the real type. */
type PlayerStateLike = { sessionId: string; x: number; y: number; health: number };

describe("bots in a real match", () => {
  /** A lobby with one human and two bots, run through the actual match path. */
  function startMatch(profiles: [string, string]): Harness {
    const config = cloneConfig(getGameConfig());
    config.npc.enabled = true;

    const harness = createHarness();
    harness.replaceConfig(config);
    harness.state.matchState = MatchState.WAITING;

    const human = harness.addPlayer("human", 400, 1700);
    human.connected = true;
    human.alive = false;
    human.inMatch = false;
    harness.state.hostId = "human";

    harness.npcs.spawn(profiles[0]);
    harness.npcs.spawn(profiles[1]);

    // The room does not start itself. The host says when, exactly as a person
    // does, and the match manager takes it from there.
    harness.matchManager.requestStart();

    // Long enough for the countdown to elapse and the match manager to spawn
    // everybody the way it does for people.
    harness.run(8);
    return harness;
  }

  it("joins the lobby, starts the match and spawns like anyone else", () => {
    const harness = startMatch(["aggressive", "rusher"]);

    assert.equal(harness.state.matchState, MatchState.PLAYING);
    // Everybody was *put into* the match. Not everybody is still alive: the
    // human here is a dummy that never moves or shoots, and two bots need
    // rather less than the eight seconds this runs for.
    assert.equal(harness.state.players.size, 3, "a human and two bots");
    for (const player of harness.state.players.values()) {
      assert.equal(player.inMatch, true, `${player.sessionId} was left out of the match`);
    }

    for (const agent of harness.npcs.list()) {
      const player = harness.state.players.get(agent.sessionId)!;
      assert.equal(player.alive, true);
      assert.equal(player.inMatch, true);
      assert.equal(player.bot, true);
      assert.ok(player.weaponId, "spawned with a weapon like everyone else");
    }
  });

  it("moves under its own power, through the ordinary input queue", () => {
    const harness = startMatch(["aggressive", "rusher"]);
    const ids = harness.npcs.list().map((agent) => agent.sessionId);

    // Ground covered, not net displacement: a bot that chases somebody across
    // the arena and is shoved back by their return fire has been moving the
    // whole time even if it finishes where it started.
    const travelled = new Map(ids.map((id) => [id, 0]));
    const previous = new Map(ids.map((id) => [id, harness.state.players.get(id)!.x]));

    // Sampled finely, because what a fighting bot mostly does is strafe -- and
    // with everybody kept alive, because the wide sight range means the fight
    // is real from the first second, and a corpse covers no ground however
    // well its input queue works.
    for (let step = 0; step < 24; step++) {
      harness.run(0.25);
      for (const id of ids) {
        const player = harness.state.players.get(id)!;
        player.health = MAX_HEALTH;
        player.alive = true;
        travelled.set(id, travelled.get(id)! + Math.abs(player.x - previous.get(id)!));
        previous.set(id, player.x);
      }
    }

    const moved = [...travelled.values()].filter((distance) => distance > 150);
    assert.ok(moved.length > 0, `expected a bot to cover ground, travelled: ${JSON.stringify([...travelled])}`);

    // The proof that it went through the same door a browser's input does.
    for (const agent of harness.npcs.list()) {
      const runtime = harness.runtimes.get(agent.sessionId)!;
      assert.ok(runtime.highestAcceptedSeq > 0, "no input was ever accepted for this bot");
    }
  });

  /**
   * Put the two bots in each other's faces on the open floor.
   *
   * The Foundry is three lanes divided by walls and a bot can see 1100px, so two
   * of them left to wander may genuinely not meet inside a short test. Placing
   * them is the difference between testing the brain and testing the map.
   */
  function faceOff(harness: Harness): PlayerStateLike[] {
    const players = harness.npcs.list().map((agent) => harness.state.players.get(agent.sessionId)!);
    const positions = [500, 760];

    players.forEach((player, index) => {
      player.x = positions[index] ?? 500;
      player.y = 1700;
      const runtime = harness.runtimes.get(player.sessionId)!;
      runtime.movement.x = player.x;
      runtime.movement.y = player.y;
    });

    return players;
  }

  it("chooses more than one kind of action once there is somebody to fight", () => {
    // A bot that only ever searches is a bot whose scoring is broken, and it
    // looks fine from the outside until you watch one for a minute.
    const harness = startMatch(["aggressive", "hunter"]);
    faceOff(harness);

    const chosen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      harness.run(0.5);
      for (const agent of harness.npcs.list()) {
        const action = agent.brain.currentAction?.id;
        if (action) chosen.add(action);
      }
    }

    assert.ok(chosen.size >= 2, `expected varied behaviour, saw only ${[...chosen]}`);
  });

  it("finds somebody and shoots them", () => {
    const harness = startMatch(["berserker", "aggressive"]);

    faceOff(harness);
    harness.run(6);

    /*
     * A hit a bot landed on somebody, rather than a health bar that went down
     * between two readings. The old measurement counted any drop at all, so a
     * bot that stood in the spikes and blew itself up read as a bot that found
     * an enemy and shot it -- and it read a match already decided inside the
     * eight seconds `startMatch` runs as a fight that never happened, since
     * nothing changes once everyone has stopped.
     */
    const bots = new Set(harness.npcs.list().map((agent) => agent.sessionId));
    const landed = harness.damage.filter(
      (record) => bots.has(record.attackerId) && record.attackerId !== record.victimId,
    );

    assert.ok(landed.length > 0, "expected a bot to find somebody and land a shot on them");
  });

  it("keeps its distance according to its personality", () => {
    // A rusher wants to be in your face; a camper does not. Same brain, same
    // situation, different number.
    const rusher = listBrainProfiles().find((entry) => entry.id === "rusher")!;
    const camper = listBrainProfiles().find((entry) => entry.id === "camper")!;
    assert.ok(rusher.preferredDistance < camper.preferredDistance);
  });

  it("takes bots out again when they are switched off", () => {
    const harness = startMatch(["aggressive", "rusher"]);
    assert.equal(harness.npcs.count, 2);

    const config = cloneConfig(getGameConfig());
    config.npc.enabled = false;
    harness.replaceConfig(config);

    // Bots are only added and removed between matches; end this one first.
    harness.state.matchState = MatchState.WAITING;
    harness.run(2);

    assert.equal(harness.npcs.count, 0);
    for (const player of harness.state.players.values()) {
      assert.equal(player.bot, false, "no bot should be left in the room");
    }
  });

  it("never leaves a bot behind when the room is torn down", () => {
    const harness = startMatch(["aggressive", "rusher"]);
    const ids = harness.npcs.list().map((agent) => agent.sessionId);

    harness.npcs.removeAll();

    assert.equal(harness.npcs.count, 0);
    for (const id of ids) {
      assert.equal(harness.state.players.get(id), undefined, "state entry left behind");
      assert.equal(harness.runtimes.get(id), undefined, "runtime left behind");
    }
  });
});

describe("the room and its host", () => {
  /** A waiting room with `people` people in it, the first of them the host. */
  function room(people: number, overrides: Partial<{ enabled: boolean }> = {}) {
    const config = cloneConfig(getGameConfig());
    config.npc.enabled = overrides.enabled ?? true;

    const harness = createHarness();
    harness.replaceConfig(config);
    harness.state.matchState = MatchState.WAITING;

    for (let index = 0; index < people; index++) {
      const player = harness.addPlayer(`human-${index}`, 400 + index * 40, 1700);
      player.connected = true;
      player.alive = false;
      player.inMatch = false;
    }
    // The room's own host bookkeeping lives in BattleRoom; the harness stands in
    // for it by naming the first arrival, which is the same rule.
    if (people > 0) harness.state.hostId = "human-0";
    return harness;
  }

  it("does not start itself, however long it waits", () => {
    // The rule this replaces: a room that filled to a magic number began on its
    // own. A room now belongs to somebody, and it waits for them.
    const harness = room(2);

    harness.run(20);

    assert.equal(harness.state.matchState, MatchState.WAITING);
  });

  it("starts when the host says so", () => {
    const harness = room(2);

    assert.equal(harness.matchManager.requestStart(), true);
    harness.run(8);

    assert.equal(harness.state.matchState, MatchState.PLAYING);
    assert.equal(harness.state.startingPlayerCount, 2, "two people is a match");
  });

  it("refuses to start a match of one", () => {
    const harness = room(1);

    assert.equal(harness.state.canStart, false);
    assert.equal(harness.matchManager.requestStart(), false);

    harness.run(8);
    assert.equal(harness.state.matchState, MatchState.WAITING);
  });

  it("starts one person and one bot", () => {
    // The smallest match worth having, and the reason a bot exists at all.
    const harness = room(1);
    assert.equal(harness.npcs.addBot("human-0", 3), true);

    assert.equal(harness.matchManager.requestStart(), true);
    harness.run(8);

    assert.equal(harness.state.matchState, MatchState.PLAYING);
    assert.equal(harness.state.startingPlayerCount, 2);
  });

  it("never starts a room of bots", () => {
    // There is nobody to play it. The bots are cleared instead, which recycles
    // the room rather than leaving a server simulating a fight nobody is in.
    const harness = room(1);
    harness.npcs.addBot("human-0", 3);
    harness.state.players.delete("human-0");
    harness.runtimes.delete("human-0");

    harness.run(4);

    assert.equal(harness.npcs.count, 0);
    assert.equal(harness.state.matchState, MatchState.WAITING);
  });

  it("starts by itself only when the room is full", () => {
    // Nothing left to wait for: every place is taken, so there is nobody the
    // host could still be holding it open for.
    const harness = room(1);
    const max = DEFAULT_GAME_CONFIG.match.maxPlayers;
    while (harness.state.players.size < max) harness.npcs.addBot("human-0", 3);

    harness.run(8);

    assert.equal(harness.state.players.size, max);
    assert.equal(harness.state.matchState, MatchState.PLAYING);
  });

  it("publishes whether starting is possible at all", () => {
    const harness = room(1);
    harness.run(1);
    assert.equal(harness.state.canStart, false, "one player is not a match");

    harness.npcs.addBot("human-0", 3);
    harness.run(1);
    assert.equal(harness.state.canStart, true);
  });
});

describe("adding bots to a room", () => {
  function room(people = 1) {
    const config = cloneConfig(getGameConfig());
    config.npc.enabled = true;

    const harness = createHarness();
    harness.replaceConfig(config);
    harness.state.matchState = MatchState.WAITING;
    for (let index = 0; index < people; index++) {
      const player = harness.addPlayer(`human-${index}`, 400 + index * 40, 1700);
      player.connected = true;
      player.alive = false;
      player.inMatch = false;
    }
    harness.state.hostId = "human-0";
    return harness;
  }

  it("adds one bot at a time, at the difficulty asked for", () => {
    const harness = room();

    assert.equal(harness.npcs.addBot("human-0", 1), true);
    assert.equal(harness.npcs.addBot("human-0", 4), true);

    const levels = harness.npcs.list().map((agent) => agent.difficulty.level);
    assert.deepEqual(levels, [1, 4], "each bot keeps its own difficulty");
  });

  it("puts the difficulty on the bot itself, for the lobby to show", () => {
    const harness = room();
    harness.npcs.addBot("human-0", 2);

    const bot = harness.npcs.list()[0]!;
    const player = harness.state.players.get(bot.sessionId)!;

    assert.equal(player.bot, true);
    assert.equal(player.botDifficulty, 2);
    assert.equal(player.botDifficultyName, "Easy");
  });

  it("clamps a difficulty the ladder does not have", () => {
    const harness = room();
    harness.npcs.addBot("human-0", 99);
    harness.npcs.addBot("human-0", -4);

    const levels = harness.npcs.list().map((agent) => agent.difficulty.level);
    assert.deepEqual(levels, [MAX_BOT_DIFFICULTY, MIN_BOT_DIFFICULTY]);
  });

  it("removes one bot without touching the others", () => {
    const harness = room();
    harness.npcs.addBot("human-0", 1);
    harness.npcs.addBot("human-0", 5);
    const [first, second] = harness.npcs.list();

    assert.equal(harness.npcs.removeBot("human-0", first!.sessionId), true);

    assert.equal(harness.npcs.count, 1);
    assert.equal(harness.npcs.list()[0]!.sessionId, second!.sessionId);
    assert.equal(harness.state.players.get(first!.sessionId), undefined, "state entry left behind");
    assert.equal(harness.runtimes.get(first!.sessionId), undefined, "runtime left behind");
  });

  it("will not fill the last place, so a room is never all bots", () => {
    const harness = room();
    for (let attempt = 0; attempt < 20; attempt++) harness.npcs.addBot("human-0", 3);

    assert.equal(harness.state.players.size, DEFAULT_GAME_CONFIG.match.maxPlayers);
    assert.equal(harness.npcs.count, DEFAULT_GAME_CONFIG.match.maxPlayers - 1);
    assert.equal(harness.npcs.addBot("human-0", 3), false, "the room is full");
  });

  it("belongs to the host and nobody else", () => {
    const harness = room(2);
    harness.npcs.addBot("human-0", 3);
    const bot = harness.npcs.list()[0]!;

    assert.equal(harness.npcs.addBot("human-1", 3), false, "a guest may not add bots");
    assert.equal(harness.npcs.removeBot("human-1", bot.sessionId), false, "nor remove them");
    assert.equal(harness.npcs.addBot("nobody-in-particular", 3), false);
    assert.equal(harness.npcs.count, 1);
  });

  it("refuses a bot asking on its own behalf", () => {
    const harness = room();
    harness.npcs.addBot("human-0", 3);
    const bot = harness.npcs.list()[0]!;

    assert.equal(harness.npcs.addBot(bot.sessionId, 5), false);
    assert.equal(harness.npcs.removeBot(bot.sessionId, bot.sessionId), false);
  });

  it("removes bots and nothing else", () => {
    // People leave by leaving. A host cannot evict a guest this way.
    const harness = room(2);

    assert.equal(harness.npcs.removeBot("human-0", "human-1"), false);
    assert.ok(harness.state.players.get("human-1"), "a person was removed as though they were a bot");
  });

  it("leaves a running match alone", () => {
    const harness = room();
    harness.npcs.addBot("human-0", 3);
    harness.matchManager.requestStart();
    harness.run(8);
    assert.equal(harness.state.matchState, MatchState.PLAYING);

    const before = harness.npcs.count;
    assert.equal(harness.npcs.addBot("human-0", 3), false, "a free spawn mid-fight");
    assert.equal(
      harness.npcs.removeBot("human-0", harness.npcs.list()[0]!.sessionId),
      false,
      "removing one mid-match would look like a disconnect",
    );
    assert.equal(harness.npcs.count, before);
  });

  it("adds nothing when bots are switched off entirely", () => {
    const config = cloneConfig(getGameConfig());
    config.npc.enabled = false;

    const harness = createHarness();
    harness.replaceConfig(config);
    harness.state.matchState = MatchState.WAITING;
    const player = harness.addPlayer("human-0", 400, 1700);
    player.connected = true;
    harness.state.hostId = "human-0";

    assert.equal(harness.npcs.addBot("human-0", 3), false);
  });
});

describe("the difficulty ladder", () => {
  const { npc } = DEFAULT_GAME_CONFIG;

  it("ships five rungs, named", () => {
    assert.deepEqual(
      npc.difficulties.map((level) => `${level.level} ${level.name}`),
      ["1 Very Easy", "2 Easy", "3 Normal", "4 Hard", "5 Very Hard"],
    );
  });

  it("starts on Normal", () => {
    assert.equal(npc.defaultDifficulty, 3);
  });

  it("gets better at every rung, and never in a straight line down", () => {
    // The property that matters: each rung is a *better player* than the one
    // below it on every axis. A ladder that improved aim while getting slower
    // would not be a ladder.
    for (let level = 2; level <= MAX_BOT_DIFFICULTY; level++) {
      const worse = getBotDifficulty(npc, level - 1);
      const better = getBotDifficulty(npc, level);

      assert.ok(better.aimSkillMultiplier > worse.aimSkillMultiplier, `aim at ${level}`);
      assert.ok(better.predictionSkillMultiplier > worse.predictionSkillMultiplier, `prediction at ${level}`);
      assert.ok(better.dodgeSkillMultiplier > worse.dodgeSkillMultiplier, `dodge at ${level}`);
      assert.ok(better.grenadeAccuracy > worse.grenadeAccuracy, `grenades at ${level}`);
      assert.ok(better.navigationSkill > worse.navigationSkill, `navigation at ${level}`);
      assert.ok(better.targetSelectionSkill > worse.targetSelectionSkill, `targeting at ${level}`);
      assert.ok(better.reactionTimeMultiplier < worse.reactionTimeMultiplier, `reaction at ${level}`);
      assert.ok(better.decisionIntervalMultiplier < worse.decisionIntervalMultiplier, `thinking at ${level}`);
      assert.ok(better.decisionNoiseMultiplier < worse.decisionNoiseMultiplier, `noise at ${level}`);
    }
  });

  it("leaves the profiles exactly as written at the top rung", () => {
    // Level 5 is the reference point: it plays the personalities as tuned, which
    // is where the bots were before difficulty existed.
    const top = getBotDifficulty(npc, MAX_BOT_DIFFICULTY);
    for (const profile of npc.profiles) {
      assert.deepEqual(applyBotDifficulty(profile, top), profile);
    }
  });

  it("changes skill and nothing else", () => {
    // The rule the whole feature rests on: difficulty is not a personality, and
    // it is emphatically not less health or less damage. Only the five values a
    // *player* varies in may differ.
    const profile = DEFAULT_GAME_CONFIG.npc.profiles[0]!;
    const weak = applyBotDifficulty(profile, getBotDifficulty(npc, 1));

    const skill = new Set([
      "aimSkill",
      "predictionSkill",
      "dodgeSkill",
      "reactionTimeMs",
      "decisionNoise",
    ]);

    for (const key of Object.keys(profile) as (keyof typeof profile)[]) {
      if (skill.has(key)) continue;
      assert.deepEqual(weak[key], profile[key], `difficulty must not touch ${key}`);
    }

    assert.ok(weak.aimSkill < profile.aimSkill);
    assert.ok(weak.reactionTimeMs > profile.reactionTimeMs);
  });

  it("never produces a perfect bot, at any rung", () => {
    // Even the hardest rung aims through the same imperfect-aim machinery.
    for (const level of npc.difficulties) {
      for (const profile of npc.profiles) {
        const tuned = applyBotDifficulty(profile, level);
        assert.ok(tuned.aimSkill < 1, `${profile.id} at ${level.level} aims perfectly`);
        assert.ok(tuned.reactionTimeMs > 0, `${profile.id} at ${level.level} reacts instantly`);
      }
    }
  });
});

describe("difficulty in the fight", () => {
  /**
   * Aim at a target that is running, and report how far off the shot is.
   *
   * Straight through the combat controller with a hand-built context, so this
   * measures the mechanism rather than the outcome of a match: a poor bot should
   * be slower to fire and worse at leading a moving target, at the same
   * personality and with the same weapon.
   */
  function engageForMs(level: number, ms: number, seed = 3) {
    const npc = DEFAULT_GAME_CONFIG.npc;
    const base = DEFAULT_GAME_CONFIG.npc.profiles.find((entry) => entry.id === "balanced")!;
    const tuned = applyBotDifficulty(base, getBotDifficulty(npc, level));

    const combat = new CombatController(createRandom(seed));
    const target = enemy({ x: 900, y: 500, velocityX: 260, distance: 400 });
    const context = emptyContext({ enemies: [target], visibleEnemies: [target], nearestEnemy: target });

    let fired = 0;
    let firstShotAt = -1;
    const step = 1000 / 60;

    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      context.now = elapsed;
      const output = combat.engage(target, context, tuned, step / 1000);
      if (output.fire) {
        fired++;
        if (firstShotAt < 0) firstShotAt = elapsed;
      }
    }

    return { fired, firstShotAt };
  }

  it("waits longer before shooting at a lower difficulty", () => {
    const weak = engageForMs(1, 3000);
    const strong = engageForMs(5, 3000);

    assert.ok(strong.firstShotAt >= 0, "the hardest rung should get a shot away");
    assert.ok(
      weak.firstShotAt > strong.firstShotAt,
      `expected the weaker bot to hesitate: ${weak.firstShotAt} vs ${strong.firstShotAt}`,
    );
  });

  it("holds fire more often at a lower difficulty", () => {
    // Not because it is forbidden to shoot, but because its aim spends more of
    // the time off target -- the controller only fires when the shot could land.
    const weak = engageForMs(1, 3000);
    const strong = engageForMs(5, 3000);

    assert.ok(
      strong.fired > weak.fired,
      `expected the better bot to take more shots: ${strong.fired} vs ${weak.fired}`,
    );
  });

  it("misjudges a grenade throw at a lower difficulty", () => {
    const base = DEFAULT_GAME_CONFIG.npc.profiles.find((entry) => entry.id === "balanced")!;
    const grenades = DEFAULT_GAME_CONFIG.grenades;

    /** How long the wind-up is held before it lets go. */
    function chargeFor(accuracy: number): number {
      const combat = new CombatController(createRandom(11));
      combat.setGrenadeAccuracy(accuracy);
      const context = emptyContext();

      let held = 0;
      const step = 1000 / 60;
      for (let elapsed = 0; elapsed < 4000; elapsed += step) {
        context.now = elapsed;
        const output = combat.throwGrenade({ x: 1100, y: 500 }, context, base, grenades, step / 1000);
        if (!output.chargeGrenade) break;
        held = elapsed;
      }
      return held;
    }

    // A misjudged throw is one held for the wrong length of time. Same target,
    // same distance, same personality: only the judgement differs.
    assert.notEqual(chargeFor(0.2), chargeFor(1), "accuracy should change the throw");
  });
});

describe("the lobby's headcount", () => {
  it("counts a bot the moment it is added", () => {
    // The lobby prints this number, and a roster that disagrees with its own
    // counter reads as a broken room.
    const config = cloneConfig(getGameConfig());
    config.npc.enabled = true;

    const harness = createHarness();
    harness.replaceConfig(config);
    harness.state.matchState = MatchState.WAITING;
    const player = harness.addPlayer("human-0", 400, 1700);
    player.connected = true;
    player.alive = false;
    player.inMatch = false;
    harness.state.hostId = "human-0";

    harness.run(0.2);
    assert.equal(harness.state.playerCount, 1);

    harness.npcs.addBot("human-0", 3);
    harness.run(0.2);
    assert.equal(harness.state.playerCount, 2);

    harness.npcs.removeBot("human-0", harness.npcs.list()[0]!.sessionId);
    harness.run(0.2);
    assert.equal(harness.state.playerCount, 1);
  });
});

describe("a bot holding something explosive", () => {
  it("will not fire a rocket into a target on top of it", () => {
    // The blast radius reaches back past the muzzle: firing here is suicide, and
    // a bot that did it would be a gift rather than an opponent.
    const launcher = getWeapon(ROCKET_LAUNCHER_ID);
    const blast = launcher.ranged!.explosion!;

    const pointBlank = enemy({ x: 560, distance: blast.radius * 0.5 });
    const across = enemy({ x: 1200, distance: blast.radius * 3 });

    /**
     * Hold the trigger for a second and report whether anything came out.
     *
     * A fresh controller each time: reaction time is measured from when a target
     * was acquired, so a reused one would still be waiting out the first case's
     * clock.
     */
    function firedAt(target: ReturnType<typeof enemy>): boolean {
      const combat = new CombatController(createRandom(5));
      const context = emptyContext({
        self: { ...emptyContext().self, weapon: launcher },
        enemies: [target],
        visibleEnemies: [target],
      });

      let fired = false;
      for (let elapsed = 0; elapsed < 1500; elapsed += 1000 / 60) {
        context.now = elapsed;
        if (combat.engage(target, context, profile(), 1 / 60).fire) fired = true;
      }
      return fired;
    }

    assert.equal(firedAt(pointBlank), false, "it should hold fire at its own feet");
    assert.equal(firedAt(across), true, "and fire freely at a safe distance");
  });

  it("fires an ordinary weapon at any range it reaches", () => {
    const combat = new CombatController(createRandom(5));
    const target = enemy({ x: 560, distance: 60 });
    const context = emptyContext({ enemies: [target], visibleEnemies: [target] });

    let fired = false;
    for (let elapsed = 0; elapsed < 1500; elapsed += 1000 / 60) {
      context.now = elapsed;
      if (combat.engage(target, context, profile(), 1 / 60).fire) fired = true;
    }

    assert.equal(fired, true, "a rifle at point-blank range is simply a rifle");
  });
});

describe("asking for another match", () => {
  /** A finished match with one person and `bots` bots still in the room. */
  function afterAMatch(bots: number) {
    const config = cloneConfig(getGameConfig());
    config.npc.enabled = true;

    const harness = createHarness();
    harness.replaceConfig(config);
    harness.state.matchState = MatchState.WAITING;

    const human = harness.addPlayer("human", 400, 1700);
    human.connected = true;
    human.alive = false;
    human.inMatch = false;
    harness.state.hostId = "human";

    for (let index = 0; index < bots; index++) harness.npcs.addBot("human", 3);
    harness.matchManager.requestStart();
    harness.run(8);

    // End it by taking the bots out of the fight.
    for (const agent of harness.npcs.list()) {
      const player = harness.state.players.get(agent.sessionId)!;
      harness.matchManager.eliminate(player, null, player.weaponId);
    }
    harness.run(0.2);
    return harness;
  }

  it("cuts the wait short when everybody who can ask has asked", () => {
    // The bug this pins: bots are always "connected" and never ask for
    // anything, so counting them meant the button could never do its job in a
    // room with one in it -- which is every room somebody plays alone.
    const harness = afterAMatch(2);
    assert.equal(harness.state.matchState, MatchState.FINISHED);

    harness.matchManager.requestRequeue("human", clock.now);
    harness.run(0.2);

    assert.equal(harness.state.matchState, MatchState.WAITING, "the room should have recycled");
  });

  it("waits for the other people, not for the bots", () => {
    const harness = afterAMatch(1);
    const guest = harness.addPlayer("human-2", 500, 1700);
    guest.connected = true;

    harness.matchManager.requestRequeue("human", clock.now);
    harness.run(0.2);
    assert.equal(harness.state.matchState, MatchState.FINISHED, "one of two people is not everybody");

    harness.matchManager.requestRequeue("human-2", clock.now);
    harness.run(0.2);
    assert.equal(harness.state.matchState, MatchState.WAITING);
  });

  it("ignores an ask outside the results screen", () => {
    const harness = afterAMatch(1);
    harness.run(20);
    assert.equal(harness.state.matchState, MatchState.WAITING);

    // Nothing to cut short; this must not disturb the lobby.
    harness.matchManager.requestRequeue("human", clock.now);
    harness.run(0.2);
    assert.equal(harness.state.matchState, MatchState.WAITING);
  });
});

describe("how a bot flies a jump", () => {
  /**
   * Put a bot on a floor and ask it to reach a ledge `rise` px above it.
   *
   * The whole loop, deliberately: the controller decides, the buttons it
   * produces go through the same movement step a browser's do, and the answer is
   * whether the bot is standing on the ledge at the end. Nothing here inspects
   * the jump -- only whether it worked.
   */
  function climbs(rise: number, seconds = 12): boolean {
    // The arena comes with a floor of its own; adding a second one above it
    // would leave a sealed storey underneath, and routes that cross it are
    // routes nobody can fly.
    const arena = createEmptyArena("climb", "Climb", 1600, 1200);
    const floorY = 1200 - 60;
    arena.elements.push({ id: "ledge", type: "platform", x: 700, y: floorY - rise, width: 400, height: 20 });

    const world = new CollisionWorld(arena);
    const graph = new NavGraph(arena, world, getPlayerConfig());
    const controller = new MovementController(graph, world);

    const state = createMovementState(400, floorY - PLAYER_HALF_HEIGHT);
    state.onGround = true;
    const input = createInputCommand();

    for (let tick = 0; tick < 60 * seconds; tick++) {
      const self = {
        x: state.x,
        y: state.y,
        velocityX: state.velocityX,
        velocityY: state.velocityY,
        onGround: state.onGround,
        jumpsRemaining: state.jumpsRemaining,
        health: 1,
        ammo: 1,
        reloading: false,
        grenades: 0,
        weapon: null,
      } as never;

      controller.setGoal(900, floorY - rise - PLAYER_HALF_HEIGHT, self, tick * 16.67);
      controller.steer(self, tick * 16.67);
      const buttons = controller.takeButtons();

      input.seq = tick + 1;
      input.moveLeft = buttons.moveLeft;
      input.moveRight = buttons.moveRight;
      input.jump = buttons.jump;
      stepPlayerMovement(state, input, FIXED_DELTA, world);

      if (state.onGround && state.y < floorY - rise) return true;
    }
    return false;
  }

  it("climbs a ledge that needs a full jump", () => {
    // The failure this pins, which stood for a long time: the jump was scripted
    // as press-then-release-next-tick, which is exactly the input the
    // variable-jump-height rule cuts short. Every bot jump was a 35px hop, and
    // 80px was out of reach.
    assert.equal(climbs(80), true);
    assert.equal(climbs(120), true);
  });

  it("spends the mid-air jump on a ledge one jump cannot reach", () => {
    // A single held jump is about 138px at the shipped tuning. Anything above
    // that is the second jump doing the work, or it does not happen at all.
    assert.equal(climbs(170), true);
    assert.equal(climbs(200), true);
  });

  it("does not pretend to reach what it cannot", () => {
    assert.equal(climbs(260, 6), false);
  });

  it("only plans jumps it can actually fly", () => {
    // The other half of the same bug: the graph was linking ledges 237px up
    // while the controller could manage 35, so bots routed themselves under
    // platforms and stayed there. Whatever the graph plans has to be flyable.
    //
    // The upper storey deliberately stops short of the right wall. It used to
    // span the arena, and the "real climb" this test celebrated was a link from
    // the storey below straight up through the solid slab -- exactly the kind
    // of route the launch check now refuses. An honest climb needs an edge
    // with open sky beside it.
    const arena = createEmptyArena("reach", "Reach", 1600, 1400);
    arena.elements.push({ id: "floor", type: "floor", x: 0, y: 1200, width: 700, height: 40 });
    for (let step = 1; step <= 10; step++) {
      arena.elements.push({
        id: `ledge-${step}`,
        type: "platform",
        x: 1100,
        y: 1200 - step * 30,
        width: 200,
        height: 10,
      });
    }

    const graph = new NavGraph(arena, new CollisionWorld(arena), getPlayerConfig());
    const rises = graph.links.flatMap((links, from) =>
      links
        .filter((link) => link.kind === "jump")
        .map((link) => graph.nodes[from]!.y - graph.nodes[link.to]!.y),
    );

    const highest = Math.max(0, ...rises);
    assert.ok(highest > 100, `the graph should still plan real climbs, got ${highest}`);
    assert.ok(highest <= 210, `the graph plans a ${Math.round(highest)}px climb a bot cannot fly`);
  });
});

describe("flying a jump to its full height", () => {
  /** A flat floor, a controller, and one commanded jump. */
  function flyOneJump(): number {
    const arena = createEmptyArena("flat", "Flat", 1600, 1200);
    const floorY = 1200 - 60;
    const world = new CollisionWorld(arena);
    const graph = new NavGraph(arena, world, getPlayerConfig());
    const controller = new MovementController(graph, world);

    const state = createMovementState(400, floorY - PLAYER_HALF_HEIGHT);
    state.onGround = true;
    const input = createInputCommand();
    let apex = state.y;

    for (let tick = 0; tick < 120; tick++) {
      const self = {
        x: state.x,
        y: state.y,
        velocityX: state.velocityX,
        velocityY: state.velocityY,
        onGround: state.onGround,
        jumpsRemaining: state.jumpsRemaining,
        health: 1,
        ammo: 1,
        reloading: false,
        grenades: 0,
        weapon: null,
      } as never;

      // A goal at its own feet, because steering (which flies the jump) does
      // nothing without one; and an unreachable jump target, so the machine
      // flies the whole profile -- full first ascent, and the mid-air jump
      // spent at its apex.
      controller.setGoal(400, floorY - PLAYER_HALF_HEIGHT, self, tick * 16.67);
      if (tick === 3) controller.jumpTo(state.y - 1000);
      controller.steer(self, tick * 16.67);
      const buttons = controller.takeButtons();
      input.seq = tick + 1;
      input.jump = buttons.jump;
      stepPlayerMovement(state, input, FIXED_DELTA, world);
      apex = Math.min(apex, state.y);
    }

    return floorY - PLAYER_HALF_HEIGHT - apex;
  }

  it("spends both jumps and reaches what the graph promises", () => {
    /*
     * The bug this pins ate every planned jump for as long as bots have
     * existed. A press made in `considerJump` was judged by `updateJump` in
     * the same tick, before the physics had seen it: the body read as not
     * rising, so the machine concluded the ascent was over, spent its rising
     * phase and the mid-air flag on the spot, and the whole flight came out a
     * single jump -- about 135px against the 203 the navigation graph plans
     * with. Bots planned routes they could not fly, bounced under ledges, and
     * fell into whatever was beneath them.
     */
    const rise = flyOneJump();
    assert.ok(
      rise > 190,
      `a full commanded jump should get close to the graph's ${"maxClimb"}, rose ${Math.round(rise)}px`,
    );
  });
});

describe("the arena closing in", () => {
  /** A bot standing where the wall is about to be. */
  function cornered(wallLeft: number, wallRight: number, x: number) {
    const arena = createEmptyArena("closing", "Closing", 2000, 1000);
    const floorY = 1000 - 60;
    const world = new CollisionWorld(arena);
    const graph = new NavGraph(arena, world, getPlayerConfig());
    const controller = new MovementController(graph, world);
    controller.setPlayableBounds(wallLeft, wallRight);

    const self = {
      x,
      y: floorY - PLAYER_HALF_HEIGHT,
      velocityX: 0,
      velocityY: 0,
      onGround: true,
      jumpsRemaining: 2,
      health: 1,
      ammo: 1,
      reloading: false,
      grenades: 0,
      weapon: null,
    } as never;

    return { controller, self, floorY };
  }

  it("steps in from a wall it is being pressed against", () => {
    /*
     * A wall does not miss, cannot be shot back at, and is coming whatever the
     * bot decides -- so it comes before every other decision. Without that a
     * bot chased a memory the walls had already swallowed, walked into the
     * wall, and stood there being pushed along and crushed: measured over six
     * closing matches, bots spent 37% of the endgame flat against an edge.
     */
    const { controller, self, floorY } = cornered(400, 1600, 420);

    // A goal further left still, which is where the trouble used to start.
    controller.setGoal(150, floorY - PLAYER_HALF_HEIGHT, self, 0);
    controller.steer(self, 0);

    assert.equal(controller.takeButtons().moveRight, true, "it should step in, away from the wall");
  });

  it("never takes a goal the walls have swallowed", () => {
    const { controller, self, floorY } = cornered(400, 1600, 900);

    controller.setGoal(120, floorY - PLAYER_HALF_HEIGHT, self, 0);

    const goal = controller.goal;
    assert.ok(goal, "a goal outside the walls should be brought inside, not dropped");
    assert.ok(goal!.x > 400, `the goal is still outside the wall at ${Math.round(goal!.x)}`);
  });

  it("leaves a bot with room alone", () => {
    // Mid-arena the walls are nobody's business: the goal decides.
    const { controller, self, floorY } = cornered(400, 1600, 1000);

    controller.setGoal(1400, floorY - PLAYER_HALF_HEIGHT, self, 0);
    controller.steer(self, 0);

    assert.equal(controller.takeButtons().moveRight, true, "it should just go where it was going");
  });
});

describe("meeting a wall", () => {
  /**
   * Put a bot on a floor with a solid wall between it and its goal, drive the
   * whole loop -- controller decides, buttons go through the real movement step
   * -- and watch what it does about the wall. The failure this pins came from a
   * live match: a bot pressed flat against a block taller than any jump,
   * leaping on the spot at a goal just the other side of it, for as long as its
   * memory of the enemy lasted.
   */
  function meetTheWall(wallHeight: number, seconds = 5) {
    const arena = createEmptyArena("wall", "Wall", 1600, 1200);
    const floorY = 1200 - 60;
    arena.elements.push({
      id: "wall",
      type: "obstacle",
      x: 700,
      y: floorY - wallHeight,
      width: 60,
      height: wallHeight,
    });

    const world = new CollisionWorld(arena);
    const graph = new NavGraph(arena, world, getPlayerConfig());
    const controller = new MovementController(graph, world);

    const state = createMovementState(560, floorY - PLAYER_HALF_HEIGHT);
    state.onGround = true;
    const input = createInputCommand();
    const goal = { x: 860, y: floorY - PLAYER_HALF_HEIGHT };

    let jumpPresses = 0;
    let jumping = false;

    for (let tick = 0; tick < 60 * seconds; tick++) {
      const self = {
        x: state.x,
        y: state.y,
        velocityX: state.velocityX,
        velocityY: state.velocityY,
        onGround: state.onGround,
        jumpsRemaining: state.jumpsRemaining,
        health: 1,
        ammo: 1,
        reloading: false,
        grenades: 0,
        weapon: null,
      } as never;

      // The brain's contribution to the bug: it asks for the same goal on
      // every thought, so the controller has to be the one that says no.
      controller.setGoal(goal.x, goal.y, self, tick * 16.67);
      controller.steer(self, tick * 16.67);
      const buttons = controller.takeButtons();

      if (buttons.jump && !jumping) jumpPresses++;
      jumping = buttons.jump;

      input.seq = tick + 1;
      input.moveLeft = buttons.moveLeft;
      input.moveRight = buttons.moveRight;
      input.jump = buttons.jump;
      stepPlayerMovement(state, input, FIXED_DELTA, world);
    }

    return { state, controller, jumpPresses };
  }

  it("hops over a wall a jump can clear", () => {
    const { state } = meetTheWall(100);
    assert.ok(state.x > 780, `should end up past the wall, got x=${Math.round(state.x)}`);
  });

  it("gives up on a wall no jump can clear, instead of leaping at it", () => {
    const { state, controller, jumpPresses } = meetTheWall(400);

    assert.equal(controller.goal, null, "an unreachable goal behind a wall should be dropped");
    assert.ok(
      jumpPresses <= 2,
      `a wall taller than any jump is not answered with jumping; pressed jump ${jumpPresses} times`,
    );
    // And it stopped trying to walk through it: not pressed against the face.
    assert.ok(state.x < 690, `should not be grinding against the wall, got x=${Math.round(state.x)}`);
  });

  it("keeps refusing the goal the brain keeps asking for", () => {
    const { controller, state } = meetTheWall(400);

    const self = {
      x: state.x,
      y: state.y,
      velocityX: 0,
      velocityY: 0,
      onGround: true,
      jumpsRemaining: 2,
      health: 1,
      ammo: 1,
      reloading: false,
      grenades: 0,
      weapon: null,
    } as never;

    // The very next brain tick hands the same goal straight back.
    controller.setGoal(860, 1140 - PLAYER_HALF_HEIGHT, self, 5 * 1000 + 100);
    assert.equal(controller.goal, null, "a goal just abandoned as unreachable is refused");

    // Memory, not a ban: once it expires the same place is worth another look,
    // which here means being turned down again on its merits rather than by
    // recall -- there really is no way over a wall that tall.
    controller.setGoal(860, 1140 - PLAYER_HALF_HEIGHT, self, 60 * 1000);
    assert.equal(controller.goal, null, "still nowhere to go: the wall has not moved");
  });
});

describe("knowing your own body", () => {
  /*
   * What a bot knows about *other people* is deliberately a few frames old --
   * that staleness is the reaction time the design asks for. Its own body is a
   * different thing entirely, and conflating the two produced the most visible
   * bug bots have had: flying a jump by a snapshot up to seven ticks old, the
   * state machine saw `velocityY === 0` right after the press, decided the jump
   * was over, released, and spent the mid-air jump at ankle height. A 170px
   * climb came out as a 50px hop, which is a bot hammering itself against a
   * wall it could clear.
   */
  it("tracks its own position every tick, not every perception pass", () => {
    const harness = createHarness();
    harness.state.matchState = MatchState.WAITING;
    const human = harness.addPlayer("human", 400, 1700);
    human.connected = true;
    human.alive = false;
    human.inMatch = false;
    harness.state.hostId = "human";
    harness.npcs.spawn("aggressive");
    harness.matchManager.requestStart();
    harness.run(8);

    const agent = harness.npcs.list()[0]!;
    let worst = 0;

    for (let tick = 0; tick < 240; tick++) {
      const player = harness.state.players.get(agent.sessionId)!;
      // Where the body was when this tick began, which is exactly what the bot
      // gets to look at: it decides first, and the movement system runs after.
      const before = { x: player.x, y: player.y, alive: player.alive };

      harness.run(1 / 60);

      const self = agent.lastContext?.self;
      if (!self || !before.alive) continue;
      worst = Math.max(worst, Math.hypot(self.x - before.x, self.y - before.y));
    }

    assert.ok(
      worst < 1,
      `a bot should always know where it is standing; its idea of itself was ${worst.toFixed(1)}px out`,
    );
  });

  it("climbs an obstacle in a real match, not just on a test bench", () => {
    // The bench version of this passed the whole time the game was broken,
    // because it handed the controller a fresh body every tick. This runs the
    // room: perception at its own cadence, the brain at its own, and the same
    // input queue a person's keyboard goes through.
    const arena = createEmptyArena("block", "Block", 1800, 1000);
    const floorY = 1000 - 60;
    arena.elements.push({
      id: "block",
      type: "obstacle",
      x: 850,
      // Above one jump (about 138px), inside two (about 200px).
      y: floorY - 155,
      width: 260,
      height: 155,
    });

    const harness = createHarness(arena);
    harness.state.matchState = MatchState.WAITING;
    const human = harness.addPlayer("human", 1400, floorY - PLAYER_HALF_HEIGHT);
    human.connected = true;
    harness.state.hostId = "human";
    harness.npcs.spawn("aggressive");
    harness.matchManager.requestStart();
    // Until the match is actually running, rather than for a fixed eight
    // seconds: the countdown is configurable, and a fixed wait meant this test
    // measured a bot that had already been playing for a while -- so shortening
    // the countdown turned a test about climbing into a test about what a bot
    // happened to be doing at the eight-second mark.
    for (let waited = 0; waited < 20; waited += 0.25) {
      harness.run(0.25);
      const state: string = harness.state.matchState;
      if (state === MatchState.PLAYING) break;
    }

    const agent = harness.npcs.list()[0]!;
    const player = harness.state.players.get(agent.sessionId)!;
    const runtime = harness.runtimes.get(agent.sessionId)!;
    // Positions live on the runtime and are written back to the state every
    // tick, so moving somebody means moving both.
    const humanRuntime = harness.runtimes.get("human")!;

    /*
     * A person on the far side of the block, and the bot against the near face
     * of it. There is no shot through 260px of solid obstacle, so a bot that
     * cannot tell "seen" from "shootable" stands here trading nothing; one that
     * can has to come over the top, which takes both jumps.
     */
    player.x = runtime.movement.x = 800;
    player.y = runtime.movement.y = floorY - PLAYER_HALF_HEIGHT;

    let highest = player.y;
    for (let i = 0; i < 30; i++) {
      harness.run(0.5);
      // Keep the target standing there rather than letting the fight resolve.
      human.x = humanRuntime.movement.x = 1400;
      human.y = humanRuntime.movement.y = floorY - PLAYER_HALF_HEIGHT;
      human.health = 100;
      human.alive = true;
      if (player.alive) highest = Math.min(highest, player.y);
    }

    assert.ok(
      highest <= floorY - 155,
      `a bot should get on top of a block two jumps high; best was ${Math.round(floorY - highest)}px up`,
    );
  });
});

describe("going and getting things", () => {
  /** A stand-in agent that records what the action asked it to do. */
  function fetcher(canShoot: boolean) {
    const asked: string[] = [];
    return {
      asked,
      agent: {
        target: null,
        effectiveProfile: profile(),
        canShootAt: () => canShoot,
        canLobAt: () => true,
        setState: (state: string) => asked.push(`state:${state}`),
        moveTo: (x: number) => asked.push(`moveTo:${Math.round(x)}`),
        stopMoving: () => asked.push("stop"),
        holdFire: () => asked.push("holdFire"),
        shootAt: (x: number) => asked.push(`shootAt:${Math.round(x)}`),
        lookAt: () => asked.push("lookAt"),
      } as never,
    };
  }

  const crate = { id: "c1", kind: "crate" as const, powerUpId: null, x: 900, y: 500, distance: 300 };

  it("shoots a crate open instead of standing and looking at it", () => {
    // For a long time the action aimed and never pulled: "the bot only points
    // and pulls" said the comment, and only pointing is what it did -- so no
    // bot in this game had ever opened a crate, or held anything but the weapon
    // it spawned with.
    const { agent, asked } = fetcher(true);
    const context = emptyContext({ items: [crate], nearestPowerUp: crate });

    actions.getPowerUpAction.execute(agent, context);

    assert.ok(asked.some((call) => call.startsWith("shootAt:")), `never fired: ${asked.join(" ")}`);
    assert.ok(asked.some((call) => call.startsWith("moveTo:")), "and closes the distance while it does");
  });

  it("does not fire at a crate it has no line to", () => {
    // A crate on a platform above you is not opened by firing into the
    // platform, however long you hold the trigger.
    const { agent, asked } = fetcher(false);
    const context = emptyContext({ items: [crate], nearestPowerUp: crate });

    actions.getPowerUpAction.execute(agent, context);

    assert.ok(!asked.some((call) => call.startsWith("shootAt:")), `fired blind: ${asked.join(" ")}`);
    assert.ok(asked.includes("holdFire"), "holds fire and keeps walking");
  });

  it("is worth doing when there is nobody to fight", () => {
    // Quiet moments are when a person goes and opens the box. Without this the
    // score was a fraction of what wandering scores, and bots walked past
    // crates for whole matches.
    const quiet = emptyContext({ items: [crate], nearestPowerUp: crate, danger: 0, visibleEnemies: [] });
    const enemy1 = enemy({ distance: 200 });
    const busy = emptyContext({
      items: [crate],
      nearestPowerUp: crate,
      danger: 0.8,
      visibleEnemies: [enemy1],
      enemies: [enemy1],
    });

    const calm = actions.getPowerUpAction.score(quiet, profile(), fetcher(true).agent);
    const underFire = actions.getPowerUpAction.score(busy, profile(), fetcher(true).agent);

    assert.ok(calm > underFire, "fetching should lose to being shot at");
    assert.ok(calm > 30, `and win a quiet moment outright, scored ${calm.toFixed(0)}`);
  });
});

describe("having a shot, as opposed to a view", () => {
  it("does not attack a target it can see but cannot hit", () => {
    const seen = enemy({ visible: true, shootable: true });
    const behindCover = enemy({ visible: true, shootable: false });

    assert.ok(actions.attackAction.score(emptyContext(), profile(), agentWith(seen)) > 0);
    assert.equal(actions.attackAction.score(emptyContext(), profile(), agentWith(behindCover)), 0);
  });

  it("holds fire on a head showing over a wall", () => {
    /** Hold the trigger for a second and report whether anything came out. */
    function firedAt(target: ReturnType<typeof enemy>): boolean {
      const combat = new CombatController(createRandom(5));
      const context = emptyContext({ enemies: [target], visibleEnemies: [target] });

      let fired = false;
      for (let elapsed = 0; elapsed < 1500; elapsed += 1000 / 60) {
        context.now = elapsed;
        if (combat.engage(target, context, profile(), 1 / 60).fire) fired = true;
      }
      return fired;
    }

    const overCover = enemy({ x: 900, distance: 300, visible: true, shootable: false });
    const inTheOpen = enemy({ x: 900, distance: 300, visible: true, shootable: true });

    assert.equal(firedAt(overCover), false, "no shot at a head behind a wall");
    assert.equal(firedAt(inTheOpen), true, "and a shot the moment there is one");
  });
});

describe("throwing a grenade somewhere useful", () => {
  const grenadeConfig = getGrenadeConfig();

  it("sees the wall it would bounce off", () => {
    const arena = createEmptyArena("lob", "Lob", 1600, 1000);
    const floorY = 1000 - 60;
    arena.elements.push({
      id: "wall",
      type: "obstacle",
      x: 700,
      y: floorY - 300,
      width: 40,
      height: 300,
    });
    const world = new CollisionWorld(arena);

    const fromX = 640;
    const fromY = floorY - PLAYER_HALF_HEIGHT;
    // Straight at a target on the far side of a wall 60px in front.
    const angle = throwAngleFor(400, 0);
    const speed = throwSpeedFor(400, grenadeConfig);
    const blocked = throwClearance(world, grenadeConfig, fromX, fromY, angle, speed);

    assert.ok(
      blocked < grenadeConfig.explosionRadius,
      `a grenade thrown into a wall 60px away lands inside its own blast, got ${Math.round(blocked)}px`,
    );

    // Nothing in the way: the same throw, from further back.
    const clear = throwClearance(world, grenadeConfig, 200, fromY, angle, speed);
    assert.ok(
      clear > grenadeConfig.explosionRadius,
      `a clear throw should get well away from the thrower, got ${Math.round(clear)}px`,
    );
  });

  it("walks out of spikes it is standing in, even with nowhere to go", () => {
    /*
     * The state bots actually died in. Hazard handling used to sit below two
     * guards -- "do I have a goal" and "am I already walking somewhere" -- so a
     * bot that stopped inside a strip of spikes, or whose goal had just been
     * dropped *because* of the hazard, had its avoidance switched off at the
     * exact moment it was standing in one.
     */
    const arena = createEmptyArena("spiked", "Spiked", 2000, 1000);
    const floorY = 1000 - 60;
    const world = new CollisionWorld(arena);
    const graph = new NavGraph(arena, world, getPlayerConfig());
    const controller = new MovementController(graph, world);

    const spikes = {
      id: "spikes",
      x: 900,
      y: floorY - 24,
      width: 300,
      height: 24,
      distance: 0,
      hot: true,
      harmful: true,
      threat: 1,
    };

    const state = createMovementState(1050, floorY - PLAYER_HALF_HEIGHT);
    state.onGround = true;
    const input = createInputCommand();

    for (let tick = 0; tick < 60 * 3; tick++) {
      const self = {
        x: state.x,
        y: state.y,
        velocityX: state.velocityX,
        velocityY: state.velocityY,
        onGround: state.onGround,
        jumpsRemaining: state.jumpsRemaining,
        health: 1,
        ammo: 1,
        reloading: false,
        grenades: 0,
        weapon: null,
      } as never;

      // No goal at all: standing in a fire is not something you need a plan for.
      controller.steer(self, tick * 16.67, [spikes]);
      const buttons = controller.takeButtons();
      input.seq = tick + 1;
      input.moveLeft = buttons.moveLeft;
      input.moveRight = buttons.moveRight;
      input.jump = buttons.jump;
      stepPlayerMovement(state, input, FIXED_DELTA, world);
    }

    const inside = state.x > spikes.x - PLAYER_HALF_WIDTH && state.x < spikes.x + spikes.width + PLAYER_HALF_WIDTH;
    assert.equal(inside, false, `still standing in the spikes at x=${Math.round(state.x)}`);
  });

  it("does not flee a jump pad", () => {
    // A pad is placed and simulated as a trap and costs nothing to touch: it is
    // a route the arena puts there on purpose. Treating it as a hazard had bots
    // walking around the shortcuts.
    const arena = createEmptyArena("padded", "Padded", 2000, 1000);
    const floorY = 1000 - 60;
    const world = new CollisionWorld(arena);
    const graph = new NavGraph(arena, world, getPlayerConfig());
    const controller = new MovementController(graph, world);

    const pad = {
      id: "pad",
      x: 900,
      y: floorY - 20,
      width: 110,
      height: 20,
      distance: 0,
      hot: true,
      harmful: false,
      threat: 0,
    };

    const self = {
      x: 950,
      y: floorY - PLAYER_HALF_HEIGHT,
      velocityX: 0,
      velocityY: 0,
      onGround: true,
      jumpsRemaining: 2,
      health: 1,
      ammo: 1,
      reloading: false,
      grenades: 0,
      weapon: null,
    } as never;

    controller.setGoal(1600, floorY - PLAYER_HALF_HEIGHT, self, 0);
    controller.steer(self, 0, [pad]);

    assert.equal(
      controller.takeButtons().moveRight,
      true,
      "standing on a jump pad should not interrupt going where you were going",
    );
  });

  it("stops short of a trap rather than walking into it", () => {
    // Chasing somebody standing in the fire is reasonable. Following them in is
    // not, so the destination is moved to the near edge rather than refused.
    const arena = createEmptyArena("fired", "Fired", 2000, 1000);
    const floorY = 1000 - 60;
    arena.traps = [
      {
        id: "fire",
        type: "fire",
        x: 1200,
        y: floorY - 140,
        width: 90,
        height: 140,
        activation: "always",
        enabled: true,
        damage: null,
        activationDelayMs: null,
        activeDurationMs: null,
        cooldownMs: null,
        moveSpeed: null,
        triggerRadius: null,
        params: {},
      },
    ];

    const world = new CollisionWorld(arena);
    const graph = new NavGraph(arena, world, getPlayerConfig());

    const inside = graph.clearOfHazards(1245, floorY - PLAYER_HALF_HEIGHT);
    assert.notEqual(inside.x, 1245, "a goal inside the fire should be moved out of it");
    assert.ok(
      inside.x < 1200 - PLAYER_HALF_WIDTH || inside.x > 1290 + PLAYER_HALF_WIDTH,
      `moved to ${Math.round(inside.x)}, which is still in the fire`,
    );

    // And somewhere harmless is left exactly where it was.
    const clear = graph.clearOfHazards(400, floorY - PLAYER_HALF_HEIGHT);
    assert.equal(clear.x, 400);
  });

  it("steers a fall off the spikes it would land in", () => {
    /*
     * Five in six of the harmful trap hits bots took were taken while falling:
     * a bot walking off a ledge, or knocked off one, dropped diagonally onto
     * the strip below and rode it down. The landing spot is known the moment
     * the fall starts -- it is ballistics -- so the fall is steered off it.
     */
    const arena = createEmptyArena("pit", "Pit", 2000, 1000);
    const floorY = 1000 - 60;
    const world = new CollisionWorld(arena);
    const graph = new NavGraph(arena, world, getPlayerConfig());
    const controller = new MovementController(graph, world);

    const spikes = {
      id: "spikes",
      x: 900,
      y: floorY - 24,
      width: 200,
      height: 24,
      distance: 120,
      hot: true,
      harmful: true,
      threat: 1,
    };

    // Falling from above and to the left, drifting right: the unsteered landing
    // point is inside the strip.
    const falling = (x: number) =>
      ({
        x,
        y: floorY - 320,
        velocityX: 160,
        velocityY: 300,
        onGround: false,
        jumpsRemaining: 1,
        health: 1,
        ammo: 1,
        reloading: false,
        grenades: 0,
        weapon: null,
      }) as never;

    const self = falling(880);
    controller.setGoal(1400, floorY - PLAYER_HALF_HEIGHT, self, 0);
    controller.steer(self, 0, [spikes]);

    assert.equal(
      controller.takeButtons().moveLeft,
      true,
      "a fall landing in the spikes steers for the near edge",
    );

    // The same fall over clear ground is left alone: it flies the goal.
    const clear = falling(400);
    controller.setGoal(1400, floorY - PLAYER_HALF_HEIGHT, clear, 100);
    controller.steer(clear, 100, [spikes]);
    assert.equal(controller.takeButtons().moveRight, true, "a clear fall keeps going where it was going");
  });

  it("never wanders into a trap on purpose", () => {
    // Steering flinches away from a hazard on the way past; a *destination*
    // inside one is a bot walking into spikes deliberately and standing there.
    const arena = createEmptyArena("spiked", "Spiked", 2000, 1000);
    arena.traps = [
      {
        id: "spikes",
        type: "spikes",
        x: 900,
        y: 1000 - 60 - 24,
        width: 300,
        height: 24,
        activation: "always",
        enabled: true,
        damage: null,
        activationDelayMs: null,
        activeDurationMs: null,
        cooldownMs: null,
        moveSpeed: null,
        triggerRadius: null,
        params: {},
      },
    ];

    const world = new CollisionWorld(arena);
    const graph = new NavGraph(arena, world, getPlayerConfig());
    const controller = new MovementController(graph, world);

    assert.ok(
      graph.nodes.some((node) => node.hazardous),
      "the test arena should have somewhere dangerous to stand",
    );

    let random = 0;
    const sequence = () => {
      random = (random + 0.137) % 1;
      return random;
    };

    for (let attempt = 0; attempt < 200; attempt++) {
      const target = controller.wanderTarget(sequence, 100, 900, attempt * 100);
      if (!target) continue;
      const node = graph.nodes.find((candidate) => candidate.x === target.x && candidate.y === target.y);
      assert.notEqual(node?.hazardous, true, `wandered to a spot inside a trap at ${target.x}`);
    }
  });
});
