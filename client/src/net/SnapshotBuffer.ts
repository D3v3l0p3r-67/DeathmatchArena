import { NETWORK, lerp, lerpAngle } from "@deathmatch/shared";

/** One remote-entity sample, stamped with the local time it arrived. */
export interface Snapshot {
  receivedAt: number;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  aimAngle: number;
  facing: number;
  alive: boolean;
  onGround: boolean;
}

export interface InterpolatedSample {
  x: number;
  y: number;
  aimAngle: number;
  facing: number;
  alive: boolean;
  onGround: boolean;
  /** Horizontal speed at the sampled instant, used to pick an animation. */
  speedX: number;
}

/**
 * Snapshot history for one remote player, with entity interpolation.
 *
 * Remote players are deliberately rendered ~110ms in the past. State arrives at
 * 20Hz while we render at 60+ FPS, so drawing the newest sample directly would
 * mean a visible 3-frame stutter every update. Holding a small delay guarantees
 * two samples to interpolate between, which turns 20Hz updates into smooth motion.
 *
 * If the buffer runs dry (packet loss), the newest sample is extrapolated with its
 * velocity for a short while rather than freezing the character.
 */
export class SnapshotBuffer {
  private readonly samples: Snapshot[] = [];

  push(snapshot: Snapshot): void {
    const last = this.samples[this.samples.length - 1];
    // Guard against duplicate patches carrying no change for this entity.
    if (last && last.receivedAt === snapshot.receivedAt) {
      this.samples[this.samples.length - 1] = snapshot;
      return;
    }

    this.samples.push(snapshot);
    if (this.samples.length > NETWORK.SNAPSHOT_BUFFER_SIZE) this.samples.shift();
  }

  /**
   * Forget everything seen so far.
   *
   * Used when somebody spawns: the history describes where they *were*, and
   * interpolating from it to a spawn point on the other side of the arena is
   * what made players appear to fly in at the start of a match.
   */
  reset(): void {
    this.samples.length = 0;
  }

  get latest(): Snapshot | undefined {
    return this.samples[this.samples.length - 1];
  }

  get length(): number {
    return this.samples.length;
  }

  /** Sample the entity as it was `INTERPOLATION_DELAY_MS` ago. */
  sample(now: number): InterpolatedSample | null {
    if (this.samples.length === 0) return null;

    const renderTime = now - NETWORK.INTERPOLATION_DELAY_MS;

    if (this.samples.length === 1) return toSample(this.samples[0]!);

    // Newest sample is already older than the render time: extrapolate briefly.
    const newest = this.samples[this.samples.length - 1]!;
    if (renderTime >= newest.receivedAt) {
      return this.extrapolate(newest, renderTime - newest.receivedAt);
    }

    // Oldest sample is newer than the render time (we just connected): clamp.
    const oldest = this.samples[0]!;
    if (renderTime <= oldest.receivedAt) return toSample(oldest);

    for (let i = this.samples.length - 1; i > 0; i--) {
      const after = this.samples[i]!;
      const before = this.samples[i - 1]!;
      if (renderTime >= before.receivedAt && renderTime <= after.receivedAt) {
        const span = after.receivedAt - before.receivedAt;
        const t = span > 0 ? (renderTime - before.receivedAt) / span : 1;
        return {
          x: lerp(before.x, after.x, t),
          y: lerp(before.y, after.y, t),
          aimAngle: lerpAngle(before.aimAngle, after.aimAngle, t),
          // Discrete fields snap to the newer sample rather than blending.
          facing: after.facing,
          alive: after.alive,
          onGround: after.onGround,
          speedX: after.velocityX,
        };
      }
    }

    return toSample(newest);
  }

  private extrapolate(snapshot: Snapshot, aheadMs: number): InterpolatedSample {
    // Cap extrapolation: guessing too far ahead looks worse than a brief pause.
    const seconds = Math.min(aheadMs, NETWORK.INTERPOLATION_DELAY_MS) / 1000;
    return {
      x: snapshot.x + snapshot.velocityX * seconds,
      y: snapshot.y + snapshot.velocityY * seconds,
      aimAngle: snapshot.aimAngle,
      facing: snapshot.facing,
      alive: snapshot.alive,
      onGround: snapshot.onGround,
      speedX: snapshot.velocityX,
    };
  }

  clear(): void {
    this.samples.length = 0;
  }
}

function toSample(snapshot: Snapshot): InterpolatedSample {
  return {
    x: snapshot.x,
    y: snapshot.y,
    aimAngle: snapshot.aimAngle,
    facing: snapshot.facing,
    alive: snapshot.alive,
    onGround: snapshot.onGround,
    speedX: snapshot.velocityX,
  };
}
