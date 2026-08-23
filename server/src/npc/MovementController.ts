import {
  PLAYER_HALF_HEIGHT,
  PLAYER_HALF_WIDTH,
  clamp01,
  type CollisionWorld,
} from "@deathmatch/shared";
import type { PerceivedTrap, SelfContext } from "./context.js";
import type { NavGraph } from "./Navigation.js";

/** What the movement controller has been asked to do this tick. */
interface MovementIntent {
  /** -1, 0 or 1. */
  direction: number;
  /** Set for one tick to press jump. */
  jump: boolean;
  /** True while trying to fall through to a lower platform. */
  dropping: boolean;
}

/** How close counts as "arrived" at a waypoint, in px. */
const WAYPOINT_RADIUS = 26;
/** How long a bot may make no progress before it decides it is stuck, in ms. */
const STUCK_AFTER_MS = 700;
/** A waypoint this much higher has to be jumped to rather than walked to. */
const CLIMB_RISE = 24;
/** Closer than this to a ledge directly overhead and a jump only bumps your head. */
const UNDER_LEDGE = 34;
/** How much room to take before charging at it, in px. */
const RUN_UP_DISTANCE = 120;
/** Give up on a goal that has made no progress for this long, in ms. */
const ABANDON_AFTER_MS = 2600;
/** Beyond this, a goal with no route to it is treated as unreachable. */
const UNREACHABLE_DISTANCE = 220;
/** How far ahead to look for something dangerous, in px. */
const HAZARD_LOOKAHEAD = 130;
/** A hazard shorter than this can be jumped over rather than avoided. */
const HAZARD_CLEARABLE_HEIGHT = 46;
/** How close to a low hazard to leave the jump. Too early and you land in it. */
const HAZARD_JUMP_GAP = 55;

/**
 * The only thing that moves an NPC.
 *
 * It offers the same verbs a player has -- left, right, stop, jump, double jump,
 * drop -- and nothing else. There is no `setPosition`, no teleport and no
 * velocity nudge, because an NPC that could do any of those would stop being
 * bound by the same rules as the human it is playing against, and the whole
 * point of routing bots through the ordinary input queue is that they are.
 *
 * A jump is a *press*, not a state: the physics only starts a jump on the edge,
 * so the controller schedules a press and a release rather than holding the
 * button down, and a mid-air jump is a second press after a release. Getting
 * this wrong is how a bot ends up either never jumping or floating.
 */
export class MovementController {
  private intent: MovementIntent = { direction: 0, jump: false, dropping: false };

  /** Queued jump presses; each entry is a tick's worth of button state. */
  private jumpScript: boolean[] = [];

  /** Where we are trying to get to, and how. */
  private path: number[] = [];
  private pathIndex = 0;
  private goalX = 0;
  private goalY = 0;
  private hasGoal = false;

  private lastProgressAt = 0;
  private lastX = 0;
  private stuck = false;
  /** True while backing away from a ledge to get a run-up at it. */
  private runningUp = false;
  /** 0..1, from this bot's difficulty. See `setNavigationSkill`. */
  private navigationSkill = 1;

  constructor(
    private graph: NavGraph,
    private world: CollisionWorld,
  ) {}

  /**
   * Learn a different arena.
   *
   * A room rotates maps between matches, and a bot steering by the last one's
   * navigation graph would walk confidently into walls. Everything in flight is
   * dropped with it: a path through geometry that no longer exists is worse than
   * no path at all.
   */
  retarget(graph: NavGraph, world: CollisionWorld): void {
    this.graph = graph;
    this.world = world;
    this.clearGoal();
    this.stop();
  }

  // -------------------------------------------------------------------------
  // The verbs
  // -------------------------------------------------------------------------

  moveLeft(): void {
    this.intent.direction = -1;
  }

  moveRight(): void {
    this.intent.direction = 1;
  }

  stop(): void {
    this.intent.direction = 0;
  }

  /** One press, released next tick so the edge is unambiguous. */
  jump(): void {
    if (this.jumpScript.length === 0) this.jumpScript = [true, false];
  }

