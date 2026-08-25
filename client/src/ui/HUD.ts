import {
  MatchState,
  getPlayerConfig,
  clamp,
  getReloadDurationMs,
  getWeapon,
  isMelee,
  usesAmmo,
  type MatchStateValue,
  type SyncedPlayer,
} from "@deathmatch/shared";
import { query, requireElement, setText, toggleClass } from "./dom.js";

export interface HudSnapshot {
  player: SyncedPlayer | null;
  matchState: MatchStateValue;
  aliveCount: number;
  totalPlayers: number;
  /** Whole seconds until the arena starts closing; 0 once it has. */
  shrinkCountdownSeconds: number;
  shrinking: boolean;
}

/**
 * How full the ammo bar reads right now, 0..1.
 *
 * A free function rather than a method: `updateAmmo` draws the bar at this
 * width, and `updateReload` needs the exact same number as the sweep's
 * starting point, so the two must ask the one place rather than compute it
 * twice and risk drifting apart.
 */
function ammoRatio(player: SyncedPlayer, weapon: ReturnType<typeof getWeapon>): number {
  return clamp(player.ammo / Math.max(1, weapon.magazineSize), 0, 1);
}

/**
 * The in-game heads-up display.
 *
 * Renders health, ammunition, reload progress, survivors, kills, the current
 * weapon and the match state. Every value comes from server-synchronised state --
 * the HUD never computes anything authoritative, it only presents it.
 *
 * Grenades are deliberately absent, and so is the throw's power: they are worn
 * on the player's belt and drawn as an arrow at the hand, where they are visible
 * on every player rather than only on your own screen.
 */
export class HUD {
  private readonly root = query('[data-layer="hud"]');
  private readonly health = requireElement("hud-health");
  private readonly healthFill = requireElement("hud-health-fill");
  private readonly ammo = requireElement("hud-ammo");
  private readonly ammoGauge = requireElement("hud-ammo-gauge");
  private readonly ammoFill = requireElement("hud-ammo-fill");
  private readonly magazine = requireElement("hud-magazine");
  private readonly weaponName = requireElement("hud-weapon");
  private readonly meleeBadge = requireElement("hud-melee");
  private readonly speedEffect = requireElement("hud-effect-speed");
  private readonly speedEffectTimer = requireElement("hud-effect-speed-timer");
  private readonly shrinkEffect = requireElement("hud-shrink");
  private readonly shrinkLabel = requireElement("hud-shrink-label");
  private readonly shrinkTimer = requireElement("hud-shrink-timer");
  private readonly reload = requireElement("hud-reload");
  private readonly alive = requireElement("hud-alive");
  private readonly kills = requireElement("hud-kills");
  private readonly matchStateLabel = requireElement("hud-match-state");
  private readonly crosshair = requireElement("crosshair");
  private readonly hitmarker = requireElement("hitmarker");
  private readonly damageFlash = requireElement("damage-flash");

  /** Local reload clock: the server only tells us that a reload is in progress. */
  private reloadStartedAt = 0;
  private reloadDurationMs = 0;
  /** The bar's width, 0..1, at the moment the current reload began. */
  private reloadStartedRatio = 0;
  private hitmarkerTimer = 0;
  private damageFlashTimer = 0;

  setVisible(visible: boolean): void {
    toggleClass(this.root, "is-active", visible);
    if (!visible) toggleClass(this.crosshair, "is-active", false);
  }

  update(snapshot: HudSnapshot): void {
    const { player } = snapshot;

    setText(this.alive, `${snapshot.aliveCount} / ${snapshot.totalPlayers}`);
    setText(this.matchStateLabel, snapshot.matchState);
    setText(this.kills, String(player?.kills ?? 0));

    if (!player) return;

    const maxHealth = getPlayerConfig().maxHealth;
    const health = clamp(player.health, 0, maxHealth);
    setText(this.health, String(Math.round(health)));
    const ratio = health / maxHealth;
    this.healthFill.style.width = `${ratio * 100}%`;
    toggleClass(this.healthFill, "is-hurt", ratio <= 0.6 && ratio > 0.3);
    toggleClass(this.healthFill, "is-critical", ratio <= 0.3);

    // Everything below is read from the weapon definition, so a weapon added
    // through configuration presents itself correctly with no change here.
    const weapon = getWeapon(player.weaponId);
    setText(this.weaponName, weapon.name);

    this.updateAmmo(player, weapon);
    this.updateReload(player, weapon);
    toggleClass(this.meleeBadge, "is-active", isMelee(weapon));

    this.updateEffects(player, snapshot);

    const inFight = snapshot.matchState === MatchState.PLAYING && player.alive;
    toggleClass(this.crosshair, "is-active", inFight);
  }

