/**
 * The single-player campaign, headless: the real CampaignDirector conducting
 * the real local simulation (the server's own systems) over the real Outpost
 * level, on a fake clock. What passes here is what the browser runs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CAMPAIGN_LEVELS,
  CAMPAIGN_SCORING,
  OUTPOST_ARENA,
  OUTPOST_LEVEL,
  REFINERY_ARENA,
  REFINERY_LEVEL,
  campaignChain,
  getCampaignArena,
  getCampaignLevel,
  validateCampaignLevel,
  type ArenaDefinition,
  type CampaignLevelDefinition,
  type CampaignLevelResult,
} from "@deathmatch/shared";

import { CampaignDirector } from "../client/src/campaign/core/CampaignDirector.js";
import { ScoreTracker } from "../client/src/campaign/core/ScoreTracker.js";
import { LOCAL_PLAYER_ID } from "../client/src/campaign/sim/LocalMatch.js";

// SaveStore expects a browser; give node a tiny stand-in so persistence and
// resume are testable rather than silently skipped.
const storage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
};

const clock = { now: 0 };

function makeDirector(
  difficulty: "easy" | "normal" | "hard" | "extreme" = "normal",
  level: CampaignLevelDefinition = OUTPOST_LEVEL,
  arena: ArenaDefinition = OUTPOST_ARENA,
) {
  clock.now = 0;
  storage.clear();
  const director = new CampaignDirector(level, arena, difficulty, {
    seed: 4242,
    now: () => clock.now,
  });
  director.start();
  return director;
}

/** Walk right, double-jump when stalled, shoot what blocks the way. */
function walkToTheEnd(director: CampaignDirector, finishX: number): number {
  const player = director.player()!;
  let lastX = player.x;
  let stalledFrames = 0;

  for (let frame = 0; frame < 60 * 240; frame++) {
    const stalled = Math.abs(player.x - lastX) < 0.4;
    if (stalled) stalledFrames++;
    else {
      stalledFrames = 0;
      lastX = player.x;
    }
    const phase = frame % 60;
    director.match.applyInput({
      moveLeft: false,
      moveRight: true,
      jump: stalled && (phase < 6 || (phase >= 12 && phase < 18)),
      fire: stalled,
      reload: false,
      chargeGrenade: false,
      aimAngle: 0,
    });
    tick(director, 16.7);
    if (player.x > finishX) break;
  }
  void stalledFrames;
  return player.x;
}

/** Advance wall time and the simulation together, in room-sized slices. */
function tick(director: CampaignDirector, ms: number): void {
  let remaining = ms;
  while (remaining > 0) {
    const slice = Math.min(50, remaining);
    clock.now += slice;
    director.update(slice);
    remaining -= slice;
  }
}

function enemies(director: CampaignDirector) {
  return Array.from(director.match.state.players.values()).filter(
    (player) => player.sessionId !== LOCAL_PLAYER_ID,
  );
}

function aliveEnemies(director: CampaignDirector) {
  return enemies(director).filter((player) => player.alive);
}

function killEnemy(director: CampaignDirector, sessionId: string): void {
  // Per-hit damage is sanity-capped at the player's max health, so tougher
  // enemies take several hits -- as they would from real fire.
  const enemy = director.match.state.players.get(sessionId)!;
  for (let hits = 0; hits < 50 && enemy.alive; hits++) {
    director.match.matchManager.applyDamage(sessionId, LOCAL_PLAYER_ID, 1_000_000, enemy.x, enemy.y, "test");
  }
}

function hitEnemy(director: CampaignDirector, sessionId: string, amount: number): void {
  const enemy = director.match.state.players.get(sessionId)!;
  let remaining = amount;
  while (remaining > 0 && enemy.alive) {
    const hit = Math.min(90, remaining);
    director.match.matchManager.applyDamage(sessionId, LOCAL_PLAYER_ID, hit, enemy.x, enemy.y, "test");
    remaining -= hit;
  }
}

describe("campaign: the level is sound", () => {
  it("outpost validates against its arena", () => {
    assert.deepEqual(validateCampaignLevel(OUTPOST_LEVEL, OUTPOST_ARENA), []);
  });

  it("starts with the player at the spawn and the furniture placed", () => {
    const director = makeDirector();
    const player = director.player()!;
    assert.ok(Math.abs(player.x - OUTPOST_LEVEL.playerSpawn.x) < 80);
    assert.equal(player.weaponId, OUTPOST_LEVEL.startingWeapon);
    assert.equal(director.match.state.crates.size, OUTPOST_LEVEL.crates.length);
  });

  it("announces the briefing objective on level start", () => {
    clock.now = 0;
    storage.clear();
    const director = new CampaignDirector(OUTPOST_LEVEL, OUTPOST_ARENA, "normal", {
      seed: 1,
      now: () => clock.now,
    });
    let objective = "";
    director.ui.on("objective", ({ text }) => (objective = text));
    director.start();
    assert.equal(objective, "Push through the outpost");
  });
});

