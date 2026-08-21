import {
  NETWORK,
  RATE_LIMITS,
  RateLimiterSet,
  createInputCommand,
  createMovementState,
  type InputCommand,
  type MovementState,
} from "@deathmatch/shared";

export type RateLimitKey = keyof typeof RATE_LIMITS;

/**
 * Server-only state for one connected player.
 *
 * None of this is synchronised. Keeping cooldowns, queues and anti-cheat budgets
 * off the wire is both a bandwidth win and a security property: a client cannot
 * observe (or spoof) the values its actions are validated against.
 */
export class PlayerRuntime {
  /** Authoritative movement state; mirrored into `PlayerState` after each step. */
  readonly movement: MovementState = createMovementState();

  /** Inputs received but not yet simulated, ordered by sequence number. */
  readonly inputQueue: InputCommand[] = [];

  /** Last simulated input; used for edge detection (semi-auto fire, reload press). */
  readonly lastInput: InputCommand = createInputCommand();

  /**
   * Token bucket bounding how many simulation steps this player may consume.
   * Refills at the simulation rate, so a modified client that floods inputs still
   * cannot move faster than real time -- it just burns through its burst allowance.
   */
  inputBudget: number = NETWORK.INPUT_BUDGET_BURST;

  /** Highest sequence number ever accepted; anything older is a replay and is dropped. */
  highestAcceptedSeq = 0;

  /**
   * Timestamp of the last shot, for fire-rate validation.
   * Starts at -Infinity so the first shot is always ready, whatever the clock's origin.
   */
  lastShotAt = Number.NEGATIVE_INFINITY;

  /** Timestamp at which an in-progress reload completes; 0 when not reloading. */
  reloadEndsAt = 0;

  /** Timestamp at which the active speed effect expires; 0 when none is active. */
  speedBoostEndsAt = 0;

  /** Spawn point index assigned for the current match. */
  spawnIndex = -1;

  readonly joinedAt: number;

  /** Per-message-type throttles for everything this connection sends. */
  readonly rateLimiters = new RateLimiterSet<RateLimitKey>(RATE_LIMITS);

  /** Set while the socket is gone and `allowReconnection` is pending. */
  awaitingReconnection = false;

  constructor(now: number) {
    this.joinedAt = now;
  }

  /** Drop queued inputs -- used on spawn and when a match ends. */
  clearInputs(): void {
    this.inputQueue.length = 0;
    this.inputBudget = NETWORK.INPUT_BUDGET_BURST;
  }

  resetForMatch(now: number): void {
    this.clearInputs();
    this.lastShotAt = Number.NEGATIVE_INFINITY;
    this.reloadEndsAt = 0;
    this.speedBoostEndsAt = 0;
    this.movement.speedMultiplier = 1;
    this.highestAcceptedSeq = 0;
    this.lastInput.seq = 0;
    this.lastInput.moveLeft = false;
    this.lastInput.moveRight = false;
    this.lastInput.jump = false;
    this.lastInput.fire = false;
    this.lastInput.reload = false;
    void now;
  }
}
