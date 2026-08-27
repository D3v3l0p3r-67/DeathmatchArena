import { PLAYER_HALF_HEIGHT, clamp, type FlagHuntConfig } from "@deathmatch/shared";
import type { RoomContext } from "../rooms/RoomContext.js";
import { FlagState } from "../rooms/schema/FlagState.js";
import type { PlayerState } from "../rooms/schema/PlayerState.js";

/** How far above the point a flag is drawn planted, in px. */
const PLANT_OFFSET = 14;

/**
 * The flags themselves: spawning, expiry, pickup, and the drop when somebody
 * dies carrying them.
 *
 * Everything a match could be won by resolves in here, on the server, on the
 * server's own positions. A client never sends "I took a flag" -- it walks
 * somewhere, and this system notices. Two players converging on one flag with
 * whatever latency between them is settled by a single pass over a single map
 * on one tick: the first taker deletes the flag, and there is nothing left for
 * the second to take.
 *
 * Owned by `FlagHuntMode` rather than by the room, so a room in any other mode
 * carries none of this -- not the state, not the timers, not the per-tick scan.
 */
export class FlagSystem {
  private nextFlagId = 0;
  private nextSpawnAt = 0;
  /** Server-only expiry per flag. The client needs the flag, not its deadline. */
  private readonly expiries = new Map<string, number>();

  constructor(private readonly context: RoomContext) {}

  private get config(): FlagHuntConfig {
    return this.context.config.getFlagHuntConfig();
  }

  /** Fresh match: no flags, counters reset, the first wave placed at once. */
  start(now: number): void {
    this.clear();
    for (let i = 0; i < this.config.initialFlags; i++) this.spawnFlag(now, false);
    this.nextSpawnAt = now + this.config.flagSpawnIntervalMs;
  }

  clear(): void {
    this.context.state.flags.clear();
    this.expiries.clear();
    this.nextFlagId = 0;
    this.nextSpawnAt = 0;
  }

  /**
   * One tick: expire the forgotten, spawn the due, and hand out what is stood
   * on. Returns everybody who collected a flag this tick, because the mode --
   * not this system -- knows whether a collection wins a sudden death.
   */
  update(now: number): PlayerState[] {
    this.expire(now);

    if (now >= this.nextSpawnAt && this.nextSpawnAt > 0) {
      this.spawnFlag(now, false);
      this.nextSpawnAt = now + this.config.flagSpawnIntervalMs;
    }

    return this.collect(now);
  }

  /**
   * Drop a share of the victim's flags where they died.
   *
   * The floor of the share, so the carrier keeps the benefit of the doubt:
   * 10 flags at 50% drops 5, 3 at 50% drops 1 and keeps 2. Dropped flags
   * scatter along the ground around the death rather than stacking on one
   * pixel, and are placed on the floor below wherever the victim was --
   * a mid-air death rains its flags onto the platform underneath.
   */
  dropFrom(victim: PlayerState, now: number): number {
    const percent = clamp(this.config.deathDropPercent, 0, 100);
    const count = Math.floor((victim.flagCount * percent) / 100);
    if (count <= 0) return 0;

    victim.flagCount -= count;

    const scatter = Math.max(0, this.config.dropScatterPx);
    for (let i = 0; i < count; i++) {
      // Spread evenly around the death, with a little jitter so two deaths on
      // one spot do not produce identical piles.
      const spread = count > 1 ? (i / (count - 1)) * 2 - 1 : 0;
      const jitter = (this.context.random() * 2 - 1) * scatter * 0.2;
      const x = this.clampX(victim.x + spread * scatter + jitter);
      const y = this.floorBelow(x, victim.y);
      this.placeFlag(x, y, true, now);
    }
    return count;
  }

  /**
   * Put one extra flag out immediately, outside the spawn schedule.
   * Sudden death opens with this.
   */
  spawnExtraFlag(now: number): void {
    this.spawnFlag(now, true);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private expire(now: number): void {
    for (const [id, expiresAt] of Array.from(this.expiries)) {
      if (expiresAt <= 0 || now < expiresAt) continue;
      this.expiries.delete(id);
      this.context.state.flags.delete(id);
    }
  }

  /**
   * Hand flags to whoever is standing on them.
   *
   * One pass on one tick is the whole concurrency story: the first eligible
   * player found takes the flag and the flag is gone before anyone else is
   * considered, so latency can race players to the spot but never split one
   * flag between two of them.
   */
  private collect(now: number): PlayerState[] {
    const radius = this.config.pickupRadius;
    const collectors: PlayerState[] = [];

    for (const flag of Array.from(this.context.state.flags.values())) {
      for (const player of this.context.state.players.values()) {
        if (!player.alive || !player.inMatch) continue;
        const dx = player.x - flag.x;
        const dy = player.y - flag.y;
        if (dx * dx + dy * dy > radius * radius) continue;

        this.context.state.flags.delete(flag.id);
        this.expiries.delete(flag.id);
        player.flagCount += 1;
        collectors.push(player);
        break;
      }
    }

    void now;
    return collectors;
  }

  /** A fresh flag at a free spawn point. `force` ignores the on-map cap. */
  private spawnFlag(now: number, force: boolean): void {
    if (!force && this.context.state.flags.size >= this.config.maxFlagsOnMap) return;

    const point = this.pickSpawnPoint();
    if (!point) return;

    this.placeFlag(point.x, point.y - PLANT_OFFSET, false, now);
  }

  private placeFlag(x: number, y: number, dropped: boolean, now: number): void {
    const flag = new FlagState();
    flag.id = `flag-${++this.nextFlagId}`;
    flag.x = x;
    flag.y = y;
    flag.dropped = dropped;

    const lifetime = dropped ? this.config.droppedFlagLifetimeMs : this.config.flagLifetimeMs;
    this.expiries.set(flag.id, lifetime > 0 ? now + lifetime : 0);
    this.context.state.flags.set(flag.id, flag);
  }

  /**
   * A power-up spawn point with no flag already on it.
   *
   * The same predefined points crates use, shared rather than duplicated: an
   * arena's author placed them where things are worth fighting over. A crate
   * occasionally sharing a point with a flag is harmless -- they are different
   * entities and both remain takeable.
   */
  private pickSpawnPoint(): { x: number; y: number } | null {
    const points = this.context.arena.powerUpSpawns.filter((point) => point.enabled);
    if (points.length === 0) return null;

    const free = points.filter((point) => {
      for (const flag of this.context.state.flags.values()) {
        if (Math.abs(flag.x - point.x) < 30 && Math.abs(flag.y - point.y) < 60) return false;
      }
      return true;
    });

    const pool = free.length > 0 ? free : points;
    return pool[Math.floor(this.context.random() * pool.length)] ?? null;
  }

  /** The walking surface below a point, so a dropped flag lies on the ground. */
  private floorBelow(x: number, fromY: number): number {
    const hit = this.context.world.raycast(x, fromY, x, this.context.arena.height);
    if (hit) return hit.y - PLANT_OFFSET;
    // An enclosed arena always has a floor; this is belt and braces.
    return this.context.arena.height - PLANT_OFFSET - PLAYER_HALF_HEIGHT;
  }

  private clampX(x: number): number {
    const left = this.context.state.shrinking ? this.context.state.shrinkLeft : 0;
    const right = this.context.state.shrinking ? this.context.state.shrinkRight : this.context.arena.width;
    return clamp(x, left + 20, right - 20);
  }
}
