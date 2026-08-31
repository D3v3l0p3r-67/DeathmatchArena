/**
 * The level, drawn over its arena, with everything placeable draggable.
 *
 * The arena itself is read-only scenery here -- geometry belongs to the arena
 * editor. What this canvas owns is the campaign layer: the player spawn, the
 * boss, checkpoints, camera zones, secrets, trigger zones and every placed
 * enemy. Each is a small descriptor over the working document with its own
 * read/write accessors, so dragging a dot writes straight into the level the
 * panel will save -- there is no second model to fall out of sync.
 */
import {
  SurfaceType,
  type ArenaDefinition,
  type CampaignLevelDefinition,
  type CampaignZone,
} from "@deathmatch/shared";

const INK: Record<string, string> = {
  [SurfaceType.FLOOR]: "#39506f",
  [SurfaceType.PLATFORM]: "#41608a",
  [SurfaceType.WALL]: "#2b3b53",
  [SurfaceType.OBSTACLE]: "#6b4a63",
};

const COLORS = {
  trap: "rgba(255, 107, 107, 0.6)",
  playerSpawn: "#52e08a",
  boss: "#ff5f6d",
  enemy: "#ffa94d",
  checkpoint: "#52e08a",
  cameraZone: "#b39ddb",
  secret: "#ffd75e",
  triggerZone: "#38bdf8",
  spawnPoint: "rgba(255, 255, 255, 0.35)",
} as const;

/** One selectable, draggable thing on the campaign layer. */
export interface LevelObject {
  /** Stable key for reselection across renders. */
  key: string;
  kind: "playerSpawn" | "boss" | "checkpoint" | "cameraZone" | "secret" | "triggerZone" | "enemy";
  label: string;
  /** The draggable anchor, in world px. */
  getPoint(): { x: number; y: number };
  setPoint(x: number, y: number): void;
  /** The zone this object also owns, when it has one. */
  getZone?(): CampaignZone;
  setZone?(zone: CampaignZone): void;
}

/** Every placeable thing in the document, as live accessors into it. */
export function collectObjects(level: CampaignLevelDefinition): LevelObject[] {
  const objects: LevelObject[] = [];

  objects.push({
    key: "playerSpawn",
    kind: "playerSpawn",
    label: "Player spawn",
    getPoint: () => ({ ...level.playerSpawn }),
    setPoint: (x, y) => {
      level.playerSpawn.x = x;
      level.playerSpawn.y = y;
    },
  });

  if (level.boss) {
    const boss = level.boss;
    objects.push({
      key: "boss",
      kind: "boss",
      label: `Boss: ${boss.name}`,
      getPoint: () => ({ x: boss.x, y: boss.y }),
      setPoint: (x, y) => {
        boss.x = x;
        boss.y = y;
      },
    });
  }

  for (const checkpoint of level.checkpoints) {
    objects.push({
      key: `checkpoint:${checkpoint.id}`,
      kind: "checkpoint",
      label: `Checkpoint ${checkpoint.id}`,
      getPoint: () => ({ x: checkpoint.x, y: checkpoint.y }),
      setPoint: (x, y) => {
        // The claim zone follows its respawn point, so a moved checkpoint
        // stays claimable where it now is.
        checkpoint.zone.x += x - checkpoint.x;
        checkpoint.zone.y += y - checkpoint.y;
        checkpoint.x = x;
        checkpoint.y = y;
      },
      getZone: () => ({ ...checkpoint.zone }),
      setZone: (zone) => Object.assign(checkpoint.zone, zone),
    });
  }

  for (const cameraZone of level.cameraZones) {
    objects.push({
      key: `cameraZone:${cameraZone.id}`,
      kind: "cameraZone",
      label: `Camera zone ${cameraZone.id}`,
      getPoint: () => ({ x: cameraZone.zone.x, y: cameraZone.zone.y }),
      setPoint: (x, y) => {
        cameraZone.zone.x = x;
        cameraZone.zone.y = y;
      },
      getZone: () => ({ ...cameraZone.zone }),
      setZone: (zone) => Object.assign(cameraZone.zone, zone),
    });
  }

  for (const secret of level.secrets) {
    objects.push({
      key: `secret:${secret.id}`,
      kind: "secret",
      label: `Secret ${secret.id}`,
      getPoint: () => ({ x: secret.zone.x, y: secret.zone.y }),
      setPoint: (x, y) => {
        secret.zone.x = x;
        secret.zone.y = y;
      },
      getZone: () => ({ ...secret.zone }),
      setZone: (zone) => Object.assign(secret.zone, zone),
    });
  }

  for (const trigger of level.triggers) {
    if (trigger.when.kind === "enterZone") {
      const zone = trigger.when.zone;
      objects.push({
        key: `trigger:${trigger.id}`,
        kind: "triggerZone",
        label: `Trigger ${trigger.id}`,
        getPoint: () => ({ x: zone.x, y: zone.y }),
        setPoint: (x, y) => {
          zone.x = x;
          zone.y = y;
        },
        getZone: () => ({ ...zone }),
        setZone: (next) => Object.assign(zone, next),
      });
    }
    for (const [actionIndex, action] of trigger.actions.entries()) {
      if (action.kind !== "spawnEnemies") continue;
      for (const [enemyIndex, enemy] of action.enemies.entries()) {
        objects.push({
          key: `trigger:${trigger.id}:action:${actionIndex}:enemy:${enemyIndex}`,
          kind: "enemy",
          label: `${enemy.type} (trigger ${trigger.id})`,
          getPoint: () => ({ x: enemy.x, y: enemy.y }),
          setPoint: (x, y) => {
            enemy.x = x;
            enemy.y = y;
          },
        });
      }
    }
  }

  for (const encounter of level.encounters) {
    for (const [waveIndex, wave] of encounter.waves.entries()) {
      for (const [enemyIndex, enemy] of wave.enemies.entries()) {
        objects.push({
          key: `encounter:${encounter.id}:wave:${waveIndex}:enemy:${enemyIndex}`,
          kind: "enemy",
          label: `${enemy.type} (${encounter.id} wave ${waveIndex + 1})`,
          getPoint: () => ({ x: enemy.x, y: enemy.y }),
          setPoint: (x, y) => {
            enemy.x = x;
            enemy.y = y;
          },
        });
      }
    }
  }

  for (const [phaseIndex, phase] of (level.boss?.phases ?? []).entries()) {
    for (const [enemyIndex, enemy] of (phase.spawnAdds ?? []).entries()) {
      objects.push({
        key: `bossPhase:${phaseIndex}:add:${enemyIndex}`,
        kind: "enemy",
        label: `${enemy.type} (boss phase ${phaseIndex + 1})`,
        getPoint: () => ({ x: enemy.x, y: enemy.y }),
        setPoint: (x, y) => {
          enemy.x = x;
          enemy.y = y;
        },
      });
    }
  }

  return objects;
}

