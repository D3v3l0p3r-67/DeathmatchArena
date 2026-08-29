/**
 * The score, as data.
 *
 * Same bargain as `sounds.ts`: there are no audio files, so a track is a
 * description -- a tempo, a scale, a chord progression and a handful of voices
 * playing patterns over it -- and `MusicPlayer` renders it with oscillators at
 * runtime. Nothing to download, nothing to license, and retuning the mood of a
 * level is editing numbers rather than commissioning a composer.
 *
 * These are deliberately *placeholders*. When real music arrives, a track
 * carries a `url` and the player streams that instead: the seam is one field,
 * and nothing that asks for a track by id has to change.
 *
 * Plain data with no DOM in it, so it can be read (and tested) in Node.
 */
import type { WaveShape } from "./sounds.js";

/**
 * One instrument.
 *
 * `pattern` is written in scale degrees rather than semitones or Hz: 0 is the
 * chord's root, 2 is a third up the scale, `null` is a rest. That is what lets
 * every voice follow the progression without any of them naming a key.
 */
export interface MusicVoice {
  id: string;
  wave: WaveShape;
  /** Peak gain for one note, 0..1. */
  gain: number;
  /** Octave offset from the track's root. */
  octave: number;
  /** Scale degrees, one slot per step. `null` rests. */
  pattern: (number | null)[];
  /** Seconds to reach peak. */
  attack: number;
  /** Seconds of decay after the attack. */
  release: number;
  /**
   * Intensity at which this voice joins in, 0..1.
   *
   * The layering knob: a track played at low intensity is its bass and pad, and
   * the same track at full intensity has the lead and the percussion on top. A
   * fight can therefore raise the music without changing the music.
   */
  fromIntensity?: number;
  /** Percussive voices are noise bursts rather than pitched tones. */
  noise?: boolean;
  /** Low-pass cutoff in Hz for a noise voice. */
  cutoff?: number;
}

export interface MusicTrack {
  id: string;
  name: string;
  bpm: number;
  /** Steps per bar. Patterns are read one slot per step, looping. */
  stepsPerBar: number;
  /** Root of the key, in Hz. */
  root: number;
  /** The scale, as semitone offsets from the root. */
  scale: number[];
  /** Chord roots, one per bar, as scale degrees. The loop's length. */
  progression: number[];
  voices: MusicVoice[];
  /**
   * A real recording to stream instead of synthesising.
   *
   * The upgrade path: drop a file in, name it here, and the placeholder for
   * that track stops being used. Everything else -- selection, volume,
   * cross-fades -- is unchanged.
   */
  url?: string;
}

/** Natural minor: the whole catalogue is in it, which is why it all fits together. */
const MINOR = [0, 2, 3, 5, 7, 8, 10];
/** Dorian: minor with a raised sixth. Darker than major, less mournful than minor. */
const DORIAN = [0, 2, 3, 5, 7, 9, 10];

/** A4 = 440Hz; these are the roots the tracks sit on. */
const A2 = 110;
const D2 = 73.42;
const E2 = 82.41;

