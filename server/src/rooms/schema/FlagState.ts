import { Schema, type } from "@colyseus/schema";
import type { SyncedFlag } from "@deathmatch/shared";

/**
 * A flag lying in the arena.
 *
 * Fully synchronised, because unlike a crate a flag hides nothing: what it is
 * worth (one flag) is the whole story. Who may take it is still decided only
 * on the server -- see `FlagSystem.collect`.
 */
export class FlagState extends Schema implements SyncedFlag {
  @type("string") id = "";

  @type("float32") x = 0;
  @type("float32") y = 0;

  /** True when this fell out of somebody rather than spawning fresh. */
  @type("boolean") dropped = false;
}
