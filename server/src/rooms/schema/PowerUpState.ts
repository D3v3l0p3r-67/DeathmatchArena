import { Schema, type } from "@colyseus/schema";
import type { SyncedPowerUp } from "@deathmatch/shared";

/**
 * A power-up revealed by a broken crate, waiting on the ground to be collected.
 *
 * Only appears once the server has destroyed the crate that contained it, so its
 * existence is itself the reveal. `powerUpId` names a *definition* in the config
 * catalogue; the client uses it purely to pick an icon and a tint.
 */
export class PowerUpState extends Schema implements SyncedPowerUp {
  /** Entity id, unique per spawned pickup. */
  @type("string") id = "";

  /** Id of the power-up definition this pickup grants. */
  @type("string") powerUpId = "";

  @type("float32") x = 0;
  @type("float32") y = 0;
}
