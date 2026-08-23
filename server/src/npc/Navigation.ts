import {
  PLAYER_HALF_HEIGHT,
  PLAYER_HALF_WIDTH,
  getPlayerConfig,
  type ArenaDefinition,
  type CollisionWorld,
  type PlayerConfig,
} from "@deathmatch/shared";

/** A place an NPC can stand: a point on top of something solid. */
export interface NavNode {
  index: number;
  x: number;
  y: number;
  /** Id of the element this node stands on, for grouping. */
  surfaceId: string;
  /**
   * True when this spot is inside a trap's reach.
   *
   * Not "impassable": an arena is allowed to put the only route through a fire
   * vent, and a bot that refused to move would be worse than one that takes a
   * risk. It is a cost, and the cost is high enough that any way round wins.
   */
  hazardous: boolean;
}

export type NavLinkKind = "walk" | "jump" | "drop";

/** How far around a trap a route should stay, in px. */
const HAZARD_MARGIN = 26;
/** What ending a step inside a trap's reach costs, in pixels of detour. */
const HAZARD_STANDING_COST = 1400;
/** What walking through one on the way costs. */
const HAZARD_CROSSING_COST = 1100;

export interface NavLink {
  to: number;
  kind: NavLinkKind;
  cost: number;
}

/**
 * Where an NPC can stand and how it can get between those places.
 *
 * Built once per arena, because an arena is static for the length of a match and
 * rebuilding this per bot per frame is exactly the kind of cost that makes AI
 * "too expensive". Links are classified by how they have to be travelled, and a
 * link only exists if the *configured* player movement can actually make it --
 * so lowering jump strength in the admin interface narrows the graph rather than
 * leaving bots hurling themselves at gaps they can no longer clear.
 */
export class NavGraph {
  readonly nodes: NavNode[] = [];
  readonly links: NavLink[][] = [];

  /** Trap rectangles, grown by a margin, that routes should avoid. */
  private readonly hazards: { left: number; right: number; top: number; bottom: number }[] = [];

  constructor(arena: ArenaDefinition, world: CollisionWorld, player: PlayerConfig) {
    this.collectHazards(arena);
    this.buildNodes(arena, world);
    this.buildLinks(player);
  }

  get size(): number {
    return this.nodes.length;
  }

  /** The standable node nearest a world point, or -1 when the graph is empty. */
  nearest(x: number, y: number): number {
    let best = -1;
    let bestCost = Infinity;

    for (const node of this.nodes) {
      // Vertical distance is weighted harder: the node under your feet is a far
      // better answer than one the same distance away but two floors up.
      const cost = Math.abs(node.x - x) + Math.abs(node.y - y) * 2.5;
      if (cost < bestCost) {
        bestCost = cost;
        best = node.index;
      }
    }

    return best;
  }

  /**
   * A* from one node to another.
   *
   * Returns the node indices to walk through, starting with `from`. Empty when
   * there is no route -- callers fall back to steering straight at the goal,
   * which is usually right when the goal is close and always better than
   * standing still.
   */
  findPath(from: number, to: number): number[] {
    if (from < 0 || to < 0 || from >= this.nodes.length || to >= this.nodes.length) return [];
    if (from === to) return [from];

    const open = new Set<number>([from]);
    const cameFrom = new Map<number, number>();
    const gScore = new Map<number, number>([[from, 0]]);
    const fScore = new Map<number, number>([[from, this.heuristic(from, to)]]);

    while (open.size > 0) {
      let current = -1;
      let bestF = Infinity;
      for (const candidate of open) {
        const score = fScore.get(candidate) ?? Infinity;
        if (score < bestF) {
          bestF = score;
          current = candidate;
        }
      }

      if (current === to) return this.reconstruct(cameFrom, current);
      open.delete(current);

      for (const link of this.links[current] ?? []) {
        const tentative = (gScore.get(current) ?? Infinity) + link.cost;
        if (tentative >= (gScore.get(link.to) ?? Infinity)) continue;

        cameFrom.set(link.to, current);
        gScore.set(link.to, tentative);
        fScore.set(link.to, tentative + this.heuristic(link.to, to));
        open.add(link.to);
      }
    }

    return [];
  }

