import { Schema, type } from "@colyseus/schema";
import type { SyncedCrate } from "@deathmatch/shared";

/**
 * A breakable power-up crate, as clients see it.
 *
 * The power-up inside is deliberately **not** here. It is held server-side in the
 * power-up system and only becomes a synchronised entity once the crate breaks,
 * so no client can look inside a crate it has not opened.
 */
export class CrateState extends Schema implements SyncedCrate {
  @type("string") id = "";

  @type("float32") x = 0;
  @type("float32") y = 0;

  @type("uint16") width = 0;
  @type("uint16") height = 0;

  /** Remaining hit points; the client renders a damage state from this. */
  @type("uint16") health = 0;
  @type("uint16") maxHealth = 0;
}
