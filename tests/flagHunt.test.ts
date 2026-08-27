/**
 * Flag Hunt, end to end on the server: spawning, pickup, the death drop, the
 * clock, sudden death and respawns -- all through the real `MatchManager` and
 * the mode instance it creates, so what is asserted is what a room does.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GameMode, MatchState, ServerMessage, cloneConfig } from "@deathmatch/shared";

import { clock, createHarness, type Harness } from "./harness.js";

const { FlagState } = await import("../server/src/rooms/schema/FlagState.js");

/** A corner far from every power-up spawn, so nobody collects by accident. */
const PARKING = { x: 60, y: 300 };

/**
 * Start a real Flag Hunt match: WAITING -> COUNTDOWN -> PLAYING through the
 * actual state machine, so the mode instance and its flags are the ones a
 * room would have. Players are then parked away from the spawn points.
 */
function startFlagHunt(harness: Harness, ids: string[], at = 0): void {
  clock.now = at;
  harness.state.matchState = MatchState.WAITING;
  harness.state.gameModeId = GameMode.FLAG_HUNT;

  for (const id of ids) {
    const player = harness.addPlayer(id, PARKING.x, PARKING.y);
    player.connected = true;
  }
  harness.state.hostId = ids[0]!;

  harness.matchManager.requestStart();
  harness.matchManager.update(clock.now);
  assert.equal(harness.state.matchState, MatchState.COUNTDOWN);

  clock.now += 4000;
  harness.matchManager.update(clock.now);
  assert.equal(harness.state.matchState, MatchState.PLAYING);

  // The match spawned everybody on the arena's own points; park them in a
  // corner so no test collects a flag it did not ask for.
  for (const id of ids) {
    const player = harness.state.players.get(id)!;
    player.x = PARKING.x;
    player.y = PARKING.y;
  }
}

/** Drop a flag exactly here, as the state would carry one. */
function plantFlag(harness: Harness, id: string, x: number, y: number, dropped = false): void {
  const flag = new FlagState();
  flag.id = id;
  flag.x = x;
  flag.y = y;
  flag.dropped = dropped;
  harness.state.flags.set(id, flag);
}

describe("flag hunt: flags on the map", () => {
  it("plants the initial flags the moment the match starts", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b"]);

    const config = harness.context.config.getFlagHuntConfig();
    assert.equal(harness.state.flags.size, config.initialFlags);
    for (const flag of harness.state.flags.values()) {
      assert.equal(flag.dropped, false);
    }
    // The clock is published from the start.
    assert.equal(
      harness.state.matchTimeRemainingSeconds,
      Math.ceil(config.matchDurationMs / 1000),
    );
  });

  it("keeps spawning on the interval but never past the cap", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b"]);

    // Immortal flags, so the count is limited by the cap alone rather than by
    // old flags expiring out from under it.
    const retuned = cloneConfig(harness.context.baselineConfig);
    retuned.flagHunt.flagLifetimeMs = 0;
    harness.replaceConfig(retuned);
    const config = harness.context.config.getFlagHuntConfig();

    // Enough intervals to overshoot the cap twice over.
    for (let i = 0; i < config.maxFlagsOnMap * 2; i++) {
      clock.now += config.flagSpawnIntervalMs;
      harness.matchManager.update(clock.now);
    }

    assert.equal(harness.state.flags.size, config.maxFlagsOnMap);
  });

  it("expires an unclaimed spawned flag after its lifetime", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b"]);
    const config = harness.context.config.getFlagHuntConfig();

    // Push the spawner far into the future -- but one spawn was already
    // scheduled at match start, so let it fire first and count it in.
    const retuned = cloneConfig(harness.context.baselineConfig);
    retuned.flagHunt.flagSpawnIntervalMs = 10 * 60 * 1000;
    harness.replaceConfig(retuned);
    clock.now += 8001;
    harness.matchManager.update(clock.now);

    const before = harness.state.flags.size;
    assert.ok(before > 0);

    clock.now += config.flagLifetimeMs + 1;
    harness.matchManager.update(clock.now);
    assert.equal(harness.state.flags.size, 0, `all ${before} flags should have expired`);
  });
});

