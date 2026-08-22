import { SoundChannel, getSound, type SoundChannelValue, type SoundDefinition } from "./sounds.js";

/** Volumes and toggles a player controls, persisted between sessions. */
export interface AudioSettings {
  muted: boolean;
  master: number;
  combat: number;
  world: number;
  interface: number;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  muted: false,
  master: 0.7,
  combat: 1,
  world: 1,
  interface: 1,
};

/** How a positional sound fades with distance from the listener. */
export interface AudioFalloff {
  /** Full volume within this distance, in world px. */
  fullVolumeDistance: number;
  /** Silent beyond this distance. */
  silenceDistance: number;
  /** How far left/right a sound can be panned, 0..1. */
  maxPan: number;
}

export const DEFAULT_FALLOFF: AudioFalloff = {
  fullVolumeDistance: 220,
  silenceDistance: 1500,
  maxPan: 0.75,
};

const STORAGE_KEY = "deathmatch-arena:audio";

/**
 * Synthesises every sound in the game at runtime.
 *
 * There are no audio files: each sound is built from oscillators and filtered
 * noise described by `sounds.ts`. That keeps the game self-contained — nothing to
 * download, nothing to license — and means retuning a sound is editing numbers.
 *
 * Everything is guarded, because audio is the one subsystem that must never take
 * the game down: browsers refuse to start an `AudioContext` before a user
 * gesture, some environments have none at all, and a failure to make a noise is
 * never worth an exception.
 */
export class AudioEngine {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private readonly channelGains = new Map<SoundChannelValue, GainNode>();

  /** One shared noise buffer; generating it per sound would be wasteful. */
  private noiseBuffer: AudioBuffer | null = null;

