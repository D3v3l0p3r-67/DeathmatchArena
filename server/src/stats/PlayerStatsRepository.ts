/**
 * Where a player's record is kept between matches.
 *
 * The same shape as the other two repositories, for the same reason: the service
 * above it knows nothing about files, so moving these into a database is writing
 * one class rather than rewriting a feature.
 *
 * What is *not* here is any notion of an account. Players are identified by an id
 * their own browser generated (see `JoinOptions.playerId`), which makes this a
 * personal record rather than a ranking: it is trivially forgeable, so nothing is
 * built on top of it that would reward forging one. Nobody is ever shown anybody
 * else's totals.
 */
import type { PlayerCareer } from "@deathmatch/shared";
import { JsonStore } from "../admin/JsonStore.js";

/** Careers keyed by the id the client offered. */
export type CareerTable = Record<string, PlayerCareer>;

export interface PlayerStatsRepository {
  read(): Promise<CareerTable>;
  write(table: CareerTable): Promise<void>;
}

export class InMemoryPlayerStatsRepository implements PlayerStatsRepository {
  private table: CareerTable = {};

  async read(): Promise<CareerTable> {
    return structuredClone(this.table);
  }

  async write(table: CareerTable): Promise<void> {
    this.table = structuredClone(table);
  }
}

export class FilePlayerStatsRepository implements PlayerStatsRepository {
  private readonly store: JsonStore<{ careers: CareerTable }>;

  constructor(directory: string, fileName = "player-stats.json") {
    this.store = new JsonStore(directory, fileName);
  }

  get location(): string {
    return this.store.location;
  }

  async read(): Promise<CareerTable> {
    return (await this.store.read())?.careers ?? {};
  }

  async write(careers: CareerTable): Promise<void> {
    await this.store.write({ careers });
  }
}