  /**
   * The magazine, as a gauge under the health bar.
   *
   * The same shape as health on purpose: both answer "how much longer can I keep
   * doing this", and two identical gauges are read faster than a bar on one side
   * and a number on the other.
   *
   * A weapon with no magazine has no gauge at all rather than an empty one --
   * the chainsaw never runs out, and a permanently empty bar would suggest it can.
   */
  private updateAmmo(player: SyncedPlayer, weapon: ReturnType<typeof getWeapon>): void {
    const ammoDriven = usesAmmo(weapon);
    toggleClass(this.ammoGauge, "is-hidden", !ammoDriven);
    if (!ammoDriven) return;

    setText(this.ammo, String(player.ammo));
    setText(this.magazine, String(weapon.magazineSize));

    /*
     * Left showing whatever is actually left, reload or not: a reload starting
     * at 9 of 10 rounds has almost nothing to fill, and a bar that dropped to
     * empty regardless said otherwise. The sweep in `updateReload` starts from
     * this same width and grows to full, so the two always agree.
     */
    const ratio = ammoRatio(player, weapon);
    this.ammoFill.style.width = `${ratio * 100}%`;
    toggleClass(this.ammoGauge, "is-empty", player.ammo === 0 && !player.reloading);
    toggleClass(this.ammoFill, "is-low", ratio > 0 && ratio <= 0.25);
  }

  /**
   * Show any active power-up effect.
   *
   * The countdown is server-sent in whole seconds, so the HUD neither guesses nor
   * needs a synchronised clock.
   */
  private updateEffects(player: SyncedPlayer, snapshot: HudSnapshot): void {
    const boosted = player.boostSeconds > 0;
    toggleClass(this.speedEffect, "is-active", boosted);
    if (boosted) setText(this.speedEffectTimer, `${player.boostSeconds}s`);

    // The arena countdown, then the warning once the walls are moving. Both are
    // server-sent, so the HUD neither guesses nor needs a synchronised clock.
    const counting = snapshot.shrinkCountdownSeconds > 0;
    const showShrink = counting || snapshot.shrinking;
    toggleClass(this.shrinkEffect, "is-active", showShrink);
    toggleClass(this.shrinkEffect, "is-closing", snapshot.shrinking);

    if (!showShrink) return;
    if (snapshot.shrinking) {
      setText(this.shrinkLabel, "ARENA");
      setText(this.shrinkTimer, "CLOSING");
    } else {
      setText(this.shrinkLabel, "ARENA IN");
      setText(this.shrinkTimer, formatCountdown(snapshot.shrinkCountdownSeconds));
    }
  }

  /**
   * Track reload progress locally so the server does not have to stream a timer.
   *
   * Starts the sweep at the ammunition already in the magazine and finishes it
   * at 100%, over `getReloadDurationMs` for however much is actually missing --
   * the same duration the server is enforcing. A gun topped up to 9 of 10 sweeps
   * a tenth of the bar in a tenth of the time; one reloaded from empty sweeps
   * all of it, exactly as before.
   */
  private updateReload(player: SyncedPlayer, weapon: ReturnType<typeof getWeapon>): void {
    const reloading = player.reloading;

    if (reloading && this.reloadStartedAt === 0) {
      this.reloadStartedAt = performance.now();
      this.reloadStartedRatio = ammoRatio(player, weapon);
      this.reloadDurationMs = getReloadDurationMs(weapon, player.ammo);
    } else if (!reloading && this.reloadStartedAt !== 0) {
      this.reloadStartedAt = 0;
    }

    toggleClass(this.reload, "is-active", reloading);
    if (!reloading) {
      this.reload.style.width = "0%";
      return;
    }

    const elapsed = performance.now() - this.reloadStartedAt;
    // A configured reloadTime of 0 (or nothing left missing) means it finished
    // the instant it started, rather than dividing by zero.
    const progress = this.reloadDurationMs > 0 ? clamp(elapsed / this.reloadDurationMs, 0, 1) : 1;
    const width = this.reloadStartedRatio + (1 - this.reloadStartedRatio) * progress;
    this.reload.style.width = `${width * 100}%`;
  }

  /** Position the DOM crosshair over the pointer. */
  setCrosshairPosition(screenX: number, screenY: number): void {
    this.crosshair.style.transform = `translate(${screenX}px, ${screenY}px)`;
  }

  showHitmarker(): void {
    // Restart the CSS animation by removing and re-adding the class.
    this.hitmarker.classList.remove("is-active");
    void this.hitmarker.offsetWidth;
    this.hitmarker.classList.add("is-active");
    this.hitmarkerTimer = performance.now();
  }

  showDamageFlash(): void {
    this.damageFlash.classList.add("is-active");
    this.damageFlashTimer = performance.now();
  }

  /** Called each frame to expire transient effects. */
  tick(now: number): void {
    if (this.damageFlashTimer !== 0 && now - this.damageFlashTimer > 120) {
      this.damageFlash.classList.remove("is-active");
      this.damageFlashTimer = 0;
    }
    if (this.hitmarkerTimer !== 0 && now - this.hitmarkerTimer > 260) {
      this.hitmarker.classList.remove("is-active");
      this.hitmarkerTimer = 0;
    }
  }
}

/** m:ss for anything over a minute, plain seconds below it. */
function formatCountdown(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
