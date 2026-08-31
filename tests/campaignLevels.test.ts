/**
 * Stored campaign levels: what the editor writes, what the game plays.
 *
 * Three layers. The normalizer is the trust boundary -- the store and the game
 * cache only ever hold what came through it, and the strongest guarantee is
 * the round trip: every shipped level survives it byte-identical, so storing
 * an untouched level changes nothing. The service refuses documents that fail
 * the semantic validator, stores only edited levels, and "reset" is exactly
 * "delete". The listing tells the admin which levels are shadowed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CAMPAIGN_LEVELS,
  OUTPOST_LEVEL,
  normalizeCampaignLevel,
} from "@deathmatch/shared";

const { CampaignLevelsService, InMemoryCampaignLevelsRepository } = await import(
  "../server/src/admin/CampaignLevelsService.js"
);
const { createLogger } = await import("../server/src/utils/logger.js");

const logger = createLogger("test");

function shippedCopy(id = "level-01") {
  return JSON.parse(JSON.stringify(CAMPAIGN_LEVELS.find((level) => level.id === id)!));
}

describe("level documents: the normalizer", () => {
  it("round-trips every shipped level exactly, with no issues", () => {
    for (const level of CAMPAIGN_LEVELS) {
      const { level: normalized, issues } = normalizeCampaignLevel(JSON.parse(JSON.stringify(level)));
      assert.deepEqual(issues, [], `${level.id} should normalize cleanly`);
      assert.deepEqual(normalized, level, `${level.id} should survive the round trip unchanged`);
    }
  });

  it("names what it drops instead of silently swallowing it", () => {
    const raw = shippedCopy();
    raw.triggers[0].actions.push({ kind: "no-such-action" });
    raw.secrets.push({ id: "broken" }); // no zone
    const { level, issues } = normalizeCampaignLevel(raw);
    assert.ok(level, "the document still normalizes");
    assert.equal(issues.length, 2, `named both problems, got: ${issues.join(" | ")}`);
    assert.ok(issues.some((issue) => issue.includes("action")), "the bad action is named");
    assert.ok(issues.some((issue) => issue.includes("secrets")), "the bad secret is named");
  });

  it("refuses a document with no skeleton", () => {
    assert.equal(normalizeCampaignLevel("garbage").level, null);
    assert.equal(normalizeCampaignLevel({}).level, null);
    assert.equal(normalizeCampaignLevel({ id: "x" }).level, null);
  });

  it("clamps numbers instead of trusting them", () => {
    const raw = shippedCopy();
    raw.respawnRule = { kind: "lives", lives: 999 };
    raw.enemyTuning = { moveSpeed: 0 };
    const { level } = normalizeCampaignLevel(raw);
    assert.deepEqual(level!.respawnRule, { kind: "lives", lives: 9 });
    assert.equal(level!.enemyTuning?.moveSpeed, 0.05, "zero speed becomes the floor, not a frozen level");
  });
});

describe("level documents: the service", () => {
  async function makeService() {
    const repository = new InMemoryCampaignLevelsRepository();
    const service = new CampaignLevelsService(repository, logger);
    await service.initialise();
    return { repository, service };
  }

  it("serves shipped levels until one is edited, then the stored document", async () => {
    const { service } = await makeService();
    assert.deepEqual(service.get("level-01"), OUTPOST_LEVEL);
    assert.deepEqual(service.stored(), {}, "nothing stored yet");

    const edited = shippedCopy();
    edited.name = "Outpost, remixed";
    const result = await service.put("level-01", edited);
    assert.equal(result.ok, true, result.issues.join(" | "));

    assert.equal(service.get("level-01")!.name, "Outpost, remixed");
    assert.equal(service.list().find((entry) => entry.id === "level-01")!.edited, true);
    assert.equal(service.list().find((entry) => entry.id === "level-02")!.edited, false);
  });

  it("refuses a document the validator would not let the engine play", async () => {
    const { service } = await makeService();
    const broken = shippedCopy();
    broken.crates.push({ spawnPointId: "no-such-point" });
    const result = await service.put("level-01", broken);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.includes("no-such-point")), result.issues.join(" | "));
    assert.deepEqual(service.stored(), {}, "nothing was stored");
  });

  it("refuses a document whose id does not match the level being saved", async () => {
    const { service } = await makeService();
    const wrong = shippedCopy("level-02");
    const result = await service.put("level-01", wrong);
    assert.equal(result.ok, false);
  });

  it("reset deletes the stored document and the shipped level returns", async () => {
    const { service } = await makeService();
    const edited = shippedCopy();
    edited.parTimeMs = 60_000;
    await service.put("level-01", edited);
    assert.equal(service.get("level-01")!.parTimeMs, 60_000);

    await service.reset("level-01");
    assert.deepEqual(service.get("level-01"), OUTPOST_LEVEL);
    assert.deepEqual(service.stored(), {});
  });

  it("a fresh service reloads the store, re-validated", async () => {
    const { repository, service } = await makeService();
    const edited = shippedCopy();
    edited.startingGrenades = 7;
    await service.put("level-01", edited);

    const second = new CampaignLevelsService(repository, logger);
    await second.initialise();
    assert.equal(second.get("level-01")!.startingGrenades, 7);

    // Corrupt the repository behind its back; a reload drops the bad document.
    const raw = await repository.read();
    (raw["level-01"] as { crates: unknown[] }).crates.push({ spawnPointId: "ghost" });
    await repository.write(raw);
    const third = new CampaignLevelsService(repository, logger);
    await third.initialise();
    assert.deepEqual(third.get("level-01"), OUTPOST_LEVEL, "an invalid stored level yields to the shipped one");
  });
});
