import {
  FIXED_DELTA,
  MatchState,
  NETWORK,
  SIMULATION_HZ,
  stepPlayerMovement,
  type CollisionWorld,
  type InputCommand,
} from "@deathmatch/shared";
import type { PlayerRuntime } from "../rooms/PlayerRuntime.js";
import type { RoomContext } from "../rooms/RoomContext.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";
import type { WeaponSystem } from "./WeaponSystem.js";

/**
 * Authoritative player movement.
 *
 * Simulation is *input-driven*: one queued input command advances that player by
 * exactly one fixed step. This is what makes client prediction exact -- the client
 * ran the same `stepPlayerMovement` with the same command and the same dt, so
 * replaying unacknowledged inputs reproduces the server's result precisely.
 *
 * Two safeguards keep that from becoming an exploit:
 *   1. A token bucket (`inputBudget`) refills at the simulation rate, so a client
 *      that floods inputs cannot make its character move faster than real time.
 *   2. Sequence numbers must strictly increase, so replayed packets are ignored.
 */
export class MovementSystem {
  constructor(
    private readonly context: RoomContext,
    private readonly world: CollisionWorld,
    private readonly weapons: WeaponSystem,
  ) {}

  /**
   * Queue a validated input command. Returns false when it was rejected
   * (out of order, or the queue is saturated).
   */
  enqueue(runtime: PlayerRuntime, input: InputCommand): boolean {
    if (input.seq <= runtime.highestAcceptedSeq) return false;
    if (runtime.inputQueue.length >= NETWORK.MAX_QUEUED_INPUTS) {
      // The client is far ahead of us; drop the oldest so it stays responsive
      // rather than accumulating unbounded latency.
      runtime.inputQueue.shift();
    }
    runtime.highestAcceptedSeq = input.seq;
    runtime.inputQueue.push(input);
    return true;
  }

  /** Advance every player by as many queued inputs as their budget allows. */
  update(dt: number, now: number): void {
    const playing = this.context.state.matchState === MatchState.PLAYING;

    for (const [sessionId, player] of this.context.state.players) {
      const runtime = this.context.runtimes.get(sessionId);
      if (!runtime) continue;

      // Refill the movement budget in step with real time.
      runtime.inputBudget = Math.min(
        NETWORK.INPUT_BUDGET_BURST,
        runtime.inputBudget + dt * SIMULATION_HZ,
      );

      if (!playing || !player.alive || !player.inMatch) {
        runtime.clearInputs();
        continue;
      }

      this.simulatePlayer(player, runtime, now);
      this.writeBack(player, runtime);
    }
  }

  private simulatePlayer(player: PlayerState, runtime: PlayerRuntime, now: number): void {
    while (runtime.inputQueue.length > 0 && runtime.inputBudget >= 1) {
      const input = runtime.inputQueue.shift()!;
      runtime.inputBudget -= 1;

      // Movement and weapons advance together so a shot is fired from the exact
      // position the player occupied on that tick.
      stepPlayerMovement(runtime.movement, input, FIXED_DELTA, this.world);
      player.aimAngle = input.aimAngle;
      this.weapons.processInput(player, runtime, input, now);

      copyInput(input, runtime.lastInput);
      player.lastProcessedInput = input.seq;

      if (!player.alive) break;
    }
  }

  /** Mirror the authoritative movement state into the synchronised schema. */
  private writeBack(player: PlayerState, runtime: PlayerRuntime): void {
    const movement = runtime.movement;
    player.x = movement.x;
    player.y = movement.y;
    player.velocityX = movement.velocityX;
    player.velocityY = movement.velocityY;
    player.onGround = movement.onGround;
    player.facing = movement.facing;
  }
}

function copyInput(source: InputCommand, target: InputCommand): void {
  target.seq = source.seq;
  target.moveLeft = source.moveLeft;
  target.moveRight = source.moveRight;
  target.jump = source.jump;
  target.fire = source.fire;
  target.reload = source.reload;
  target.aimAngle = source.aimAngle;
}
