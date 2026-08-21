/**
 * Sliding-window rate limiting for untrusted client messages.
 *
 * Cheap by design: one counter per bucket, reset when the window rolls over.
 * Exceeding a limit drops the message rather than disconnecting the player, so
 * ordinary network jitter can never kick anyone while scripted floods are absorbed.
 */
export interface RateLimitRule {
  maxEvents: number;
  windowMs: number;
}

export class RateLimiter {
  private windowStart = 0;
  private count = 0;
  private droppedTotal = 0;

  constructor(private readonly rule: RateLimitRule) {}

  /** @returns true when the event is allowed through. */
  tryConsume(now: number): boolean {
    if (now - this.windowStart >= this.rule.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.rule.maxEvents) {
      this.droppedTotal++;
      return false;
    }
    this.count++;
    return true;
  }

  get dropped(): number {
    return this.droppedTotal;
  }
}

/** Holder for the several limiters attached to a single connection. */
export class RateLimiterSet<TKey extends string> {
  private readonly limiters = new Map<TKey, RateLimiter>();

  constructor(rules: Record<TKey, RateLimitRule>) {
    for (const key of Object.keys(rules) as TKey[]) {
      this.limiters.set(key, new RateLimiter(rules[key]));
    }
  }

  allow(key: TKey, now: number): boolean {
    return this.limiters.get(key)?.tryConsume(now) ?? true;
  }

  droppedFor(key: TKey): number {
    return this.limiters.get(key)?.dropped ?? 0;
  }
}
