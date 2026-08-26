import type { TrailSpec } from "./effects.js";

/**
 * The path a trail is drawn along, and how faded each part of it is.
 *
 * Pure arithmetic: no Phaser, no DOM, no scene. `TrailRenderer` maps what comes
 * out of here onto pooled sprites, and keeping the two apart is what lets the
 * sampling gate and the fade curve -- the only parts with any real logic in
 * them -- be tested directly.
 *
 * Nothing is allocated after construction. The points live in preallocated
 * typed arrays used as a ring buffer, and `segments()` returns the same array
 * of the same objects every frame with their fields overwritten. A trail is
 * updated on every rendered frame for every player and grenade on screen, which
 * is exactly the place where allocating a handful of little objects per call
 * turns into a garbage collector pause somebody feels.
 */
export interface TrailSegment {
  /** The older end. */
  x0: number;
  y0: number;
  /** The newer end. */
  x1: number;
  y1: number;
  /** Already scaled by the spec's own alpha; 0..1. */
  alpha: number;
  /** Already tapered; in px. */
  width: number;
}

export class TrailPath {
  /** One more point than segments: n segments need n+1 ends. */
  private readonly capacity: number;
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private readonly times: Float64Array;

  /** Index of the oldest live point, and how many are live. */
  private start = 0;
  private count = 0;

  /** Reused output. Grown once, never reallocated, never handed out to keep. */
  private readonly output: TrailSegment[] = [];
  private outputLength = 0;

  constructor(private readonly spec: TrailSpec) {
    this.capacity = Math.max(2, Math.floor(spec.segments) + 1);
    this.xs = new Float64Array(this.capacity);
    this.ys = new Float64Array(this.capacity);
    this.times = new Float64Array(this.capacity);

    for (let i = 0; i < this.capacity - 1; i++) {
      this.output.push({ x0: 0, y0: 0, x1: 0, y1: 0, alpha: 0, width: 0 });
    }
  }

  /**
   * Offer the emitter's current position to the trail.
   *
   * Returns whether it was actually recorded. Movement too slow or too small is
   * ignored rather than recorded, which is what stops a standing player from
   * grinding a hundred identical points through the buffer every second -- and
   * what makes a trail *stop being fed* rather than being cut off, so it fades
   * out where it is instead of vanishing.
   */
  sample(x: number, y: number, nowMs: number): boolean {
    if (this.count === 0) {
      this.push(x, y, nowMs);
      return true;
    }

    const last = this.indexOf(this.count - 1);
    const dx = x - this.xs[last]!;
    const dy = y - this.ys[last]!;
    const distance = Math.hypot(dx, dy);
    if (distance < this.spec.minSampleDistance) return false;

    // A non-positive step means two samples in the same millisecond: the
    // distance test above has already accepted the movement, so take it rather
    // than dividing by zero to decide.
    const elapsedSec = (nowMs - this.times[last]!) / 1000;
    if (elapsedSec > 0 && distance / elapsedSec < this.spec.minSpeed) return false;

    this.push(x, y, nowMs);
    return true;
  }

  /**
   * Rebuild the live segments, oldest first, and return how many there are.
   *
   * Expiry happens here rather than on a timer: points are recorded in order,
   * so everything older than the fade window is a prefix of the buffer and
   * dropping it is moving one index.
   *
   * Returns a count rather than an array, and the caller reads that many
   * entries out of `segmentAt`. Handing back a `slice` would be a nicer shape
   * and would allocate an array per trail per frame, which is the one thing
   * this class exists to avoid.
   */
  update(nowMs: number): number {
    this.expire(nowMs);
    this.outputLength = 0;

    const { fadeMs, alpha, width, taper } = this.spec;
    for (let i = 0; i + 1 < this.count; i++) {
      const older = this.indexOf(i);
      const newer = this.indexOf(i + 1);

      // Aged by the older end, so the far end of the trail is the faint one.
      const fade = fadeMs > 0 ? 1 - (nowMs - this.times[older]!) / fadeMs : 0;
      if (fade <= 0) continue;

      const segment = this.output[this.outputLength++]!;
      segment.x0 = this.xs[older]!;
      segment.y0 = this.ys[older]!;
      segment.x1 = this.xs[newer]!;
      segment.y1 = this.ys[newer]!;
      segment.alpha = alpha * fade;
      segment.width = width * (taper + (1 - taper) * fade);
    }

    return this.outputLength;
  }

  /**
   * One live segment, by index below the count `update` returned.
   *
   * The object is owned by this path and overwritten on the next `update` --
   * read it, do not keep it.
   */
  segmentAt(index: number): TrailSegment {
    return this.output[index]!;
  }

  /**
   * Forget the path entirely.
   *
   * For a jump in position that is not travel -- a respawn, a new match, a
   * spectator switching who they watch. Without it the next sample would draw a
   * streak across the arena between two places nothing ever moved between.
   */
  clear(): void {
    this.start = 0;
    this.count = 0;
    this.outputLength = 0;
  }

  private push(x: number, y: number, nowMs: number): void {
    const at = this.indexOf(this.count);
    this.xs[at] = x;
    this.ys[at] = y;
    this.times[at] = nowMs;

    if (this.count < this.capacity) this.count += 1;
    // Full: the write above landed on the oldest slot, so that is the new head.
    else this.start = (this.start + 1) % this.capacity;
  }

  /** Drop points that have finished fading. Always a prefix; see `segments`. */
  private expire(nowMs: number): void {
    while (this.count > 0 && nowMs - this.times[this.start]! > this.spec.fadeMs) {
      this.start = (this.start + 1) % this.capacity;
      this.count -= 1;
    }
  }

  private indexOf(offset: number): number {
    return (this.start + offset) % this.capacity;
  }
}
