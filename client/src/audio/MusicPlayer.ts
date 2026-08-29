/**
 * Plays the score.
 *
 * Web Audio cannot be driven from a render loop -- a note started when a frame
 * happens to run is a note that arrives late. So this schedules *ahead*: every
 * tick it looks a short way into the future and books every step that falls in
 * that window, at exact times the audio clock will honour whatever the frame
 * rate is doing. The loop is therefore seamless by construction rather than by
 * luck.
 *
 * Switching tracks cross-fades: the outgoing track keeps playing into a gain
 * that is being taken to zero, so a level ending or a boss appearing is a
 * transition rather than a cut. Everything is guarded, like the rest of the
 * audio layer: a browser that refuses to make a noise must never take the game
 * with it.
 */
import type { AudioEngine } from "./AudioEngine.js";
import { degreeToFrequency, getMusicTrack, type MusicTrack, type MusicVoice } from "./music.js";

/** How far ahead notes are booked, in seconds. */
const SCHEDULE_AHEAD = 0.4;
/** How long one track takes to give way to the next. */
const CROSSFADE_SECONDS = 1.2;

interface ActiveTrack {
  track: MusicTrack;
  /** This track's own fader, under the engine's music channel. */
  gain: GainNode;
  /** Audio-clock time of step 0. */
  startedAt: number;
  /** Steps already booked. */
  scheduledSteps: number;
  /** A streamed file, when the track has one. */
  element: HTMLAudioElement | null;
  /** Set once it is on its way out, so it is not scheduled any further. */
  retiring: boolean;
}

export class MusicPlayer {
  private active: ActiveTrack | null = null;
  private retiring: ActiveTrack[] = [];
  private intensity = 1;
  /** What was asked for before the audio context existed, played on resume. */
  private pending: string | null = null;
  private enabled = true;

  constructor(private readonly engine: AudioEngine) {}

  /**
   * Ask for a track by id.
   *
   * Idempotent: asking for the track already playing does nothing, so callers
   * can say what the music *should* be on every state change without having to
   * work out whether it changed.
   */
  play(trackId: string | null): void {
    if (!this.enabled) {
      this.pending = trackId;
      return;
    }
    if (trackId === null) {
      this.stop();
      return;
    }
    if (this.active && !this.active.retiring && this.active.track.id === trackId) return;

    const output = this.engine.musicOutput();
    if (!output) {
      // No audio context yet -- it needs a user gesture. Remember the wish.
      this.pending = trackId;
      return;
    }

    const track = getMusicTrack(trackId);
    if (!track) return;

    this.retireActive(output.context);

    try {
      const gain = output.context.createGain();
      gain.gain.setValueAtTime(0.0001, output.context.currentTime);
      gain.gain.linearRampToValueAtTime(1, output.context.currentTime + CROSSFADE_SECONDS);
      gain.connect(output.destination);

      const element = track.url ? this.startStream(track, output.context, gain) : null;

      this.active = {
        track,
        gain,
        startedAt: output.context.currentTime,
        scheduledSteps: 0,
        element,
        retiring: false,
      };
      this.pending = null;
    } catch {
      // A browser that will not build the graph simply gets no music.
    }
  }

  /** Fade everything out. */
  stop(): void {
    const output = this.engine.musicOutput();
    if (output) this.retireActive(output.context);
    this.active = null;
    this.pending = null;
  }

  /**
   * How much of the arrangement plays, 0..1.
   *
   * Voices declare the intensity they join at, so this thickens or thins the
   * same track without changing it -- a quiet corridor and a firefight can
   * share a piece of music and still feel different.
   */
  setIntensity(intensity: number): void {
    this.intensity = Math.min(1, Math.max(0, intensity));
  }

