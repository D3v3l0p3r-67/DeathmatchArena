/** Axis-aligned rectangle described by its top-left corner. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Axis-aligned bounding box described by its edges. */
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function rectToBounds(rect: Rect): Bounds {
  return {
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
  };
}

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function pointInRect(px: number, py: number, rect: Rect): boolean {
  return px >= rect.x && px <= rect.x + rect.width && py >= rect.y && py <= rect.y + rect.height;
}

/** Centre-anchored AABB, the shape used for every player capsule. */
export function centeredBounds(cx: number, cy: number, halfWidth: number, halfHeight: number): Bounds {
  return {
    left: cx - halfWidth,
    top: cy - halfHeight,
    right: cx + halfWidth,
    bottom: cy + halfHeight,
  };
}

export interface RayHit {
  /** Normalised distance along the segment where the hit occurred (0..1). */
  t: number;
  x: number;
  y: number;
  normalX: number;
  normalY: number;
}

/**
 * Slab-method intersection between the segment (x0,y0)->(x1,y1) and an AABB.
 *
 * Returns `null` when there is no hit. A segment that starts inside the box
 * reports `t = 0`, which is what we want for projectiles spawned inside geometry.
 */
export function segmentVsBounds(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  bounds: Bounds,
): RayHit | null {
  const dx = x1 - x0;
  const dy = y1 - y0;

  let tMin = 0;
  let tMax = 1;
  let normalX = 0;
  let normalY = 0;

  // X slab
  if (dx === 0) {
    if (x0 < bounds.left || x0 > bounds.right) return null;
  } else {
    const inverse = 1 / dx;
    let t1 = (bounds.left - x0) * inverse;
    let t2 = (bounds.right - x0) * inverse;
    let axisNormal = -1;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
      axisNormal = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      normalX = axisNormal;
      normalY = 0;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }

  // Y slab
  if (dy === 0) {
    if (y0 < bounds.top || y0 > bounds.bottom) return null;
  } else {
    const inverse = 1 / dy;
    let t1 = (bounds.top - y0) * inverse;
    let t2 = (bounds.bottom - y0) * inverse;
    let axisNormal = -1;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
      axisNormal = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      normalX = 0;
      normalY = axisNormal;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }

  return {
    t: tMin,
    x: x0 + dx * tMin,
    y: y0 + dy * tMin,
    normalX,
    normalY,
  };
}
