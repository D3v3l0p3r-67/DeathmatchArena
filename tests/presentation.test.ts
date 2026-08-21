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
