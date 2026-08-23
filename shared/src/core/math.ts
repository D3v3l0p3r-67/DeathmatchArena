/**
 * Small, dependency-free math helpers.
 *
 * Everything in `shared/` is used by BOTH the authoritative server simulation and
 * the client-side prediction, so it must stay pure and deterministic: no `Date.now()`,
 * no `Math.random()`, no platform APIs.
 */

export const TWO_PI = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Clamp to 0..1.
 *
 * The workhorse of the NPC utility system, which compares scores built from
 * normalised terms -- a term that escapes 0..1 quietly overwhelms every other
 * term it is added to, and the bug looks like a personality rather than a bug.
 */
export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential smoothing towards `b`. */
export function damp(a: number, b: number, smoothing: number, dt: number): number {
  return lerp(a, b, 1 - Math.pow(smoothing, dt));
}

/** Wrap an angle into (-PI, PI]. */
export function normalizeAngle(angle: number): number {
  let a = angle % TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  if (a <= -Math.PI) a += TWO_PI;
  return a;
}

/** Shortest signed angular distance from `a` to `b`. */
export function angleDelta(a: number, b: number): number {
  return normalizeAngle(b - a);
}

export function lerpAngle(a: number, b: number, t: number): number {
  return normalizeAngle(a + angleDelta(a, b) * t);
}

export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(distanceSq(ax, ay, bx, by));
}

export function sign(value: number): number {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Deterministic pseudo random number generator (mulberry32).
 *
 * Used server-side for weapon spread so that shots are reproducible from a seed,
 * which keeps replay/debugging possible. Never used for client-visible outcomes.
 */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return function random(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Distance from a point to the nearest edge of a box.
 *
 * Measured to the box rather than to its centre, so a blast landing against
 * somebody's feet counts as a direct hit rather than as one player-height away.
 */
export function distanceToBox(
  fromX: number,
  fromY: number,
  boxX: number,
  boxY: number,
  halfWidth: number,
  halfHeight: number,
): number {
  const dx = Math.max(Math.abs(fromX - boxX) - halfWidth, 0);
  const dy = Math.max(Math.abs(fromY - boxY) - halfHeight, 0);
  return Math.hypot(dx, dy);
}
