import { Schema, type } from "@colyseus/schema";
import type { SyncedProjectile } from "@deathmatch/shared";

/**
 * A live projectile. The server owns every field; clients only render them
 * (extrapolating between the 20Hz patches using the synchronised velocity).
 */
export class ProjectileState extends Schema implements SyncedProjectile {
  @type("string") id = "";

  /** Session id of the shooter. Used to skip self-collision and to attribute kills. */
  @type("string") ownerId = "";

  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") velocityX = 0;
  @type("float32") velocityY = 0;

  /** Damage this projectile will apply on hit. Server-decided, never client-supplied. */
  @type("uint16") damage = 0;

  /** Server timestamp (ms) at spawn; used for lifetime and client-side trail fade. */
  @type("number") createdAt = 0;

  /** Which weapon fired it -- lets the client pick the right visual style. */
  @type("string") weaponId = "";
}
