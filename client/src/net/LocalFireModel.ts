import {
  FIXED_DELTA_MS,
  getFireIntervalMs,
  getReloadDurationMs,
  getWeapon,
  isMelee,
  usesAmmo,
  type InputCommand,
  type SyncedPlayer,
  type WeaponDefinition,
} from "@deathmatch/shared";

/** One shot the model believes the server will also fire. */
export interface PredictedShot {
  /** The input tick the shot fires on, for replay during reconciliation. */
  seq: number;
  aimAngle: number;
  /** The weapon's recoil at the moment of firing, captured so a later weapon
   *  swap cannot rewrite the kick of a shot already taken. */
  recoilForce: number;
  /** Pellet count, so the local muzzle flash stacks exactly as the
   *  projectile-driven one does for everybody else. */
  pellets: number;
  weaponId: string;
}

/**
 * A client-side mirror of the server's fire gate, for the local player only.
 *
 * The server decides what a shot *does* -- damage, projectiles, ammunition are
 * authoritative there and stay there. What this predicts is *whether the server
 * will say yes*, so the two things a player feels on the trigger can happen
 * immediately instead of a round trip later: the recoil shove (fed into
 * movement prediction) and the muzzle feedback (flash, kick, sound).
 *
 * It runs the same gate as the server's WeaponSystem -- alive, not reloading,
 * ammunition in the magazine, fire-rate cooldown elapsed, fresh trigger pull for
 * semi-automatics -- against the same weapon definition, advanced one fixed tick
 * per input exactly as the server drains one input per tick. Time is measured in
 * simulation ticks rather than the wall clock, so the model cannot drift with
 * frame-rate hiccups; the server measures real time, so the two can disagree by
 * a tick around the edges of a cooldown. That is fine: a mispredicted shot is
 * one reconciliation correction, which is what *every* shot cost before this
 * model existed.
 *
 * Self-healing: each patch, `reconcile` rebuilds the magazine from the server's
 * count minus the predicted shots the server has not simulated yet, so a wrong
 * guess (or an ammunition refill the model cannot see) is corrected within one
 * patch instead of compounding.
 */
export class LocalFireModel {
  /** Simulation time, advanced one fixed step per predicted input. */
  private simMs = 0;
  private lastShotAtMs = Number.NEGATIVE_INFINITY;
  private weaponId = "";
  private ammo = 0;
  private reloading = false;
  private reloadEndsAtMs = 0;
  private lastFire = false;
  private lastReload = false;

  /** Shots predicted but not yet covered by an acknowledged input. */
  private readonly unacked: PredictedShot[] = [];

  /** Predicted shots the server has not confirmed yet, oldest first. */
  get pendingShots(): readonly PredictedShot[] {
    return this.unacked;
  }

  /** Adopt the authoritative state wholesale. Used on spawn and match start. */
  reset(player: SyncedPlayer): void {
    this.weaponId = player.weaponId;
    this.ammo = player.ammo;
    this.reloading = player.reloading;
    this.reloadEndsAtMs = 0;
    this.lastShotAtMs = Number.NEGATIVE_INFINITY;
    this.simMs = 0;
    this.lastFire = false;
    this.lastReload = false;
    this.unacked.length = 0;
  }

  /**
   * Advance one predicted tick. Returns the shot if the server will fire one
   * for this input, or null.
   *
   * Mirrors WeaponSystem.processInput for ranged weapons. Melee is not
   * predicted: a swing has no recoil and its feedback is the arc the server
   * broadcasts.
   */
  advance(input: InputCommand): PredictedShot | null {
    this.simMs += FIXED_DELTA_MS;

    const weaponId = this.weaponId;
    const shot = weaponId ? this.tryFire(input, weaponId) : null;

    // The server compares against the *previous* input for edge detection, so
    // these update after the gate whatever it decided.
    this.lastFire = input.fire;
    this.lastReload = input.reload;
    return shot;
  }

  private tryFire(input: InputCommand, weaponId: string): PredictedShot | null {
    const weapon = getWeapon(weaponId);
    const ammoLimited = usesAmmo(weapon);

    // Finish a reload whose deadline has passed, exactly as the server does
    // before considering the trigger.
    if (this.reloading && this.simMs >= this.reloadEndsAtMs) {
      this.ammo = weapon.magazineSize;
      this.reloading = false;
    }

    // Reload on a fresh key press only.
    if (input.reload && !this.lastReload && ammoLimited) this.tryStartReload(weapon);

    if (!input.fire) return null;
    if (!weapon.automatic && this.lastFire) return null;
    if (isMelee(weapon)) return null;
    if (this.reloading) return null;

    if (ammoLimited && this.ammo <= 0) {
      this.tryStartReload(weapon);
      return null;
    }

    if (this.simMs - this.lastShotAtMs < getFireIntervalMs(weapon)) return null;

    this.lastShotAtMs = this.simMs;
    if (ammoLimited) this.ammo -= 1;
    if (ammoLimited && this.ammo === 0) this.tryStartReload(weapon);

    const shot: PredictedShot = {
      seq: input.seq,
      aimAngle: input.aimAngle,
      recoilForce: weapon.recoilForce,
      pellets: Math.max(1, weapon.ranged?.pellets ?? 1),
      weaponId,
    };
    this.unacked.push(shot);
    return shot;
  }

  private tryStartReload(weapon: WeaponDefinition): void {
    if (this.reloading) return;
    if (this.ammo >= weapon.magazineSize) return;
    this.reloading = true;
    // Proportional to what is missing, mirroring the server -- see
    // getReloadDurationMs.
    this.reloadEndsAtMs = this.simMs + getReloadDurationMs(weapon, this.ammo);
  }

  /**
   * Fold the authoritative weapon state back in. Call once per patch, before
   * replaying pending inputs, so `pendingShots` holds only unacknowledged shots.
   */
  reconcile(player: SyncedPlayer): void {
    // Drop everything the server has already simulated -- confirmed or not,
    // its effect is inside the authoritative state now.
    while (this.unacked.length > 0 && this.unacked[0]!.seq <= player.lastProcessedInput) {
      this.unacked.shift();
    }

    if (player.weaponId !== this.weaponId) {
      // A pickup or respawn re-equipped us server-side. Shots predicted with
      // the old weapon are stale; adopt the new state wholesale.
      this.weaponId = player.weaponId;
      this.ammo = player.ammo;
      this.reloading = player.reloading;
      this.reloadEndsAtMs = 0;
      this.lastShotAtMs = Number.NEGATIVE_INFINITY;
      this.unacked.length = 0;
      return;
    }

    // Server truth, minus the shots it has not seen yet. This also absorbs
    // refills the model cannot predict (ammunition power-ups) and any shot the
    // gate got wrong, within one patch.
    const weapon = getWeapon(this.weaponId);
    if (usesAmmo(weapon)) {
      const unseen = this.unacked.length;
      this.ammo = Math.min(Math.max(player.ammo - unseen, 0), weapon.magazineSize);
    }

    // With no shots in flight there is nothing the server is yet to learn, so
    // its view of the reload is simply the truth. (While shots are pending the
    // model may already be reloading off the back of one, so it keeps its own.)
    if (this.unacked.length === 0 && this.reloading !== player.reloading) {
      this.reloading = player.reloading;
      // Adopting a reload the model never started: it cannot know how far along
      // the server is, so assume the worst -- a full reload for however much is
      // actually missing, starting now. Firing resumes at the ammunition resync
      // above the moment the server actually finishes.
      this.reloadEndsAtMs = player.reloading ? this.simMs + getReloadDurationMs(weapon, this.ammo) : 0;
    }
  }
}
