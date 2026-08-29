/**
 * The music catalogue is plain data, so it can be checked in Node without a
 * browser: the arithmetic that turns a pattern into pitches, and the sanity of
 * every shipped track. What Web Audio does with it is verified in the browser.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { MUSIC_TRACKS, MusicId, degreeToFrequency, getMusicTrack } = await import(
  "../client/src/audio/music.js"
);

describe("music: the catalogue is playable", () => {
  it("ships a track for every situation the game asks for", () => {
    for (const id of Object.values(MusicId)) {
      assert.ok(getMusicTrack(id), `no track for "${id}"`);
    }
  });

  it("describes tracks a scheduler can actually render", () => {
    for (const track of MUSIC_TRACKS) {
      assert.ok(track.bpm > 0 && track.bpm < 300, `${track.id} has an unplayable tempo`);
      assert.ok(track.stepsPerBar > 0, `${track.id} has no steps`);
      assert.ok(track.root > 20, `${track.id} is rooted below hearing`);
      assert.ok(track.scale.length >= 5, `${track.id} has too small a scale`);
      assert.ok(track.progression.length > 0, `${track.id} has no progression`);
      assert.ok(track.voices.length > 0, `${track.id} has no voices`);

      for (const voice of track.voices) {
        assert.ok(voice.pattern.length > 0, `${track.id}/${voice.id} has an empty pattern`);
        assert.ok(voice.gain > 0 && voice.gain <= 1, `${track.id}/${voice.id} has an odd gain`);
        assert.ok(voice.release > 0, `${track.id}/${voice.id} never fades`);
        const intensity = voice.fromIntensity ?? 0;
        assert.ok(intensity >= 0 && intensity <= 1, `${track.id}/${voice.id} has an out-of-range intensity`);
      }
    }
  });

  it("keeps every voice inside a range worth hearing", () => {
    for (const track of MUSIC_TRACKS) {
      for (const voice of track.voices) {
        for (const degree of voice.pattern) {
          if (degree === null) continue;
          // Patterns are played against every chord in the progression.
          for (const chord of track.progression) {
            const hz = degreeToFrequency(track, chord + degree, voice.octave);
            assert.ok(hz > 30 && hz < 6000, `${track.id}/${voice.id} reaches ${hz.toFixed(0)}Hz`);
          }
        }
      }
    }
  });

  it("reads degrees as scale steps, and octaves as doublings", () => {
    const track = getMusicTrack(MusicId.Menu)!;
    const root = degreeToFrequency(track, 0, 0);
    assert.ok(Math.abs(root - track.root) < 0.001, "degree 0 is the root");

    // A full scale up is one octave: exactly double.
    const octaveUp = degreeToFrequency(track, track.scale.length, 0);
    assert.ok(Math.abs(octaveUp - track.root * 2) < 0.001, "seven degrees up doubles the frequency");

    // And the octave argument doubles it again.
    assert.ok(
      Math.abs(degreeToFrequency(track, 0, 1) - track.root * 2) < 0.001,
      "one octave up doubles the root",
    );

    // Negative degrees step down rather than folding back up.
    assert.ok(degreeToFrequency(track, -1, 0) < root, "a degree below the root is lower");
  });

  it("layers voices by intensity, so a track can thicken without changing", () => {
    // At least one shipped track must have something held back for pressure,
    // or the intensity system is decoration.
    const layered = MUSIC_TRACKS.filter((track) =>
      track.voices.some((voice) => (voice.fromIntensity ?? 0) > 0),
    );
    assert.ok(layered.length >= 3, "most tracks should have voices that join under pressure");

    const arena = getMusicTrack(MusicId.Arena)!;
    const quiet = arena.voices.filter((voice) => (voice.fromIntensity ?? 0) <= 0.2).length;
    const loud = arena.voices.length;
    assert.ok(quiet >= 1 && quiet < loud, "the arena track must play at low intensity and grow");
  });
});
