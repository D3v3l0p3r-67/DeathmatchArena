/**
 * The one piece of trap vocabulary the client shares.
 *
 * A trap's phase is synchronised, so it belongs to the network contract rather
 * than to the arena data model -- and it is what makes a trap readable: a player
 * has to be able to see the difference between a crusher that is winding up and
 * one that is about to flatten them.
 */
export const TrapPhase = {
  /** Dormant, waiting for whatever triggers it. */
  IDLE: "idle",
  /** Triggered and winding up. Harmless, but about to not be. */
  ARMING: "arming",
  /** Dangerous. */
  ACTIVE: "active",
  /** Spent, recovering before it can trigger again. */
  COOLDOWN: "cooldown",
} as const;

export type TrapPhaseValue = (typeof TrapPhase)[keyof typeof TrapPhase];