  /** Press, release, press: the second one is the mid-air jump. */
  doubleJump(): void {
    if (this.jumpScript.length === 0) this.jumpScript = [true, false, true, false];
  }

  /** Walk off the edge rather than jumping over it. */
  dropDown(): void {
    this.intent.dropping = true;
  }

  // -------------------------------------------------------------------------
  // Going somewhere
  // -------------------------------------------------------------------------

  get goal(): { x: number; y: number } | null {
    return this.hasGoal ? { x: this.goalX, y: this.goalY } : null;
  }

  get isStuck(): boolean {
    return this.stuck;
  }

  get pathLength(): number {
    return Math.max(0, this.path.length - this.pathIndex);
  }

  /**
   * Somewhere in the arena worth walking to.
   *
   * Picked from the navigation graph rather than by adding a random offset to
   * the current position: a bot wandering by offsets stays in the corner it
   * started in, which is exactly what stops an arena full of them from ever
   * meeting. Biased away from where the bot already is, so a "search" actually
   * covers ground.
   */
  wanderTarget(random: () => number, fromX: number, fromY: number): { x: number; y: number } | null {
    const nodes = this.graph.nodes;
    if (nodes.length === 0) return null;

    let best: { x: number; y: number } | null = null;
    let bestScore = -Infinity;

    // A handful of candidates, the furthest of which wins. Cheap, and enough
    // randomness that two bots do not pick the same corner.
    for (let i = 0; i < 6; i++) {
      const node = nodes[Math.floor(random() * nodes.length)]!;
      const score = Math.hypot(node.x - fromX, node.y - fromY) * (0.6 + random() * 0.8);
      if (score > bestScore) {
        bestScore = score;
        best = { x: node.x, y: node.y };
      }
    }

    return best;
  }

  clearGoal(): void {
    this.hasGoal = false;
    this.path = [];
    this.pathIndex = 0;
  }

  /**
   * Head for a world position.
   *
   * The path is only recomputed when it needs to be -- the goal moved a long way,
   * there is no path yet, or we stopped making progress. Pathfinding on every
   * brain tick for every bot is the classic way to make AI look expensive when
   * it is really just wasteful.
   */
  /**
   * How well this bot reads the arena, 0..1. Comes from its difficulty.
   *
   * It buys two things a better player has: seeing further ahead, and noticing
   * sooner that what you are doing is not working. It buys no extra information
   * -- the hazards it looks at are the ones it can already perceive.
   */
  setNavigationSkill(skill: number): void {
    this.navigationSkill = clamp01(skill);
  }

  /** How far ahead this bot looks for something dangerous, in px. */
  private get hazardLookahead(): number {
    return HAZARD_LOOKAHEAD * (0.35 + 0.65 * this.navigationSkill);
  }

  /** How long it flails before deciding it is stuck, in ms. */
  private get stuckAfterMs(): number {
    return STUCK_AFTER_MS / Math.max(0.2, 0.4 + 0.6 * this.navigationSkill);
  }

  private get abandonAfterMs(): number {
    return ABANDON_AFTER_MS / Math.max(0.2, 0.4 + 0.6 * this.navigationSkill);
  }

  setGoal(x: number, y: number, self: SelfContext, now: number): void {
    const moved = !this.hasGoal || Math.hypot(x - this.goalX, y - this.goalY) > 90;

    this.goalX = x;
    this.goalY = y;
    this.hasGoal = true;

    if (moved || this.path.length === 0 || this.stuck) {
      this.recomputePath(self, now);
    }
  }

  private recomputePath(self: SelfContext, now: number): void {
    const from = this.graph.nearest(self.x, self.y);
    const to = this.graph.nearest(this.goalX, this.goalY);

    this.path = this.graph.findPath(from, to);
    this.pathIndex = 0;
    this.stuck = false;
    this.runningUp = false;
    this.lastProgressAt = now;
    this.lastX = self.x;

    // No route, and too far to just walk at it. Steering straight at something
    // unreachable is what makes a bot pace back and forth under a ledge for the
    // rest of the match; dropping the goal lets the brain pick something it can
    // actually do.
    const straightLine = Math.hypot(this.goalX - self.x, this.goalY - self.y);
    if (this.path.length === 0 && straightLine > UNREACHABLE_DISTANCE) {
      this.clearGoal();
    }
  }

