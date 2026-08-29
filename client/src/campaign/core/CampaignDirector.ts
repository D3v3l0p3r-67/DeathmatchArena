/**
 * One level's run, conducted.
 *
 * The director owns the local simulation and the campaign systems around it --
 * triggers, encounters, the boss, the roster, checkpoints, score, saving --
 * and speaks to the presentation layer only through the `ui` emitter and a
 * handful of read accessors. It contains no Phaser and no DOM, which is what
 * lets the whole campaign run headless in tests.
 */
import {
  ServerMessage,
  getCampaignEnemy,
  CAMPAIGN_SCORING,
  validateCampaignLevel,
  type ArenaDefinition,
  type CampaignDifficultyId,
  type CampaignEnemySpawn,
  type CampaignLevelDefinition,
  type CampaignLevelResult,
  type CampaignProgress,
  type CampaignTriggerAction,
  type CampaignZone,
  type DamagePayload,
  type KillPayload,
  type MeleeSwingPayload,
  type CrateDestroyedPayload,
} from "@deathmatch/shared";
import { Emitter } from "../../core/Emitter.js";
import { LOCAL_PLAYER_ID, LocalMatch } from "../sim/LocalMatch.js";
import { BossDirector, type BossStatus } from "./BossDirector.js";
import { EncounterDirector } from "./EncounterDirector.js";
import { EnemyRoster } from "./EnemyRoster.js";
import { SaveStore, type CheckpointSave } from "./SaveStore.js";
import { ScoreTracker } from "./ScoreTracker.js";
import { TriggerEngine } from "./TriggerEngine.js";

export interface CampaignUiEvents {
  message: { text: string; durationMs: number };
  objective: { text: string };
  checkpoint: { id: string };
  secretFound: { id: string; message: string };
  /** null returns the camera to plain follow. */
  cameraLock: { zoneId: string | null };
  shake: { intensity: number };
  playerDied: { respawnInMs: number; livesLeft: number | null };
  levelCompleted: { result: CampaignLevelResult; progress: CampaignProgress };
  levelFailed: Record<string, never>;
}

export interface CampaignDirectorOptions {
  seed?: number;
  now?: () => number;
  saveStore?: SaveStore;
  playerName?: string;
}

const RESPAWN_DELAY_MS = 2500;

export class CampaignDirector {
  readonly match: LocalMatch;
  readonly ui = new Emitter<CampaignUiEvents>();

  private readonly triggers: TriggerEngine;
  private readonly roster: EnemyRoster;
  private readonly encounters: EncounterDirector;
  private readonly boss: BossDirector | null;
  private readonly score = new ScoreTracker(CAMPAIGN_SCORING);
  private readonly save: SaveStore;

  private startedAt = 0;
  private elapsedOffsetMs = 0;
  private finished = false;
  private failed = false;
  private respawnAt = 0;
  private livesLeft: number | null = null;

  private lastCheckpoint: { id: string; x: number; y: number } | null = null;
  private claimedCheckpoints = new Set<string>();
  private foundSecrets = new Set<string>();
  /** Crate groups still standing, so scripted destroys and watchers agree. */
  private readonly crateGroups = new Map<string, Set<string>>();
  /** Projectiles already counted as the player's shots. */
  private readonly countedShots = new Set<string>();

