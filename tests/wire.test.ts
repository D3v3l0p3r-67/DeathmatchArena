/**
 * What survives the wire.
 *
 * Every number an administrator can set eventually lands in a synchronised
 * field, and those fields have widths. When the two disagree the game does not
 * complain -- it truncates and carries on: raising maximum health to 1000 gave
 * every player 232 health, a red sliver of a bar, and no clue why.
 *
 * These encode real state through the real encoder and decode it into a fresh
 * copy, which is the only way to see a width. Assigning to a schema field keeps
 * whatever you gave it; the loss happens on the way out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Decoder, Encoder } from "@colyseus/schema";
import { DEFAULT_GAME_CONFIG, buildConfigFields } from "@deathmatch/shared";

const { GameState } = await import("../server/src/rooms/schema/GameState.js");
const { PlayerState } = await import("../server/src/rooms/schema/PlayerState.js");

/** Put a player in a room, send the room, and read the player back. */
function roundTrip(mutate: (player: InstanceType<typeof PlayerState>) => void) {
  const state = new GameState();
  const player = new PlayerState();
  player.sessionId = "a";
  mutate(player);
  state.players.set("a", player);

  const mirror = new GameState();
  new Decoder(mirror).decode(new Encoder(state).encodeAll());

  const received = mirror.players.get("a");
  assert.ok(received, "the player did not survive the round trip at all");
  return received;
}

const FIELDS = buildConfigFields(DEFAULT_GAME_CONFIG);

/** The largest value an administrator can set for a configuration key. */
function adminMaximum(key: string): number {
  const field = FIELDS.find((candidate) => candidate.key === key);
  assert.ok(field, `no configuration field named ${key}`);
  assert.equal(typeof field.max, "number", `${key} has no declared maximum`);
  return field.max as number;
}

describe("configured numbers survive synchronisation", () => {
  it("carries the largest health an administrator may set", () => {
    // The bug this pins, exactly: uint8 health against a setting that goes to
    // 1000. Sent 1000, received 232.
    const most = adminMaximum("player.maxHealth");
    const received = roundTrip((player) => {
      player.health = most;
    });

    assert.equal(received.health, most, `health is too narrow for a maximum of ${most}`);
  });

  it("carries the largest magazine an administrator may set", () => {
    const most = adminMaximum("weapons.assault-rifle.magazineSize");
    const received = roundTrip((player) => {
      player.ammo = most;
    });

    assert.equal(received.ammo, most, `ammo is too narrow for a magazine of ${most}`);
  });

  it("carries the most grenades an administrator may set", () => {
    const most = adminMaximum("grenades.maxCount");
    const received = roundTrip((player) => {
      player.grenades = most;
    });

    assert.equal(received.grenades, most, `the grenade count is too narrow for ${most}`);
  });

  it("carries the most jumps an administrator may set", () => {
    const most = adminMaximum("player.maxJumps");
    const received = roundTrip((player) => {
      player.jumpsRemaining = most;
    });

    assert.equal(received.jumpsRemaining, most, `the jump count is too narrow for ${most}`);
  });
});