  /** How a step between two nodes has to be travelled. */
  linkKind(from: number, to: number): NavLinkKind | null {
    return this.links[from]?.find((link) => link.to === to)?.kind ?? null;
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  /**
   * Sample the top of every solid thing.
   *
   * One node every 110px along each surface, plus both ends, which is fine
   * enough to route around an arena and coarse enough that the Foundry's forty-odd
   * platforms produce a couple of hundred nodes rather than thousands.
   */
  /**
   * Where the arena's traps are.
   *
   * Position rather than phase: spikes that are down now come back up, and a
   * route planned around the schedule would be a route planned around
   * information a bot has no business having. Standing *on* a trap is what the
   * plan avoids; reacting to one going off is perception's job, later and
   * separately.
   */
  private collectHazards(arena: ArenaDefinition): void {
    for (const trap of arena.traps) {
      if (!trap.enabled) continue;
      this.hazards.push({
        left: trap.x - HAZARD_MARGIN,
        right: trap.x + trap.width + HAZARD_MARGIN,
        // Generous upwards: a bot standing on the lip of a spike pit is close
        // enough to be caught by it.
        top: trap.y - PLAYER_HALF_HEIGHT * 2,
        bottom: trap.y + trap.height + HAZARD_MARGIN,
      });
    }
  }

  /** Is this point somewhere a trap can reach? */
  private isHazardous(x: number, y: number): boolean {
    for (const hazard of this.hazards) {
      if (x < hazard.left || x > hazard.right) continue;
      if (y < hazard.top || y > hazard.bottom) continue;
      return true;
    }
    return false;
  }

  /**
   * Does the straight line between two nodes pass over a trap?
   *
   * Sampled rather than solved: two nodes either side of a strip of spikes are
   * both perfectly safe, and only the walk between them is not.
   */
  private crossesHazard(a: NavNode, b: NavNode): boolean {
    if (this.hazards.length === 0) return false;

    const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 40));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (this.isHazardous(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return true;
    }
    return false;
  }

  private buildNodes(arena: ArenaDefinition, world: CollisionWorld): void {
    const spacing = 110;

    for (const element of arena.elements) {
      const top = element.y - PLAYER_HALF_HEIGHT - 1;
      if (top < PLAYER_HALF_HEIGHT) continue;

      const from = element.x + PLAYER_HALF_WIDTH;
      const to = element.x + element.width - PLAYER_HALF_WIDTH;
      if (to <= from) continue;

      const steps = Math.max(1, Math.round((to - from) / spacing));
      for (let i = 0; i <= steps; i++) {
        const x = from + ((to - from) * i) / steps;
        // Standing room only: a "surface" with something solid directly above it
        // is a crawlspace, not a place to be.
        if (world.isBoxBlocked(x, top, PLAYER_HALF_WIDTH, PLAYER_HALF_HEIGHT)) continue;

        this.nodes.push({
          index: this.nodes.length,
          x,
          y: top,
          surfaceId: element.id,
          hazardous: this.isHazardous(x, top),
        });
      }
    }
  }

