/**
 * The administration services.
 *
 * Everything an administrator can do goes through these two classes, so this is
 * where the guarantees are checked: nothing reaches storage without being
 * validated, nothing that would leave the server unable to run a match is
 * accepted, and a reset means exactly "stop overriding this".
 *
 * Run against in-memory repositories, because what is being tested is the rules,
 * not the filesystem.
 */
process.env.VERBOSE_LOGGING = "false";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { DEFAULT_GAME_CONFIG, getArena, listArenas } from "@deathmatch/shared";

const { ArenaService } = await import("../server/src/admin/ArenaService.js");
const { InMemoryArenaRepository } = await import("../server/src/admin/ArenaRepository.js");
const { GameConfigService } = await import("../server/src/admin/GameConfigService.js");
const { InMemoryGameConfigRepository } = await import("../server/src/admin/GameConfigRepository.js");
const { createLogger } = await import("../server/src/utils/logger.js");

const logger = createLogger("test");

describe("arena management", () => {
  let repository: InstanceType<typeof InMemoryArenaRepository>;
  let service: InstanceType<typeof ArenaService>;

  beforeEach(async () => {
    repository = new InMemoryArenaRepository();
    service = new ArenaService(repository, logger);
    await service.initialise();
  });

  it("starts from the arenas the build ships with", async () => {
    const arenas = await service.list();
    assert.ok(arenas.some((arena) => arena.id === "foundry"));
  });

  it("creates an arena that is immediately playable", async () => {
    const result = await service.create("Iron Works");
    assert.equal(result.ok, true);
    assert.equal(result.arena?.id, "iron-works", "the id is derived from the name");

    // Not literally empty: an arena with no ground is something you have to fix
    // before you can even look at it.
    assert.ok((result.arena?.elements.length ?? 0) > 0);
    assert.ok((result.arena?.playerSpawns.length ?? 0) >= 2);
  });

  it("never lets two arenas share an id", async () => {
    await service.create("Iron Works");
    const second = await service.create("Iron Works");
    assert.equal(second.arena?.id, "iron-works-2");
  });

  it("duplicates an arena without sharing anything with the original", async () => {
    const copy = await service.duplicate("foundry");
    assert.equal(copy.ok, true);
    assert.equal(copy.arena?.id, "the-foundry-copy");

    const source = await service.get("foundry");
    assert.equal(copy.arena?.elements.length, source?.elements.length);
    assert.notEqual(copy.arena?.elements[0], source?.elements[0]);
  });

  it("refuses to store an arena that would not work", async () => {
    const arena = await service.get("foundry");
    const broken = { ...arena!, playerSpawns: [] };

    const result = await service.save("foundry", broken);
    assert.equal(result.ok, false);

    const stored = await service.get("foundry");
    assert.ok((stored?.playerSpawns.length ?? 0) > 0, "the stored arena must be untouched");
  });

  it("keeps warnings on a successful save", async () => {
    // Warnings are advice. Losing them on success would mean an operator only
    // ever sees them while something else is broken.
    const arena = await service.get("foundry");
    const result = await service.save("foundry", { ...arena!, powerUpSpawns: [] });
    assert.equal(result.ok, true);
    assert.ok(result.issues.some((issue) => issue.severity === "warning"));
  });

  it("ignores an id in the body and keeps the one being saved", async () => {
    // Renaming an id through a save would orphan every reference to it.
    const arena = await service.get("foundry");
    const result = await service.save("foundry", { ...arena!, id: "something-else" });
    assert.equal(result.arena?.id, "foundry");
    assert.equal(await service.get("something-else"), null);
  });

  it("repairs whatever arrives over the wire", async () => {
    const result = await service.save("foundry", {
      id: "foundry",
      name: "Repaired",
      width: 3200,
      height: 1800,
      elements: [{ id: "floor-1", type: "floor", x: 0, y: 1740, width: 3200, height: 60 }],
      playerSpawns: [
        { id: "spawn-1", x: 400, y: 1700, enabled: true },
        { id: "spawn-2", x: 2800, y: 1700, enabled: true },
      ],
      powerUpSpawns: [{ id: "crate-1", x: 1600, y: 1718, enabled: true }],
      traps: [{ id: "trap-1", type: "spikes", x: 800, y: 1716, width: 160, height: 24 }],
      extraNonsense: true,
    });

    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.arena?.name, "Repaired");
    assert.equal(result.arena?.traps[0]?.damage, null, "an unstated override stays inherited");
    assert.equal((result.arena as unknown as Record<string, unknown>).extraNonsense, undefined);
  });

  it("publishes a saved arena so the next match uses it", async () => {
    // Rooms read the process-wide catalogue at creation, so a save has to reach
    // it -- otherwise an edit would take a restart to appear.
    const arena = await service.get("foundry");
    await service.save("foundry", { ...arena!, name: "Renamed Foundry" });
    assert.equal(getArena("foundry").name, "Renamed Foundry");
  });

  it("disables an arena without deleting it", async () => {
    await service.create("Spare");
    const result = await service.setEnabled("foundry", false);
    assert.equal(result.ok, true);
    assert.equal((await service.get("foundry"))?.enabled, false);
    assert.equal(getArena("foundry").id, "spare", "a disabled arena is never chosen for a match");
  });

  it("refuses to delete the last arena a match could run on", async () => {
    const result = await service.delete("foundry");
    assert.equal(result.ok, false);
    assert.match(result.message, /only playable arena/);
    assert.notEqual(await service.get("foundry"), null);
  });

  it("deletes one that is not the last", async () => {
    await service.create("Spare");
    const result = await service.delete("foundry");
    assert.equal(result.ok, true);
    assert.equal(await service.get("foundry"), null);
    assert.ok(!listArenas().some((arena) => arena.id === "foundry"));
  });

  it("validates without storing", async () => {
    const arena = await service.get("foundry");
    const check = await service.check("foundry", { ...arena!, playerSpawns: [] });
    assert.equal(check.ok, false);
    assert.ok((await service.get("foundry"))!.playerSpawns.length > 0);
  });
});

