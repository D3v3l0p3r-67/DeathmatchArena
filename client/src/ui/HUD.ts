import {
  MatchState,
  getPlayerConfig,
  clamp,
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
  /** Local wind-up progress, 0..1. Drawn from the client's own press time. */
  grenadeCharge: number;
}

/**
 * The in-game heads-up display.
 *
 * Renders health, ammunition, reload progress, survivors, kills, the current
 * weapon and the match state. Every value comes from server-synchronised state --
 * the HUD never computes anything authoritative, it only presents it.
 */
export class HUD {
  private readonly root = query('[data-layer="hud"]');
  private readonly health = requireElement("hud-health");
  private readonly healthFill = requireElement("hud-health-fill");
  private readonly ammo = requireElement("hud-ammo");
  private readonly ammoGroup = requireElement("hud-ammo").parentElement!;
  private readonly magazine = requireElement("hud-magazine");
  private readonly weaponName = requireElement("hud-weapon");
  private readonly meleeBadge = requireElement("hud-melee");
  private readonly speedEffect = requireElement("hud-effect-speed");
  private readonly speedEffectTimer = requireElement("hud-effect-speed-timer");
  private readonly shrinkEffect = requireElement("hud-shrink");
  private readonly shrinkLabel = requireElement("hud-shrink-label");
  private readonly shrinkTimer = requireElement("hud-shrink-timer");
  private readonly grenadeGroup = requireElement("hud-grenades");
  private readonly grenadeCount = requireElement("hud-grenade-count");
  private readonly throwPower = requireElement("hud-throw-power");
  private readonly throwFill = requireElement("hud-throw-fill");
  private readonly reload = requireElement("hud-reload");
  private readonly reloadFill = requireElement("hud-reload-fill");
  private readonly alive = requireElement("hud-alive");
  private readonly kills = requireElement("hud-kills");
  private readonly matchStateLabel = requireElement("hud-match-state");
  private readonly crosshair = requireElement("crosshair");
  private readonly hitmarker = requireElement("hitmarker");
  private readonly damageFlash = requireElement("damage-flash");

  /** Local reload clock: the server only tells us that a reload is in progress. */
  private reloadStartedAt = 0;
  private reloadDurationMs = 0;
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

    const ammoDriven = usesAmmo(weapon);
    this.ammoGroup.style.display = ammoDriven ? "" : "none";
    toggleClass(this.meleeBadge, "is-active", isMelee(weapon));

    if (ammoDriven) {
      setText(this.ammo, String(player.ammo));
      setText(this.magazine, String(weapon.magazineSize));
      toggleClass(this.ammoGroup, "is-empty", player.ammo === 0);
    }

    this.updateReload(player.reloading, weapon.reloadTime);
    this.updateGrenades(player, snapshot);
    this.updateEffects(player, snapshot);

    const inFight = snapshot.matchState === MatchState.PLAYING && player.alive;
    toggleClass(this.crosshair, "is-active", inFight);
  }

  /**
   * Grenade count, and the power bar while a throw is winding up.
   *
   * The count is server state. The bar is local so it moves at frame rate, but
   * it charges against the same configured maximum the server measures with, so
   * a full bar really is a full-power throw.
   */
  private updateGrenades(player: SyncedPlayer, snapshot: HudSnapshot): void {
    setText(this.grenadeCount, String(player.grenades));
    toggleClass(this.grenadeGroup, "is-empty", player.grenades === 0);

    const charging = snapshot.grenadeCharge > 0 && player.alive;
    toggleClass(this.throwPower, "is-active", charging);
    if (charging) this.throwFill.style.width = `${Math.min(1, snapshot.grenadeCharge) * 100}%`;
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

  /** Track reload progress locally so the server does not have to stream a timer. */
  private updateReload(reloading: boolean, durationMs: number): void {
    if (reloading && this.reloadStartedAt === 0) {
      this.reloadStartedAt = performance.now();
      this.reloadDurationMs = durationMs;
    } else if (!reloading && this.reloadStartedAt !== 0) {
      this.reloadStartedAt = 0;
    }

    toggleClass(this.reload, "is-active", reloading);
    if (!reloading) return;

    const elapsed = performance.now() - this.reloadStartedAt;
    const progress = clamp(elapsed / Math.max(1, this.reloadDurationMs), 0, 1);
    this.reloadFill.style.width = `${progress * 100}%`;
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
