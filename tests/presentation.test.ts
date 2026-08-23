/**
 * The sound and effect catalogues.
 *
 * Both are pure data consumed at runtime, which means a malformed entry fails
 * quietly -- a sound that never plays, or a burst that throws mid-frame. These
 * check the shapes instead, so a typo is caught here rather than in a match.
 *
 * Only the data modules are imported; neither touches the DOM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLAYER, PLAYER_HALF_WIDTH, listWeapons } from "@deathmatch/shared";

const { SOUNDS, SoundChannel, SoundId, getSound } = await import("../client/src/audio/sounds.js");
const { BURSTS, SHAKES, DEFAULT_EFFECTS_SETTINGS } = await import("../client/src/game/fx/effects.js");

describe("sound catalogue", () => {
  const channels = new Set<string>(Object.values(SoundChannel));

  it("defines every sound the game asks for", () => {
    for (const [name, id] of Object.entries(SoundId)) {
      assert.ok(getSound(id), `SoundId.${name} ("${id}") has no definition`);
    }
  });

  it("keys every entry by its own id", () => {
    for (const [key, sound] of Object.entries(SOUNDS)) {
      assert.equal(sound.id, key, `"${key}" is keyed differently from its id`);
    }
  });

  it("routes every sound to a real mixer channel", () => {
    for (const sound of Object.values(SOUNDS)) {
      assert.ok(channels.has(sound.channel), `${sound.id} uses unknown channel "${sound.channel}"`);
    }
  });

  it("gives every sound layers the synthesiser can actually render", () => {
    for (const sound of Object.values(SOUNDS)) {
      assert.ok(sound.layers.length > 0, `${sound.id} has no layers`);

      for (const layer of sound.layers) {
        assert.ok(layer.gain > 0, `${sound.id} has a silent layer`);
        assert.ok(layer.duration > 0, `${sound.id} has a zero-length layer`);
        assert.ok(layer.attack >= 0, `${sound.id} has a negative attack`);
        assert.ok((layer.delay ?? 0) >= 0, `${sound.id} has a negative delay`);

        if (layer.kind === "tone") {
          // Audible range: an oscillator swept to 0 Hz would throw.
          assert.ok(layer.frequency > 20, `${sound.id} has a sub-audible tone`);
          if (layer.sweepTo !== undefined) {
            assert.ok(layer.sweepTo > 0, `${sound.id} sweeps to an invalid frequency`);
          }
        } else {
          assert.ok(layer.cutoff > 0, `${sound.id} has an invalid filter cutoff`);
          if (layer.cutoffTo !== undefined) {
            assert.ok(layer.cutoffTo > 0, `${sound.id} sweeps its filter to an invalid cutoff`);
          }
        }
      }
    }
  });

  it("keeps volumes and jitter within sane bounds", () => {
    for (const sound of Object.values(SOUNDS)) {
      const volume = sound.volume ?? 1;
      assert.ok(volume > 0 && volume <= 1, `${sound.id} has an out-of-range volume`);
      const jitter = sound.pitchJitter ?? 0;
      assert.ok(jitter >= 0 && jitter < 1, `${sound.id} has implausible pitch jitter`);
    }
  });

  it("throttles the sounds that can fire in bursts", () => {
    // A shotgun lands nine pellets at once; without a throttle they stack into
    // one distorted clack rather than a hit.
    for (const id of [SoundId.BulletImpact, SoundId.FleshImpact, SoundId.CrateHit]) {
      const sound = getSound(id)!;
      assert.ok((sound.throttleMs ?? 0) > 0, `${id} should be throttled`);
    }
  });
});

describe("effect catalogue", () => {
  it("describes bursts that produce visible, finite particles", () => {
    for (const [name, spec] of Object.entries(BURSTS)) {
      assert.ok(spec.count > 0, `${name} spawns nothing`);
      assert.ok(spec.maxSpeed >= spec.minSpeed, `${name} has an inverted speed range`);
      assert.ok(spec.minLife > 0, `${name} has a zero-length particle`);
      assert.ok(spec.maxLife >= spec.minLife, `${name} has an inverted lifetime range`);
      assert.ok(spec.scale > 0, `${name} has invisible particles`);
      assert.ok(Number.isFinite(spec.gravity), `${name} has a non-finite gravity`);
    }
  });

  it("keeps camera shakes short and subtle", () => {
    for (const [name, spec] of Object.entries(SHAKES)) {
      assert.ok(spec.durationMs > 0, `${name} has no duration`);
      // Phaser's intensity is a fraction of the viewport; anything approaching
      // 0.1 is unplayable.
      assert.ok(spec.intensity > 0 && spec.intensity < 0.05, `${name} shakes far too hard`);
    }
  });

  it("ships defaults a player can turn all the way down", () => {
    assert.ok(DEFAULT_EFFECTS_SETTINGS.particleIntensity > 0);
    assert.ok(DEFAULT_EFFECTS_SETTINGS.screenShake > 0);
    // Both are fractions, so 0 is a legal setting and means "off".
    assert.ok(DEFAULT_EFFECTS_SETTINGS.particleIntensity <= 1);
    assert.ok(DEFAULT_EFFECTS_SETTINGS.screenShake <= 1);
  });
});

describe("weapon silhouettes", () => {
  it("gives every weapon a shape someone can recognise across the arena", () => {
    for (const weapon of listWeapons()) {
      const shape = weapon.silhouette;
      assert.ok(shape, `${weapon.id} has no silhouette`);
      assert.ok(shape.length > 0 && shape.height > 0, `${weapon.id} has no size`);
      assert.ok(shape.parts.length > 0, `${weapon.id} would draw as nothing`);
    }
  });

  it("keeps every part inside the texture it is drawn into", () => {
    // A part that overflows is silently clipped, which is the kind of thing you
    // only notice as a weapon that looks subtly wrong from across the map.
    for (const weapon of listWeapons()) {
      const shape = weapon.silhouette;
      for (const [index, part] of shape.parts.entries()) {
        const where = `${weapon.id} part ${index}`;
        assert.ok(part.width > 0 && part.height > 0, `${where} is empty`);
        assert.ok(part.x >= 0 && part.y >= 0, `${where} starts outside the texture`);
        assert.ok(part.x + part.width <= shape.length, `${where} overflows the length`);
        assert.ok(part.y + part.height <= shape.height, `${where} overflows the height`);
      }
    }
  });

  it("puts the grip inside the weapon", () => {
    for (const weapon of listWeapons()) {
      const shape = weapon.silhouette;
      assert.ok(shape.gripX >= 0 && shape.gripX <= shape.length, `${weapon.id} grips off the end`);
      assert.ok(shape.gripY >= 0 && shape.gripY <= shape.height, `${weapon.id} grips off the side`);
    }
  });

  it("puts a ranged weapon's muzzle where the flash is drawn", () => {
    // Three things have to agree about where the barrel ends: the drawn weapon,
    // the muzzle flash, and the point the server spawns projectiles from. The
    // weapon is held `WEAPON_FORWARD_X` in front of the shoulder, so its own
    // reach from grip to muzzle covers the rest of the distance.
    for (const weapon of listWeapons()) {
      if (!weapon.ranged) continue;

      const reach = weapon.silhouette.length - weapon.silhouette.gripX;
      const muzzle = PLAYER.WEAPON_FORWARD_X + reach;

      assert.ok(
        Math.abs(muzzle - PLAYER.MUZZLE_OFFSET_X) <= 4,
        `${weapon.id} reaches ${muzzle}px from the shoulder, but the flash is drawn at ${PLAYER.MUZZLE_OFFSET_X}px`,
      );
    }
  });

  it("never draws two weapons with the same silhouette", () => {
    // The whole point is that another player can read your loadout at a glance,
    // and the way that quietly breaks is a copy-pasted shape on a new weapon.
    const seen = new Map<string, string>();
    for (const weapon of listWeapons()) {
      const signature = JSON.stringify(weapon.silhouette);
      const twin = seen.get(signature);
      assert.equal(twin, undefined, `${weapon.id} is drawn identically to ${twin}`);
      seen.set(signature, weapon.id);
    }
  });
});

describe("reading a player at a glance", () => {
  it("reaches past the body it is held against", () => {
    // A weapon drawn entirely inside the figure is a weapon nobody can identify,
    // which defeats the whole point of giving each one a shape.
    for (const weapon of listWeapons()) {
      const shape = weapon.silhouette;
      const reach = PLAYER.WEAPON_FORWARD_X + (shape.length - shape.gripX);

      assert.ok(
        reach > PLAYER_HALF_WIDTH + 6,
        `${weapon.id} reaches ${reach}px, which is inside the ${PLAYER_HALF_WIDTH}px-wide body`,
      );
    }
  });

  it("never covers the visor, whatever is being carried", () => {
    /*
     * The weapon draws in front of the body, so nothing but geometry keeps it
     * off the face -- and pushing it forward is not enough on its own, because a
     * bulky weapon's stock reaches back past the grip. What does the work is the
     * hold *height*: at the shoulder the rocket launcher covered 56px² of a
     * 84px² visor; at chest height every weapon clears it.
     *
     * Measured with the aim horizontal, which is where a weapon sits highest
     * against the head.
     */
    const visor = { left: -3, right: 11, top: -15, bottom: -9 };

    for (const weapon of listWeapons()) {
      const shape = weapon.silhouette;

      for (const part of shape.parts) {
        const left = PLAYER.WEAPON_FORWARD_X + (part.x - shape.gripX);
        const right = left + part.width;
        const top = PLAYER.AIM_ORIGIN_Y + (part.y - shape.gripY);
        const bottom = top + part.height;

        const overlapX = Math.min(right, visor.right) - Math.max(left, visor.left);
        const overlapY = Math.min(bottom, visor.bottom) - Math.max(top, visor.top);

        assert.ok(
          overlapX <= 0 || overlapY <= 0,
          `${weapon.id} covers ${Math.max(0, overlapX) * Math.max(0, overlapY)}px² of the visor`,
        );
      }
    }
  });
});