describe("game configuration management", () => {
  let repository: InstanceType<typeof InMemoryGameConfigRepository>;
  let service: InstanceType<typeof GameConfigService>;

  beforeEach(async () => {
    repository = new InMemoryGameConfigRepository();
    service = new GameConfigService(repository, logger);
    await service.initialise();
  });

  it("starts on the shipped values", () => {
    assert.deepEqual(service.getConfig().player, DEFAULT_GAME_CONFIG.player);
    assert.ok(service.listFields().every((field) => !field.overridden));
  });

  it("stores a change and reports it as overridden", async () => {
    const result = await service.setMany({ "player.gravity": 2500 });
    assert.equal(result.ok, true);
    assert.equal(service.getConfig().player.gravity, 2500);

    const field = result.fields.find((candidate) => candidate.key === "player.gravity")!;
    assert.equal(field.value, 2500);
    assert.equal(field.overridden, true);
    assert.equal(field.defaultValue, DEFAULT_GAME_CONFIG.player.gravity);
  });

  it("stores deltas, not a snapshot", async () => {
    // A stored snapshot would freeze every other value at the moment somebody
    // first touched the interface, and future rebalances would stop arriving.
    await service.setMany({ "player.gravity": 2500 });
    assert.deepEqual(await repository.read(), { "player.gravity": 2500 });
  });

  it("applies a batch all or nothing", async () => {
    const result = await service.setMany({
      "player.gravity": 2500,
      "player.moveSpeed": 999999,
    });

    assert.equal(result.ok, false);
    assert.equal(service.getConfig().player.gravity, DEFAULT_GAME_CONFIG.player.gravity, "nothing applied");
  });

  it("stops tracking a value set back to its default", async () => {
    await service.setMany({ "player.gravity": 2500 });
    await service.setMany({ "player.gravity": DEFAULT_GAME_CONFIG.player.gravity });
    assert.deepEqual(await repository.read(), {});
  });

  it("resets one parameter", async () => {
    await service.setMany({ "player.gravity": 2500, "player.moveSpeed": 400 });
    await service.resetKey("player.gravity");

    assert.equal(service.getConfig().player.gravity, DEFAULT_GAME_CONFIG.player.gravity);
    assert.equal(service.getConfig().player.moveSpeed, 400, "the other override survives");
  });

  it("resets one subcategory without touching its siblings", async () => {
    await service.setMany({ "player.gravity": 2500, "player.maxHealth": 150 });
    const result = await service.resetGroup("Player", "Jumping");

    assert.equal(result.ok, true);
    assert.equal(service.getConfig().player.gravity, DEFAULT_GAME_CONFIG.player.gravity);
    assert.equal(service.getConfig().player.maxHealth, 150, "Vitality is a different section");
  });

  it("resets a whole category", async () => {
    await service.setMany({ "player.gravity": 2500, "player.maxHealth": 150, "crate.health": 90 });
    await service.resetGroup("Player");

    assert.equal(service.getConfig().player.gravity, DEFAULT_GAME_CONFIG.player.gravity);
    assert.equal(service.getConfig().player.maxHealth, DEFAULT_GAME_CONFIG.player.maxHealth);
    assert.equal(service.getConfig().crate.health, 90, "another category is untouched");
  });

  it("resets everything", async () => {
    await service.setMany({ "player.gravity": 2500, "crate.health": 90 });
    await service.resetAll();
    assert.deepEqual(await repository.read(), {});
    assert.deepEqual(service.getConfig().player, DEFAULT_GAME_CONFIG.player);
  });

  it("refuses an unknown key", async () => {
    const result = await service.setMany({ "player.telepathy": 1 });
    assert.equal(result.ok, false);
    assert.match(result.issues[0]!.message, /Unknown setting/);
  });

  it("refuses a change that breaks the configuration as a whole", async () => {
    const result = await service.setMany({ "weapons.assault-rifle.enabled": false });
    assert.equal(result.ok, false);
    assert.equal(service.getConfig().weapons.find((w) => w.id === "assault-rifle")?.enabled, true);
  });

  it("seeds defaults from the environment, and lets an admin override them", async () => {
    const seeded = new GameConfigService(new InMemoryGameConfigRepository(), logger, {
      "match.countdownMs": 1500,
    });
    await seeded.initialise();

    assert.equal(seeded.getConfig().match.countdownMs, 1500);
    assert.equal(
      seeded.listFields().find((field) => field.key === "match.countdownMs")?.defaultValue,
      1500,
      "a deployment seed becomes what reset restores",
    );

    await seeded.setMany({ "match.countdownMs": 9000 });
    assert.equal(seeded.getConfig().match.countdownMs, 9000);

    await seeded.resetKey("match.countdownMs");
    assert.equal(seeded.getConfig().match.countdownMs, 1500, "reset returns to the seed, not the shipped value");
  });

  it("survives a stored override that no longer applies", async () => {
    // A weapon can be removed between releases; a stale key in a stored file
    // must not stop the server from starting.
    await repository.write({ "weapons.railgun.damage": 80, "player.gravity": 2400 });
    const reloaded = new GameConfigService(repository, logger);
    await reloaded.initialise();

    assert.equal(reloaded.getConfig().player.gravity, 2400);
  });
});
