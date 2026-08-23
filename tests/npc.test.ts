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
  DEFAULT_GAME_CONFIG,
  MAX_BOT_DIFFICULTY,
  MIN_BOT_DIFFICULTY,
  MatchState,
  applyBotDifficulty,
  createRandom,
  getBotDifficulty,
  cloneConfig,
  getGameConfig,
  clamp01,
  createEmptyArena,
  getNpcConfig,
  getPlayerConfig,
  getWeapon,
  listBrainProfiles,
  type BrainProfile,
} from "@deathmatch/shared";
import { createHarness, type Harness } from "./harness.js";
import { MAX_HEALTH } from "./helpers.js";

const { Brain, deriveEffectiveProfile } = await import("../server/src/npc/Brain.js");
const { Memory } = await import("../server/src/npc/Memory.js");
const { Perception } = await import("../server/src/npc/Perception.js");
const { TargetSelector } = await import("../server/src/npc/TargetSelector.js");
const { CombatController } = await import("../server/src/npc/CombatController.js");
const { NavGraph } = await import("../server/src/npc/Navigation.js");
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
    ageMs: 0,
    facingUs: 0,
    ...overrides,
  };
}

/** A stand-in agent: the actions only ever ask it for the chosen target. */
function agentWith(target: PerceivedEnemy | null, profileOverride?: BrainProfile) {
  return {
    target,
    effectiveProfile: profileOverride ?? profile(),
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
    return perception.build(self, runtime, memory, profile(), now);
  }

  it("sees an enemy standing in the open", () => {
    harness.addPlayer("bot", 600, 1700);
    harness.addPlayer("target", 800, 1700);

    const context = perceive("bot");
    assert.equal(context.visibleEnemies.length, 1);
    assert.equal(context.nearestEnemy?.sessionId, "target");
    assert.ok(context.nearestEnemy!.distance > 0);
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
    // A three-player match: one person and two bots. The shipped configuration
    // seats five, which is more bots than these tests need to watch.
    config.npc.defaultBotCount = 2;
    config.match.minPlayers = 3;
    // These tests are about bots playing, not about how long a lobby holds its
    // places open for people; that has its own tests below.
    config.npc.fillAfterMs = 0;

    const harness = createHarness();
    harness.replaceConfig(config);
    harness.state.matchState = MatchState.WAITING;

    const human = harness.addPlayer("human", 400, 1700);
    human.connected = true;
    human.alive = false;
    human.inMatch = false;

    harness.npcs.spawn(profiles[0]);
    harness.npcs.spawn(profiles[1]);

    // Long enough for the countdown to elapse and the match manager to spawn
    // everybody the way it does for people.
    harness.run(8);
    return harness;
  }

  it("joins the lobby, starts the match and spawns like anyone else", () => {
    const harness = startMatch(["aggressive", "rusher"]);

    assert.equal(harness.state.matchState, MatchState.PLAYING);
    assert.equal(harness.state.aliveCount, 3, "a human and two bots");

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
    let previous = new Map(ids.map((id) => [id, harness.state.players.get(id)!.x]));

    for (let second = 0; second < 6; second++) {
      harness.run(1);
      for (const id of ids) {
        const x = harness.state.players.get(id)!.x;
        travelled.set(id, travelled.get(id)! + Math.abs(x - previous.get(id)!));
        previous.set(id, x);
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

    const players = faceOff(harness);

    const before = players.map((player) => player.health);
    harness.run(6);
    const after = players.map((player) => player.health);

    assert.ok(
      after.some((health, index) => health < before[index]!),
      `expected somebody to get hurt, ${JSON.stringify({ before, after })}`,
    );
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

describe("holding a lobby open for people", () => {
  /** A waiting lobby with one person in it and bots configured to fill it. */
  function lobby(
    overrides: Partial<{ fillAfterMs: number; bots: number; enabled: boolean }> = {},
  ) {
    const config = cloneConfig(getGameConfig());
    config.npc.enabled = overrides.enabled ?? true;
    config.npc.defaultBotCount = overrides.bots ?? 4;
    config.npc.fillAfterMs = overrides.fillAfterMs ?? 60000;
    // Kept out of the way: this is about the lobby, not about matches starting.
    config.match.minPlayers = 4;

    const harness = createHarness();
    harness.replaceConfig(config);
    harness.state.matchState = MatchState.WAITING;

    const human = harness.addPlayer("human", 400, 1700);
    human.connected = true;
    human.alive = false;
    human.inMatch = false;

    return harness;
  }

  it("ships an arena for five, and never starts one short", () => {
    // The whole rule in four numbers: always five, at least one of them a
    // person, bots for the rest, and nothing begins until the arena is full.
    const { match, npc } = DEFAULT_GAME_CONFIG;

    assert.equal(match.maxPlayers, 5);
    assert.equal(match.minPlayers, match.maxPlayers, "a match should never start short-handed");
    assert.equal(
      npc.defaultBotCount,
      match.maxPlayers - 1,
      "a lobby offers enough bots to fill the arena around one person",
    );
    assert.equal(npc.maxBots, match.maxPlayers - 1, "one seat is always a person's");
  });

  it("fills to five and starts, from one person", () => {
    const config = cloneConfig(getGameConfig());
    config.npc.enabled = true;
    config.npc.fillAfterMs = 0;

    const harness = createHarness();
    harness.replaceConfig(config);
    harness.state.matchState = MatchState.WAITING;

    const human = harness.addPlayer("human", 400, 1700);
    human.connected = true;
    human.alive = false;
    human.inMatch = false;

    harness.run(8);

    assert.equal(harness.state.matchState, MatchState.PLAYING);
    assert.equal(harness.state.startingPlayerCount, 5, "a full arena, every time");
    assert.equal(harness.npcs.count, 4);
  });

  it("waits rather than starting with two people and three empty seats", () => {
    // Two humans used to be enough to begin. Now the seats are held, filled,
    // and only then does anything start -- which is the point of "always five".
    const config = cloneConfig(getGameConfig());
    config.npc.enabled = true;
    config.npc.fillAfterMs = 30000;

    const harness = createHarness();
    harness.replaceConfig(config);
    harness.state.matchState = MatchState.WAITING;

    for (const name of ["one", "two"]) {
      const player = harness.addPlayer(name, 400, 1700);
      player.connected = true;
      player.alive = false;
      player.inMatch = false;
    }

    harness.run(5);

    assert.equal(harness.state.matchState, MatchState.WAITING);
    assert.ok(harness.state.canStartNow, "and either of them can skip the wait");

    harness.npcs.requestImmediateStart("one");
    harness.run(8);

    assert.equal(harness.state.matchState, MatchState.PLAYING);
    assert.equal(harness.state.startingPlayerCount, 5);
  });

  it("leaves no room for a bot when five people turn up", () => {
    const config = cloneConfig(getGameConfig());
    config.npc.enabled = true;
    config.npc.fillAfterMs = 0;

    const harness = createHarness();
    harness.replaceConfig(config);
    harness.state.matchState = MatchState.WAITING;

    for (const name of ["a", "b", "c", "d", "e"]) {
      const player = harness.addPlayer(name, 400, 1700);
      player.connected = true;
      player.alive = false;
      player.inMatch = false;
    }

    harness.run(3);

    assert.equal(harness.npcs.count, 0, "a full lobby of people needs no bots");
    assert.equal(harness.state.canStartNow, false, "and nothing to skip");
  });

  it("keeps the free places open while the hold runs", () => {
    const harness = lobby({ fillAfterMs: 10000 });

    harness.run(4);
    assert.equal(harness.npcs.count, 0, "a bot took somebody's place too early");
    assert.ok(harness.state.botFillSeconds > 0, "the lobby should say what it is waiting for");
    assert.equal(harness.state.canStartNow, true, "and offer to skip it");
  });

  it("counts the wait down in whole seconds", () => {
    const harness = lobby({ fillAfterMs: 10000 });

    harness.run(1);
    const first = harness.state.botFillSeconds;
    harness.run(4);
    const later = harness.state.botFillSeconds;

    assert.ok(first > later, `expected the wait to shrink, ${first} -> ${later}`);
    assert.ok(later > 0);
  });

  it("fills what is left once the hold expires", () => {
    const harness = lobby({ fillAfterMs: 3000, bots: 4 });

    harness.run(6);

    assert.equal(harness.npcs.count, 4, "one person and four bots is a full arena");
    assert.equal(harness.state.botFillSeconds, 0);
    assert.equal(harness.state.canStartNow, false, "nothing left to skip");
  });

  it("never fills past the arena's own limit", () => {
    const harness = lobby({ fillAfterMs: 0, bots: 99 });

    harness.run(2);

    assert.ok(harness.state.players.size <= DEFAULT_GAME_CONFIG.match.maxPlayers);
  });

  it("lets whoever is waiting skip the hold", () => {
    const harness = lobby({ fillAfterMs: 60000 });
    harness.run(2);
    assert.equal(harness.npcs.count, 0, "still holding");

    assert.equal(harness.npcs.requestImmediateStart("human"), true);
    assert.ok(harness.npcs.count > 0, "asking should fill the lobby immediately");
    assert.equal(harness.state.canStartNow, false);
  });

  it("ignores a bot asking to skip its own hold", () => {
    const harness = lobby({ fillAfterMs: 0 });
    harness.run(2);

    const bot = harness.npcs.list()[0]!;
    assert.equal(harness.npcs.requestImmediateStart(bot.sessionId), false);
  });

  it("ignores somebody who is not in this lobby", () => {
    const harness = lobby({ fillAfterMs: 60000 });
    harness.run(1);

    assert.equal(harness.npcs.requestImmediateStart("nobody-in-particular"), false);
    assert.equal(harness.npcs.count, 0);
  });

  it("waits for nobody when there is nobody", () => {
    // Bots never play among themselves, so an empty lobby stays empty.
    const config = cloneConfig(getGameConfig());
    config.npc.enabled = true;
    config.npc.fillAfterMs = 0;

    const harness = createHarness();
    harness.replaceConfig(config);
    harness.state.matchState = MatchState.WAITING;

    harness.run(3);

    assert.equal(harness.npcs.count, 0);
    assert.equal(harness.state.canStartNow, false);
  });

  it("clears the bots when the last person leaves, even mid-match", () => {
    // The lobby fills, the match starts, and then everybody quits. A server
    // quietly simulating a fight nobody is watching is a bug, not a feature.
    const harness = lobby({ fillAfterMs: 0 });
    harness.run(4);
    assert.ok(harness.npcs.count > 0, "expected the lobby to fill");

    harness.state.players.delete("human");
    harness.runtimes.delete("human");
    harness.run(2);

    assert.equal(harness.npcs.count, 0, "bots should not be left playing alone");
  });

  it("keeps playing while a dropped player might still come back", () => {
    // A connection blip is not the same as leaving, and ending somebody's match
    // over one would be worse than letting the bots carry on for a few seconds.
    const harness = lobby({ fillAfterMs: 0 });
    harness.run(4);
    const filled = harness.npcs.count;
    assert.ok(filled > 0);

    harness.state.players.get("human")!.connected = false;
    harness.run(2);

    assert.equal(harness.npcs.count, filled, "their seat is still theirs");
  });

  it("does not hold anything open when bots are switched off", () => {
    const harness = lobby({ enabled: false, fillAfterMs: 60000 });

    harness.run(3);

    assert.equal(harness.npcs.count, 0);
    assert.equal(harness.state.canStartNow, false, "offering a skip that does nothing would be a lie");
    assert.equal(harness.npcs.requestImmediateStart("human"), false);
  });
});

describe("choosing the bots before a match", () => {
  /** A waiting lobby with `people` people in it and the shipped ladder. */
  function lobbyOf(people: number, overrides: Partial<{ fillAfterMs: number; bots: number }> = {}) {
    const config = cloneConfig(getGameConfig());
    config.npc.enabled = true;
    config.npc.fillAfterMs = overrides.fillAfterMs ?? 0;
    if (overrides.bots !== undefined) config.npc.defaultBotCount = overrides.bots;

    const harness = createHarness();
    harness.replaceConfig(config);
    harness.state.matchState = MatchState.WAITING;

    for (let index = 0; index < people; index++) {
      const player = harness.addPlayer(`human-${index}`, 400 + index * 40, 1700);
      player.connected = true;
      player.alive = false;
      player.inMatch = false;
    }
    return harness;
  }

  it("publishes what the lobby may be asked for", () => {
    const harness = lobbyOf(1);
    harness.run(1);

    assert.equal(harness.state.maxBots, DEFAULT_GAME_CONFIG.match.maxPlayers - 1);
    assert.equal(harness.state.botCount, DEFAULT_GAME_CONFIG.npc.defaultBotCount);
    assert.equal(harness.state.botDifficulty, DEFAULT_GAME_CONFIG.npc.defaultDifficulty);
    assert.equal(harness.state.botDifficultyName, "Normal", "the ladder names its own rungs");
  });

  it("fills to exactly the number asked for", () => {
    const harness = lobbyOf(1);
    assert.equal(harness.npcs.setLobbyBots("human-0", 2, 3), true);

    harness.run(3);

    assert.equal(harness.npcs.count, 2);
  });

  it("retires bots when the number is lowered, and moves the rest", () => {
    // Inside the hold, where the lobby still exists: once it has what it asked
    // for it starts, and a running match is nobody's to reconfigure.
    const harness = lobbyOf(1, { fillAfterMs: 60000 });
    harness.run(1);

    harness.npcs.setLobbyBots("human-0", 3, 5);
    harness.npcs.requestImmediateStart("human-0");
    assert.equal(harness.npcs.count, 3, "expected the lobby to fill to what was asked for");

    assert.equal(harness.npcs.setLobbyBots("human-0", 1, 2), true);

    assert.equal(harness.npcs.count, 1, "the extra bots should have left");
    for (const agent of harness.npcs.list()) {
      assert.equal(agent.difficulty.level, 2, "and the one left should have changed level");
    }
  });

  it("adds no bots at all when asked for none", () => {
    const harness = lobbyOf(2);
    harness.npcs.setLobbyBots("human-0", 0, 3);

    // Long enough for the countdown to run out, too.
    harness.run(8);

    assert.equal(harness.npcs.count, 0, "nobody asked for a bot");
    assert.equal(harness.state.matchState, MatchState.PLAYING, "two people are a match");
  });

  it("waits for a second person rather than starting a match of one", () => {
    // A solo match is over on the tick it begins. With no bots asked for, an
    // opponent has to be somebody.
    const harness = lobbyOf(1);
    harness.npcs.setLobbyBots("human-0", 0, 3);

    harness.run(8);

    assert.equal(harness.npcs.count, 0);
    assert.equal(harness.state.matchState, MatchState.WAITING);
  });

  it("starts a short match rather than holding out for five", () => {
    // One person, one bot: fewer than the arena seats, and a match all the same.
    const harness = lobbyOf(1);
    harness.npcs.setLobbyBots("human-0", 1, 2);

    harness.run(8);

    assert.equal(harness.state.matchState, MatchState.PLAYING);
    assert.equal(harness.state.players.size, 2);
  });

  it("clamps a count the arena cannot seat", () => {
    const harness = lobbyOf(1);
    harness.npcs.setLobbyBots("human-0", 99, 3);

    assert.equal(harness.state.botCount, DEFAULT_GAME_CONFIG.match.maxPlayers - 1);
  });

  it("clamps a difficulty the ladder does not have", () => {
    const harness = lobbyOf(1);

    harness.npcs.setLobbyBots("human-0", 1, 99);
    assert.equal(harness.state.botDifficulty, MAX_BOT_DIFFICULTY);

    harness.npcs.setLobbyBots("human-0", 1, -4);
    assert.equal(harness.state.botDifficulty, MIN_BOT_DIFFICULTY);
  });

  it("refuses a bot and a stranger asking", () => {
    const harness = lobbyOf(1, { fillAfterMs: 60000 });
    harness.run(1);
    harness.npcs.requestImmediateStart("human-0");
    const bot = harness.npcs.list()[0]!;

    assert.equal(harness.npcs.setLobbyBots(bot.sessionId, 0, 5), false);
    assert.equal(harness.npcs.setLobbyBots("nobody-in-particular", 0, 5), false);
  });

  it("refuses to change the setup once a match is running", () => {
    const harness = lobbyOf(1);
    harness.run(6);
    assert.equal(harness.state.matchState, MatchState.PLAYING);

    const before = harness.state.botCount;
    assert.equal(harness.npcs.setLobbyBots("human-0", 0, 5), false);
    assert.equal(harness.state.botCount, before);
  });

  it("spawns bots at the difficulty the lobby chose", () => {
    const harness = lobbyOf(1);
    harness.npcs.setLobbyBots("human-0", 2, 1);
    harness.run(1);

    for (const agent of harness.npcs.list()) {
      assert.equal(agent.difficulty.level, 1);
      assert.equal(agent.difficulty.name, "Very Easy");
    }
  });

  it("keeps a running match's difficulty out of the lobby's hands", () => {
    const harness = lobbyOf(1);
    harness.npcs.setLobbyBots("human-0", 2, 1);
    harness.run(8);
    assert.equal(harness.state.matchState, MatchState.PLAYING);

    assert.equal(harness.npcs.setLobbyBots("human-0", 2, 5), false);
    for (const agent of harness.npcs.list()) {
      assert.equal(agent.difficulty.level, 1, "the match is being played at the level it started at");
    }
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

describe("a lobby that asked for no bots", () => {
  function soloLobby(people: number) {
    const config = cloneConfig(getGameConfig());
    config.npc.enabled = true;
    config.npc.fillAfterMs = 60000;
    config.npc.defaultBotCount = 0;

    const harness = createHarness();
    harness.replaceConfig(config);
    harness.state.matchState = MatchState.WAITING;
    for (let index = 0; index < people; index++) {
      const player = harness.addPlayer(`human-${index}`, 400 + index * 40, 1700);
      player.connected = true;
      player.alive = false;
      player.inMatch = false;
    }
    return harness;
  }

  it("offers no skip that would do nothing", () => {
    // One person, no bots: skipping the wait cannot conjure an opponent, and a
    // button that quietly achieves nothing is worse than no button.
    const harness = soloLobby(1);
    harness.run(2);

    assert.equal(harness.state.canStartNow, false);
    assert.equal(harness.npcs.requestImmediateStart("human-0"), false);
    assert.equal(harness.state.matchState, MatchState.WAITING);
  });

  it("still says what it is waiting for", () => {
    const harness = soloLobby(1);
    harness.run(2);

    assert.ok(harness.state.botFillSeconds > 0, "the wait is real even with no bots in it");
  });

  it("offers the skip again as soon as there is somebody to fight", () => {
    const harness = soloLobby(2);
    harness.run(2);

    assert.equal(harness.state.canStartNow, true);
    assert.equal(harness.npcs.requestImmediateStart("human-0"), true);

    harness.run(8);
    assert.equal(harness.state.matchState, MatchState.PLAYING);
    assert.equal(harness.npcs.count, 0, "nobody asked for a bot");
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