describe("campaign: triggers spawn the world on approach", () => {
  it("spawns the patrol when the player reaches its zone, and not before", () => {
    const director = makeDirector();
    director.debugSetGodMode(true);
    assert.equal(enemies(director).length, 0, "nothing is active at the door");

    director.debugTeleport(1000, 1100);
    tick(director, 100);
    assert.equal(aliveEnemies(director).length, 2, "two soldiers on normal");
  });

  it("difficulty changes the composition, not just numbers on the same men", () => {
    const director = makeDirector("hard");
    director.debugSetGodMode(true);
    director.debugTeleport(1000, 1100);
    tick(director, 100);
    assert.equal(aliveEnemies(director).length, 3, "hard adds a third soldier");
  });

  it("scales enemy health by difficulty", () => {
    const easy = makeDirector("easy");
    easy.debugSetGodMode(true);
    easy.debugTeleport(1000, 1100);
    tick(easy, 100);
    const easySoldier = aliveEnemies(easy)[0]!;
    assert.equal(easySoldier.health, Math.round(70 * 0.75));
  });

  it("a turret spawns stationary and stays put", () => {
    const director = makeDirector();
    director.debugSetGodMode(true);
    director.debugTeleport(2300, 1100);
    tick(director, 100);
    const turret = aliveEnemies(director).find((enemy) => enemy.name === "Turret");
    assert.ok(turret, "the tower trigger spawns a turret");
    const before = turret.x;
    tick(director, 3000);
    assert.ok(Math.abs(turret.x - before) < 2, "an emplacement does not wander");
  });
});

describe("campaign: the yard encounter", () => {
  function enterYard(director: CampaignDirector): string[] {
    const locks: (string | null)[] = [];
    director.ui.on("cameraLock", ({ zoneId }) => locks.push(zoneId));
    director.debugSetGodMode(true);
    director.debugTeleport(4890, 1100);
    tick(director, 100);
    return locks.filter((zone): zone is string => zone !== null);
  }

  it("locks the camera and runs two waves before opening the way", () => {
    const director = makeDirector();
    const locks = enterYard(director);
    assert.deepEqual(locks, ["yard"]);

    const waveOne = aliveEnemies(director);
    assert.equal(waveOne.length, 3, "soldier, soldier, runner on normal");

    for (const enemy of waveOne) killEnemy(director, enemy.sessionId);
    tick(director, 100);
    const waveTwo = aliveEnemies(director);
    assert.equal(waveTwo.length, 2, "grenadier and heavy on normal");

    let breach = false;
    director.ui.on("message", ({ text }) => {
      if (text.includes("Breach")) breach = true;
    });
    for (const enemy of waveTwo) killEnemy(director, enemy.sessionId);
    tick(director, 100);

    assert.ok(breach, "clearing the yard triggers the scripted breach");
    // The scripted breach destroys the crate holding the yard's exit shut.
    const door = OUTPOST_ARENA.powerUpSpawns.find((point) => point.id === "door")!;
    const remaining = Array.from(director.match.state.crates.values()).filter(
      (crate) => Math.abs(crate.x - door.x) < 60 && Math.abs(crate.y - door.y) < 120,
    );
    assert.equal(remaining.length, 0, "the yard door is gone");
  });

  it("dying mid-encounter resets the fight and refunds its points", () => {
    const director = makeDirector();
    director.debugSetGodMode(true);
    director.debugTeleport(4890, 1100);
    tick(director, 100);

    const first = aliveEnemies(director)[0]!;
    killEnemy(director, first.sessionId);
    tick(director, 60);
    assert.ok(director.currentScore() > 0, "the kill paid out");

    // Die.
    director.debugSetGodMode(false);
    director.match.matchManager.applyDamage(LOCAL_PLAYER_ID, "", 1_000_000, 0, 0, "test");
    tick(director, 3000);

    assert.equal(director.player()!.alive, true, "respawned at the checkpoint delay's end");
    assert.equal(director.currentScore(), 0, "the encounter's points came back off");
    assert.equal(aliveEnemies(director).length, 0, "the encounter's enemies left");

    // Walking back in restarts it from wave one.
    director.debugSetGodMode(true);
    director.debugTeleport(4890, 1100);
    tick(director, 100);
    assert.equal(aliveEnemies(director).length, 3, "wave one again, in full");
  });
});

