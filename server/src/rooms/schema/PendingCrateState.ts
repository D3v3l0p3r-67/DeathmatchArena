import { Schema, type } from "@colyseus/schema";
import type { SyncedPendingCrate } from "@deathmatch/shared";

/**
 * A crate that is about to land, and the spot it will land on.
 *
 * Exists so a crate never simply appears: the place is marked, the marking
 * builds, and only then does the crate arrive -- which turns "a crate spawned
 * over there" into a decision somebody had time to make.
 *
 * Entirely presentational on the client's side. Nothing collides with a warning,
 * nothing can be picked up from one, and the contents stay secret exactly as
 * they do for a sealed crate.
 */
export class PendingCrateState extends Schema implements SyncedPendingCrate {
  @type("string") id = "";

  /** Centre of the crate-to-be. */
  @type("float32") x = 0;
  @type("float32") y = 0;

  /** The size it will land at, so the marker matches what arrives. */
  @type("uint16") width = 0;
  @type("uint16") height = 0;

  /**
   * 0 when the warning starts, 1 the moment the crate lands.
   *
   * Sent as a fraction rather than a deadline so the client needs no clock
   * synchronisation to build the effect towards the arrival.
   */
  @type("float32") progress = 0;
}
