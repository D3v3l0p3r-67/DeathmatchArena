import { Schema, type } from "@colyseus/schema";
import { TrapPhase, type SyncedTrap, type TrapPhaseValue } from "@deathmatch/shared";

/**
 * A trap, as clients see it.
 *
 * Position and size are synchronised because a trap can move, and `phase` is what
 * lets the client warn the player: an arming crusher looks different from an
 * active one, and that difference is the whole reason a trap is fair.
 *
 * What is *not* here is anything that decides damage. The server owns activation,
 * overlap and damage entirely; this is a description of what to draw.
 */
export class TrapState extends Schema implements SyncedTrap {
  @type("string") id = "";

  /** Trap type id, so the client can pick the right look from the catalogue. */
  @type("string") trapType = "";

  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("uint16") width = 0;
  @type("uint16") height = 0;

  /** One of TrapPhase. A string so it reads plainly in the Colyseus monitor. */
  @type("string") phase: TrapPhaseValue = TrapPhase.IDLE;
}