interface CanvasHooks {
  onSelect(object: LevelObject | null): void;
  onChanged(): void;
}

export class CampaignLevelCanvas {
  readonly element = document.createElement("canvas");
  private readonly context: CanvasRenderingContext2D;
  private camera = { x: 0, y: 0, scale: 0.5 };
  private objects: LevelObject[] = [];
  private selectedKey: string | null = null;
  private drag: { kind: "pan"; startX: number; startY: number } | { kind: "move"; object: LevelObject; offsetX: number; offsetY: number } | null = null;

  constructor(
    private level: CampaignLevelDefinition,
    private readonly arena: ArenaDefinition,
    private readonly hooks: CanvasHooks,
  ) {
    this.element.className = "campaign-editor__canvas";
    this.context = this.element.getContext("2d")!;
    this.bind();
  }

  /** Replace the working document (e.g. after a JSON apply) and redraw. */
  setLevel(level: CampaignLevelDefinition): void {
    this.level = level;
    this.selectedKey = null;
    this.hooks.onSelect(null);
    this.refresh();
  }

  get selected(): LevelObject | null {
    return this.objects.find((object) => object.key === this.selectedKey) ?? null;
  }

  /** Rebuild descriptors from the document and redraw. */
  refresh(): void {
    this.objects = collectObjects(this.level);
    this.draw();
  }

  /** Size the backing store to the layout box and fit the level into view. */
  fit(): void {
    const box = this.element.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    this.element.width = Math.max(1, Math.round(box.width * ratio));
    this.element.height = Math.max(1, Math.round(box.height * ratio));
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const scale = Math.min(box.height / this.arena.height, box.width / this.arena.width) * 0.95;
    this.camera.scale = Math.max(0.05, scale);
    this.camera.x = 0;
    this.camera.y = this.arena.height / 2 - box.height / this.camera.scale / 2;
    this.refresh();
  }