  /**
   * Work out which pairs of nodes are actually connected, and how.
   *
   * The reach figures come from the configured movement, so this stays true
   * after a rebalance: raise gravity and the jump links thin out by themselves.
   */
  private buildLinks(player: PlayerConfig): void {
    const gravity = Math.max(1, player.gravity);
    const jumpSpeed = Math.abs(player.jumpVelocity);

    /*
     * How high one jump gets, and how much the mid-air jump adds on top.
     *
     * Deliberately short of the theoretical maximum. The second jump *replaces*
     * the current upward speed rather than adding to it, so its full value is
     * only available exactly at the apex -- and a bot flying a real arc, with a
     * tick of release in between, lands a little under that. Measured at 200px
     * against 138 for one jump; linking anything a bot cannot actually fly is
     * how a route becomes a bot pressed against the underside of a ledge.
     */
    const singleRise = (jumpSpeed * jumpSpeed) / (2 * gravity);
    const jumps = Math.max(1, Math.round(player.maxJumps));
    const maxRise = jumps > 1 ? singleRise * (1 + player.airJumpMultiplier ** 2 * 0.55) : singleRise;

    // Roughly how far you travel horizontally over a full jump arc.
    const airtime = (2 * jumpSpeed) / gravity;
    const maxReach = player.moveSpeed * airtime * (jumps > 1 ? 1.55 : 1);

    // A drop is only limited by how far sideways you can steer on the way down.
    const maxDropReach = maxReach * 1.2;

    for (let i = 0; i < this.nodes.length; i++) this.links.push([]);

    for (let i = 0; i < this.nodes.length; i++) {
      const a = this.nodes[i]!;

      for (let j = 0; j < this.nodes.length; j++) {
        if (i === j) continue;
        const b = this.nodes[j]!;

        const dx = Math.abs(b.x - a.x);
        // Positive means b is higher than a.
        const rise = a.y - b.y;

        if (a.surfaceId === b.surfaceId && Math.abs(rise) < 2 && dx <= 140) {
          this.links[i]!.push({ to: j, kind: "walk", cost: dx + this.hazardCost(a, b) });
          continue;
        }

        if (rise > 4) {
          // Climbing. Both the height and the gap have to be within reach.
          if (rise <= maxRise && dx <= maxReach) {
            this.links[i]!.push({
              to: j,
              kind: "jump",
              cost: dx + rise * 2 + 60 + this.hazardCost(a, b),
            });
          }
          continue;
        }

        // Level or downwards. A step across a gap still needs a hop.
        if (dx <= maxDropReach && -rise <= 2200) {
          const kind: NavLinkKind = rise < -4 ? "drop" : "jump";
          this.links[i]!.push({
            to: j,
            kind,
            cost:
              dx +
              Math.abs(rise) * 0.35 +
              (kind === "drop" ? 20 : 60) +
              this.hazardCost(a, b),
          });
        }
      }
    }
  }

  /**
   * What taking this link through a trap is worth avoiding.
   *
   * Priced in the same units as the rest of the graph -- pixels of travel -- so
   * a bot will happily walk the length of the arena rather than through the
   * spikes, and will still go through them when there is no other way at all.
   */
  private hazardCost(a: NavNode, b: NavNode): number {
    let cost = b.hazardous ? HAZARD_STANDING_COST : 0;
    if (this.crossesHazard(a, b)) cost += HAZARD_CROSSING_COST;
    return cost;
  }

  private heuristic(from: number, to: number): number {
    const a = this.nodes[from]!;
    const b = this.nodes[to]!;
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) * 1.4;
  }

  private reconstruct(cameFrom: Map<number, number>, current: number): number[] {
    const path = [current];
    while (cameFrom.has(current)) {
      current = cameFrom.get(current)!;
      path.unshift(current);
    }
    return path;
  }
}

/**
 * One graph per arena *and* per movement tuning.
 *
 * Keyed on both because the links depend on how far a player can jump: retuning
 * gravity through the admin interface has to produce a new graph, not a stale
 * one full of jumps nobody can make any more.
 */
const cache = new WeakMap<ArenaDefinition, Map<string, NavGraph>>();

export function getNavGraph(
  arena: ArenaDefinition,
  world: CollisionWorld,
  player: PlayerConfig = getPlayerConfig(),
): NavGraph {
  let byTuning = cache.get(arena);
  if (!byTuning) {
    byTuning = new Map();
    cache.set(arena, byTuning);
  }

  const key = `${player.gravity}:${player.jumpVelocity}:${player.moveSpeed}:${player.maxJumps}:${player.airJumpMultiplier}`;
  let graph = byTuning.get(key);
  if (!graph) {
    graph = new NavGraph(arena, world, player);
    byTuning.set(key, graph);
  }

  return graph;
}
