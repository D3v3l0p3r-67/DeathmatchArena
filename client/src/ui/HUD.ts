import {
  GameMode,
  MatchState,
  getPlayerConfig,
  clamp,
  getGaugesConfig,
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
  /** Which mode this match runs. Decides whether the Flag Hunt panels show. */
  gameModeId: string;
  /** Whole seconds left on a timed mode's clock; 0 when no clock is running. */
  matchClockSeconds: number;
  suddenDeath: boolean;
  /** Everyone in the room, for the Flag Hunt leaderboard. */
  players: ReadonlyMap<string, SyncedPlayer>;
  localSessionId: string;
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
  private readonly gauges = query(".gauges");
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
  private readonly alive = requireElement("hud-alive");
  private readonly kills = requireElement("hud-kills");
  private readonly matchStateLabel = requireElement("hud-match-state");
  private readonly flagsStat = requireElement("hud-flags-stat");
  private readonly flags = requireElement("hud-flags");
  private readonly clockEffect = requireElement("hud-clock");
  private readonly clockLabel = requireElement("hud-clock-label");
  private readonly clockTimer = requireElement("hud-clock-timer");
  private readonly flagboard = requireElement("flagboard");
  private readonly crosshair = requireElement("crosshair");
  private readonly hitmarker = requireElement("hitmarker");
  private readonly damageFlash = requireElement("damage-flash");

  /** Whether the last `update` saw a reload in progress, to catch the edges. */
  private wasReloading = false;
  /** What the flagboard currently shows, so its DOM is rebuilt only on change. */
  private flagboardSignature = "";
  private hitmarkerTimer = 0;
  private damageFlashTimer = 0;

  /** Campaign runs hide the multiplayer corner rows and the minimap. */
  setCampaignMode(campaign: boolean): void {
    toggleClass(this.root, "hud--campaign", campaign);
  }

  setVisible(visible: boolean): void {
    toggleClass(this.root, "is-active", visible);
    if (!visible) toggleClass(this.crosshair, "is-active", false);
  }

  update(snapshot: HudSnapshot): void {
    const { player } = snapshot;

    setText(this.alive, `${snapshot.aliveCount} / ${snapshot.totalPlayers}`);
    setText(this.matchStateLabel, snapshot.matchState);
    setText(this.kills, String(player?.kills ?? 0));

    this.updateFlagHunt(snapshot);

    if (!player) return;

    // Everything below is read from the weapon definition, so a weapon added
    // through configuration presents itself correctly with no change here.
    const weapon = getWeapon(player.weaponId);
    setText(this.weaponName, weapon.name);
    toggleClass(this.meleeBadge, "is-active", isMelee(weapon));

    this.updateGauges(player, weapon);
    this.updateEffects(player, snapshot);

    const inFight = snapshot.matchState === MatchState.PLAYING && player.alive;
    toggleClass(this.crosshair, "is-active", inFight);
  }

  /**
   * The corner gauge stack: health and ammunition, for the local player.
   *
   * One switch for the pair, because with the bars drawn over every player's
   * head this panel is a second copy of the same two numbers in the corner
   * nobody is looking at. Skipping only this leaves the rest of the HUD -- the
   * weapon name, the arena notice, the crosshair -- untouched, which is the
   * whole point of it being a stack rather than the HUD itself.
   */
  private updateGauges(player: SyncedPlayer, weapon: ReturnType<typeof getWeapon>): void {
    const inHud = getGaugesConfig().inHud;
    toggleClass(this.gauges, "is-hidden", !inHud);
    if (!inHud) return;

    const maxHealth = getPlayerConfig().maxHealth;
    const health = clamp(player.health, 0, maxHealth);
    setText(this.health, String(Math.round(health)));
    const ratio = health / maxHealth;
    this.healthFill.style.width = `${ratio * 100}%`;
    toggleClass(this.healthFill, "is-hurt", ratio <= 0.6 && ratio > 0.3);
    toggleClass(this.healthFill, "is-critical", ratio <= 0.3);

    this.updateAmmo(player, weapon);
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

    const ratio = ammoRatio(player, weapon);
    toggleClass(this.ammoGauge, "is-empty", player.ammo === 0 && !player.reloading);
    toggleClass(this.ammoFill, "is-low", ratio > 0 && ratio <= 0.25);

    this.updateReloadFill(player, weapon, ratio);
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
   * The ammo bar *is* the reload indicator -- one element, one width, so there
   * is exactly one fill animation on screen rather than an amber overlay
   * sweeping over a white bar that then plays its own catch-up fill once the
   * overlay disappears.
   *
   * Starting a reload hands the bar's `width` transition an explicit duration
   * matching `getReloadDurationMs` and sets the target to 100% in the same
   * tick: the browser interpolates from whatever width the bar already had
   * (the ammunition still in the magazine) to full, over exactly the time the
   * server is enforcing. No per-frame progress bookkeeping is needed here --
   * the transition *is* the animation. Only the edges do anything: the first
   * tick of a reload starts the sweep and turns the bar amber; the first tick
   * after it ends restores the bar's ordinary fast transition for whatever
   * ammo does next. Every tick in between leaves the bar alone so the running
   * transition is never interrupted or restarted.
   */
  private updateReloadFill(player: SyncedPlayer, weapon: ReturnType<typeof getWeapon>, ratio: number): void {
    const reloading = player.reloading;
    toggleClass(this.ammoFill, "is-reloading", reloading);

    if (reloading) {
      if (!this.wasReloading) {
        const durationMs = getReloadDurationMs(weapon, player.ammo);
        this.ammoFill.style.transition =
          durationMs > 0 ? `width ${durationMs}ms linear, background 200ms ease` : "background 200ms ease";
        // Force the browser to commit the current width before the next line
        // changes it, so the sweep actually starts from here rather than the
        // width-and-transition change being batched into one silent jump.
        void this.ammoFill.offsetWidth;
        this.ammoFill.style.width = "100%";
      }
    } else {
      if (this.wasReloading) {
        // Back to the CSS-defined transition (140ms) for ordinary ammo changes.
        this.ammoFill.style.transition = "";
      }
      this.ammoFill.style.width = `${ratio * 100}%`;
    }

    this.wasReloading = reloading;
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

  /**
   * Everything Flag Hunt puts on screen: your count, the clock, the board.
   *
   * All of it renders server truth -- flag counts, the remaining seconds and
   * the sudden-death bit are synchronised state, so the HUD never runs a
   * clock of its own. In any other mode every element here stays hidden.
   */
  private updateFlagHunt(snapshot: HudSnapshot): void {
    const active = snapshot.gameModeId === GameMode.FLAG_HUNT;
    this.flagsStat.hidden = !active;
    this.flagboard.hidden = !active || snapshot.matchState !== MatchState.PLAYING;

    const showClock =
      active &&
      snapshot.matchState === MatchState.PLAYING &&
      (snapshot.suddenDeath || snapshot.matchClockSeconds > 0);
    toggleClass(this.clockEffect, "is-active", showClock);

    if (!active) return;

    setText(this.flags, String(snapshot.player?.flagCount ?? 0));

    if (showClock) {
      toggleClass(this.clockEffect, "is-sudden", snapshot.suddenDeath);
      toggleClass(
        this.clockEffect,
        "is-urgent",
        !snapshot.suddenDeath && snapshot.matchClockSeconds <= 30,
      );
      if (snapshot.suddenDeath) {
        setText(this.clockLabel, "SUDDEN DEATH");
        setText(this.clockTimer, "NEXT FLAG WINS");
      } else {
        setText(this.clockLabel, "TIME");
        setText(this.clockTimer, formatClock(snapshot.matchClockSeconds));
      }
    }

    if (!this.flagboard.hidden) this.renderFlagboard(snapshot);
  }

  /**
   * The live leaderboard, sorted the way the mode scores: flags, then kills,
   * then name -- the same order the server ranks the final standings in, so
   * the board never disagrees with the result screen.
   *
   * The DOM is rebuilt only when what it would say changes; at 20Hz the
   * common case is a string comparison and nothing else.
   */
  private renderFlagboard(snapshot: HudSnapshot): void {
    const rows: SyncedPlayer[] = [];
    for (const player of snapshot.players.values()) {
      if (player.inMatch) rows.push(player);
    }
    rows.sort(
      (a, b) => b.flagCount - a.flagCount || b.kills - a.kills || a.name.localeCompare(b.name),
    );

    const best = rows[0]?.flagCount ?? 0;
    const signature = rows
      .map((player) => `${player.sessionId}:${player.flagCount}:${player.kills}:${player.name}`)
      .join("|");
    if (signature === this.flagboardSignature) return;
    this.flagboardSignature = signature;

    this.flagboard.replaceChildren();
    rows.forEach((player, index) => {
      const row = document.createElement("li");
      row.className = "flagboard__row";
      if (player.sessionId === snapshot.localSessionId) row.classList.add("is-you");
      if (best > 0 && player.flagCount === best) row.classList.add("is-leader");

      const rank = document.createElement("span");
      rank.className = "flagboard__rank";
      rank.textContent = `${index + 1}.`;
      const name = document.createElement("span");
      name.className = "flagboard__name";
      name.textContent = player.name;
      const flags = document.createElement("span");
      flags.className = "flagboard__flags";
      flags.textContent = `\u{1F6A9} ${player.flagCount}`;

      row.append(rank, name, flags);
      this.flagboard.appendChild(row);
    });
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

/** Always m:ss -- a match clock reads as a clock even under a minute. */
function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** m:ss for anything over a minute, plain seconds below it. */
function formatCountdown(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
