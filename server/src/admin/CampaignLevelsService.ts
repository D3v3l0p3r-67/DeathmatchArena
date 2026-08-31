/**
 * Stored campaign levels: whole documents, the way arenas are stored.
 *
 * The editor edits a complete `CampaignLevelDefinition`; the shipped levels
 * are the seed and the fallback. Only *edited* levels are stored -- an
 * untouched level keeps shipping with the game, and "reset to shipped" is
 * exactly "delete the stored document". Everything written passes the shared
 * normalizer (shape) and validator (sense) first, so the store can hold
 * nothing the engine could not play.
 */
import {
  CAMPAIGN_LEVELS,
  getCampaignArena,
  normalizeCampaignLevel,
  validateCampaignLevel,
  type CampaignLevelDefinition,
} from "@deathmatch/shared";
import type { Logger } from "../utils/logger.js";
import { JsonStore } from "./JsonStore.js";

export type StoredCampaignLevels = Record<string, CampaignLevelDefinition>;

export interface CampaignLevelsRepository {
  read(): Promise<StoredCampaignLevels>;
  write(levels: StoredCampaignLevels): Promise<void>;
}

export class InMemoryCampaignLevelsRepository implements CampaignLevelsRepository {
  private levels: StoredCampaignLevels = {};

  async read(): Promise<StoredCampaignLevels> {
    return structuredClone(this.levels);
  }

  async write(levels: StoredCampaignLevels): Promise<void> {
    this.levels = structuredClone(levels);
  }
}

export class FileCampaignLevelsRepository implements CampaignLevelsRepository {
  private readonly store: JsonStore<{ levels: StoredCampaignLevels }>;

  constructor(directory: string) {
    this.store = new JsonStore(directory, "campaign-levels.json");
  }

  get location(): string {
    return this.store.location;
  }

  async read(): Promise<StoredCampaignLevels> {
    const document = await this.store.read();
    return document?.levels ?? {};
  }

  async write(levels: StoredCampaignLevels): Promise<void> {
    await this.store.write({ levels });
  }
}

export interface LevelSummary {
  id: string;
  name: string;
  arenaId: string;
  /** True when a stored document shadows the shipped one. */
  edited: boolean;
}

export interface LevelWriteResult {
  ok: boolean;
  issues: string[];
  level?: CampaignLevelDefinition;
}

export class CampaignLevelsService {
  private levels: StoredCampaignLevels = {};

  constructor(
    private readonly repository: CampaignLevelsRepository,
    private readonly logger: Logger,
  ) {}

  async initialise(): Promise<void> {
    /*
     * Held to today's rules on load, not just on write: a hand-edited file, or
     * one written before a rule existed, gets each level re-normalized and
     * re-validated, and anything that no longer passes is dropped with a log
     * line rather than handed to the engine.
     */
    const raw = await this.repository.read();
    const kept: StoredCampaignLevels = {};
    for (const [id, document] of Object.entries(raw)) {
      const verdict = this.check(id, document);
      if (verdict.ok && verdict.level) kept[id] = verdict.level;
      else this.logger.warn("Dropped a stored campaign level that no longer validates", { id, issues: verdict.issues });
    }
    this.levels = kept;
    if (Object.keys(kept).length > 0) {
      this.logger.info("Loaded stored campaign levels", { levels: Object.keys(kept) });
    }
  }

  /** Every level the campaign has, shipped or stored, with its edit state. */
  list(): LevelSummary[] {
    return CAMPAIGN_LEVELS.map((shipped) => {
      const stored = this.levels[shipped.id];
      return {
        id: shipped.id,
        name: stored?.name ?? shipped.name,
        arenaId: stored?.arenaId ?? shipped.arenaId,
        edited: stored !== undefined,
      };
    });
  }

  /** The document the game would play: stored when edited, shipped otherwise. */
  get(id: string): CampaignLevelDefinition | null {
    const stored = this.levels[id];
    if (stored) return structuredClone(stored);
    const shipped = CAMPAIGN_LEVELS.find((level) => level.id === id);
    return shipped ? structuredClone(shipped) : null;
  }

  /** Only the edited documents: what the game overlays onto its bundle. */
  stored(): StoredCampaignLevels {
    return structuredClone(this.levels);
  }

  async put(id: string, raw: unknown): Promise<LevelWriteResult> {
    const verdict = this.check(id, raw);
    if (!verdict.ok || !verdict.level) return { ok: false, issues: verdict.issues };

    this.levels[id] = verdict.level;
    await this.repository.write(this.levels);
    this.logger.info("Stored a campaign level", { id });
    return { ok: true, issues: [], level: structuredClone(verdict.level) };
  }

  /** Back to the shipped document. Deleting what was never stored is a no-op. */
  async reset(id: string): Promise<void> {
    if (!(id in this.levels)) return;
    delete this.levels[id];
    await this.repository.write(this.levels);
    this.logger.info("Reset a campaign level to shipped", { id });
  }

  private check(id: string, raw: unknown): { ok: boolean; issues: string[]; level?: CampaignLevelDefinition } {
    const { level, issues } = normalizeCampaignLevel(raw);
    if (!level) return { ok: false, issues };
    if (level.id !== id) issues.push(`the document's id (${level.id}) must match the level being saved (${id})`);
    if (!CAMPAIGN_LEVELS.some((shipped) => shipped.id === id)) {
      // New levels need a bundle entry to be playable offline; the editor
      // edits the campaign that exists rather than inventing dangling ids.
      issues.push(`unknown level id ${id}: the editor edits shipped levels`);
    }

    const arena = getCampaignArena(level.arenaId);
    if (!arena) {
      issues.push(`unknown arena ${level.arenaId}`);
      return { ok: false, issues };
    }
    issues.push(...validateCampaignLevel(level, arena, CAMPAIGN_LEVELS.map((shipped) => shipped.id)));
    return issues.length > 0 ? { ok: false, issues } : { ok: true, issues: [], level };
  }
}