describe("flag hunt: pickup is server-decided", () => {
  it("hands a flag to a player standing on it", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b"]);
    harness.state.flags.clear();

    const a = harness.state.players.get("a")!;
    plantFlag(harness, "f1", a.x + 10, a.y);

    clock.now += 50;
    harness.matchManager.update(clock.now);

    assert.equal(a.flagCount, 1);
    assert.equal(harness.state.flags.has("f1"), false);
  });

  it("gives a contested flag to exactly one of two players on it", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b"]);
    harness.state.flags.clear();

    // Both inside the pickup radius on the same tick -- the latency race in
    // miniature. One pass, one winner, by construction.
    const a = harness.state.players.get("a")!;
    const b = harness.state.players.get("b")!;
    plantFlag(harness, "contested", PARKING.x + 5, PARKING.y);
    b.x = PARKING.x + 8;
    b.y = PARKING.y;

    clock.now += 50;
    harness.matchManager.update(clock.now);

    assert.equal(a.flagCount + b.flagCount, 1, "the flag must be counted exactly once");
    assert.equal(harness.state.flags.size, 0);
  });

  it("ignores the dead and the spectating", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b", "c"]);
    harness.state.flags.clear();

    const a = harness.state.players.get("a")!;
    a.alive = false;
    a.x = 900;
    a.y = 300;
    plantFlag(harness, "f1", a.x, a.y);

    clock.now += 50;
    harness.matchManager.update(clock.now);

    assert.equal(a.flagCount, 0);
    assert.equal(harness.state.flags.has("f1"), true);
  });
});

describe("flag hunt: death drops a share", () => {
  it("drops the floor of the percentage and keeps the rest", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["victim", "killer"]);
    harness.state.flags.clear();

    const victim = harness.state.players.get("victim")!;
    const killer = harness.state.players.get("killer")!;
    victim.flagCount = 10;

    harness.matchManager.eliminate(victim, killer, killer.weaponId);

    // 10 at the default 50% -> 5 dropped, 5 kept.
    assert.equal(victim.flagCount, 5);
    const dropped = Array.from(harness.state.flags.values()).filter((flag) => flag.dropped);
    assert.equal(dropped.length, 5);
  });

  it("rounds the share down: 3 flags at 50% drops 1 and keeps 2", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["victim", "killer"]);
    harness.state.flags.clear();

    const victim = harness.state.players.get("victim")!;
    victim.flagCount = 3;

    harness.matchManager.eliminate(victim, harness.state.players.get("killer")!, "chainsaw");

    assert.equal(victim.flagCount, 2);
    assert.equal(Array.from(harness.state.flags.values()).filter((f) => f.dropped).length, 1);
  });

  it("scatters the dropped flags around the death instead of stacking them", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["victim", "killer"]);
    harness.state.flags.clear();

    const victim = harness.state.players.get("victim")!;
    victim.x = 1200;
    victim.y = 400;
    victim.flagCount = 10;

    harness.matchManager.eliminate(victim, harness.state.players.get("killer")!, "chainsaw");

    const config = harness.context.config.getFlagHuntConfig();
    const xs = Array.from(harness.state.flags.values()).map((flag) => flag.x);
    assert.equal(new Set(xs.map((x) => Math.round(x))).size, xs.length, "no two flags on one spot");
    for (const x of xs) {
      assert.ok(
        Math.abs(x - 1200) <= config.dropScatterPx * 1.2 + 1,
        `flag at ${x} landed outside the scatter`,
      );
    }
  });

  it("expires dropped flags on their own, shorter, clock", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["victim", "killer"]);
    harness.state.flags.clear();

    // Stop the spawner so only the dropped flags are in the count -- letting
    // the one spawn already scheduled at match start fire and be swept first.
    const retuned = cloneConfig(harness.context.baselineConfig);
    retuned.flagHunt.flagSpawnIntervalMs = 10 * 60 * 1000;
    harness.replaceConfig(retuned);
    clock.now += 8001;
    harness.matchManager.update(clock.now);
    harness.state.flags.clear();

    const victim = harness.state.players.get("victim")!;
    victim.flagCount = 4;
    harness.matchManager.eliminate(victim, harness.state.players.get("killer")!, "chainsaw");
    assert.equal(harness.state.flags.size, 2);

    clock.now += harness.context.config.getFlagHuntConfig().droppedFlagLifetimeMs + 1;
    harness.matchManager.update(clock.now);
    assert.equal(harness.state.flags.size, 0);
  });
});