export const MUSIC_TRACKS: readonly MusicTrack[] = [
  {
    // Menus and lobbies: slow, wide, nothing demanding attention.
    id: "menu",
    name: "Standby",
    bpm: 84,
    stepsPerBar: 8,
    root: A2,
    scale: MINOR,
    progression: [0, 5, 3, 4],
    voices: [
      {
        id: "pad",
        wave: "triangle",
        gain: 0.16,
        octave: 1,
        pattern: [0, null, null, null, 4, null, null, null],
        attack: 0.6,
        release: 1.6,
      },
      {
        id: "bass",
        wave: "sine",
        gain: 0.22,
        octave: 0,
        pattern: [0, null, null, 0, null, null, 4, null],
        attack: 0.02,
        release: 0.5,
      },
      {
        id: "bell",
        wave: "sine",
        gain: 0.09,
        octave: 3,
        pattern: [null, null, 4, null, null, 2, null, null],
        attack: 0.01,
        release: 0.9,
        fromIntensity: 0.4,
      },
    ],
  },
  {
    // A multiplayer match: driving, repetitive, built to be ignored.
    id: "arena",
    name: "Contact",
    bpm: 132,
    stepsPerBar: 16,
    root: E2,
    scale: MINOR,
    progression: [0, 0, 5, 4],
    voices: [
      {
        id: "bass",
        wave: "sawtooth",
        gain: 0.2,
        octave: 0,
        pattern: [0, null, 0, null, 0, null, 3, null, 0, null, 0, null, 4, null, 3, null],
        attack: 0.01,
        release: 0.16,
      },
      {
        id: "pad",
        wave: "triangle",
        gain: 0.1,
        octave: 1,
        pattern: [0, null, null, null, null, null, null, null, 4, null, null, null, null, null, null, null],
        attack: 0.4,
        release: 1.2,
      },
      {
        id: "kick",
        wave: "sine",
        gain: 0.34,
        octave: 0,
        pattern: [0, null, null, null, 0, null, null, null, 0, null, null, null, 0, null, null, null],
        attack: 0.001,
        release: 0.13,
        noise: true,
        cutoff: 180,
        fromIntensity: 0.25,
      },
      {
        id: "hat",
        wave: "square",
        gain: 0.05,
        octave: 0,
        pattern: [null, null, 0, null, null, null, 0, null, null, null, 0, null, null, null, 0, null],
        attack: 0.001,
        release: 0.05,
        noise: true,
        cutoff: 7000,
        fromIntensity: 0.55,
      },
      {
        id: "lead",
        wave: "square",
        gain: 0.07,
        octave: 2,
        pattern: [null, null, null, null, 4, null, 3, null, null, null, 2, null, null, null, null, null],
        attack: 0.01,
        release: 0.2,
        fromIntensity: 0.8,
      },
    ],
  },
  {
    // The campaign's default: industrial, patient, a little bleak.
    id: "campaign",
    name: "Advance",
    bpm: 104,
    stepsPerBar: 16,
    root: D2,
    scale: DORIAN,
    progression: [0, 3, 0, 6],
    voices: [
      {
        id: "bass",
        wave: "sawtooth",
        gain: 0.19,
        octave: 0,
        pattern: [0, null, null, 0, null, null, 0, null, null, 4, null, null, 0, null, null, null],
        attack: 0.02,
        release: 0.3,
      },
      {
        id: "pad",
        wave: "triangle",
        gain: 0.12,
        octave: 1,
        pattern: [0, null, null, null, null, null, null, null, 2, null, null, null, null, null, null, null],
        attack: 0.7,
        release: 1.8,
      },
      {
        id: "clank",
        wave: "square",
        gain: 0.1,
        octave: 0,
        pattern: [null, null, null, null, 0, null, null, null, null, null, null, null, 0, null, null, null],
        attack: 0.001,
        release: 0.2,
        noise: true,
        cutoff: 2600,
        fromIntensity: 0.3,
      },
      {
        id: "lead",
        wave: "triangle",
        gain: 0.08,
        octave: 2,
        pattern: [null, null, 4, null, null, 3, null, null, null, null, 2, null, null, null, null, null],
        attack: 0.02,
        release: 0.5,
        fromIntensity: 0.6,
      },
    ],
  },
  {
    // A boss: faster, tighter, and it does not resolve.
    id: "boss",
    name: "The Floor Is Yours",
    bpm: 148,
    stepsPerBar: 16,
    root: D2,
    scale: MINOR,
    progression: [0, 1, 0, 5],
    voices: [
      {
        id: "bass",
        wave: "sawtooth",
        gain: 0.24,
        octave: 0,
        pattern: [0, 0, null, 0, 0, null, 0, null, 0, 0, null, 0, 1, null, 0, null],
        attack: 0.005,
        release: 0.12,
      },
      {
        id: "kick",
        wave: "sine",
        gain: 0.36,
        octave: 0,
        pattern: [0, null, null, null, 0, null, null, 0, 0, null, null, null, 0, null, 0, null],
        attack: 0.001,
        release: 0.12,
        noise: true,
        cutoff: 200,
      },
      {
        id: "stab",
        wave: "square",
        gain: 0.1,
        octave: 1,
        pattern: [0, null, null, null, null, null, 4, null, null, null, null, null, 2, null, null, null],
        attack: 0.01,
        release: 0.3,
        fromIntensity: 0.4,
      },
      {
        id: "shriek",
        wave: "sawtooth",
        gain: 0.06,
        octave: 3,
        pattern: [null, null, null, 6, null, null, null, null, null, 5, null, null, null, null, 4, null],
        attack: 0.01,
        release: 0.25,
        fromIntensity: 0.7,
      },
    ],
  },
  {
    // After a level: warm, short, and it actually resolves.
    id: "victory",
    name: "Cleared",
    bpm: 96,
    stepsPerBar: 8,
    root: A2,
    scale: [0, 2, 4, 5, 7, 9, 11],
    progression: [0, 4, 5, 0],
    voices: [
      {
        id: "bass",
        wave: "sine",
        gain: 0.2,
        octave: 0,
        pattern: [0, null, null, null, 4, null, null, null],
        attack: 0.02,
        release: 0.7,
      },
      {
        id: "chime",
        wave: "triangle",
        gain: 0.13,
        octave: 2,
        pattern: [0, null, 2, null, 4, null, 2, null],
        attack: 0.01,
        release: 0.8,
      },
    ],
  },
] as const;

export function getMusicTrack(trackId: string): MusicTrack | null {
  return MUSIC_TRACKS.find((track) => track.id === trackId) ?? null;
}

/** Stable ids, referenced from game code and from level content. */
export const MusicId = {
  Menu: "menu",
  Arena: "arena",
  Campaign: "campaign",
  Boss: "boss",
  Victory: "victory",
} as const;

/**
 * The frequency of a scale degree, in Hz.
 *
 * Degrees run past the end of the scale into the next octave, so a pattern may
 * reach for a seventh above the root without the scale needing fourteen
 * entries. Exported because it is the one piece of the music worth testing on
 * its own -- everything else is Web Audio.
 */
export function degreeToFrequency(track: MusicTrack, degree: number, octave: number): number {
  const size = track.scale.length;
  // Floor division, so a negative degree steps *down* an octave rather than
  // folding back onto itself.
  const octaveShift = Math.floor(degree / size);
  const index = ((degree % size) + size) % size;
  const semitones = track.scale[index]! + 12 * (octaveShift + octave);
  return track.root * Math.pow(2, semitones / 12);
}
