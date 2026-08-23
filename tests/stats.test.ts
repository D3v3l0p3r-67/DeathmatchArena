/**
 * A player's record across matches.
 *
 * The property worth defending here is what this feature deliberately is *not*.
 * Players are identified by an id their own browser generated, which is a claim
 * rather than an identity — so a career is a personal record, never a ranking,
 * and nobody is ever shown anybody else's.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLogger } from "../server/src/utils/logger.js";

const { PlayerStatsService, emptyCareer } = await import("../server/src/stats/PlayerStatsService.js");
const { InMemoryPlayerStatsRepository } = await import(
  "../server/src/stats/PlayerStatsRepository.js"
);

const logger = createLogger("test");

function service() {
  const repository = new InMemoryPlayerStatsRepository();
  return { repository, stats: new PlayerStatsService(repository, logger) };
}

describe("careers", () => {
  it("starts everybody at nothing rather than at absent", () => {
    // A first-time player is a career of zeroes, not a null the caller has to
    // think about.
    const { stats } = service();
    assert.deepEqual(stats.get("nobody"), emptyCareer());
  });

  it("adds one match at a time", () => {
    const { stats } = service();

    stats.record([{ playerId: "p1", kills: 3, deaths: 1, placement: 2 }]);
    stats.record([{ playerId: "p1", kills: 1, deaths: 1, placement: 4 }]);

    assert.deepEqual(stats.get("p1"), {
      matches: 2,
      wins: 0,
      kills: 4,
      deaths: 2,
      bestPlacement: 2,
    });
  });

  it("counts a win only for first place", () => {
    const { stats } = service();

    stats.record([{ playerId: "p1", kills: 5, deaths: 0, placement: 1 }]);
    stats.record([{ playerId: "p1", kills: 0, deaths: 1, placement: 2 }]);

    const career = stats.get("p1");
    assert.equal(career.wins, 1);
    assert.equal(career.matches, 2);
    assert.equal(career.bestPlacement, 1);
  });

  it("keeps the best placement, not the latest", () => {
    const { stats } = service();

    stats.record([{ playerId: "p1", kills: 0, deaths: 1, placement: 3 }]);
    stats.record([{ playerId: "p1", kills: 0, deaths: 1, placement: 7 }]);

    assert.equal(stats.get("p1").bestPlacement, 3);
  });

  it("keeps players apart", () => {
    const { stats } = service();

    stats.record([
      { playerId: "p1", kills: 4, deaths: 0, placement: 1 },
      { playerId: "p2", kills: 0, deaths: 1, placement: 2 },
    ]);

    assert.equal(stats.get("p1").wins, 1);
    assert.equal(stats.get("p2").wins, 0);
    assert.equal(stats.get("p2").deaths, 1);
  });

  it("ignores an update with no id to file it under", () => {
    // A bot, or a browser that could not store one. Neither has a record.
    const { stats } = service();
    const written = stats.record([{ playerId: "", kills: 9, deaths: 0, placement: 1 }]);

    assert.equal(written.size, 0);
    assert.deepEqual(stats.get(""), emptyCareer());
  });

  it("hands back what it just wrote, so the room need not read it again", () => {
    const { stats } = service();
    const written = stats.record([{ playerId: "p1", kills: 2, deaths: 0, placement: 1 }]);

    assert.deepEqual(written.get("p1"), stats.get("p1"));
  });

  it("survives a restart", async () => {
    const { repository, stats } = service();
    stats.record([{ playerId: "p1", kills: 6, deaths: 2, placement: 1 }]);

    // The write is deliberately not awaited by `record`; a match ending must
    // never wait on a disk.
    await Promise.resolve();

    const revived = new PlayerStatsService(repository, logger);
    await revived.load();
    assert.deepEqual(revived.get("p1"), stats.get("p1"));
  });

  it("hands out copies, so a caller cannot edit the record in place", () => {
    const { stats } = service();
    stats.record([{ playerId: "p1", kills: 1, deaths: 0, placement: 1 }]);

    const career = stats.get("p1");
    career.kills = 999;

    assert.equal(stats.get("p1").kills, 1);
  });
});