describe("flag hunt: deaths pause, they do not end", () => {
  it("keeps the match running past a kill, and the kill is not match point", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b"]);

    harness.matchManager.eliminate(harness.state.players.get("a")!, harness.state.players.get("b")!, "smg");

    assert.equal(harness.state.matchState, MatchState.PLAYING);
    const kill = [...harness.broadcasts].reverse().find((entry) => entry.type === ServerMessage.KILL);
    assert.equal((kill!.payload as { endsMatch: boolean }).endsMatch, false);
  });

  it("respawns the victim after the delay with score intact", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b"]);
    harness.state.flags.clear();

    const a = harness.state.players.get("a")!;
    a.flagCount = 4;
    a.kills = 3;
    harness.matchManager.eliminate(a, harness.state.players.get("b")!, "smg");
    assert.equal(a.alive, false);
    assert.equal(a.flagCount, 2);

    // One tick before the delay: still dead.
    const delay = harness.context.config.getFlagHuntConfig().respawnDelayMs;
    clock.now += delay - 1;
    harness.matchManager.update(clock.now);
    assert.equal(a.alive, false);

    clock.now += 1;
    harness.matchManager.update(clock.now);
    assert.equal(a.alive, true);
    assert.equal(a.flagCount, 2, "a respawn is not a reset");
    assert.equal(a.kills, 3);
    assert.equal(a.deaths, 1);
    assert.equal(a.health, harness.context.config.getPlayerConfig().maxHealth);
  });
});

describe("flag hunt: full time and sudden death", () => {
  it("ends at full time with the flag leader as winner, standings by flags", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b", "c"]);
    harness.state.flags.clear();

    harness.state.players.get("a")!.flagCount = 2;
    harness.state.players.get("b")!.flagCount = 7;
    harness.state.players.get("c")!.flagCount = 4;
    harness.state.players.get("c")!.kills = 9; // kills must not outrank flags

    clock.now += harness.context.config.getFlagHuntConfig().matchDurationMs + 1;
    harness.matchManager.update(clock.now);

    assert.equal(harness.state.matchState, MatchState.FINISHED);
    assert.equal(harness.state.winnerId, "b");

    const result = [...harness.broadcasts].reverse().find((entry) => entry.type === ServerMessage.MATCH_RESULT);
    const standings = (result!.payload as { standings: { sessionId: string; flags?: number; placement: number }[] })
      .standings;
    assert.deepEqual(
      standings.map((standing) => standing.sessionId),
      ["b", "c", "a"],
    );
    assert.deepEqual(
      standings.map((standing) => standing.flags),
      [7, 4, 2],
    );
    assert.equal(harness.state.players.get("b")!.placement, 1);
  });

  it("a tie at full time goes to sudden death, and the first tied collector wins", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b", "c"]);
    harness.state.flags.clear();

    // Silence the scheduled spawner so the one flag on the map is provably
    // sudden death's own.
    const retuned = cloneConfig(harness.context.baselineConfig);
    retuned.flagHunt.flagSpawnIntervalMs = 60 * 60 * 1000;
    harness.replaceConfig(retuned);
    clock.now += 8001;
    harness.matchManager.update(clock.now);
    harness.state.flags.clear();

    harness.state.players.get("a")!.flagCount = 5;
    harness.state.players.get("b")!.flagCount = 5;
    harness.state.players.get("c")!.flagCount = 1;

    clock.now += harness.context.config.getFlagHuntConfig().matchDurationMs + 1;
    harness.matchManager.update(clock.now);

    // Not over: the clock stopped and one extra flag went out.
    assert.equal(harness.state.matchState, MatchState.PLAYING);
    assert.equal(harness.state.suddenDeath, true);
    assert.equal(harness.state.matchTimeRemainingSeconds, 0);
    assert.equal(harness.state.flags.size, 1);

    // The non-contender collecting decides nothing. Spread the players out
    // first, so each planted flag can only reach its intended taker.
    harness.state.flags.clear();
    const c = harness.state.players.get("c")!;
    c.x = 900;
    c.y = 300;
    plantFlag(harness, "sd-1", c.x, c.y);
    clock.now += 50;
    harness.matchManager.update(clock.now);
    assert.equal(c.flagCount, 2);
    assert.equal(harness.state.matchState, MatchState.PLAYING, "a non-contender cannot win sudden death");

    // A contender collecting ends it on the spot.
    const b = harness.state.players.get("b")!;
    b.x = 1600;
    b.y = 300;
    plantFlag(harness, "sd-2", b.x, b.y);
    clock.now += 50;
    harness.matchManager.update(clock.now);
    assert.equal(harness.state.matchState, MatchState.FINISHED);
    assert.equal(harness.state.winnerId, "b");
  });

  it("with sudden death disabled a tie resolves deterministically at once", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b"]);
    harness.state.flags.clear();

    const retuned = cloneConfig(harness.context.baselineConfig);
    retuned.flagHunt.suddenDeathEnabled = false;
    harness.replaceConfig(retuned);

    harness.state.players.get("a")!.flagCount = 5;
    harness.state.players.get("b")!.flagCount = 5;
    harness.state.players.get("b")!.kills = 2; // the visible tie-break

    clock.now += harness.context.config.getFlagHuntConfig().matchDurationMs + 1;
    harness.matchManager.update(clock.now);

    assert.equal(harness.state.matchState, MatchState.FINISHED);
    assert.equal(harness.state.suddenDeath, false);
    assert.equal(harness.state.winnerId, "b");
  });

  it("ends as a walkover the moment only one participant is connected", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b"]);

    harness.state.players.get("b")!.connected = false;
    clock.now += 50;
    harness.matchManager.update(clock.now);

    assert.equal(harness.state.matchState, MatchState.FINISHED);
    assert.equal(harness.state.winnerId, "a");
  });

  it("publishes a falling clock while playing", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b"]);
    const total = Math.ceil(harness.context.config.getFlagHuntConfig().matchDurationMs / 1000);
    assert.equal(harness.state.matchTimeRemainingSeconds, total);

    clock.now += 60_000;
    harness.matchManager.update(clock.now);
    assert.equal(harness.state.matchTimeRemainingSeconds, total - 60);
  });
});

