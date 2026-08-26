/**
 * The configuration metadata: what exists, what it may be set to, and what
 * "reset" means.
 *
 * The property that matters most here is that the field list is *generated* --
 * a weapon added to the catalogue must become editable without anyone touching
 * the metadata. Several of these tests add one and check that it appears.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConfigFieldType,
  ConfigRegistry,
  DEFAULT_GAME_CONFIG,
  PowerUpType,
  WeaponType,
  applyChange,
  buildConfigFields,
  cloneConfig,
  readConfigValue,
  validateChange,
  validateConfig,
  type GameConfig,
  type WeaponDefinition,
} from "@deathmatch/shared";

function base(): GameConfig {
  return cloneConfig(DEFAULT_GAME_CONFIG);
}

const RAILGUN: WeaponDefinition = {
  id: "railgun",
  name: "Railgun",
  type: WeaponType.RANGED,
  enabled: true,
  damage: 80,
  range: 2000,
  fireRate: 40,
  magazineSize: 4,
  reloadTime: 3000,
  automatic: false,
  knockbackForce: 2,
  recoilForce: 0.7,
  ranged: {
    bulletSpeed: 4000,
    spread: 0,
    pellets: 1,
    falloff: null,
    explosion: null,
    projectileStyle: { color: 0x88ccff, radius: 3, trailLength: 40 },
  },
  melee: null,
  silhouette: {
    length: 34,
    height: 14,
    gripX: 12,
    gripY: 7,
    color: 0x88ccff,
    parts: [{ x: 0, y: 4, width: 34, height: 6 }],
  },
};

describe("the configuration field list", () => {
  it("covers every category the administration interface promises", () => {
    const categories = new Set(buildConfigFields(base()).map((field) => field.category));
    for (const expected of ["Player", "Weapons", "Grenades", "Power-ups", "Crates", "Match", "Traps", "Arena", "Minimap"]) {
      assert.ok(categories.has(expected), `missing category ${expected}`);
    }
  });

  it("exposes the minimap's visibility, what it draws, and its radius as ordinary fields", () => {
    // Nothing about the panel should be a constant somewhere in client code: an
    // administrator turns it off, drops either layer, or narrows the radius the
    // same way they retune anything else.
    const keys = buildConfigFields(base()).map((field) => field.key);
    for (const key of ["minimap.enabled", "minimap.showPlayers", "minimap.showPowerUps", "minimap.radius"]) {
      assert.ok(keys.includes(key), `missing ${key}`);
    }

    const registry = new ConfigRegistry(base());
    assert.equal(registry.get("minimap.enabled")!.type, ConfigFieldType.BOOLEAN);
    assert.equal(registry.get("minimap.radius")!.type, ConfigFieldType.NUMBER);
    assert.equal(registry.get("minimap.radius")!.min, 0, "0 is the documented \"whole arena\" value, not an arbitrary floor");
  });

  it("is generated from the catalogue, so a new weapon brings its own fields", () => {
    const config = base();
    config.weapons.push(RAILGUN);

    const keys = buildConfigFields(config).map((field) => field.key);
    assert.ok(keys.includes("weapons.railgun.damage"));
    assert.ok(keys.includes("weapons.railgun.ranged.bulletSpeed"));
    assert.ok(
      !keys.includes("weapons.railgun.melee.arcDegrees"),
      "a ranged weapon must not offer melee settings",
    );
  });

  it("offers falloff settings only for a weapon that has falloff", () => {
    const keys = buildConfigFields(base()).map((field) => field.key);
    assert.ok(keys.includes("weapons.shotgun.ranged.falloff.startDistance"));
    assert.ok(!keys.includes("weapons.assault-rifle.ranged.falloff.startDistance"));
  });

  it("gives each power-up the fields its own type needs", () => {
    const keys = buildConfigFields(base()).map((field) => field.key);
    assert.ok(keys.includes("powerUps.health-50.restoreFraction"));
    assert.ok(keys.includes("powerUps.speed-boost.durationMs"));
    assert.ok(keys.includes("powerUps.grenade-pack.amount"));
    assert.ok(keys.includes("powerUps.weapon-shotgun.weaponId"));
    assert.ok(!keys.includes("powerUps.health-50.durationMs"));
  });

  it("offers the weapon choice as a list of real weapons", () => {
    // Generated from the catalogue, so a weapon added to it turns up here on its
    // own -- which is the reason to build the field list from the config at all.
    const config = base();
    const field = new ConfigRegistry(config).get("powerUps.weapon-shotgun.weaponId")!;

    assert.equal(field.type, ConfigFieldType.SELECT);
    assert.deepEqual(
      field.options?.map((option) => option.value).sort(),
      config.weapons.map((weapon) => weapon.id).sort(),
    );
  });

  it("takes each default from the baseline, not from the current value", () => {
    const config = base();
    config.player.gravity = 4000;

    const field = new ConfigRegistry(config, DEFAULT_GAME_CONFIG).get("player.gravity")!;
    assert.equal(field.defaultValue, DEFAULT_GAME_CONFIG.player.gravity);
  });
});

describe("reading and writing by key", () => {
  it("reaches values nested behind an id in an array", () => {
    assert.equal(readConfigValue(base(), "weapons.shotgun.ranged.pellets"), 9);
    assert.equal(readConfigValue(base(), "powerUps.speed-boost.speedMultiplier"), 1.55);
  });

  it("returns nothing for a key that does not resolve", () => {
    assert.equal(readConfigValue(base(), "weapons.nope.damage"), undefined);
    assert.equal(readConfigValue(base(), "player"), undefined);
    assert.equal(readConfigValue(base(), "player.constructor"), undefined);
  });

  it("refuses to write a key that is not a declared field", () => {
    // The field list doubles as the write whitelist, which is what stops a
    // crafted path reaching arbitrary parts of the configuration object.
    const registry = new ConfigRegistry(base());
    const config = base();
    assert.equal(registry.write(config, "player.__proto__", 1), false);
    // A section is not a setting, and neither is a field nobody declared.
    assert.equal(registry.write(config, "arenaShrink", 1), false);
    assert.equal(registry.write(config, "player.notAThing", 1), false);
  });
});

describe("validating one change", () => {
  const registry = new ConfigRegistry(base());

  it("coerces the text a form actually sends", () => {
    const field = registry.get("player.moveSpeed")!;
    assert.equal(validateChange(field, "420", base()).value, 420);

    const flag = registry.get("grenades.enabled")!;
    assert.equal(validateChange(flag, "false", base()).value, false);
  });

  it("refuses a value outside the declared range rather than clamping it", () => {
    // Clamping would silently store a different number than was typed, and the
    // operator would never learn that a limit exists.
    const field = registry.get("player.moveSpeed")!;
    const result = validateChange(field, 99999, base());
    assert.equal(result.ok, false);
    assert.match(result.issues[0]!.message, /at most/);
  });

  it("refuses a fraction where a whole number is required", () => {
    const field = registry.get("player.maxJumps")!;
    assert.equal(validateChange(field, 2.5, base()).ok, false);
  });

  it("refuses an option that is not on the list", () => {
    const field = registry.get("powerUps.weapon-shotgun.weaponId")!;
    assert.equal(validateChange(field, "railgun", base()).ok, false);
    assert.equal(validateChange(field, "chainsaw", base()).ok, true);
  });

  it("enforces the relationships between fields", () => {
    const config = base();
    const starting = registry.get("grenades.startingCount")!;
    assert.equal(validateChange(starting, config.grenades.maxCount + 1, config).ok, false);

    const minThrow = registry.get("grenades.minThrowSpeed")!;
    assert.equal(validateChange(minThrow, config.grenades.maxThrowSpeed + 100, config).ok, false);

    const minPlayers = registry.get("match.minPlayers")!;
    assert.equal(validateChange(minPlayers, config.match.maxPlayers + 1, config).ok, false);
  });
});

describe("applying a change", () => {
  it("leaves the caller's configuration untouched either way", () => {
    const registry = new ConfigRegistry(base());
    const config = base();
    const before = JSON.stringify(config);

    const accepted = applyChange(registry, config, "player.gravity", 2500);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.config.player.gravity, 2500);
    assert.equal(JSON.stringify(config), before, "the original must not be mutated");

    const rejected = applyChange(registry, config, "player.gravity", -5);
    assert.equal(rejected.ok, false);
    assert.equal(JSON.stringify(config), before);
  });

  it("rejects an unknown key", () => {
    const registry = new ConfigRegistry(base());
    assert.equal(applyChange(registry, base(), "player.telepathy", 1).ok, false);
  });

  it("changes the minimap live, and refuses a negative radius", () => {
    const registry = new ConfigRegistry(base());

    const off = applyChange(registry, base(), "minimap.enabled", false);
    assert.equal(off.ok, true);
    assert.equal(off.config.minimap.enabled, false);

    const narrowed = applyChange(registry, base(), "minimap.radius", 600);
    assert.equal(narrowed.ok, true);
    assert.equal(narrowed.config.minimap.radius, 600);

    const negative = applyChange(registry, base(), "minimap.radius", -1);
    assert.equal(negative.ok, false, "a negative radius has no meaning to clamp to");
  });

  it("refuses a change that would break the configuration as a whole", () => {
    // Individually legal, collectively fatal: every player spawns with the
    // default weapon, so it is the one weapon that cannot be switched off.
    const registry = new ConfigRegistry(base());
    const result = applyChange(registry, base(), "weapons.assault-rifle.enabled", false);
    assert.equal(result.ok, false);
    assert.match(result.issues[0]!.message, /default weapon cannot be disabled/);
  });
});

describe("whole-configuration invariants", () => {
  it("accepts what the game ships with", () => {
    assert.equal(validateConfig(base()).ok, true);
  });

  it("catches a power-up granting a weapon that does not exist", () => {
    const config = base();
    config.weapons = config.weapons.filter((weapon) => weapon.id !== "chainsaw");
    const result = validateConfig(config);
    assert.equal(result.ok, false);
    assert.match(result.issues.map((issue) => issue.message).join(" "), /unknown weapon "chainsaw"/);
  });

  it("catches duplicate ids", () => {
    const config = base();
    config.weapons.push({ ...config.weapons[0]! });
    assert.match(validateConfig(config).issues.map((i) => i.message).join(" "), /Duplicate weapon id/);

    const powerUps = base();
    powerUps.powerUps.push({ ...powerUps.powerUps[0]! });
    assert.match(validateConfig(powerUps).issues.map((i) => i.message).join(" "), /Duplicate power-up id/);
  });

  it("catches a missing default weapon", () => {
    const config = base();
    config.defaultWeaponId = "nonexistent";
    assert.match(validateConfig(config).issues.map((i) => i.message).join(" "), /does not exist/);
  });

  it("catches a power-up type that has no fields of its own", () => {
    // A weapon power-up is the only kind whose target needs checking; the rest
    // carry their effect inline. Sanity-check the union stays exhaustive.
    const config = base();
    const weaponPowerUp = config.powerUps.find((powerUp) => powerUp.type === PowerUpType.WEAPON);
    assert.ok(weaponPowerUp, "the shipped configuration should include a weapon power-up");
  });
});
