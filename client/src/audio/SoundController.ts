import {
  MatchState,
  PowerUpType,
  getPowerUp,
  getWeapon,
  isMelee,
  type DamagePayload,
  type ExplosionPayload,
  type KillPayload,
  type MatchStateValue,
  type MeleeSwingPayload,
  type PowerUpCollectedPayload,
  type SyncedGameState,
  type SyncedPlayer,
  type SyncedProjectile,
  type SyncedTrap,
  TrapPhase,
} from "@deathmatch/shared";
import type { NetworkManager } from "../net/NetworkManager.js";
import type { AudioEngine } from "./AudioEngine.js";
import { SoundId } from "./sounds.js";

/** Per-weapon firing sounds, chosen from the weapon definition rather than by id. */
const RANGED_SHOT_BY_PELLETS = (pellets: number): string =>
  pellets > 1 ? SoundId.ShotgunShot : SoundId.RifleShot;

/** Which pickup sound a power-up type gets. */
const PICKUP_SOUND: Record<string, string> = {
  [PowerUpType.WEAPON]: SoundId.PickupWeapon,
  [PowerUpType.HEALTH]: SoundId.PickupHealth,
  [PowerUpType.SPEED]: SoundId.PickupSpeed,
  [PowerUpType.GRENADE]: SoundId.PickupGrenade,
};

/**
 * Turns game events into sound.
 *
 * Kept apart from the scene deliberately: rendering and audio react to the same
 * events but have nothing to say to each other, and a single place that knows
 * "this happened, so play that" is far easier to reason about than `play()`
 * calls sprinkled through the renderer.
 *
 * Everything here reads from state the server sent. Nothing decides anything.
 */
export class SoundController {
  /** Tracked so a change can be recognised as an event worth a sound. */
  private previousHealth = new Map<string, number>();
  private previousOnGround = new Map<string, boolean>();
  private previousJumps = new Map<string, number>();
  private previousReloading = false;
  private previousGrenadeSeconds = new Map<string, number>();
  private previousTrapPhases = new Map<string, string>();
  private wasShrinking = false;

  constructor(
    private readonly audio: AudioEngine,
    private readonly network: NetworkManager,
  ) {}

  /** Subscribe to everything worth hearing. */
  attach(): void {
    const events = this.network.events;

    events.on("projectileAdded", ({ projectile }) => this.onShot(projectile));
    events.on("projectileRemoved", ({ projectile }) => this.onProjectileGone(projectile));
    events.on("meleeSwing", (payload) => this.onMeleeSwing(payload));
    events.on("damage", (payload) => this.onDamage(payload));
    events.on("kill", (payload) => this.onKill(payload));
    events.on("crateDestroyed", (payload) => {
      this.audio.playAt(SoundId.CrateBreak, payload.x, payload.y);
    });
    events.on("powerUpCollected", (payload) => this.onPickup(payload));
    events.on("grenadeAdded", ({ grenade }) => {
      this.audio.playAt(SoundId.GrenadeThrow, grenade.x, grenade.y);
    });
    events.on("explosion", (payload) => this.onExplosion(payload));
    events.on("matchStateChanged", ({ matchState }) => this.onMatchState(matchState));
    events.on("countdownChanged", ({ seconds }) => {
      if (seconds > 0) this.audio.play(SoundId.CountdownTick);
    });
    events.on("patch", ({ state }) => this.onPatch(state));
  }

  /** Forget per-match state, so a new match does not inherit old comparisons. */
  reset(): void {
    this.previousHealth.clear();
    this.previousOnGround.clear();
    this.previousJumps.clear();
    this.previousGrenadeSeconds.clear();
    this.previousTrapPhases.clear();
    this.previousReloading = false;
    this.wasShrinking = false;
  }

  // -------------------------------------------------------------------------
  // Combat
  // -------------------------------------------------------------------------

  private onShot(projectile: SyncedProjectile): void {
    const weapon = getWeapon(projectile.weaponId);
    // Read from the definition, not from an id, so a new weapon sounds sensible
    // without a change here.
    const sound = RANGED_SHOT_BY_PELLETS(weapon.ranged?.pellets ?? 1);
    this.audio.playAt(sound, projectile.x, projectile.y);
  }

  private onProjectileGone(projectile: SyncedProjectile): void {
    this.audio.playAt(SoundId.BulletImpact, projectile.x, projectile.y, 0.7);
  }

  private onMeleeSwing(payload: MeleeSwingPayload): void {
    const player = this.network.state?.players.get(payload.sessionId);
    if (!player) return;

    const weapon = getWeapon(payload.weaponId);
    if (!isMelee(weapon)) return;

    this.audio.playAt(
      payload.connected ? SoundId.ChainsawHit : SoundId.ChainsawSwing,
      player.x,
      player.y,
    );
  }

  private onDamage(payload: DamagePayload): void {
    const local = this.network.sessionId;

    // Being hit is about you, so it plays unpositioned and at full volume.
    if (payload.victimId === local) this.audio.play(SoundId.Hurt);
    else this.audio.playAt(SoundId.FleshImpact, payload.x, payload.y);
  }