describe("flag hunt: the arena stays whole", () => {
  it("never starts the closing walls: no countdown, no shrink, full bounds", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b"]);

    // Not even the initial countdown is published.
    assert.equal(harness.state.shrinkCountdownSeconds, 0);

    // Ride well past the point deathmatch's walls would have started moving.
    const startAfterMs = harness.context.config.getArenaShrinkConfig().startAfterMs;
    const until = clock.now + startAfterMs + 30_000;
    while (clock.now < until) {
      clock.now += 1000;
      harness.matchManager.update(clock.now);
      harness.stepArenaShrink(1, clock.now);
    }

    assert.equal(harness.state.shrinking, false);
    assert.equal(harness.state.shrinkCountdownSeconds, 0);
    assert.equal(harness.state.shrinkLeft, 0);
    assert.equal(harness.state.shrinkRight, harness.arena.width);
  });

  it("runs the walls again when flagHunt.arenaShrinking is switched on", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b"]);

    const retuned = cloneConfig(harness.context.baselineConfig);
    retuned.flagHunt.arenaShrinking = true;
    harness.replaceConfig(retuned);

    const startAfterMs = harness.context.config.getArenaShrinkConfig().startAfterMs;
    clock.now += 1000;
    harness.stepArenaShrink(1, clock.now);
    assert.ok(harness.state.shrinkCountdownSeconds > 0, "the countdown should be running");

    clock.now += startAfterMs + 5000;
    harness.matchManager.update(clock.now);
    harness.stepArenaShrink(1, clock.now);
    assert.equal(harness.state.shrinking, true);
  });

  it("puts already-moving walls back if shrinking is switched off mid-match", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b"]);

    const shrinkOn = cloneConfig(harness.context.baselineConfig);
    shrinkOn.flagHunt.arenaShrinking = true;
    harness.replaceConfig(shrinkOn);

    clock.now += harness.context.config.getArenaShrinkConfig().startAfterMs + 5000;
    harness.matchManager.update(clock.now);
    harness.stepArenaShrink(5, clock.now);
    assert.equal(harness.state.shrinking, true);
    assert.ok(harness.state.shrinkLeft > 0);

    const shrinkOff = cloneConfig(harness.context.baselineConfig);
    shrinkOff.flagHunt.arenaShrinking = false;
    harness.replaceConfig(shrinkOff);
    clock.now += 1000;
    harness.stepArenaShrink(1, clock.now);

    assert.equal(harness.state.shrinking, false);
    assert.equal(harness.state.shrinkLeft, 0);
    assert.equal(harness.state.shrinkRight, harness.arena.width);
  });

  it("deathmatch still gets its walls after a real match start", () => {
    const harness = createHarness();
    clock.now = 0;
    harness.state.matchState = MatchState.WAITING;
    for (const id of ["a", "b"]) {
      const player = harness.addPlayer(id, PARKING.x, PARKING.y);
      player.connected = true;
    }
    harness.state.hostId = "a";
    harness.matchManager.requestStart();
    harness.matchManager.update(clock.now);
    clock.now += 4000;
    harness.matchManager.update(clock.now);

    assert.equal(harness.state.matchState, MatchState.PLAYING);
    assert.ok(harness.state.shrinkCountdownSeconds > 0, "deathmatch keeps the countdown");
  });

  it("an untimed Flag Hunt publishes no clock and never ends at full time", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b"]);

    const retuned = cloneConfig(harness.context.baselineConfig);
    retuned.flagHunt.timedMatch = false;
    harness.replaceConfig(retuned);

    clock.now += 1000;
    harness.matchManager.update(clock.now);
    assert.equal(harness.state.matchTimeRemainingSeconds, 0, "no clock to show");

    clock.now += harness.context.config.getFlagHuntConfig().matchDurationMs + 60_000;
    harness.matchManager.update(clock.now);
    assert.equal(harness.state.matchState, MatchState.PLAYING, "full time never arrives");
  });
});

