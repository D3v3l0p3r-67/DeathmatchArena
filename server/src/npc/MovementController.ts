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
/** How far above a ledge to aim, so a landing is a landing and not a scrape. */
const JUMP_CLEARANCE = 14;
/** How high to try when nothing is working and a jump is the cheapest guess. */
const STUCK_HOP = 200;
/** Beyond this, a goal with no route to it is treated as unreachable. */
const UNREACHABLE_DISTANCE = 220;
/** How long an abandoned goal stays refused, in ms. */
const FAILED_GOAL_MS = 3500;
/** A new goal this close to a recently failed one is the same goal. */
const FAILED_GOAL_RADIUS = 80;
/** Walls are re-planned around at most this often, in ms. */
const REPATH_COOLDOWN_MS = 450;
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
  /**
   * How a jump is being flown, tick by tick.
   *
   * A jump is not one button press: the height comes from *how long the button
   * is held*, and the mid-air jump needs a fresh press, which means a release
   * first. Scripting that as a fixed list of ticks made every bot jump a 35px
   * hop -- released on the very next tick, which is exactly the input the
   * variable-jump-height rule cuts short -- while the navigation graph was
   * linking ledges 138px up and pairs of jumps reaching 237px. Bots were
   * planning routes they physically could not fly.
   *
   * So it is a small state machine over what the body is actually doing, which
   * also means it needs no knowledge of gravity or jump strength: it holds while
   * it is still rising and still below where it is going, and it spends the
   * second jump at the apex, but only if it is not going to make it otherwise.
   */
  private jumpPhase: "idle" | "rising" | "release" | "airRising" = "idle";
  /** World Y this jump is trying to reach. Lower is higher. */
  private jumpTargetY = 0;
  /** Whether the mid-air jump may still be spent on this jump. */
  private airJumpAvailable = false;
  /** What the jump button should be doing this tick. */
  private jumpButton = false;

  /** Where we are trying to get to, and how. */
  private path: number[] = [];
  private pathIndex = 0;
  private goalX = 0;
  private goalY = 0;
  private hasGoal = false;

  private lastProgressAt = 0;
  private lastX = 0;
  private stuck = false;
  /**
   * Goals given up on, kept briefly so they are not immediately retried.
   *
   * The brain re-decides eight times a second, and an action that wants an
   * enemy's last-seen position will ask for it again on the very next thought.
   * Without this, "abandon the unreachable goal" lasts an eighth of a second
   * and a bot spends the rest of the memory window pressed against the wall
   * between it and a place it cannot get to.
   */
  private failedGoals: { x: number; y: number; until: number }[] = [];
  private lastWallRepathAt = 0;
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
    // Failures were failures *of that arena's geometry*; the coordinates mean
    // something else entirely in the next one.
    this.failedGoals.length = 0;
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

  /**
   * Jump, aiming to reach `targetY`.
   *
   * The height is flown rather than chosen: the button is held while the bot is
   * still rising and still below the target, so a low ledge costs a hop and a
   * high one costs a full jump. Ignored if a jump is already in the air.
   */
  jumpTo(targetY: number): void {
    if (this.jumpPhase !== "idle") return;

    this.jumpPhase = "rising";
    this.jumpTargetY = targetY;
    this.airJumpAvailable = true;
    this.jumpButton = true;
  }

  /** A hop with nothing particular to reach -- clearing a hazard, or unsticking. */
  jump(): void {
    this.jumpTo(Number.NEGATIVE_INFINITY);
  }

  /**
   * Fly the jump.
   *
   * Called every tick while a jump is in the air. The two interesting moments:
   * the release, which has to happen at the apex rather than earlier or the
   * ascent is cut short, and the second press, which is only spent when the apex
   * arrives with the target still out of reach.
   */
  private updateJump(self: SelfContext): void {
    if (this.jumpPhase === "idle") {
      this.jumpButton = false;
      return;
    }

    const rising = self.velocityY < 0;
    const belowTarget = self.y > this.jumpTargetY;

    switch (this.jumpPhase) {
      case "rising":
      case "airRising": {
        // Hold while it is still buying height. Letting go early is what the
        // variable-jump-height rule is for, and it costs two thirds of the jump.
        if (rising && belowTarget) {
          this.jumpButton = true;
          return;
        }

        const canReachHigher =
          this.jumpPhase === "rising" && this.airJumpAvailable && belowTarget && self.jumpsRemaining > 0;

        this.jumpButton = false;
        this.jumpPhase = canReachHigher ? "release" : "idle";
        return;
      }

      case "release": {
        // One tick of release, so the next press reads as a press. At the apex
        // this costs nothing: there is no ascent left to cut.
        this.airJumpAvailable = false;
        this.jumpButton = true;
        this.jumpPhase = "airRising";
        return;
      }
    }
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
    // A goal that was just abandoned as unreachable is not accepted back until
    // the arena has had a chance to change -- somebody moved, a trap cooled.
    // The refusal is what lets the brain's scoring actually move on.
    if (this.isFailedGoal(x, y, now)) {
      if (this.hasGoal && Math.hypot(this.goalX - x, this.goalY - y) <= FAILED_GOAL_RADIUS) {
        this.clearGoal();
        this.stop();
      }
      return;
    }

    const moved = !this.hasGoal || Math.hypot(x - this.goalX, y - this.goalY) > 90;

    this.goalX = x;
    this.goalY = y;
    this.hasGoal = true;

    // The progress clock starts with the goal, not with the plan. It used to
    // restart on every replan -- and a stuck bot replans constantly, so the
    // "give this up" deadline receded forever while the bot ground against
    // whatever it was stuck on.
    if (moved) {
      this.lastProgressAt = now;
      this.lastX = self.x;
    }

    if (moved || this.path.length === 0 || this.stuck) {
      this.recomputePath(self, now);
    }
  }

  private rememberFailure(now: number): void {
    if (!this.hasGoal) return;
    this.failedGoals.push({ x: this.goalX, y: this.goalY, until: now + FAILED_GOAL_MS });
    if (this.failedGoals.length > 4) this.failedGoals.shift();
  }

  private isFailedGoal(x: number, y: number, now: number): boolean {
    let alive = 0;
    for (const failed of this.failedGoals) {
      if (failed.until <= now) continue;
      this.failedGoals[alive++] = failed;
    }
    this.failedGoals.length = alive;

    return this.failedGoals.some(
      (failed) => Math.hypot(failed.x - x, failed.y - y) <= FAILED_GOAL_RADIUS,
    );
  }

  private recomputePath(self: SelfContext, now: number): void {
    const from = this.graph.nearest(self.x, self.y);
    const to = this.graph.nearest(this.goalX, this.goalY);

    this.path = this.graph.findPath(from, to);
    this.pathIndex = 0;
    this.stuck = false;
    this.runningUp = false;

    // No route, and too far to just walk at it. Steering straight at something
    // unreachable is what makes a bot pace back and forth under a ledge for the
    // rest of the match; dropping the goal -- and remembering it, so the brain
    // cannot hand it straight back -- lets it pick something it can actually do.
    const straightLine = Math.hypot(this.goalX - self.x, this.goalY - self.y);
    if (this.path.length === 0 && straightLine > UNREACHABLE_DISTANCE) {
      this.rememberFailure(now);
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

    this.considerJump(self, waypoint, rise, dx, now);
    this.avoidHazards(self, hazards);
    this.updateJump(self);
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
    now: number,
  ): void {
    if (!self.onGround && self.jumpsRemaining <= 0) return;

    if (this.intent.dropping) {
      this.intent.dropping = false;
      return;
    }

    if (rise > CLIMB_RISE && Math.abs(dx) < 420) {
      // Aim at the ledge itself, with a little clearance. How high that turns
      // out to be -- a hop, a full jump, or a jump and the mid-air one -- is
      // decided while flying it rather than guessed from a threshold here.
      this.jumpTo(waypoint.y - JUMP_CLEARANCE);
      return;
    }

    if (this.intent.direction !== 0 && self.onGround && this.blockedAhead(self)) {
      // Measure the wall before jumping at it. A blind maximum jump against
      // anything solid was the old answer, and against a wall taller than a
      // jump it produced the most recognisable form of stuck bot there is:
      // pressed against the face of it, leaping on the spot.
      const passY = this.clearanceAhead(self);
      if (passY !== null) this.jumpTo(passY - JUMP_CLEARANCE);
      else this.routeAroundWall(self, now);
      return;
    }

    if (this.stuck && self.onGround) this.jumpTo(self.y - STUCK_HOP);
  }

  /** Something solid at knee height in the direction of travel. */
  private blockedAhead(self: SelfContext): boolean {
    const probeX = self.x + this.intent.direction * (PLAYER_HALF_WIDTH + 10);
    return this.world.isBoxBlocked(probeX, self.y - 6, PLAYER_HALF_WIDTH * 0.8, PLAYER_HALF_HEIGHT * 0.6);
  }

  /**
   * The height at which the body would pass over what is directly ahead, or
   * null when no jump can fly that high.
   *
   * Probes upward with the same body-sized box `blockedAhead` used, against the
   * same climb ceiling the navigation graph built its links from -- so what
   * steering believes it can clear and what routes believe it can clear are the
   * same physics.
   */
  private clearanceAhead(self: SelfContext): number | null {
    const probeX = self.x + this.intent.direction * (PLAYER_HALF_WIDTH + 10);

    for (let rise = 24; rise <= this.graph.maxClimb; rise += 16) {
      const y = self.y - rise;
      if (!this.world.isBoxBlocked(probeX, y, PLAYER_HALF_WIDTH * 0.8, PLAYER_HALF_HEIGHT * 0.6)) {
        return y;
      }
    }

    return null;
  }

  /**
   * The wall ahead cannot be jumped: stop walking into it and find another way.
   *
   * Replans from where the bot actually is -- the graph knows routes over and
   * around -- and when there is none, gives the goal up *and remembers it*, so
   * the brain's next thought cannot immediately hand the same one back. Without
   * the memory this is a loop with a one-tick pause in it.
   */
  private routeAroundWall(self: SelfContext, now: number): void {
    if (now - this.lastWallRepathAt < REPATH_COOLDOWN_MS) return;
    this.lastWallRepathAt = now;

    this.recomputePath(self, now);

    // recomputePath keeps a close pathless goal on the theory that walking
    // straight at it will do. The wall in front of us is proof it will not.
    if (this.hasGoal && this.path.length === 0) {
      this.rememberFailure(now);
      this.clearGoal();
      this.stop();
    }
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
      this.rememberFailure(now);
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
    const buttons = {
      moveLeft: this.intent.direction < 0,
      moveRight: this.intent.direction > 0,
      jump: this.jumpButton,
    };

    // The direction persists between physics ticks -- it is only re-decided when
    // the brain runs -- but a jump press is consumed.
    return buttons;
  }

  reset(): void {
    this.intent = { direction: 0, jump: false, dropping: false };
    this.failedGoals.length = 0;
    this.lastWallRepathAt = 0;
    this.jumpPhase = "idle";
    this.jumpButton = false;
    this.airJumpAvailable = false;
    this.clearGoal();
    this.stuck = false;
    this.runningUp = false;
  }
}