describe("campaign: checkpoints and secrets", () => {
  it("claims a checkpoint once and persists a resume save", () => {
    const director = makeDirector();
    director.debugSetGodMode(true);
    const claimed: string[] = [];
    director.ui.on("checkpoint", ({ id }) => claimed.push(id));

    director.debugTeleport(3620, 1100);
    tick(director, 100);
    tick(director, 100);
    assert.deepEqual(claimed, ["cp1"]);

    const raw = storage.get("deathmatch-campaign-checkpoint");
    assert.ok(raw, "the checkpoint is saved locally");
    assert.equal(JSON.parse(raw!).checkpointId, "cp1");
  });

  it("death returns the player to the last checkpoint", () => {
    const director = makeDirector();
    director.debugSetGodMode(true);
    director.debugTeleport(3620, 1100);
    tick(director, 100);

    director.debugSetGodMode(false);
    director.match.matchManager.applyDamage(LOCAL_PLAYER_ID, "", 1_000_000, 0, 0, "test");
    tick(director, 3000);

    const player = director.player()!;
    assert.equal(player.alive, true);
    assert.ok(Math.abs(player.x - 3600) < 80, `respawned at cp1, not ${player.x}`);
  });

  it("finds a secret exactly once and pays it out", () => {
    const director = makeDirector();
    director.debugSetGodMode(true);
    let found = 0;
    director.ui.on("secretFound", () => found++);

    director.debugTeleport(210, 740);
    tick(director, 100);
    director.debugTeleport(210, 740);
    tick(director, 100);

    assert.equal(found, 1);
    assert.equal(director.currentScore(), CAMPAIGN_SCORING.defaultSecretPoints);
  });
});

describe("campaign: the boss", () => {
  function startBoss(director: CampaignDirector) {
    director.debugSetGodMode(true);
    director.debugTeleport(7520, 1100);
    tick(director, 100);
    const boss = enemies(director).find((enemy) => enemy.name === "The Warden");
    assert.ok(boss, "the gate trigger spawns the Warden");
    return boss;
  }

  it("spawns with scaled health and walks its phase table", () => {
    const director = makeDirector();
    const boss = startBoss(director);
    assert.equal(boss.health, 900, "full boss health on normal");
    assert.equal(director.bossStatus()?.name, "The Warden");

    // Into phase two: rockets, and adds.
    hitEnemy(director, boss.sessionId, 400);
    tick(director, 100);
    assert.equal(boss.weaponId, "rocket-launcher", "phase two swaps the weapon");
    assert.ok(
      aliveEnemies(director).some((enemy) => enemy.name === "Runner"),
      "phase two calls adds",
    );

    // Into phase three: the overcharge.
    hitEnemy(director, boss.sessionId, 300);
    tick(director, 100);
    assert.equal(boss.weaponId, "laser", "phase three overcharges");
  });

  it("defeat opens the finish, and the finish ends the level with a result", () => {
    const director = makeDirector();
    const boss = startBoss(director);

    let completed: CampaignLevelResult | null = null;
    director.ui.on("levelCompleted", ({ result }) => (completed = result));

    // The finish line refuses to count while the Warden stands.
    director.debugTeleport(8860, 1100);
    tick(director, 200);
    assert.equal(completed, null, "no early exit past a living boss");

    killEnemy(director, boss.sessionId);
    for (const add of aliveEnemies(director)) killEnemy(director, add.sessionId);
    tick(director, 100);

    director.debugTeleport(8860, 1100);
    tick(director, 200);

    assert.ok(completed, "the level completes");
    const result: CampaignLevelResult = completed!;
    assert.equal(result.levelId, "level-01");
    assert.ok(result.score > 0);
    assert.ok(["S", "A", "B", "C", "D"].includes(result.rank));
    assert.equal(result.secretsTotal, 2);

    // Progress landed in the local record.
    const progress = JSON.parse(storage.get("deathmatch-campaign-progress")!);
    assert.equal(progress.levels["level-01"].completed, true);
  });
});

