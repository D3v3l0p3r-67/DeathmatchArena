/**
 * Stored campaign level overrides: the balance overlay the admin edits.
 *
 * Same shape of responsibility as the game configuration service, one size
 * smaller. Only *overrides* are stored, never a level: an untouched field
 * keeps whatever the shipped level says, so a rebalance in a future release
 * flows through to every field nobody has overridden, and a reset is exactly
 * "delete the key". Everything written passes the shared sanitizer, so the
 * store can hold nothing a level could not survive.
 */
import { sanitizeCampaignOverrides, type CampaignOverrides } from "@deathmatch/shared";
import type { Logger } from "../utils/logger.js";
import { JsonStore } from "./JsonStore.js";

export interface CampaignLevelsRepository {
  read(): Promise<CampaignOverrides>;
  write(overrides: CampaignOverrides): Promise<void>;
}

export class InMemoryCampaignLevelsRepository implements CampaignLevelsRepository {
  private overrides: CampaignOverrides = {};

  async read(): Promise<CampaignOverrides> {
    return structuredClone(this.overrides);
  }

  async write(overrides: CampaignOverrides): Promise<void> {
    this.overrides = structuredClone(overrides);
  }
}

export class FileCampaignLevelsRepository implements CampaignLevelsRepository {
  private readonly store: JsonStore<{ overrides: CampaignOverrides }>;

  constructor(directory: string) {
    this.store = new JsonStore(directory, "campaign-levels.json");
  }

  get location(): string {
    return this.store.location;
  }

  async read(): Promise<CampaignOverrides> {
    const document = await this.store.read();
    return document?.overrides ?? {};
  }

  async write(overrides: CampaignOverrides): Promise<void> {
    await this.store.write({ overrides });
  }
}

export class CampaignLevelsService {
  private overrides: CampaignOverrides = {};

  constructor(
    private readonly repository: CampaignLevelsRepository,
    private readonly logger: Logger,
  ) {}

  async initialise(): Promise<void> {
    // Sanitized on the way in as well as on the way out of the API: a stored
    // file predating a limits change, or edited by hand, is held to today's
    // rules the moment it is loaded.
    this.overrides = sanitizeCampaignOverrides(await this.repository.read());
    const touched = Object.keys(this.overrides).length;
    if (touched > 0) this.logger.info("Loaded campaign level overrides", { levels: touched });
  }

  /** The whole overlay, for the admin UI and the game alike. */
  current(): CampaignOverrides {
    return structuredClone(this.overrides);
  }

  /** Replace the overlay with a sanitized version of `raw` and persist it. */
  async replace(raw: unknown): Promise<CampaignOverrides> {
    const clean = sanitizeCampaignOverrides(raw);
    await this.repository.write(clean);
    this.overrides = clean;
    this.logger.info("Stored campaign level overrides", { levels: Object.keys(clean).length });
    return this.current();
  }
}