  constructor(
    private readonly level: CampaignLevelDefinition,
    arena: ArenaDefinition,
    private readonly difficulty: CampaignDifficultyId,
    options: CampaignDirectorOptions = {},
  ) {
    const issues = validateCampaignLevel(level, arena);
    if (issues.length > 0) {
      throw new Error(`level ${level.id} is invalid: ${issues.join("; ")}`);
    }

    this.save = options.saveStore ?? new SaveStore();
    this.match = new LocalMatch(arena, { seed: options.seed, now: options.now });

    this.roster = new EnemyRoster(this.match, difficulty, (group) => this.onGroupCleared(group));
    this.encounters = new EncounterDirector(level.encounters, this.roster, {
      lockCamera: (zoneId) => this.ui.emit("cameraLock", { zoneId }),
      unlockCamera: () => this.ui.emit("cameraLock", { zoneId: null }),
      encounterCompleted: (id) => this.triggers.notifyEncounterCompleted(id, this.match.now()),
    });
    this.boss = level.boss
      ? new BossDirector(level.boss, this.match, this.roster, difficulty, {
          message: (text, durationMs) => this.ui.emit("message", { text, durationMs: durationMs ?? 3000 }),
          bossPhaseStarted: (phase) => this.triggers.notifyBossPhase(phase, this.match.now()),
          bossDefeated: () => this.triggers.notifyBossDefeated(this.match.now()),
        })
      : null;

    this.triggers = new TriggerEngine(level.triggers, {
      playerX: () => this.player()?.x ?? 0,
      playerY: () => this.player()?.y ?? 0,
      playerHealthPercent: () => {
        const player = this.player();
        const max = this.match.config.getPlayerConfig().maxHealth;
        return player ? Math.max(0, player.health) / Math.max(1, max) : 0;
      },
      execute: (action, triggerId) => this.execute(action, triggerId),
    });

    if (level.respawnRule.kind === "lives") this.livesLeft = level.respawnRule.lives;

    this.match.events.on(ServerMessage.KILL, (payload) => this.onKill(payload as KillPayload));
    this.match.events.on(ServerMessage.DAMAGE, (payload) => this.onDamage(payload as DamagePayload));
    this.match.events.on(ServerMessage.MELEE_SWING, (payload) => this.onMeleeSwing(payload as MeleeSwingPayload));
    this.match.events.on(ServerMessage.CRATE_DESTROYED, (payload) =>
      this.onCrateDestroyed(payload as CrateDestroyedPayload),
    );

    void options.playerName;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Begin the level.
   *
   * `carried` is what the previous level was finished with. Whether any of it
   * survives is the *arriving* level's decision (`carryOver`), so a level can
   * always guarantee the loadout it was designed around -- and a resume from a
   * checkpoint outranks both, because that save already recorded what was in
   * hand at the time.
   */
  start(
    resume: CheckpointSave | null = null,
    playerName = "You",
    carried: { weaponId?: string; grenades?: number } = {},
  ): void {
    const level = this.level;
    const spawn = resume ? this.checkpointById(resume.checkpointId) ?? level.playerSpawn : level.playerSpawn;

    const carriedWeapon = level.carryOver?.weapon ? carried.weaponId : undefined;
    const carriedGrenades =
      level.carryOver?.grenades && carried.grenades !== undefined
        ? Math.max(carried.grenades, level.startingGrenades)
        : undefined;

    this.match.addLocalPlayer(
      playerName,
      spawn.x,
      spawn.y,
      resume?.weaponId ?? carriedWeapon ?? level.startingWeapon,
      resume?.grenades ?? carriedGrenades ?? level.startingGrenades,
    );

    // Level furniture: every placed crate, up front. Sections activate their
    // *enemies* on approach; the scenery is cheap and part of the map.
    for (const crate of level.crates) {
      const crateId = this.match.spawnCrateAt(crate.spawnPointId, crate.powerUpId ?? null);
      if (crateId && crate.group) this.addToCrateGroup(crate.group, crateId);
    }

    this.startedAt = this.match.now();

    if (resume) {
      this.elapsedOffsetMs = resume.elapsedMs;
      this.score.restore(resume.score);
      this.encounters.restoreCompleted(resume.completedEncounters);
      this.triggers.restoreFired(resume.firedTriggers, this.startedAt);
      this.foundSecrets = new Set(resume.secretsFound);
      this.claimedCheckpoints = new Set([resume.checkpointId]);
      const checkpoint = this.checkpointById(resume.checkpointId);
      if (checkpoint) this.lastCheckpoint = { id: resume.checkpointId, x: checkpoint.x, y: checkpoint.y };
    }

    this.save.notifyLevelStarted(level.id, this.difficulty);
    this.triggers.start(this.match.now());
  }

  /** Drive one frame. The scene calls this before it draws. */
  update(deltaMs: number, onSimStep?: () => void): void {
    if (this.finished || this.failed) return;

    this.match.step(deltaMs, onSimStep);
    const now = this.match.now();

    if (this.respawnAt !== 0 && now >= this.respawnAt) {
      this.respawnAt = 0;
      this.respawn();
    }

    this.triggers.update(now);
    this.boss?.update();
    this.pollCheckpoints();
    this.pollSecrets();
    this.countShots();
    this.roster.sweep(now);
  }

  // -------------------------------------------------------------------------
  // Read accessors for the scene and HUD
  // -------------------------------------------------------------------------

  player() {
    return this.match.state.players.get(LOCAL_PLAYER_ID) ?? null;
  }

  bossStatus(): BossStatus | null {
    return this.boss?.status() ?? null;
  }

  currentScore(): number {
    return this.score.currentPoints;
  }

  currentKills(): number {
    return this.score.currentKills;
  }

  elapsedMs(): number {
    return this.match.now() - this.startedAt + this.elapsedOffsetMs;
  }

  isOver(): boolean {
    return this.finished || this.failed;
  }

  levelDefinition(): CampaignLevelDefinition {
    return this.level;
  }

  campaignDifficulty(): CampaignDifficultyId {
    return this.difficulty;
  }

  /** Lives left under a lives rule; null when the rule has no such number. */
  livesRemaining(): number | null {
    return this.livesLeft;
  }

  // -------------------------------------------------------------------------
  // Trigger actions -- the whole scripting vocabulary lands here
  // -------------------------------------------------------------------------

  private execute(action: CampaignTriggerAction, triggerId: string): void {
    const now = this.match.now();
    switch (action.kind) {
      case "spawnEnemies": {
        const spawned = this.roster.spawnGroup(action.group, action.enemies);
        if (spawned === 0) this.triggers.notifyEnemiesKilled(action.group, now);
        return;
      }
      case "startEncounter":
        this.encounters.start(action.encounterId, triggerId);
        return;
      case "destroyObjects": {
        const crates = this.crateGroups.get(action.group);
        for (const crateId of Array.from(crates ?? [])) this.match.destroyCrate(crateId);
        return;
      }
      case "spawnCrate": {
        const crateId = this.match.spawnCrateAt(action.spawnPointId, action.powerUpId ?? null);
        if (crateId && action.group) this.addToCrateGroup(action.group, crateId);
        return;
      }
      case "lockCamera":
        this.ui.emit("cameraLock", { zoneId: action.zoneId });
        return;
      case "unlockCamera":
        this.ui.emit("cameraLock", { zoneId: null });
        return;
      case "shake":
        this.ui.emit("shake", { intensity: action.intensity ?? 0.006 });
        return;
      case "message":
        this.ui.emit("message", { text: action.text, durationMs: action.durationMs ?? 3000 });
        return;
      case "objective":
        this.ui.emit("objective", { text: action.text });
        return;
      case "checkpoint":
        this.claimCheckpoint(action.checkpointId);
        return;
      case "revealSecret":
        this.claimSecret(action.secretId);
        return;
      case "startBoss":
        this.boss?.start(triggerId);
        return;
      case "completeLevel":
        this.completeLevel();
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Simulation events
  // -------------------------------------------------------------------------

  private onKill(payload: KillPayload): void {
    const now = this.match.now();
    if (payload.victimId === LOCAL_PLAYER_ID) {
      this.onPlayerDied();
      return;
    }

    const entry = this.roster.handleKill(payload.victimId, now);
    if (entry && payload.killerId === LOCAL_PLAYER_ID) {
      this.score.recordKill(entry.points, now);
    }
  }

  private onGroupCleared(group: string): void {
    const now = this.match.now();
    this.encounters.onGroupCleared(group);
    this.boss?.onGroupCleared(group);
    this.triggers.notifyEnemiesKilled(group, now);
  }

  private onDamage(payload: DamagePayload): void {
    if (payload.attackerId === LOCAL_PLAYER_ID && payload.victimId !== LOCAL_PLAYER_ID) {
      this.score.recordHit();
    }
  }

  private onMeleeSwing(payload: MeleeSwingPayload): void {
    if (payload.sessionId !== LOCAL_PLAYER_ID) return;
    this.score.recordShot();
    if (payload.connected) this.score.recordHit();
  }

  private onCrateDestroyed(payload: CrateDestroyedPayload): void {
    for (const [group, crates] of this.crateGroups) {
      if (!crates.delete(payload.crateId)) continue;
      if (crates.size === 0) {
        this.crateGroups.delete(group);
        this.triggers.notifyObjectsDestroyed(group, this.match.now());
      }
      break;
    }
  }

  /** Count the player's projectiles once each; pellets count per pellet. */
  private countShots(): void {
    for (const [id, projectile] of this.match.state.projectiles) {
      if (projectile.ownerId !== LOCAL_PLAYER_ID || this.countedShots.has(id)) continue;
      this.countedShots.add(id);
      this.score.recordShot();
    }
    // The set only ever grows during a level; bound it loosely.
    if (this.countedShots.size > 4096) this.countedShots.clear();
  }

  // -------------------------------------------------------------------------
  // Checkpoints, secrets, death, completion
  // -------------------------------------------------------------------------

  private pollCheckpoints(): void {
    const player = this.player();
    if (!player?.alive) return;
    for (const checkpoint of this.level.checkpoints) {
      if (this.claimedCheckpoints.has(checkpoint.id)) continue;
      if (this.inZone(checkpoint.zone, player.x, player.y)) this.claimCheckpoint(checkpoint.id);
    }
  }

  private claimCheckpoint(checkpointId: string): void {
    const checkpoint = this.checkpointById(checkpointId);
    if (!checkpoint || this.claimedCheckpoints.has(checkpointId)) return;
    this.claimedCheckpoints.add(checkpointId);
    this.lastCheckpoint = { id: checkpointId, x: checkpoint.x, y: checkpoint.y };

    const player = this.player();
    this.save.saveCheckpoint({
      levelId: this.level.id,
      difficulty: this.difficulty,
      checkpointId,
      firedTriggers: this.triggers.firedIds(),
      completedEncounters: this.encounters.completedIds(),
      secretsFound: Array.from(this.foundSecrets),
      score: this.score.snapshot(),
      elapsedMs: this.elapsedMs(),
      weaponId: player?.weaponId ?? this.level.startingWeapon,
      grenades: player?.grenades ?? 0,
    });

    this.triggers.notifyCheckpointReached(checkpointId, this.match.now());
    this.ui.emit("checkpoint", { id: checkpointId });
  }

  private pollSecrets(): void {
    const player = this.player();
    if (!player?.alive) return;
    for (const secret of this.level.secrets) {
      if (this.foundSecrets.has(secret.id)) continue;
      if (this.inZone(secret.zone, player.x, player.y)) this.claimSecret(secret.id);
    }
  }

  private claimSecret(secretId: string): void {
    const secret = this.level.secrets.find((entry) => entry.id === secretId);
    if (!secret || this.foundSecrets.has(secretId)) return;
    this.foundSecrets.add(secretId);
    this.score.recordSecret(secret.points);
    this.ui.emit("secretFound", { id: secretId, message: secret.message ?? "Secret found" });
  }

  private onPlayerDied(): void {
    this.score.recordDeath();

    const rule = this.level.respawnRule;
    if (rule.kind === "oneLife") {
      this.failLevel();
      return;
    }
    if (rule.kind === "lives") {
      this.livesLeft = Math.max(0, (this.livesLeft ?? rule.lives) - 1);
      if (this.livesLeft === 0) {
        this.failLevel();
        return;
      }
    }

    this.respawnAt = this.match.now() + RESPAWN_DELAY_MS;
    this.ui.emit("playerDied", { respawnInMs: RESPAWN_DELAY_MS, livesLeft: this.livesLeft });
  }

  /**
   * Back to the last checkpoint. The world persists -- enemies not part of a
   * stateful fight stay where they were -- but an encounter or boss in
   * progress resets wholesale: its enemies leave, the points they had already
   * paid out come back off the score, and the trigger that started it re-arms.
   */
  private respawn(): void {
    const spawn = this.lastCheckpoint ?? { id: "", ...this.level.playerSpawn };

    const encounterReset = this.encounters.reset();
    if (encounterReset) {
      this.score.deduct(encounterReset.killedPoints, encounterReset.killedCount);
      this.triggers.rearm(encounterReset.startedBy);
    }
    const bossReset = this.boss?.reset() ?? null;
    if (bossReset) {
      this.score.deduct(bossReset.killedPoints, bossReset.killedCount);
      if (bossReset.startedBy) this.triggers.rearm(bossReset.startedBy);
      this.ui.emit("cameraLock", { zoneId: null });
    }

    const player = this.player();
    this.match.respawnLocalPlayer(
      spawn.x,
      spawn.y,
      player?.weaponId ?? this.level.startingWeapon,
      Math.max(player?.grenades ?? 0, this.level.startingGrenades),
    );
  }

  private failLevel(): void {
    if (this.finished || this.failed) return;
    this.failed = true;
    this.ui.emit("levelFailed", {});
  }

  private completeLevel(): void {
    if (this.finished || this.failed) return;
    this.finished = true;

    const result = this.score.finalize(
      this.level.id,
      this.difficulty,
      this.elapsedMs(),
      this.level.parTimeMs,
      this.level.secrets.length,
      this.achievableKillPoints(),
      this.achievableSecretPoints(),
    );
    const progress = this.save.recordResult(result);
    this.save.clearCheckpoint();
    this.ui.emit("levelCompleted", { result, progress });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** What this difficulty makes killable, for the relative rank. */
  private achievableKillPoints(): number {
    let total = 0;
    const count = (spawns: readonly CampaignEnemySpawn[]) => {
      for (const spawn of spawns) {
        if (spawn.difficulties && !spawn.difficulties.includes(this.difficulty)) continue;
        total += getCampaignEnemy(spawn.type)?.points ?? 0;
      }
    };

    for (const trigger of this.level.triggers) {
      for (const action of trigger.actions) {
        if (action.kind === "spawnEnemies") count(action.enemies);
      }
    }
    for (const encounter of this.level.encounters) {
      for (const wave of encounter.waves) count(wave.enemies);
    }
    if (this.level.boss) {
      total += this.level.boss.points;
      for (const phase of this.level.boss.phases) count(phase.spawnAdds ?? []);
    }
    return total;
  }

  private achievableSecretPoints(): number {
    return this.level.secrets.reduce(
      (sum, secret) => sum + (secret.points ?? CAMPAIGN_SCORING.defaultSecretPoints),
      0,
    );
  }

  private checkpointById(id: string): { x: number; y: number } | null {
    const checkpoint = this.level.checkpoints.find((entry) => entry.id === id);
    return checkpoint ? { x: checkpoint.x, y: checkpoint.y } : null;
  }

  private addToCrateGroup(group: string, crateId: string): void {
    let crates = this.crateGroups.get(group);
    if (!crates) this.crateGroups.set(group, (crates = new Set()));
    crates.add(crateId);
  }

  private inZone(zone: CampaignZone, x: number, y: number): boolean {
    return x >= zone.x && x <= zone.x + zone.width && y >= zone.y && y <= zone.y + zone.height;
  }

  // Debug hooks -- the SP debug overlay drives these.

  debugKillAllEnemies(): void {
    // Damage is sanity-capped per hit, so anything tougher than a player
    // takes several -- exactly as it would from real fire.
    for (const player of this.match.aliveEnemies()) {
      for (let hits = 0; hits < 50 && player.alive; hits++) {
        this.match.matchManager.applyDamage(player.sessionId, LOCAL_PLAYER_ID, 1_000_000, player.x, player.y, "debug");
      }
    }
  }

  debugSetGodMode(enabled: boolean): void {
    this.match.godMode = enabled;
  }

  debugTeleport(x: number, y: number): void {
    const player = this.player();
    if (!player) return;
    this.match.respawnLocalPlayer(x, y, player.weaponId, player.grenades);
  }
}