describe("campaign: respawn rules", () => {
  it("one-life mode fails the level on the first death", () => {
    const oneLife: CampaignLevelDefinition = { ...OUTPOST_LEVEL, respawnRule: { kind: "oneLife" } };
    const director = makeDirector("normal", oneLife);
    let failed = false;
    director.ui.on("levelFailed", () => (failed = true));

    director.match.matchManager.applyDamage(LOCAL_PLAYER_ID, "", 1_000_000, 0, 0, "test");
    tick(director, 100);
    assert.equal(failed, true);
  });

  it("limited lives fail only when they run out", () => {
    const arcade: CampaignLevelDefinition = { ...OUTPOST_LEVEL, respawnRule: { kind: "lives", lives: 2 } };
    const director = makeDirector("normal", arcade);
    let failed = false;
    const deaths: (number | null)[] = [];
    director.ui.on("levelFailed", () => (failed = true));
    director.ui.on("playerDied", ({ livesLeft }) => deaths.push(livesLeft));

    director.match.matchManager.applyDamage(LOCAL_PLAYER_ID, "", 1_000_000, 0, 0, "test");
    tick(director, 3000);
    assert.equal(failed, false);
    assert.deepEqual(deaths, [1]);

    director.match.matchManager.applyDamage(LOCAL_PLAYER_ID, "", 1_000_000, 0, 0, "test");
    tick(director, 100);
    assert.equal(failed, true);
  });
});

describe("campaign: the level is actually playable", () => {
  it("can be walked from the spawn to the finish line", () => {
    /*
     * Nothing here teleports: this is the test that would have caught a 240px
     * wall standing on the only route, which three debug-teleported
     * playthroughs happily jumped straight over.
     */
    const director = makeDirector();
    director.debugSetGodMode(true);
    const reached = walkToTheEnd(director, 8800);
    assert.ok(reached > 8760, `should reach the finish zone on foot, stopped at ${Math.round(reached)}`);
  });

  it("places no crate inside solid geometry", () => {
    // Box physics shoves such a crate out on the first tick, landing it
    // somewhere the level never chose -- and the shot that misses it lands
    // nowhere near the crate the player can see.
    assert.deepEqual(
      validateCampaignLevel(OUTPOST_LEVEL, OUTPOST_ARENA).filter((issue) => issue.includes("inside solid")),
      [],
    );

    const broken: CampaignLevelDefinition = {
      ...OUTPOST_LEVEL,
      crates: [{ spawnPointId: "wall-trap" }],
    };
    const arena = {
      ...OUTPOST_ARENA,
      powerUpSpawns: [{ id: "wall-trap", x: 4400, y: 1000, enabled: true }],
      elements: [...OUTPOST_ARENA.elements, { id: "slab", type: "wall" as const, x: 4380, y: 980, width: 60, height: 60 }],
    };
    assert.ok(
      validateCampaignLevel(broken, arena).some((issue) => issue.includes("inside solid")),
      "a crate buried in a wall must be reported",
    );
  });

  it("settles every crate within a crate's height of where it was placed", () => {
    const director = makeDirector();
    const placed = new Map<string, { x: number; y: number }>();
    for (const crate of director.match.state.crates.values()) {
      placed.set(crate.id, { x: crate.x, y: crate.y });
    }

    tick(director, 4000);

    for (const crate of director.match.state.crates.values()) {
      const from = placed.get(crate.id)!;
      const drift = Math.hypot(crate.x - from.x, crate.y - from.y);
      assert.ok(
        drift <= 44,
        `crate ${crate.id} drifted ${Math.round(drift)}px from where the level put it`,
      );
    }
  });
});

