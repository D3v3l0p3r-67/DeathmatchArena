/**
 * Arena data: validation, normalisation and the factory helpers.
 *
 * These are what stand between the administration interface and a match that
 * cannot start, so they are checked from the outside: an arena goes in, a list
 * of problems comes out, and the severity of each problem is part of the
 * contract -- warnings must not block a save and errors must.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ARENA_LIMITS,
  SurfaceType,
  TrapActivation,
  createEmptyArena,
  duplicateArena,
  getArena,
  nextObjectId,
  normaliseArena,
  slugify,
  trapRegistry,
  uniqueId,
  validateArena,
  type ArenaDefinition,
} from "@deathmatch/shared";

function errors(arena: ArenaDefinition, takenIds: string[] = []): string[] {
  return validateArena(arena, { takenIds })
    .issues.filter((issue) => issue.severity === "error")
    .map((issue) => `${issue.path}: ${issue.message}`);
}

describe("the shipped arena", () => {
  it("is valid on its own terms", () => {
    const result = validateArena(getArena("foundry"));
    assert.equal(result.ok, true, `errors: ${JSON.stringify(result.issues)}`);
  });

  it("has no warnings either, so a fresh install starts clean", () => {
    // Warnings do not block a save, but shipping an arena that generates them
    // would teach whoever opens the editor to ignore the list.
    const result = validateArena(getArena("foundry"));
    assert.deepEqual(result.issues, []);
  });

  it("places every trap on a type the simulation knows how to run", () => {
    for (const trap of getArena("foundry").traps) {
      assert.ok(trapRegistry.has(trap.type), `unknown trap type "${trap.type}"`);
    }
  });
});

describe("arena validation", () => {
  it("accepts a freshly created arena", () => {
    const arena = createEmptyArena("test-arena", "Test Arena");
    assert.deepEqual(errors(arena), []);
  });

  it("rejects an id that is already taken", () => {
    const arena = createEmptyArena("taken", "Taken");
    assert.match(errors(arena, ["taken"]).join(" "), /already uses the id/);
  });

  it("rejects dimensions outside the supported range", () => {
    const small = { ...createEmptyArena("tiny", "Tiny"), width: ARENA_LIMITS.MIN_WIDTH - 1 };
    assert.match(errors(small).join(" "), /Width must be between/);

    const huge = { ...createEmptyArena("huge", "Huge"), height: ARENA_LIMITS.MAX_HEIGHT + 1 };
    assert.match(errors(huge).join(" "), /Height must be between/);
  });

  it("rejects geometry that leaves the arena", () => {
    const arena = createEmptyArena("edge", "Edge");
    arena.elements.push({ id: "stray", type: SurfaceType.PLATFORM, x: arena.width - 10, y: 100, width: 200, height: 20 });
    assert.match(errors(arena).join(" "), /Extends outside the arena/);
  });

  it("rejects two objects sharing an id, whatever kind they are", () => {
    const arena = createEmptyArena("clash", "Clash");
    // Geometry, spawns and traps share one id namespace, because the editor
    // addresses everything it can select by id.
    arena.playerSpawns.push({ id: arena.elements[0]!.id, x: 200, y: 200, enabled: true });
    assert.match(errors(arena).join(" "), /Duplicate object id/);
  });

  it("insists on somewhere for players to stand", () => {
    const arena = createEmptyArena("empty", "Empty");
    arena.playerSpawns = [];
    assert.match(errors(arena).join(" "), /at least one enabled player spawn/);

    // Disabled points do not count: the match would have nowhere to put anyone.
    const disabled = createEmptyArena("off", "Off");
    disabled.playerSpawns = disabled.playerSpawns.map((spawn) => ({ ...spawn, enabled: false }));
    assert.match(errors(disabled).join(" "), /at least one enabled player spawn/);
  });

  it("warns about a buried spawn rather than refusing it", () => {
    const arena = createEmptyArena("buried", "Buried");
    // Straight into the floor. The server nudges it clear at match start, so
    // this is advice, not a refusal.
    const floor = arena.elements[0]!;
    arena.playerSpawns[0] = { id: "spawn-1", x: floor.x + 100, y: floor.y + 10, enabled: true };

    const result = validateArena(arena);
    assert.equal(result.ok, true, "a buried spawn must not block a save");
    assert.ok(
      result.issues.some((issue) => issue.severity === "warning" && /inside solid geometry/.test(issue.message)),
    );
  });

  it("measures a crate spawn against a crate, not a player", () => {
    // A crate spawn resting exactly on a surface is correct placement. Checking
    // it with a player's taller hitbox would flag every properly-placed one.
    const arena = createEmptyArena("crates", "Crates");
    const floor = arena.elements[0]!;
    arena.powerUpSpawns = [{ id: "crate-1", x: 600, y: floor.y - 22, enabled: true }];

    const result = validateArena(arena);
    assert.equal(
      result.issues.filter((issue) => issue.path.startsWith("powerUpSpawns")).length,
      0,
      "a crate resting on the floor is not buried",
    );
  });

  it("rejects an unknown trap type and out-of-range trap values", () => {
    const arena = createEmptyArena("traps", "Traps");
    const trap = trapRegistry.createTrap("spikes", "trap-1", 300, 300)!;
    arena.traps.push({ ...trap, type: "laser-of-doom" });
    assert.match(errors(arena).join(" "), /not a known trap type/);

    const ranged = createEmptyArena("ranged", "Ranged");
    ranged.traps.push({ ...trapRegistry.createTrap("fire", "trap-1", 300, 300)!, damage: 99999 });
    assert.match(errors(ranged).join(" "), /Damage must be between/);
  });

  it("treats a null trap override as inheritance, not as a missing value", () => {
    const arena = createEmptyArena("inherit", "Inherit");
    const trap = trapRegistry.createTrap("saw", "trap-1", 300, 300)!;
    arena.traps.push({ ...trap, damage: null, cooldownMs: null, moveSpeed: null });
    assert.deepEqual(errors(arena), []);
  });

  it("warns when a proximity trap has no reach", () => {
    const arena = createEmptyArena("reach", "Reach");
    arena.traps.push({
      ...trapRegistry.createTrap("crusher", "trap-1", 300, 300)!,
      activation: TrapActivation.PROXIMITY,
      triggerRadius: 0,
    });

    const result = validateArena(arena);
    assert.equal(result.ok, true);
    assert.match(result.issues.map((issue) => issue.message).join(" "), /never activate/);
  });
});

describe("arena normalisation", () => {
  it("turns arbitrary JSON into a well-formed arena", () => {
    const arena = normaliseArena({
      id: "Weird Name!",
      name: "  Spaced  ",
      width: "2400",
      height: null,
      elements: [{ type: "not-a-type", x: "10" }],
      playerSpawns: "not an array",
      traps: [{ type: "spikes", x: 5, y: 5 }],
    });

    assert.equal(arena.id, "weird-name");
    assert.equal(arena.name, "Spaced");
    assert.equal(arena.width, 2400);
    assert.equal(arena.height, 1800, "a missing dimension falls back rather than becoming NaN");
    assert.equal(arena.elements[0]!.type, SurfaceType.PLATFORM, "an unknown type becomes a platform");
    assert.deepEqual(arena.playerSpawns, []);
    assert.equal(arena.traps.length, 1);
  });

  it("drops a trap whose type does not exist", () => {
    // There is nothing to repair it against, and keeping it would store something
    // the simulation cannot run.
    const arena = normaliseArena({ traps: [{ id: "t", type: "laser-of-doom", x: 1, y: 1 }] });
    assert.deepEqual(arena.traps, []);
  });

  it("keeps null trap overrides as null", () => {
    const arena = normaliseArena({
      traps: [{ id: "t", type: "fire", x: 1, y: 1, damage: null, cooldownMs: 500 }],
    });
    assert.equal(arena.traps[0]!.damage, null);
    assert.equal(arena.traps[0]!.cooldownMs, 500);
  });

  it("fills in a missing type parameter from the type's own default", () => {
    const arena = normaliseArena({ traps: [{ id: "t", type: "saw", x: 1, y: 1, params: {} }] });
    assert.equal(arena.traps[0]!.params.direction, "right");
    assert.equal(arena.traps[0]!.params.travel, 320);
  });
});

describe("arena identifiers", () => {
  it("makes readable slugs", () => {
    assert.equal(slugify("The Foundry"), "the-foundry");
    assert.equal(slugify("!!!"), "arena", "something unusable still yields a usable id");
  });

  it("avoids collisions by counting, not by randomness", () => {
    assert.equal(uniqueId("the-foundry", ["the-foundry"]), "the-foundry-2");
    assert.equal(uniqueId("the-foundry", ["the-foundry", "the-foundry-2"]), "the-foundry-3");
  });

  it("numbers object ids within their own kind", () => {
    // The sixth trap is trap-6, even in an arena holding fifty platforms.
    const existing = [{ id: "element-1" }, { id: "element-2" }, { id: "trap-1" }];
    assert.equal(nextObjectId("trap", existing), "trap-2");
    assert.equal(nextObjectId("element", existing), "element-3");
  });

  it("still avoids an id another kind already holds", () => {
    assert.equal(nextObjectId("trap", [{ id: "trap-1" }, { id: "trap-2" }]), "trap-3");
  });
});

describe("duplicating an arena", () => {
  it("copies everything under a new identity, sharing nothing", () => {
    const source = getArena("foundry");
    const copy = duplicateArena(source, "foundry-2", "The Foundry copy");

    assert.equal(copy.id, "foundry-2");
    assert.equal(copy.elements.length, source.elements.length);
    assert.equal(copy.traps.length, source.traps.length);

    copy.elements[0]!.x = 999;
    assert.notEqual(source.elements[0]!.x, 999, "a copy must not share objects with its source");
  });
});
