/**
 * Rate-limits a sound, so a shotgun's nine pellets land as one impact rather
 * than nine stacked into a clack.
 *
 * Buckets exist because the limit is per *situation*, not per sound. A hit is a
 * hit whoever landed it, and the whole arena's hits are announced to every
 * client now: with one window per sound id, a faint exchange between two bots
 * across the map could arrive a few milliseconds ahead of the shot you just
 * landed and silence it -- first come wins, however little it mattered. Your
 * own hits and other people's are counted separately, so neither can swallow
 * the other.
 */
export class SoundThrottle {
  /** Last time each bucket played, in seconds on the audio clock. */
  private readonly lastPlayedAt = new Map<string, number>();

  /**
   * Whether this play is allowed now, recording it if so.
   *
   * `nowSec` is the audio context clock rather than the wall clock, because
   * that is the timeline the sounds themselves are scheduled on.
   */
  allows(soundId: string, throttleMs: number | undefined, nowSec: number, bucket?: string): boolean {
    if (!throttleMs) return true;

    const key = bucket ? `${soundId}#${bucket}` : soundId;
    const last = this.lastPlayedAt.get(key) ?? Number.NEGATIVE_INFINITY;
    if ((nowSec - last) * 1000 < throttleMs) return false;

    this.lastPlayedAt.set(key, nowSec);
    return true;
  }

  /** Forget every window. Used when the audio context is rebuilt. */
  clear(): void {
    this.lastPlayedAt.clear();
  }
}