  private toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const box = this.element.getBoundingClientRect();
    return {
      x: (clientX - box.left) / this.camera.scale + this.camera.x,
      y: (clientY - box.top) / this.camera.scale + this.camera.y,
    };
  }

  private bind(): void {
    this.element.addEventListener("pointerdown", (event) => {
      this.element.setPointerCapture(event.pointerId);
      const world = this.toWorld(event.clientX, event.clientY);
      const hit = this.hitTest(world.x, world.y);
      if (hit) {
        this.selectedKey = hit.key;
        const point = hit.getPoint();
        this.drag = { kind: "move", object: hit, offsetX: world.x - point.x, offsetY: world.y - point.y };
        this.hooks.onSelect(hit);
      } else {
        this.selectedKey = null;
        this.drag = { kind: "pan", startX: event.clientX, startY: event.clientY };
        this.hooks.onSelect(null);
      }
      this.draw();
    });

    this.element.addEventListener("pointermove", (event) => {
      if (!this.drag) return;
      if (this.drag.kind === "pan") {
        this.camera.x -= (event.clientX - this.drag.startX) / this.camera.scale;
        this.camera.y -= (event.clientY - this.drag.startY) / this.camera.scale;
        this.drag.startX = event.clientX;
        this.drag.startY = event.clientY;
      } else {
        const world = this.toWorld(event.clientX, event.clientY);
        this.drag.object.setPoint(
          Math.round(world.x - this.drag.offsetX),
          Math.round(world.y - this.drag.offsetY),
        );
        this.hooks.onChanged();
      }
      this.draw();
    });

    const release = () => {
      this.drag = null;
    };
    this.element.addEventListener("pointerup", release);
    this.element.addEventListener("pointercancel", release);

    this.element.addEventListener("wheel", (event) => {
      event.preventDefault();
      const before = this.toWorld(event.clientX, event.clientY);
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.camera.scale = Math.min(3, Math.max(0.05, this.camera.scale * factor));
      const after = this.toWorld(event.clientX, event.clientY);
      this.camera.x += before.x - after.x;
      this.camera.y += before.y - after.y;
      this.draw();
    });
  }

  /** Points first (they are small), then zones, smallest zone winning. */
  private hitTest(x: number, y: number): LevelObject | null {
    const pointRadius = 14 / this.camera.scale;
    let best: LevelObject | null = null;
    let bestDistance = pointRadius;
    for (const object of this.objects) {
      const point = object.getPoint();
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance <= bestDistance) {
        best = object;
        bestDistance = distance;
      }
    }
    if (best) return best;

    let bestZone: LevelObject | null = null;
    let bestArea = Infinity;
    for (const object of this.objects) {
      const zone = object.getZone?.();
      if (!zone) continue;
      if (x < zone.x || x > zone.x + zone.width || y < zone.y || y > zone.y + zone.height) continue;
      const area = zone.width * zone.height;
      if (area < bestArea) {
        bestZone = object;
        bestArea = area;
      }
    }
    return bestZone;
  }

  draw(): void {
    const context = this.context;
    const box = this.element.getBoundingClientRect();
    context.save();
    context.clearRect(0, 0, box.width, box.height);
    context.fillStyle = "#0a0e16";
    context.fillRect(0, 0, box.width, box.height);
    context.translate(-this.camera.x * this.camera.scale, -this.camera.y * this.camera.scale);
    context.scale(this.camera.scale, this.camera.scale);

    // The arena: scenery, not editable here.
    for (const element of this.arena.elements) {
      context.fillStyle = INK[element.type] ?? INK[SurfaceType.PLATFORM]!;
      context.fillRect(element.x, element.y, element.width, element.height);
    }
    for (const trap of this.arena.traps) {
      if (!trap.enabled) continue;
      context.fillStyle = COLORS.trap;
      context.fillRect(trap.x, trap.y, trap.width, trap.height);
    }
    for (const point of this.arena.powerUpSpawns) {
      if (!point.enabled) continue;
      context.fillStyle = COLORS.spawnPoint;
      context.fillRect(point.x - 6, point.y - 6, 12, 12);
      this.label(point.id, point.x, point.y - 12, COLORS.spawnPoint);
    }

    // The campaign layer.
    for (const object of this.objects) {
      const selected = object.key === this.selectedKey;
      const zone = object.getZone?.();
      if (zone) {
        const color = this.colorFor(object.kind);
        context.lineWidth = (selected ? 3 : 1.5) / this.camera.scale;
        context.strokeStyle = color;
        context.strokeRect(zone.x, zone.y, zone.width, zone.height);
        if (selected) {
          context.fillStyle = color.replace(")", ", 0.08)").replace("rgb", "rgba").replace("#", "#");
          context.globalAlpha = 0.12;
          context.fillStyle = color;
          context.fillRect(zone.x, zone.y, zone.width, zone.height);
          context.globalAlpha = 1;
        }
      }
      const point = object.getPoint();
      const radius = (object.kind === "boss" ? 12 : 7) / Math.max(0.4, Math.min(1, this.camera.scale));
      context.fillStyle = this.colorFor(object.kind);
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fill();
      if (selected) {
        context.lineWidth = 2 / this.camera.scale;
        context.strokeStyle = "#ffffff";
        context.stroke();
      }
      this.label(object.label, point.x, point.y - radius - 6, this.colorFor(object.kind));
    }

    context.restore();
  }

  private colorFor(kind: LevelObject["kind"]): string {
    switch (kind) {
      case "playerSpawn":
        return COLORS.playerSpawn;
      case "boss":
        return COLORS.boss;
      case "enemy":
        return COLORS.enemy;
      case "checkpoint":
        return COLORS.checkpoint;
      case "cameraZone":
        return COLORS.cameraZone;
      case "secret":
        return COLORS.secret;
      case "triggerZone":
        return COLORS.triggerZone;
    }
  }

  private label(text: string, x: number, y: number, color: string): void {
    const context = this.context;
    const size = 12 / this.camera.scale;
    if (size > 60) return; // Zoomed out so far that labels would be noise.
    context.font = `${size}px system-ui, sans-serif`;
    context.fillStyle = color;
    context.textAlign = "center";
    context.fillText(text, x, y);
  }
}