  private onKill(payload: KillPayload): void {
    const local = this.network.sessionId;
    const victim = this.network.state?.players.get(payload.victimId);

    if (victim) this.audio.playAt(SoundId.Death, victim.x, victim.y);
    // A distinct chime for a kill you scored, so it reads over the noise.
    if (payload.killerId === local && payload.victimId !== local) {
      this.audio.play(SoundId.KillConfirm);
    }
  }

  private onExplosion(payload: ExplosionPayload): void {
    this.audio.playAt(SoundId.Explosion, payload.x, payload.y);
  }

  private onPickup(payload: PowerUpCollectedPayload): void {
    const definition = getPowerUp(payload.powerUpId);
    const sound = definition ? PICKUP_SOUND[definition.type] : undefined;
    if (!sound) return;

    // Your own pickup is a personal event; someone else's is a world one.
    if (payload.sessionId === this.network.sessionId) this.audio.play(sound);
    else this.audio.playAt(sound, payload.x, payload.y, 0.6);
  }

  // -------------------------------------------------------------------------
  // Match
  // -------------------------------------------------------------------------

  private onMatchState(matchState: MatchStateValue): void {
    if (matchState === MatchState.PLAYING) {
      this.reset();
      this.audio.play(SoundId.MatchStart);
      return;
    }

    if (matchState === MatchState.FINISHED) {
      const local = this.network.state?.players.get(this.network.sessionId);
      const won = this.network.state?.winnerId === this.network.sessionId;
      this.audio.play(won ? SoundId.Victory : SoundId.Defeat);
      void local;
    }
  }

  /**
   * Derive the remaining sounds from state changes between patches.
   *
   * Jumping, landing, reloading, a ticking fuse and the walls starting to close
   * are all things the server never sends a message for — they are simply
   * visible in the state, so this is where they become audible.
   */
  private onPatch(state: SyncedGameState): void {
    const localId = this.network.sessionId;

    for (const [sessionId, player] of state.players) {
      if (!player.inMatch) continue;
      this.trackMovement(sessionId, player, sessionId === localId);
      this.previousHealth.set(sessionId, player.health);
    }

    this.trackReload(state.players.get(localId));
    this.trackGrenadeFuses(state);
    this.trackTraps(state);
    this.trackShrink(state);
  }

  private trackMovement(sessionId: string, player: SyncedPlayer, isLocal: boolean): void {
    const wasOnGround = this.previousOnGround.get(sessionId);
    const previousJumps = this.previousJumps.get(sessionId);

    // A jump is the allowance dropping, which distinguishes the mid-air jump
    // from the first one without needing an extra message.
    if (previousJumps !== undefined && player.jumpsRemaining < previousJumps && player.alive) {
      const midAir = !wasOnGround;
      this.audio.playAt(
        midAir ? SoundId.DoubleJump : SoundId.Jump,
        player.x,
        player.y,
        isLocal ? 1 : 0.7,
      );
    }

    if (wasOnGround === false && player.onGround && player.alive) {
      this.audio.playAt(SoundId.Land, player.x, player.y, isLocal ? 0.9 : 0.6);
    }

    this.previousOnGround.set(sessionId, player.onGround);
    this.previousJumps.set(sessionId, player.jumpsRemaining);
  }

  private trackReload(local: SyncedPlayer | undefined): void {
    const reloading = local?.reloading ?? false;
    if (reloading && !this.previousReloading) this.audio.play(SoundId.Reload);
    this.previousReloading = reloading;
  }

  /** One beep per second of remaining fuse, so a live grenade is audible. */
  private trackGrenadeFuses(state: SyncedGameState): void {
    for (const [id, grenade] of state.grenades) {
      const previous = this.previousGrenadeSeconds.get(id);
      if (previous !== undefined && grenade.fuseSeconds < previous) {
        this.audio.playAt(SoundId.GrenadeBeep, grenade.x, grenade.y, 0.8);
      }
      this.previousGrenadeSeconds.set(id, grenade.fuseSeconds);
    }

    for (const id of Array.from(this.previousGrenadeSeconds.keys())) {
      if (!state.grenades.has(id)) this.previousGrenadeSeconds.delete(id);
    }
  }

  /**
   * Warn, then hurt.
   *
   * Both phases get a sound because both matter: the wind-up is the only fair
   * warning a player gets, and it is often audible before the trap is on screen.
   */
  private trackTraps(state: SyncedGameState): void {
    for (const [id, trap] of state.traps) {
      const previous = this.previousTrapPhases.get(id);
      this.previousTrapPhases.set(id, trap.phase);
      // The first patch is the current state, not a transition.
      if (previous === undefined || previous === trap.phase) continue;

      if (trap.phase === TrapPhase.ARMING) this.playAtTrap(SoundId.TrapArm, trap, 0.9);
      else if (trap.phase === TrapPhase.ACTIVE) this.playAtTrap(SoundId.TrapFire, trap, 1);
    }

    for (const id of Array.from(this.previousTrapPhases.keys())) {
      if (!state.traps.has(id)) this.previousTrapPhases.delete(id);
    }
  }

  private playAtTrap(sound: string, trap: SyncedTrap, volume: number): void {
    this.audio.playAt(sound, trap.x + trap.width / 2, trap.y + trap.height / 2, volume);
  }

  private trackShrink(state: SyncedGameState): void {
    if (state.shrinking && !this.wasShrinking) this.audio.play(SoundId.ShrinkWarning);
    this.wasShrinking = state.shrinking;
  }
}
