import { boundsOverlap, centeredBounds, rectToBounds, segmentVsBounds, type Bounds, type RayHit } from "../core/geometry.js";
import type { ArenaDefinition, Surface } from "./arena.js";

const CELL_SIZE = 256;

export interface SurfaceHit extends RayHit {
  surface: Surface;
}

/**
 * Static broad-phase for arena geometry.
 *
 * Built once per arena and shared by the server simulation and the client
 * prediction. Query order is deterministic (surfaces are visited in definition
 * order) so both sides resolve collisions identically.
 */
export class CollisionWorld {
  readonly arena: ArenaDefinition;
  readonly bounds: Bounds;

  private readonly surfaces: Surface[];
  private readonly surfaceBounds: Bounds[];
  private readonly columns: number;
  private readonly rows: number;
  private readonly cells: number[][];

  /** Scratch buffers reused between queries to keep the hot path allocation-free. */
  private readonly visitStamp: Int32Array;
  private visitToken = 0;
  private readonly queryResult: number[] = [];

  constructor(arena: ArenaDefinition) {
    this.arena = arena;
    this.surfaces = arena.surfaces;
    this.surfaceBounds = arena.surfaces.map(rectToBounds);
    this.bounds = { left: 0, top: 0, right: arena.width, bottom: arena.height };

    this.columns = Math.max(1, Math.ceil(arena.width / CELL_SIZE));
    this.rows = Math.max(1, Math.ceil(arena.height / CELL_SIZE));
    this.cells = new Array(this.columns * this.rows);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];

    this.surfaceBounds.forEach((bounds, index) => {
      const minColumn = this.clampColumn(Math.floor(bounds.left / CELL_SIZE));
      const maxColumn = this.clampColumn(Math.floor((bounds.right - 1e-6) / CELL_SIZE));
      const minRow = this.clampRow(Math.floor(bounds.top / CELL_SIZE));
      const maxRow = this.clampRow(Math.floor((bounds.bottom - 1e-6) / CELL_SIZE));
      for (let row = minRow; row <= maxRow; row++) {
        for (let column = minColumn; column <= maxColumn; column++) {
          this.cells[row * this.columns + column]!.push(index);
        }
      }
    });

    this.visitStamp = new Int32Array(this.surfaces.length);
  }

  getSurface(index: number): Surface {
    return this.surfaces[index]!;
  }

  getSurfaceBounds(index: number): Bounds {
    return this.surfaceBounds[index]!;
  }

  /**
   * Indices of every surface whose cell overlaps the query box, in ascending
   * (definition) order. The returned array is reused — copy it if you need to keep it.
   */
  querySurfaceIndices(area: Bounds): readonly number[] {
    const result = this.queryResult;
    result.length = 0;

    const token = ++this.visitToken;
    const minColumn = this.clampColumn(Math.floor(area.left / CELL_SIZE));
    const maxColumn = this.clampColumn(Math.floor(area.right / CELL_SIZE));
    const minRow = this.clampRow(Math.floor(area.top / CELL_SIZE));
    const maxRow = this.clampRow(Math.floor(area.bottom / CELL_SIZE));

    for (let row = minRow; row <= maxRow; row++) {
      for (let column = minColumn; column <= maxColumn; column++) {
        const bucket = this.cells[row * this.columns + column]!;
        for (let i = 0; i < bucket.length; i++) {
          const index = bucket[i]!;
          if (this.visitStamp[index] === token) continue;
          this.visitStamp[index] = token;
          if (boundsOverlap(area, this.surfaceBounds[index]!)) result.push(index);
        }
      }
    }

    // Deterministic ordering regardless of grid traversal.
    result.sort(ascending);
    return result;
  }

  overlapsSolid(area: Bounds): boolean {
    return this.querySurfaceIndices(area).length > 0;
  }

  /** True when a centred AABB would overlap geometry at (cx, cy). */
  isBoxBlocked(cx: number, cy: number, halfWidth: number, halfHeight: number): boolean {
    return this.overlapsSolid(centeredBounds(cx, cy, halfWidth, halfHeight));
  }

  /**
   * First surface hit by the segment (x0,y0)->(x1,y1), or `null`.
   * Used for projectile travel; the arena shell guarantees a hit before the
   * world edge, so projectiles can never leave the map.
   */
  raycast(x0: number, y0: number, x1: number, y1: number): SurfaceHit | null {
    const area: Bounds = {
      left: Math.min(x0, x1),
      top: Math.min(y0, y1),
      right: Math.max(x0, x1),
      bottom: Math.max(y0, y1),
    };

    const candidates = this.querySurfaceIndices(area);
    let closest: SurfaceHit | null = null;

    for (let i = 0; i < candidates.length; i++) {
      const index = candidates[i]!;
      const hit = segmentVsBounds(x0, y0, x1, y1, this.surfaceBounds[index]!);
      if (hit && (closest === null || hit.t < closest.t)) {
        closest = { ...hit, surface: this.surfaces[index]! };
      }
    }

    return closest;
  }

  private clampColumn(column: number): number {
    return column < 0 ? 0 : column >= this.columns ? this.columns - 1 : column;
  }

  private clampRow(row: number): number {
    return row < 0 ? 0 : row >= this.rows ? this.rows - 1 : row;
  }
}

function ascending(a: number, b: number): number {
  return a - b;
}

const cache = new Map<string, CollisionWorld>();

/** Arenas are immutable, so one collision world per arena id is enough. */
export function getCollisionWorld(arena: ArenaDefinition): CollisionWorld {
  let world = cache.get(arena.id);
  if (!world) {
    world = new CollisionWorld(arena);
    cache.set(arena.id, world);
  }
  return world;
}
