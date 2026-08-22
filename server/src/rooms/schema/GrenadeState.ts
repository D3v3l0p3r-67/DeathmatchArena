import { Schema, type } from "@colyseus/schema";
import type { SyncedGrenade } from "@deathmatch/shared";

/**
 * A grenade in flight, as clients see it.
 *
 * Position and velocity are here so clients can extrapolate between the 20 Hz
 * patches; the fuse is sent as whole seconds so it changes once a second rather
 * than every tick. What is *not* here is anything a client could act on: the
 * blast is resolved entirely server-side when the fuse runs out.
 */
export class GrenadeState extends Schema implements SyncedGrenade {
  @type("string") id = "";

  /** Session id of the thrower. They are not immune to their own grenade. */
  @type("string") ownerId = "";

  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") velocityX = 0;
  @type("float32") velocityY = 0;

  /** Whole seconds left on the fuse, for the client's warning blink. */
  @type("uint8") fuseSeconds = 0;
}
