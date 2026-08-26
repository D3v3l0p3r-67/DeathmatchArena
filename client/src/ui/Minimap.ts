import { MatchState, getMinimapConfig, type ArenaDefinition, type SyncedGameState } from "@deathmatch/shared";
import { requireElement, toggleClass } from "./dom.js";
import { normalisePosition, withinRadius, type MinimapPoint } from "./minimapGeometry.js";

/**
 * The corner minimap.
 *
 * Deliberately reads nothing that is not already in `SyncedGameState`: a
 * player's position and a power-up's are already sent to every client, so this
 * decides what gets drawn, never what gets sent. `minimap.*` in the shared
 * config decides whether it appears at all, whether it draws players and/or
 * power-ups, and how far from the local player something has to be to earn a
 * dot -- see `getMinimapConfig`. Reads that config live, so an admin change
 * lands on the next update rather than needing a rejoin.
 *
 * Positions are normalised to 0..1 and placed with CSS percentages
 * (`normalisePosition`), so this never has to measure its own element or
 * recompute anything when the panel's on-screen size changes.
 */
export class Minimap {
  private readonly root = requireElement("minimap");
  private readonly frame = requireElement("minimap-frame");

  private readonly playerDots = new Map<string, HTMLElement>();
  private readonly powerUpDots = new Map<string, HTMLElement>();

  update(state: SyncedGameState | undefined, arena: ArenaDefinition | null, localSessionId: string): void {
    const config = getMinimapConfig();
    const active = config.enabled && state?.matchState === MatchState.PLAYING && arena !== null;
    toggleClass(this.root, "is-active", active);

    if (!active || !state || !arena) {
      this.clear(this.playerDots);
      this.clear(this.powerUpDots);
      return;
    }

    /*
     * The radius is measured from where the local player actually is, and only
     * while they actually are somewhere -- i.e. still playing. Centring it on a
     * dead player's corpse instead would leave a spectator's minimap blank the
     * moment the fight moved away from wherever they died, for the rest of the
     * match. A spectator is watching, not playing, so full awareness costs
     * nothing back.
     */
    const local = state.players.get(localSessionId);
    const center = local?.alive ? local : undefined;

    this.updatePlayers(state, arena, config, localSessionId, center);
    this.updatePowerUps(state, arena, config, center);
  }

  private updatePlayers(
    state: SyncedGameState,
    arena: ArenaDefinition,
    config: ReturnType<typeof getMinimapConfig>,
    localSessionId: string,
    center: { x: number; y: number } | undefined,
  ): void {
    if (!config.showPlayers) {
      this.clear(this.playerDots);
      return;
    }

    const seen = new Set<string>();
    for (const [sessionId, player] of state.players) {
      if (!player.alive) continue;
      if (center && !withinRadius(center.x, center.y, player.x, player.y, config.radius)) continue;

      seen.add(sessionId);
      const dot = this.dotFor(this.playerDots, sessionId, this.frame, "minimap__dot");
      toggleClass(dot, "minimap__dot--self", sessionId === localSessionId);
      toggleClass(dot, "minimap__dot--enemy", sessionId !== localSessionId);
      this.place(dot, normalisePosition(player.x, player.y, arena));
    }
    this.prune(this.playerDots, seen);
  }

  private updatePowerUps(
    state: SyncedGameState,
    arena: ArenaDefinition,
    config: ReturnType<typeof getMinimapConfig>,
    center: { x: number; y: number } | undefined,
  ): void {
    if (!config.showPowerUps) {
      this.clear(this.powerUpDots);
      return;
    }

    const seen = new Set<string>();
    for (const [id, powerUp] of state.powerUps) {
      if (center && !withinRadius(center.x, center.y, powerUp.x, powerUp.y, config.radius)) continue;

      seen.add(id);
      const dot = this.dotFor(this.powerUpDots, id, this.frame, "minimap__dot minimap__dot--powerup");
      this.place(dot, normalisePosition(powerUp.x, powerUp.y, arena));
    }
    this.prune(this.powerUpDots, seen);
  }

  private dotFor(
    pool: Map<string, HTMLElement>,
    id: string,
    parent: HTMLElement,
    className: string,
  ): HTMLElement {
    let dot = pool.get(id);
    if (!dot) {
      dot = document.createElement("div");
      dot.className = className;
      parent.appendChild(dot);
      pool.set(id, dot);
    }
    return dot;
  }

  private place(dot: HTMLElement, point: MinimapPoint): void {
    dot.style.left = `${point.nx * 100}%`;
    dot.style.top = `${point.ny * 100}%`;
  }

  /** Drop every pooled dot not seen this update -- gone, out of range, or hidden by config. */
  private prune(pool: Map<string, HTMLElement>, seen: ReadonlySet<string>): void {
    for (const [id, dot] of pool) {
      if (seen.has(id)) continue;
      dot.remove();
      pool.delete(id);
    }
  }

  private clear(pool: Map<string, HTMLElement>): void {
    for (const dot of pool.values()) dot.remove();
    pool.clear();
  }
}