  private settings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };
  private falloff: AudioFalloff = { ...DEFAULT_FALLOFF };

  /** Listener position in world space, normally the camera's centre. */
  private listenerX = 0;
  private listenerY = 0;

  /** Last time each sound played, for per-sound throttling. */
  private readonly lastPlayedAt = new Map<string, number>();

  private unavailable = false;

  constructor() {
    this.settings = { ...DEFAULT_AUDIO_SETTINGS, ...loadSettings() };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start (or resume) audio. Must be called from a user gesture.
   *
   * Browsers suspend audio until the player interacts, so this is wired to the
   * Play button rather than to page load.
   */
  async resume(): Promise<void> {
    if (this.unavailable) return;

    try {
      if (!this.context) this.initialise();
      if (this.context?.state === "suspended") await this.context.resume();
    } catch {
      // No audio in this environment. The game carries on in silence.
      this.unavailable = true;
    }
  }

  private initialise(): void {
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      this.unavailable = true;
      return;
    }

    const context = new Ctor();
    const master = context.createGain();
    master.connect(context.destination);

    for (const channel of Object.values(SoundChannel)) {
      const gain = context.createGain();
      gain.connect(master);
      this.channelGains.set(channel, gain);
    }

    // One second of white noise, looped and re-read per sound.
    const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    this.context = context;
    this.masterGain = master;
    this.noiseBuffer = buffer;
    this.applyGains();
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  getSettings(): AudioSettings {
    return { ...this.settings };
  }

  updateSettings(patch: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.applyGains();
    saveSettings(this.settings);
  }

  setFalloff(falloff: Partial<AudioFalloff>): void {
    this.falloff = { ...this.falloff, ...falloff };
  }

  /** Where the player is listening from; sounds fade and pan around it. */
  setListenerPosition(x: number, y: number): void {
    this.listenerX = x;
    this.listenerY = y;
  }

  private applyGains(): void {
    if (!this.masterGain) return;
    const master = this.settings.muted ? 0 : clamp01(this.settings.master);
    this.masterGain.gain.value = master;

    this.channelGains.get(SoundChannel.COMBAT)!.gain.value = clamp01(this.settings.combat);
    this.channelGains.get(SoundChannel.WORLD)!.gain.value = clamp01(this.settings.world);
    this.channelGains.get(SoundChannel.INTERFACE)!.gain.value = clamp01(this.settings.interface);
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  /** Play a sound with no position — menus, countdowns, your own feedback. */
  play(soundId: string, volumeScale = 1): void {
    this.emit(soundId, volumeScale, 0);
  }

  /**
   * Play a sound somewhere in the world.
   *
   * Volume falls off with distance from the listener and pans towards the side
   * it happened on, which is most of what makes a firefight readable when you
   * cannot see the shooter.
   */
  playAt(soundId: string, x: number, y: number, volumeScale = 1): void {
    const dx = x - this.listenerX;
    const distance = Math.hypot(dx, y - this.listenerY);

    const { fullVolumeDistance, silenceDistance, maxPan } = this.falloff;
    if (distance >= silenceDistance) return;

    const span = Math.max(1, silenceDistance - fullVolumeDistance);
    const attenuation = distance <= fullVolumeDistance ? 1 : 1 - (distance - fullVolumeDistance) / span;

    const pan = clamp(dx / silenceDistance, -1, 1) * maxPan;
    this.emit(soundId, volumeScale * attenuation * attenuation, pan);
  }

  private emit(soundId: string, volumeScale: number, pan: number): void {
    if (this.unavailable || this.settings.muted) return;
    if (volumeScale <= 0.001) return;

    const definition = getSound(soundId);
    if (!definition) return;

    const context = this.context;
    const channel = this.channelGains.get(definition.channel);
    if (!context || !channel || context.state !== "running") return;

    const now = context.currentTime;
    if (!this.passesThrottle(definition, now)) return;

    try {
      this.render(definition, context, channel, now, volumeScale, pan);
    } catch {
      // A sound that fails to build is never worth interrupting the game for.
    }
  }

  /** Rate-limit a sound, so a shotgun's pellets do not stack into a clack. */
  private passesThrottle(definition: SoundDefinition, now: number): boolean {
    if (!definition.throttleMs) return true;

    const last = this.lastPlayedAt.get(definition.id) ?? -Infinity;
    if ((now - last) * 1000 < definition.throttleMs) return false;

    this.lastPlayedAt.set(definition.id, now);
    return true;
  }

  private render(
    definition: SoundDefinition,
    context: AudioContext,
    channel: GainNode,
    now: number,
    volumeScale: number,
    pan: number,
  ): void {
    const jitter = definition.pitchJitter ?? 0;
    const pitch = 1 + (Math.random() * 2 - 1) * jitter;
    const volume = clamp01((definition.volume ?? 1) * volumeScale);

    const panner = context.createStereoPanner?.();
    const destination: AudioNode = panner ?? channel;
    if (panner) {
      panner.pan.value = clamp(pan, -1, 1);
      panner.connect(channel);
    }

    for (const layer of definition.layers) {
      const startAt = now + (layer.delay ?? 0);
      const gain = context.createGain();
      gain.connect(destination);

      // Attack then exponential-ish decay, which is what makes a sound read as
      // a hit rather than a hum.
      const peak = Math.max(0.0001, layer.gain * volume);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.linearRampToValueAtTime(peak, startAt + Math.max(0.001, layer.attack));
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + layer.attack + layer.duration);

      if (layer.kind === "tone") {
        const oscillator = context.createOscillator();
        oscillator.type = layer.wave;
        oscillator.frequency.setValueAtTime(layer.frequency * pitch, startAt);
        if (layer.sweepTo !== undefined) {
          oscillator.frequency.exponentialRampToValueAtTime(
            Math.max(20, layer.sweepTo * pitch),
            startAt + layer.attack + layer.duration,
          );
        }
        oscillator.connect(gain);
        oscillator.start(startAt);
        oscillator.stop(startAt + layer.attack + layer.duration + 0.02);
      } else {
        const source = context.createBufferSource();
        source.buffer = this.noiseBuffer;
        source.loop = true;

        const filter = context.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.setValueAtTime(Math.max(60, layer.cutoff * pitch), startAt);
        if (layer.cutoffTo !== undefined) {
          filter.frequency.exponentialRampToValueAtTime(
            Math.max(60, layer.cutoffTo * pitch),
            startAt + layer.attack + layer.duration,
          );
        }
        if (layer.resonance !== undefined) filter.Q.value = layer.resonance;

        source.connect(filter);
        filter.connect(gain);
        source.start(startAt);
        source.stop(startAt + layer.attack + layer.duration + 0.02);
      }
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function loadSettings(): Partial<AudioSettings> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<AudioSettings>) : {};
  } catch {
    return {};
  }
}

function saveSettings(settings: AudioSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing, or storage disabled. Settings simply last one session.
  }
}