describe("flag hunt: mode boundaries", () => {
  it("a deathmatch room carries no flags and no clock", () => {
    const harness = createHarness();
    clock.now = 0;
    harness.state.matchState = MatchState.WAITING;
    // The default mode: exactly what every existing test plays under.
    for (const id of ["a", "b"]) {
      const player = harness.addPlayer(id, PARKING.x, PARKING.y);
      player.connected = true;
    }
    harness.state.hostId = "a";
    harness.matchManager.requestStart();
    harness.matchManager.update(clock.now);
    clock.now += 4000;
    harness.matchManager.update(clock.now);

    assert.equal(harness.state.matchState, MatchState.PLAYING);
    assert.equal(harness.state.flags.size, 0);
    assert.equal(harness.state.matchTimeRemainingSeconds, 0);

    // And the deathmatch rule still stands: the last kill ends the match.
    harness.matchManager.eliminate(harness.state.players.get("a")!, harness.state.players.get("b")!, "smg");
    harness.matchManager.update(clock.now + 50);
    assert.equal(harness.state.matchState, MatchState.FINISHED);
    assert.equal(harness.state.winnerId, "b");
  });

  it("flag counts are wiped when the room returns to the lobby", () => {
    const harness = createHarness();
    startFlagHunt(harness, ["a", "b"]);
    harness.state.players.get("a")!.flagCount = 6;

    clock.now += harness.context.config.getFlagHuntConfig().matchDurationMs + 1;
    harness.matchManager.update(clock.now);
    assert.equal(harness.state.matchState, MatchState.FINISHED);

    // Ride the results screen out; the room resets to WAITING on its own.
    for (let i = 0; i < 40; i++) {
      clock.now += 1000;
      harness.matchManager.update(clock.now);
    }
    assert.equal(harness.state.matchState, MatchState.WAITING);
    assert.equal(harness.state.players.get("a")!.flagCount, 0);
    assert.equal(harness.state.flags.size, 0);
    assert.equal(harness.state.suddenDeath, false);
  });
});