describe("campaign: level 2 and the chain", () => {
  it("every shipped level validates against its own arena", () => {
    const ids = CAMPAIGN_LEVELS.map((level) => level.id);
    for (const level of CAMPAIGN_LEVELS) {
      const arena = getCampaignArena(level.arenaId);
      assert.ok(arena, `level ${level.id} names an arena the campaign cannot load`);
      assert.deepEqual(validateCampaignLevel(level, arena, ids), [], `level ${level.id} has content issues`);
    }
  });

  it("chains Outpost into Refinery, and the chain terminates", () => {
    const chain = campaignChain();
    assert.deepEqual(chain.map((level) => level.id), ["level-01", "level-02"]);
    assert.equal(chain.at(-1)!.nextLevelId, undefined, "the last level leads nowhere");
  });

  it("walks Refinery from the spawn to its finish line", () => {
    const director = makeDirector("normal", REFINERY_LEVEL, REFINERY_ARENA);
    director.debugSetGodMode(true);
    const reached = walkToTheEnd(director, 9450);
    assert.ok(reached > 9380, `should reach Refinery's finish on foot, stopped at ${Math.round(reached)}`);
  });

  it("fights the Foreman through a mounted phase and a mobile one", () => {
    const director = makeDirector("normal", REFINERY_LEVEL, REFINERY_ARENA);
    director.debugSetGodMode(true);
    director.debugTeleport(8290, 1290);
    tick(director, 200);

    const boss = Array.from(director.match.state.players.values()).find(
      (player) => player.name === "The Foreman",
    );
    assert.ok(boss, "the gate trigger spawns the Foreman");

    // Phase one: an emplacement. It holds its ground.
    const agent = director.match.npcs.get(boss.sessionId)!;
    assert.equal(agent.stationary, true, "the Foreman starts mounted");

    // Past 60%: it tears loose, changes weapon and brings help.
    hitEnemy(director, boss.sessionId, 500);
    tick(director, 200);
    assert.equal(agent.stationary, false, "the second phase tears it off its mount");
    assert.equal(boss.weaponId, "flamethrower");
    assert.ok(
      aliveEnemies(director).some((enemy) => enemy.name === "Enforcer"),
      "the second phase calls Enforcers",
    );
  });

  it("carries the weapon forward only when the arriving level asks for it", () => {
    // Refinery asks; a copy that does not must get its own starting weapon.
    clock.now = 0;
    storage.clear();
    const carrying = new CampaignDirector(REFINERY_LEVEL, REFINERY_ARENA, "normal", {
      seed: 7,
      now: () => clock.now,
    });
    carrying.start(null, "You", { weaponId: "rocket-launcher", grenades: 5 });
    assert.equal(carrying.player()!.weaponId, "rocket-launcher");
    assert.equal(carrying.player()!.grenades, 5, "grenades carry, topped up to the level's own count");

    const noCarry: CampaignLevelDefinition = { ...REFINERY_LEVEL, carryOver: undefined };
    clock.now = 0;
    storage.clear();
    const fresh = new CampaignDirector(noCarry, REFINERY_ARENA, "normal", { seed: 7, now: () => clock.now });
    fresh.start(null, "You", { weaponId: "rocket-launcher", grenades: 5 });
    assert.equal(fresh.player()!.weaponId, REFINERY_LEVEL.startingWeapon);
    assert.equal(fresh.player()!.grenades, REFINERY_LEVEL.startingGrenades);
  });

  it("a resumed checkpoint outranks anything carried in", () => {
    const director = makeDirector("normal", REFINERY_LEVEL, REFINERY_ARENA);
    director.debugSetGodMode(true);
    director.debugTeleport(2700, 1290);
    tick(director, 200);

    const saved = JSON.parse(storage.get("deathmatch-campaign-checkpoint")!);
    assert.equal(saved.checkpointId, "cp1");

    clock.now = 0;
    const resumed = new CampaignDirector(REFINERY_LEVEL, REFINERY_ARENA, "normal", {
      seed: 7,
      now: () => clock.now,
    });
    resumed.start(saved, "You", { weaponId: "laser", grenades: 9 });
    assert.equal(resumed.player()!.weaponId, saved.weaponId, "the save's own loadout wins");
  });

  it("level 2 uses enemies level 1 never had", () => {
    const spawnedTypes = new Set<string>();
    for (const trigger of REFINERY_LEVEL.triggers) {
      for (const action of trigger.actions) {
        if (action.kind === "spawnEnemies") for (const spawn of action.enemies) spawnedTypes.add(spawn.type);
      }
    }
    for (const encounter of REFINERY_LEVEL.encounters) {
      for (const wave of encounter.waves) for (const spawn of wave.enemies) spawnedTypes.add(spawn.type);
    }
    for (const fresh of ["enforcer", "marksman", "zealot"]) {
      assert.ok(spawnedTypes.has(fresh), `Refinery should field the ${fresh}`);
    }
    assert.equal(getCampaignLevel("level-02")!.boss!.enemyType, "foreman");
  });
});

describe("campaign: scoring arithmetic", () => {
  it("chains combo kills up to the cap", () => {
    const tracker = new ScoreTracker(CAMPAIGN_SCORING);
    assert.equal(tracker.recordKill(100, 0), 100);
    assert.equal(tracker.recordKill(100, 1000), 125);
    assert.equal(tracker.recordKill(100, 2000), 150);
    // Far outside the window: the chain resets.
    assert.equal(tracker.recordKill(100, 60000), 100);
  });

  it("ranks a strong clear high and an empty one low", () => {
    const strong = new ScoreTracker(CAMPAIGN_SCORING);
    for (let i = 0; i < 10; i++) {
      strong.recordShot();
      strong.recordHit();
      strong.recordKill(500, i * 1000);
    }
    strong.recordSecret();
    const good = strong.finalize("x", "normal", 200_000, 300_000, 1, 5000, 500);
    assert.ok(["S", "A"].includes(good.rank), `expected a top rank, got ${good.rank}`);

    const weak = new ScoreTracker(CAMPAIGN_SCORING);
    const bad = weak.finalize("x", "normal", 900_000, 300_000, 1, 5000, 500);
    assert.equal(bad.rank, "D");
  });
});