  /**
   * Turn the goal into this tick's movement.
   *
   * Called every physics tick, not every brain tick: steering has to be smooth
   * even though deciding where to go happens eight times a second.
   */
  steer(self: SelfContext, now: number, hazards: readonly PerceivedTrap[] = []): void {
    if (!this.hasGoal) return;

    const waypoint = this.nextWaypoint(self);
    const rise = self.y - waypoint.y;
    const dx = waypoint.x - self.x;

    // Standing directly under a ledge and jumping only bumps your head. Back off
    // far enough to jump *across* onto it -- which is what a person does, and
    // without it a bot simply cannot climb at all.
    //
    // The flag matters as much as the distance: without it the bot backs off to
    // the threshold, immediately approaches again, and oscillates on the spot
    // for the rest of the match instead of ever jumping.
    if (rise > CLIMB_RISE && self.onGround) {
      if (Math.abs(dx) < UNDER_LEDGE) this.runningUp = true;
      else if (Math.abs(dx) > RUN_UP_DISTANCE) this.runningUp = false;
    } else {
      this.runningUp = false;
    }

    if (this.runningUp) {
      if (dx >= 0) this.moveLeft();
      else this.moveRight();
      this.trackProgress(self, now);
      return;
    }

    if (Math.abs(dx) > WAYPOINT_RADIUS) {
      if (dx > 0) this.moveRight();
      else this.moveLeft();
    } else if (Math.abs(this.goalX - self.x) <= WAYPOINT_RADIUS) {
      this.stop();
    }

    this.considerJump(self, waypoint, rise, dx);
    this.avoidHazards(self, hazards);
    this.trackProgress(self, now);
  }

  /**
   * Do not walk into the fire.
   *
   * Dodging is the brain's job once a trap is close enough to be frightening;
   * this is the smaller, duller thing that has to happen first -- noticing that
   * the route ahead runs through something that is currently lethal. Without it
   * bots march into spikes on the way to somewhere else and a match full of them
   * is over in seconds.
   *
   * Low hazards are hopped; anything too tall to clear turns the bot round and
   * drops the goal, so the brain picks a different plan on its next thought.
   */
  private avoidHazards(self: SelfContext, hazards: readonly PerceivedTrap[]): void {
    if (this.intent.direction === 0 || hazards.length === 0) return;

    const hazard = this.hazardAhead(self, hazards);
    if (!hazard) return;

    if (hazard.height <= HAZARD_CLEARABLE_HEIGHT) {
      // Leave the jump late. Jumping the moment a strip of spikes comes into
      // view carries the bot over the near edge and down into the middle of it,
      // which is worse than not jumping at all.
      const leading = self.x + Math.sign(this.intent.direction) * PLAYER_HALF_WIDTH;
      const nearEdge = this.intent.direction > 0 ? hazard.x : hazard.x + hazard.width;
      if (self.onGround && Math.abs(nearEdge - leading) <= HAZARD_JUMP_GAP) this.jump();
      return;
    }

    // Too tall to jump: back away from it and let the brain reconsider.
    this.intent.direction = -this.intent.direction;
    this.clearGoal();
  }

  /** The first live hazard sitting in the direction of travel. */
  private hazardAhead(self: SelfContext, hazards: readonly PerceivedTrap[]): PerceivedTrap | null {
    const from = self.x - PLAYER_HALF_WIDTH;
    const to = self.x + PLAYER_HALF_WIDTH + this.intent.direction * this.hazardLookahead;

    const left = Math.min(from, to);
    const right = Math.max(from, to);
    const top = self.y - PLAYER_HALF_HEIGHT;
    const bottom = self.y + PLAYER_HALF_HEIGHT;

    for (const hazard of hazards) {
      if (!hazard.hot) continue;
      if (hazard.x + hazard.width < left || hazard.x > right) continue;
      if (hazard.y + hazard.height < top || hazard.y > bottom) continue;
      return hazard;
    }

    return null;
  }

