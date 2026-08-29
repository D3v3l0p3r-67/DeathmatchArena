/**
 * Offline-first persistence, and the one place a server is ever mentioned.
 *
 * Gameplay writes here synchronously -- localStorage, wrapped in try/catch so
 * a blocked storage never touches play -- and the optional sync sink ships
 * rare, high-level events (level started, checkpoint, level completed,
 * progress changed) after the fact. Nothing ever awaits it: lose the
 * connection mid-level and nothing happens at all.
 *
 * The synced payloads are client claims. Anything a server might someday
 * reward from them (leaderboards, currency, unlocks) must be verified
 * server-side first -- the shapes live in shared so such a verifier can speak
 * the same language without touching this engine.
 */
import type {
  CampaignDifficultyId,
  CampaignLevelResult,
  CampaignProgress,
  CampaignRank,
  CampaignSyncEvent,
} from "@deathmatch/shared";
import type { ScoreSnapshot } from "./ScoreTracker.js";

const PROGRESS_KEY = "deathmatch-campaign-progress";
const CHECKPOINT_KEY = "deathmatch-campaign-checkpoint";

/** Everything needed to resume a run from its last checkpoint. */
export interface CheckpointSave {
  levelId: string;
  difficulty: CampaignDifficultyId;
  checkpointId: string;
  firedTriggers: string[];
  completedEncounters: string[];
  secretsFound: string[];
  score: ScoreSnapshot;
  /** Play time already on the clock when the checkpoint was claimed. */
  elapsedMs: number;
  weaponId: string;
  grenades: number;
  /**
   * Attempts left under a lives rule, so quitting and resuming is not a free
   * refill. Optional because saves written before lives existed do not have it;
   * those resume on a full set, which is the generous reading of a missing
   * number.
   */
  livesLeft?: number | null;
}

export interface CampaignSyncSink {
  send(event: CampaignSyncEvent): void;
}

/** The default: nowhere. Single player owes nothing to any server. */
export class NullSync implements CampaignSyncSink {
  send(): void {}
}

/**
 * Optional cloud persistence: fire-and-forget POSTs, errors swallowed.
 * The game never waits on this, and never notices it failing.
 */
export class HttpCampaignSync implements CampaignSyncSink {
  constructor(private readonly baseUrl: string) {}

  send(event: CampaignSyncEvent): void {
    try {
      void fetch(`${this.baseUrl}/api/campaign/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // Storage of last resort is local; the sync layer is best-effort only.
    }
  }
}

const RANK_ORDER: Record<CampaignRank, number> = { S: 4, A: 3, B: 2, C: 1, D: 0 };

export class SaveStore {
  constructor(private readonly sync: CampaignSyncSink = new NullSync()) {}

  loadProgress(): CampaignProgress {
    try {
      const raw = localStorage.getItem(PROGRESS_KEY);
      if (raw) return JSON.parse(raw) as CampaignProgress;
    } catch {
      // A blocked or corrupt store reads as a fresh campaign.
    }
    return { levels: {} };
  }

  /** Fold a finished run into the record and persist it. */
  recordResult(result: CampaignLevelResult): CampaignProgress {
    const progress = this.loadProgress();
    const entry = progress.levels[result.levelId] ?? {
      completed: false,
      bestScore: 0,
      bestRank: null,
      completedDifficulties: [],
      secretsFound: 0,
    };

    entry.completed = true;
    entry.bestScore = Math.max(entry.bestScore, result.score);
    if (!entry.bestRank || RANK_ORDER[result.rank] > RANK_ORDER[entry.bestRank]) {
      entry.bestRank = result.rank;
    }
    if (!entry.completedDifficulties.includes(result.difficulty)) {
      entry.completedDifficulties.push(result.difficulty);
    }
    entry.secretsFound = Math.max(entry.secretsFound, result.secretsFound);
    progress.levels[result.levelId] = entry;

    this.persistProgress(progress);
    this.sync.send({ kind: "levelCompleted", levelId: result.levelId, result });
    this.sync.send({ kind: "progressChanged", progress });
    return progress;
  }

  saveCheckpoint(save: CheckpointSave): void {
    try {
      localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(save));
    } catch {
      // Local play continues regardless.
    }
    this.sync.send({ kind: "checkpointReached", levelId: save.levelId, checkpointId: save.checkpointId });
  }

  loadCheckpoint(levelId: string): CheckpointSave | null {
    try {
      const raw = localStorage.getItem(CHECKPOINT_KEY);
      if (!raw) return null;
      const save = JSON.parse(raw) as CheckpointSave;
      return save.levelId === levelId ? save : null;
    } catch {
      return null;
    }
  }

  clearCheckpoint(): void {
    try {
      localStorage.removeItem(CHECKPOINT_KEY);
    } catch {
      // Nothing to do.
    }
  }

  notifyLevelStarted(levelId: string, difficulty: CampaignDifficultyId): void {
    this.sync.send({ kind: "levelStarted", levelId, difficulty });
  }

  private persistProgress(progress: CampaignProgress): void {
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    } catch {
      // Progress lives for the session even when storage refuses.
    }
  }
}