  /** Turn the score off entirely, e.g. from a setting. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      const wanted = this.active?.track.id ?? this.pending;
      this.stop();
      this.pending = wanted;
      return;
    }
    if (this.pending) this.play(this.pending);
  }

  get currentTrackId(): string | null {
    return this.active && !this.active.retiring ? this.active.track.id : null;
  }

  /**
   * Book whatever falls inside the look-ahead window. Call it regularly; it
   * costs nothing when there is nothing due.
   */
  update(): void {
    const output = this.engine.musicOutput();
    if (!output) return;

    // A context that only just started can honour a wish made before it existed.
    if (this.pending && this.enabled) {
      const wanted = this.pending;
      this.pending = null;
      this.play(wanted);
    }

    this.sweepRetired(output.context);

    const active = this.active;
    if (!active || active.retiring || active.element) return;

    const track = active.track;
    const stepSeconds = 60 / track.bpm / (track.stepsPerBar / 4);
    const horizon = output.context.currentTime + SCHEDULE_AHEAD;

    // Catch up if the tab was asleep: skip straight to the present rather than
    // booking a thousand notes nobody heard.
    const elapsedSteps = Math.floor((output.context.currentTime - active.startedAt) / stepSeconds);
    if (elapsedSteps > active.scheduledSteps + 8) active.scheduledSteps = elapsedSteps;

    while (active.startedAt + active.scheduledSteps * stepSeconds < horizon) {
      this.scheduleStep(output.context, active, active.scheduledSteps, stepSeconds);
      active.scheduledSteps++;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private scheduleStep(
    context: AudioContext,
    active: ActiveTrack,
    step: number,
    stepSeconds: number,
  ): void {
    const track = active.track;
    const at = active.startedAt + step * stepSeconds;
    const slot = step % track.stepsPerBar;
    const bar = Math.floor(step / track.stepsPerBar) % track.progression.length;
    const chordRoot = track.progression[bar]!;

    for (const voice of track.voices) {
      if ((voice.fromIntensity ?? 0) > this.intensity) continue;
      const degree = voice.pattern[slot % voice.pattern.length];
      if (degree === null || degree === undefined) continue;
      this.scheduleNote(context, active, track, voice, chordRoot + degree, at);
    }
  }

  private scheduleNote(
    context: AudioContext,
    active: ActiveTrack,
    track: MusicTrack,
    voice: MusicVoice,
    degree: number,
    at: number,
  ): void {
    try {
      const gain = context.createGain();
      gain.connect(active.gain);

      const peak = Math.max(0.0001, voice.gain);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(peak, at + Math.max(0.001, voice.attack));
      gain.gain.exponentialRampToValueAtTime(0.0001, at + voice.attack + voice.release);

      const stopAt = at + voice.attack + voice.release + 0.02;

      if (voice.noise) {
        // Percussion: a filtered burst of the engine's noise buffer.
        const source = context.createBufferSource();
        source.buffer = this.engine.noise();
        source.loop = true;
        const filter = context.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = voice.cutoff ?? 1200;
        source.connect(filter);
        filter.connect(gain);
        source.start(at);
        source.stop(stopAt);
        return;
      }

      const oscillator = context.createOscillator();
      oscillator.type = voice.wave;
      oscillator.frequency.value = degreeToFrequency(track, degree, voice.octave);
      oscillator.connect(gain);
      oscillator.start(at);
      oscillator.stop(stopAt);
    } catch {
      // One note that cannot be built is not worth an exception.
    }
  }

  /** Stream a real recording, for a track that has one. */
  private startStream(track: MusicTrack, context: AudioContext, gain: GainNode): HTMLAudioElement | null {
    try {
      const element = new Audio(track.url);
      element.loop = true;
      element.crossOrigin = "anonymous";
      const source = context.createMediaElementSource(element);
      source.connect(gain);
      void element.play().catch(() => {});
      return element;
    } catch {
      return null;
    }
  }

  private retireActive(context: AudioContext): void {
    const active = this.active;
    if (!active || active.retiring) return;

    active.retiring = true;
    try {
      active.gain.gain.cancelScheduledValues(context.currentTime);
      active.gain.gain.setValueAtTime(active.gain.gain.value, context.currentTime);
      active.gain.gain.linearRampToValueAtTime(0.0001, context.currentTime + CROSSFADE_SECONDS);
    } catch {
      // Nothing to fade.
    }
    this.retiring.push(active);
    this.active = null;
  }

  /** Disconnect faded-out tracks once they are silent. */
  private sweepRetired(context: AudioContext): void {
    if (this.retiring.length === 0) return;
    const done: ActiveTrack[] = [];

    this.retiring = this.retiring.filter((entry) => {
      const finished = context.currentTime > entry.startedAt + CROSSFADE_SECONDS + 0.2;
      if (finished) done.push(entry);
      return !finished;
    });

    for (const entry of done) {
      try {
        entry.element?.pause();
        entry.gain.disconnect();
      } catch {
        // Already gone.
      }
    }
  }
}
