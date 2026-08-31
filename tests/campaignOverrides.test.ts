/**
 * The campaign level overlay: what the admin edits, what the game applies.
 *
 * Three layers under test. The sanitizer, which is the trust boundary -- the
 * store and the game cache only ever hold what came through it. The merge,
 * which must leave shipped values alone wherever a field was not overridden.
 * And the service, which persists exactly the sanitized overlay and reloads it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OUTPOST_LEVEL,
  applyCampaignLevelOverride,
  sanitizeCampaignOverrides,
} from "@deathmatch/shared";

const { CampaignLevelsService, InMemoryCampaignLevelsRepository } = await import(
  "../server/src/admin/CampaignLevelsService.js"
);
const { createLogger } = await import("../server/src/utils/logger.js");

const logger = createLogger("test");

describe("campaign overrides: the sanitizer", () => {
  it("keeps known knobs, drops everything else", () => {
    const clean = sanitizeCampaignOverrides({
      "level-01": {
        enemyTuning: { moveSpeed: 0.7, nonsense: 4 },
        lives: 3,
        startingGrenades: 5,
        parTimeMs: 240_000,
        geometry: "nice try",
      },
      junk: "not an object",
    });
    assert.deepEqual(clean, {
      "level-01": {
        enemyTuning: { moveSpeed: 0.7 },
        lives: 3,
        startingGrenades: 5,
        parTimeMs: 240_000,
      },
    });
  });

  it("clamps every number into its limits and refuses NaN", () => {
    const clean = sanitizeCampaignOverrides({
      "level-01": {
        enemyTuning: { moveSpeed: 0, fireRate: 99, projectileSpeed: Number.NaN },
        lives: 0,
        startingGrenades: 999,
        parTimeMs: 1,
      },
    });
    const override = clean["level-01"]!;
    assert.equal(override.enemyTuning?.moveSpeed, 0.05, "zero speed becomes the floor, not a frozen level");
    assert.equal(override.enemyTuning?.fireRate, 5);
    assert.equal(override.enemyTuning?.projectileSpeed, undefined, "NaN is dropped");
    assert.equal(override.lives, 1, "a level always grants at least one attempt");
    assert.equal(override.startingGrenades, 20);
    assert.equal(override.parTimeMs, 30_000);
  });

  it("an empty override never earns a key", () => {
    assert.deepEqual(sanitizeCampaignOverrides({ "level-01": { enemyTuning: {} } }), {});
    assert.deepEqual(sanitizeCampaignOverrides(null), {});
    assert.deepEqual(sanitizeCampaignOverrides("garbage"), {});
  });
});

describe("campaign overrides: the merge", () => {
  it("no override returns the shipped level untouched, by identity", () => {
    assert.equal(applyCampaignLevelOverride(OUTPOST_LEVEL, undefined), OUTPOST_LEVEL);
  });

  it("overridden fields replace, absent fields keep the shipped value", () => {
    const merged = applyCampaignLevelOverride(OUTPOST_LEVEL, {
      enemyTuning: { projectileSpeed: 0.5 },
      lives: 4,
    });

    assert.equal(merged.enemyTuning?.projectileSpeed, 0.5, "the overridden field");
    assert.equal(merged.enemyTuning?.moveSpeed, OUTPOST_LEVEL.enemyTuning?.moveSpeed, "the shipped field");
    assert.deepEqual(merged.respawnRule, { kind: "lives", lives: 4 });
    assert.equal(merged.startingGrenades, OUTPOST_LEVEL.startingGrenades);
    assert.equal(merged.parTimeMs, OUTPOST_LEVEL.parTimeMs);

    // The shipped module data was never mutated.
    assert.notEqual(merged, OUTPOST_LEVEL);
    assert.equal(OUTPOST_LEVEL.respawnRule.kind, "lives");
    assert.notEqual(OUTPOST_LEVEL.enemyTuning?.projectileSpeed, 0.5);
  });
});

describe("campaign overrides: the service", () => {
  it("stores the sanitized overlay and serves clones of it", async () => {
    const repository = new InMemoryCampaignLevelsRepository();
    const service = new CampaignLevelsService(repository, logger);
    await service.initialise();

    await service.replace({ "level-01": { lives: 0, enemyTuning: { moveSpeed: 0.6 } } });
    const served = service.current();
    assert.equal(served["level-01"]!.lives, 1, "sanitized on the way in");
    assert.equal(served["level-01"]!.enemyTuning?.moveSpeed, 0.6);

    served["level-01"]!.lives = 9;
    assert.equal(service.current()["level-01"]!.lives, 1, "a caller edits a clone, not the store");
  });

  it("a fresh service reloads what the last one stored, sanitized again", async () => {
    const repository = new InMemoryCampaignLevelsRepository();
    const first = new CampaignLevelsService(repository, logger);
    await first.initialise();
    await first.replace({ "level-02": { startingGrenades: 6 } });

    const second = new CampaignLevelsService(repository, logger);
    await second.initialise();
    assert.deepEqual(second.current(), { "level-02": { startingGrenades: 6 } });
  });
});