  /**
   * The point currently being walked towards.
   *
   * Waypoints are consumed as they are reached, and when there is no path at all
   * the goal itself is the waypoint -- steering straight at something is usually
   * right when it is close, and is always better than standing still.
   */
  private nextWaypoint(self: SelfContext): { x: number; y: number; kind: string } {
    while (this.pathIndex < this.path.length) {
      const node = this.graph.nodes[this.path[this.pathIndex]!];
      if (!node) break;

      const reached = Math.abs(node.x - self.x) < WAYPOINT_RADIUS && Math.abs(node.y - self.y) < 70;
      if (!reached) {
        const previous = this.path[this.pathIndex - 1];
        const kind = previous !== undefined ? this.graph.linkKind(previous, node.index) : null;
        return { x: node.x, y: node.y, kind: kind ?? "walk" };
      }
      this.pathIndex++;
    }

    return { x: this.goalX, y: this.goalY, kind: "walk" };
  }

  /**
   * Decide whether this step needs air.
   *
   * Three reasons to jump, in the order they matter: the next waypoint is above
   * us, something solid is directly in the way, or we have stopped getting
   * anywhere and a hop is the cheapest thing to try.
   */
  private considerJump(
    self: SelfContext,
    waypoint: { x: number; y: number; kind: string },
    rise: number,
    dx: number,
  ): void {
    if (!self.onGround && self.jumpsRemaining <= 0) return;

    if (this.intent.dropping) {
      this.intent.dropping = false;
      return;
    }

    if (rise > CLIMB_RISE && Math.abs(dx) < 420) {
      // High enough to need the second jump, or close enough for one.
      if (rise > 150 && self.onGround) this.doubleJump();
      else this.jump();
      return;
    }

    if (this.intent.direction !== 0 && self.onGround && this.blockedAhead(self)) {
      this.jump();
      return;
    }

    if (this.stuck && self.onGround) this.doubleJump();
  }

  /** Something solid at knee height in the direction of travel. */
  private blockedAhead(self: SelfContext): boolean {
    const probeX = self.x + this.intent.direction * (PLAYER_HALF_WIDTH + 10);
    return this.world.isBoxBlocked(probeX, self.y - 6, PLAYER_HALF_WIDTH * 0.8, PLAYER_HALF_HEIGHT * 0.6);
  }

  private trackProgress(self: SelfContext, now: number): void {
    if (Math.abs(self.x - this.lastX) > 12) {
      this.lastX = self.x;
      this.lastProgressAt = now;
      this.stuck = false;
      return;
    }

    // Standing still counts as no progress too. Only checking while actively
    // walking let a bot that had stopped short of an unreachable goal stay
    // there indefinitely, which looks exactly like a hung process.
    const arrived = Math.hypot(this.goalX - self.x, this.goalY - self.y) <= WAYPOINT_RADIUS * 2;
    if (arrived) {
      this.lastProgressAt = now;
      return;
    }

    const stalled = now - this.lastProgressAt;
    if (stalled > this.stuckAfterMs) this.stuck = true;

    // Somewhere genuinely unreachable. Dropping the goal lets the brain choose
    // something else next time it thinks, rather than leaving a bot pressed
    // against the underside of a platform for the rest of the match.
    if (stalled > this.abandonAfterMs) {
      this.clearGoal();
      this.stop();
      this.lastProgressAt = now;
    }
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /** Consume this tick's intent into the three movement buttons. */
  takeButtons(): { moveLeft: boolean; moveRight: boolean; jump: boolean } {
    const jump = this.jumpScript.length > 0 ? this.jumpScript.shift()! : false;

    const buttons = {
      moveLeft: this.intent.direction < 0,
      moveRight: this.intent.direction > 0,
      jump,
    };

    // The direction persists between physics ticks -- it is only re-decided when
    // the brain runs -- but a jump press is consumed.
    return buttons;
  }

  reset(): void {
    this.intent = { direction: 0, jump: false, dropping: false };
    this.jumpScript = [];
    this.clearGoal();
    this.stuck = false;
    this.runningUp = false;
  }
}
