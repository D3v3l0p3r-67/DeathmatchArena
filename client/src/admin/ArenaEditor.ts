import {
  clamp,
  SurfaceType,
  nextObjectId,
  trapRegistry,
  type ArenaDefinition,
  type ArenaElement,
  type ArenaIssue,
  type ArenaSpawnPoint,
  type SurfaceTypeValue,
  type TrapDefinition,
} from "@deathmatch/shared";

/** What is currently selected. One namespace of ids, so one reference does it. */
export interface Selection {
  kind: "element" | "playerSpawn" | "powerUpSpawn" | "trap";
  id: string;
}

/** What a click on empty canvas does. */
export type Tool =
  | { kind: "select" }
  | { kind: "place"; what: "element"; elementType: SurfaceTypeValue }
  | { kind: "place"; what: "playerSpawn" | "powerUpSpawn" }
  | { kind: "place"; what: "trap"; trapType: string };

export interface EditorHooks {
  /** The arena changed. `commit` is false while a drag is still in progress. */
  onChange(arena: ArenaDefinition, commit: boolean): void;
  onSelectionChange(selection: Selection | null): void;
  /**
   * The active tool changed.
   *
   * Not only the panel changes it: placing an object drops back to select, and
   * Escape cancels, so the toolbar cannot keep its highlight in step on its own.
   */
  onToolChange(tool: Tool): void;
}

/** Which layers are drawn and can be picked. */
export interface LayerVisibility {
  geometry: boolean;
  playerSpawns: boolean;
  powerUpSpawns: boolean;
  traps: boolean;
}

const ELEMENT_STYLE: Record<string, { fill: string; stroke: string }> = {
  [SurfaceType.FLOOR]: { fill: "#2b3549", stroke: "#5670a0" },
  [SurfaceType.PLATFORM]: { fill: "#32405f", stroke: "#6a86c4" },
  [SurfaceType.WALL]: { fill: "#232b3d", stroke: "#4a5878" },
  [SurfaceType.OBSTACLE]: { fill: "#3d3046", stroke: "#8b66a0" },
};

/** Resize handles, as fractions of the box. */
const HANDLES = [
  { id: "nw", fx: 0, fy: 0 },
  { id: "n", fx: 0.5, fy: 0 },
  { id: "ne", fx: 1, fy: 0 },
  { id: "e", fx: 1, fy: 0.5 },
  { id: "se", fx: 1, fy: 1 },
  { id: "s", fx: 0.5, fy: 1 },
  { id: "sw", fx: 0, fy: 1 },
  { id: "w", fx: 0, fy: 0.5 },
] as const;

const HANDLE_SCREEN_SIZE = 9;
/** Below this, a handle would eat the whole object and leave nowhere to grab it. */
const MIN_HANDLE_SCREEN_SIZE = 3;
const SPAWN_RADIUS = 16;
const MIN_SIZE = 8;

/**
 * The visual arena editor.
 *
 * A canvas, a camera and a hit test. Objects are placed, dragged and resized
 * directly on the map, because the alternative -- typing coordinates into a form
 * -- is how you end up with a platform nobody can reach and no idea why.
 *
 * It edits a copy and reports every change upwards. It never talks to the
 * server: validation and storage belong to the panel around it, and keeping the
 * editor ignorant of both is what makes it possible to test one without the
 * other.
 */
export class ArenaEditor {
  readonly canvas = document.createElement("canvas");

  private context: CanvasRenderingContext2D;
  private arena: ArenaDefinition;
  private selection: Selection | null = null;
  private tool: Tool = { kind: "select" };
  private issues: ArenaIssue[] = [];

  private camera = { x: 0, y: 0, zoom: 0.35 };
  private layers: LayerVisibility = {
    geometry: true,
    playerSpawns: true,
    powerUpSpawns: true,
    traps: true,
  };
  private snap = 10;

  /** In-progress pointer interaction, if any. */
  private drag:
    | { mode: "pan"; startX: number; startY: number; cameraX: number; cameraY: number }
    | { mode: "move"; offsetX: number; offsetY: number }
    | { mode: "resize"; handle: string; origin: { x: number; y: number; width: number; height: number } }
    | null = null;

  private frameRequested = false;
  /**
   * Whether the view has been fitted to the arena yet.
   *
   * A canvas has no real size until it is laid out, and fitting to a 300x150
   * default would leave the camera wildly wrong -- the arena would still draw,
   * but every click would land somewhere else entirely. So the first genuine
   * resize is what frames the view.
   */
  private framed = false;
  private readonly resizeObserver: ResizeObserver;

  constructor(
    arena: ArenaDefinition,
    private readonly hooks: EditorHooks,
  ) {
    this.arena = structuredClone(arena);
    this.canvas.className = "editor__canvas";
    this.canvas.tabIndex = 0;

    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot provide a 2D canvas.");
    this.context = context;

    this.attachPointerHandlers();
    this.attachKeyboardHandlers();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  getArena(): ArenaDefinition {
    return structuredClone(this.arena);
  }

  /** Replace the arena wholesale, e.g. after loading or an undo. */
  setArena(arena: ArenaDefinition, keepSelection = false): void {
    this.arena = structuredClone(arena);
    if (!keepSelection || !this.selectionStillExists()) this.select(null);
    this.draw();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.canvas.style.cursor = tool.kind === "place" ? "crosshair" : "default";
    this.hooks.onToolChange(tool);
  }

  getTool(): Tool {
    return this.tool;
  }

  setLayers(layers: LayerVisibility): void {
    this.layers = { ...layers };
    this.draw();
  }

  getLayers(): LayerVisibility {
    return { ...this.layers };
  }

  setSnap(snap: number): void {
    this.snap = Math.max(1, snap);
  }

  getSnap(): number {
    return this.snap;
  }

  /** Highlight the objects the validator complained about. */
  setIssues(issues: readonly ArenaIssue[]): void {
    this.issues = [...issues];
    this.draw();
  }

  getSelection(): Selection | null {
    return this.selection;
  }

  select(selection: Selection | null): void {
    this.selection = selection;
    this.hooks.onSelectionChange(selection);
    this.draw();
  }

  /**
   * Fit the whole arena in view.
   *
   * Does nothing until the canvas has been laid out; `resize` calls it again as
   * soon as it has, so an early call from a caller that cannot know is harmless.
   */
  frameAll(): void {
    // Measured from the element, not from the backing store: a canvas that has
    // not been sized yet still reports the HTML default of 300x150, and framing
    // against that leaves the camera far enough off that every click lands
    // somewhere other than where it was aimed.
    const rect = this.canvas.getBoundingClientRect();
    const { width, height } = rect;
    if (width <= 1 || height <= 1) return;

    this.framed = true;
    const zoom = Math.min(width / this.arena.width, height / this.arena.height) * 0.92;
    this.camera.zoom = clamp(zoom, 0.05, 4);
    this.camera.x = (this.arena.width - width / this.camera.zoom) / 2;
    this.camera.y = (this.arena.height - height / this.camera.zoom) / 2;
    this.draw();
  }

  /** Apply an edit to the selected object and report it. */
  updateSelected(patch: Record<string, unknown>): void {
    const target = this.findSelected();
    if (!target) return;
    Object.assign(target as object, patch);
    this.commit();
  }

  deleteSelected(): void {
    if (!this.selection) return;
    const { kind, id } = this.selection;

    if (kind === "element") this.arena.elements = this.arena.elements.filter((item) => item.id !== id);
    else if (kind === "trap") this.arena.traps = this.arena.traps.filter((item) => item.id !== id);
    else if (kind === "playerSpawn") {
      this.arena.playerSpawns = this.arena.playerSpawns.filter((item) => item.id !== id);
    } else this.arena.powerUpSpawns = this.arena.powerUpSpawns.filter((item) => item.id !== id);

    this.select(null);
    this.commit();
  }

  /** Copy the selection, offset a little so the copy is visible. */
  duplicateSelected(): void {
    const target = this.findSelected();
    if (!target || !this.selection) return;

    const offset = 24;
    const { kind } = this.selection;

    if (kind === "element") {
      const copy = { ...structuredClone(target as ArenaElement), id: nextObjectId("element", this.allObjects()) };
      copy.x += offset;
      copy.y += offset;
      this.arena.elements.push(copy);
      this.select({ kind, id: copy.id });
    } else if (kind === "trap") {
      const copy = { ...structuredClone(target as TrapDefinition), id: nextObjectId("trap", this.allObjects()) };
      copy.x += offset;
      copy.y += offset;
      this.arena.traps.push(copy);
      this.select({ kind, id: copy.id });
    } else {
      const list = kind === "playerSpawn" ? this.arena.playerSpawns : this.arena.powerUpSpawns;
      const prefix = kind === "playerSpawn" ? "spawn" : "crate";
      const copy = { ...structuredClone(target as ArenaSpawnPoint), id: nextObjectId(prefix, this.allObjects()) };
      copy.x += offset;
      list.push(copy);
      this.select({ kind, id: copy.id });
    }

    this.commit();
  }

  destroy(): void {
    this.resizeObserver.disconnect();
  }

  // -------------------------------------------------------------------------
  // Pointer interaction
  // -------------------------------------------------------------------------

  private attachPointerHandlers(): void {
    this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
    this.canvas.addEventListener("pointercancel", () => this.endDrag(false));
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.canvas.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
  }

  private onPointerDown(event: PointerEvent): void {
    this.canvas.focus();
    this.canvas.setPointerCapture(event.pointerId);
    const world = this.toWorld(event);

    // Middle button and right button always pan, whatever the tool is: getting
    // around the map must never depend on which tool happens to be selected.
    if (event.button === 1 || event.button === 2) {
      this.drag = { mode: "pan", startX: event.clientX, startY: event.clientY, cameraX: this.camera.x, cameraY: this.camera.y };
      return;
    }

    if (this.tool.kind === "place") {
      this.place(world);
      return;
    }

    const handle = this.hitHandle(event);
    if (handle) {
      const box = this.selectedBox();
      if (box) {
        this.drag = { mode: "resize", handle, origin: { ...box } };
        return;
      }
    }

    const hit = this.hitTest(world);
    this.select(hit);

    if (hit) {
      const target = this.findSelected();
      if (target) {
        this.drag = {
          mode: "move",
          offsetX: world.x - (target as { x: number }).x,
          offsetY: world.y - (target as { y: number }).y,
        };
      }
      return;
    }

    this.drag = { mode: "pan", startX: event.clientX, startY: event.clientY, cameraX: this.camera.x, cameraY: this.camera.y };
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.drag) return;

    if (this.drag.mode === "pan") {
      const scale = this.camera.zoom;
      this.camera.x = this.drag.cameraX - (event.clientX - this.drag.startX) / scale;
      this.camera.y = this.drag.cameraY - (event.clientY - this.drag.startY) / scale;
      this.draw();
      return;
    }

    const world = this.toWorld(event);
    const target = this.findSelected();
    if (!target) return;

    if (this.drag.mode === "move") {
      const moved = target as { x: number; y: number };
      moved.x = this.snapValue(world.x - this.drag.offsetX);
      moved.y = this.snapValue(world.y - this.drag.offsetY);
      this.hooks.onChange(this.getArena(), false);
      this.draw();
      return;
    }

    this.applyResize(target as { x: number; y: number; width: number; height: number }, world);
    this.hooks.onChange(this.getArena(), false);
    this.draw();
  }

  private onPointerUp(event: PointerEvent): void {
    this.canvas.releasePointerCapture(event.pointerId);
    this.endDrag(true);
  }

  private endDrag(commit: boolean): void {
    const wasEditing = this.drag !== null && this.drag.mode !== "pan";
    this.drag = null;
    // A pan changed nothing about the arena, so it is not worth an undo entry.
    if (commit && wasEditing) this.commit();
  }

  /** Resize from one handle, keeping the opposite edge pinned. */
  private applyResize(
    box: { x: number; y: number; width: number; height: number },
    world: { x: number; y: number },
  ): void {
    if (!this.drag || this.drag.mode !== "resize") return;
    const origin = this.drag.origin;
    const handle = this.drag.handle;

    let left = origin.x;
    let top = origin.y;
    let right = origin.x + origin.width;
    let bottom = origin.y + origin.height;

    if (handle.includes("w")) left = this.snapValue(world.x);
    if (handle.includes("e")) right = this.snapValue(world.x);
    if (handle.includes("n")) top = this.snapValue(world.y);
    if (handle.includes("s")) bottom = this.snapValue(world.y);

    // Dragging an edge past its opposite would invert the box; stopping at the
    // minimum keeps the object where the cursor last made sense.
    box.x = Math.min(left, right - MIN_SIZE);
    box.y = Math.min(top, bottom - MIN_SIZE);
    box.width = Math.max(MIN_SIZE, right - left);
    box.height = Math.max(MIN_SIZE, bottom - top);
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    const before = this.toWorld(event);
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.camera.zoom = clamp(this.camera.zoom * factor, 0.05, 4);

    // Zoom towards the cursor rather than the centre, so the thing being looked
    // at stays under the pointer.
    const after = this.toWorld(event);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
    this.draw();
  }

  private attachKeyboardHandlers(): void {
    this.canvas.addEventListener("keydown", (event) => {
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        this.deleteSelected();
        return;
      }
      if (event.key === "Escape") {
        this.setTool({ kind: "select" });
        this.select(null);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        this.duplicateSelected();
        return;
      }

      // Arrow keys nudge: one pixel for precision, a snap step with shift.
      const step = event.shiftKey ? this.snap : 1;
      const nudges: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const nudge = nudges[event.key];
      if (!nudge) return;

      const target = this.findSelected() as { x: number; y: number } | null;
      if (!target) return;
      event.preventDefault();
      target.x += nudge[0];
      target.y += nudge[1];
      this.commit();
    });
  }

  // -------------------------------------------------------------------------
  // Creating objects
  // -------------------------------------------------------------------------

  private place(world: { x: number; y: number }): void {
    const x = this.snapValue(world.x);
    const y = this.snapValue(world.y);
    if (this.tool.kind !== "place") return;

    if (this.tool.what === "element") {
      const element: ArenaElement = {
        id: nextObjectId("element", this.allObjects()),
        type: this.tool.elementType,
        // Placed centred on the click: the cursor is where you meant it to be,
        // not where its top-left corner should end up.
        x: x - 100,
        y: y - 12,
        width: 200,
        height: 24,
      };
      this.arena.elements.push(element);
      this.select({ kind: "element", id: element.id });
    } else if (this.tool.what === "trap") {
      const trap = trapRegistry.createTrap(this.tool.trapType, nextObjectId("trap", this.allObjects()), 0, 0);
      if (!trap) return;
      trap.x = x - trap.width / 2;
      trap.y = y - trap.height / 2;
      this.arena.traps.push(trap);
      this.select({ kind: "trap", id: trap.id });
    } else {
      const isPlayer = this.tool.what === "playerSpawn";
      const spawn: ArenaSpawnPoint = {
        id: nextObjectId(isPlayer ? "spawn" : "crate", this.allObjects()),
        x,
        y,
        enabled: true,
      };
      (isPlayer ? this.arena.playerSpawns : this.arena.powerUpSpawns).push(spawn);
      this.select({ kind: this.tool.what, id: spawn.id });
    }

    // One click, one object: staying in place mode would carpet the map with
    // platforms every time somebody tried to reposition the one they just made.
    this.setTool({ kind: "select" });
    this.commit();
  }

  // -------------------------------------------------------------------------
  // Hit testing
  // -------------------------------------------------------------------------

  /**
   * What is under the cursor.
   *
   * Traps first, then spawn points, then geometry -- smallest and most fiddly on
   * top, so a spawn marker sitting on a floor is still selectable.
   */
  private hitTest(world: { x: number; y: number }): Selection | null {
    if (this.layers.traps) {
      for (const trap of [...this.arena.traps].reverse()) {
        if (insideBox(world, trap)) return { kind: "trap", id: trap.id };
      }
    }

    const spawnRadius = SPAWN_RADIUS / this.camera.zoom;
    if (this.layers.playerSpawns) {
      for (const spawn of [...this.arena.playerSpawns].reverse()) {
        if (near(world, spawn, spawnRadius)) return { kind: "playerSpawn", id: spawn.id };
      }
    }
    if (this.layers.powerUpSpawns) {
      for (const spawn of [...this.arena.powerUpSpawns].reverse()) {
        if (near(world, spawn, spawnRadius)) return { kind: "powerUpSpawn", id: spawn.id };
      }
    }

    if (this.layers.geometry) {
      for (const element of [...this.arena.elements].reverse()) {
        if (insideBox(world, element)) return { kind: "element", id: element.id };
      }
    }

    return null;
  }

  /**
   * How big a resize handle should be for the selected box, in screen pixels.
   *
   * Fixed-size handles are unusable on a thin object: a floor 3200px wide and
   * 60px tall is about fifteen screen pixels tall when the whole arena is in
   * view, so nine-pixel handles would cover all of it and it could only ever be
   * resized, never moved. Shrinking them with the box leaves a band in the
   * middle to grab.
   */
  private handleSize(box: { width: number; height: number }): number {
    const shortest = Math.min(box.width, box.height) * this.camera.zoom;
    return Math.max(MIN_HANDLE_SCREEN_SIZE, Math.min(HANDLE_SCREEN_SIZE, shortest / 3));
  }

  private hitHandle(event: PointerEvent): string | null {
    const box = this.selectedBox();
    if (!box) return null;

    const point = this.toScreen(event);
    const reach = this.handleSize(box);

    for (const handle of HANDLES) {
      const hx = (box.x + box.width * handle.fx - this.camera.x) * this.camera.zoom;
      const hy = (box.y + box.height * handle.fy - this.camera.y) * this.camera.zoom;
      if (Math.abs(point.x - hx) <= reach && Math.abs(point.y - hy) <= reach) {
        return handle.id;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /** Coalesce draws into one per frame; a drag fires far more often than that. */
  private draw(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.paint();
    });
  }

  private resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);

    // The first time the canvas has a real size is the first time framing can
    // mean anything, so that is when it happens.
    if (!this.framed && rect.width > 1 && rect.height > 1) {
      this.frameAll();
      return;
    }
    this.draw();
  }

  private paint(): void {
    const ctx = this.context;
    const ratio = window.devicePixelRatio || 1;
    const width = this.canvas.width / ratio;
    const height = this.canvas.height / ratio;

    ctx.save();
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0b0f18";
    ctx.fillRect(0, 0, width, height);

    ctx.translate(-this.camera.x * this.camera.zoom, -this.camera.y * this.camera.zoom);
    ctx.scale(this.camera.zoom, this.camera.zoom);

    this.paintArenaBounds(ctx);
    this.paintGrid(ctx);
    if (this.layers.geometry) this.paintElements(ctx);
    if (this.layers.traps) this.paintTraps(ctx);
    if (this.layers.playerSpawns) this.paintSpawns(ctx, this.arena.playerSpawns, "#37d0ff", "P");
    if (this.layers.powerUpSpawns) this.paintSpawns(ctx, this.arena.powerUpSpawns, "#c9a227", "C");
    this.paintSelection(ctx);

    ctx.restore();
  }

  private paintArenaBounds(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = "#121826";
    ctx.fillRect(0, 0, this.arena.width, this.arena.height);
    ctx.strokeStyle = "#3c4a68";
    ctx.lineWidth = 2 / this.camera.zoom;
    ctx.strokeRect(0, 0, this.arena.width, this.arena.height);
  }

  private paintGrid(ctx: CanvasRenderingContext2D): void {
    // Coarser as you zoom out, so the grid stays a hint rather than a wall of ink.
    const spacing = this.camera.zoom < 0.25 ? 320 : this.camera.zoom < 0.6 ? 160 : 80;
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1 / this.camera.zoom;
    ctx.beginPath();
    for (let x = 0; x <= this.arena.width; x += spacing) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.arena.height);
    }
    for (let y = 0; y <= this.arena.height; y += spacing) {
      ctx.moveTo(0, y);
      ctx.lineTo(this.arena.width, y);
    }
    ctx.stroke();
  }

  private paintElements(ctx: CanvasRenderingContext2D): void {
    for (const element of this.arena.elements) {
      const style = ELEMENT_STYLE[element.type] ?? ELEMENT_STYLE[SurfaceType.PLATFORM]!;
      ctx.fillStyle = style.fill;
      ctx.fillRect(element.x, element.y, element.width, element.height);
      ctx.strokeStyle = this.hasIssue(element.id) ? "#ff4d5e" : style.stroke;
      ctx.lineWidth = (this.hasIssue(element.id) ? 3 : 1.5) / this.camera.zoom;
      ctx.strokeRect(element.x, element.y, element.width, element.height);
    }
  }

  private paintTraps(ctx: CanvasRenderingContext2D): void {
    for (const trap of this.arena.traps) {
      const type = trapRegistry.get(trap.type);
      const color = hex(type?.color ?? 0xef5350);

      ctx.fillStyle = withAlpha(color, trap.enabled ? 0.45 : 0.15);
      ctx.fillRect(trap.x, trap.y, trap.width, trap.height);
      ctx.strokeStyle = this.hasIssue(trap.id) ? "#ff4d5e" : color;
      ctx.lineWidth = 2 / this.camera.zoom;
      if (!trap.enabled) ctx.setLineDash([8 / this.camera.zoom, 6 / this.camera.zoom]);
      ctx.strokeRect(trap.x, trap.y, trap.width, trap.height);
      ctx.setLineDash([]);

      // The label only earns its space once it is legible.
      if (this.camera.zoom > 0.3) {
        ctx.fillStyle = color;
        ctx.font = `${Math.round(14 / this.camera.zoom)}px Inter, system-ui, sans-serif`;
        ctx.fillText(type?.label ?? trap.type, trap.x, trap.y - 6 / this.camera.zoom);
      }
    }
  }

  private paintSpawns(
    ctx: CanvasRenderingContext2D,
    spawns: readonly ArenaSpawnPoint[],
    color: string,
    letter: string,
  ): void {
    const radius = SPAWN_RADIUS / this.camera.zoom;

    for (const spawn of spawns) {
      ctx.beginPath();
      ctx.arc(spawn.x, spawn.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(color, spawn.enabled ? 0.25 : 0.08);
      ctx.fill();
      ctx.strokeStyle = this.hasIssue(spawn.id) ? "#ff4d5e" : color;
      ctx.lineWidth = 2 / this.camera.zoom;
      if (!spawn.enabled) ctx.setLineDash([5 / this.camera.zoom, 4 / this.camera.zoom]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = color;
      ctx.font = `${Math.round(15 / this.camera.zoom)}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(letter, spawn.x, spawn.y);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }
  }

  private paintSelection(ctx: CanvasRenderingContext2D): void {
    if (!this.selection) return;

    const box = this.selectedBox();
    if (!box) return;

    ctx.strokeStyle = "#ffd166";
    ctx.lineWidth = 2 / this.camera.zoom;
    ctx.setLineDash([6 / this.camera.zoom, 4 / this.camera.zoom]);
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    ctx.setLineDash([]);

    // Spawn points are a position, not an area, so they get no resize handles.
    if (this.selection.kind === "playerSpawn" || this.selection.kind === "powerUpSpawn") return;

    const size = this.handleSize(box) / this.camera.zoom;
    ctx.fillStyle = "#ffd166";
    for (const handle of HANDLES) {
      const hx = box.x + box.width * handle.fx;
      const hy = box.y + box.height * handle.fy;
      ctx.fillRect(hx - size / 2, hy - size / 2, size, size);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private commit(): void {
    this.hooks.onChange(this.getArena(), true);
    this.draw();
  }

  /** Every object in the arena, for id generation across the one namespace. */
  private allObjects(): { id: string }[] {
    return [
      ...this.arena.elements,
      ...this.arena.playerSpawns,
      ...this.arena.powerUpSpawns,
      ...this.arena.traps,
    ];
  }

  private findSelected(): ArenaElement | ArenaSpawnPoint | TrapDefinition | null {
    if (!this.selection) return null;
    const { kind, id } = this.selection;

    if (kind === "element") return this.arena.elements.find((item) => item.id === id) ?? null;
    if (kind === "trap") return this.arena.traps.find((item) => item.id === id) ?? null;
    if (kind === "playerSpawn") return this.arena.playerSpawns.find((item) => item.id === id) ?? null;
    return this.arena.powerUpSpawns.find((item) => item.id === id) ?? null;
  }

  private selectionStillExists(): boolean {
    return this.findSelected() !== null;
  }

  /** The selection's box. A spawn point gets a nominal one so it can be outlined. */
  private selectedBox(): { x: number; y: number; width: number; height: number } | null {
    const target = this.findSelected();
    if (!target) return null;

    if ("width" in target) {
      return { x: target.x, y: target.y, width: target.width, height: target.height };
    }

    const radius = SPAWN_RADIUS / this.camera.zoom;
    return { x: target.x - radius, y: target.y - radius, width: radius * 2, height: radius * 2 };
  }

  private hasIssue(objectId: string): boolean {
    return this.issues.some(
      (issue) => issue.severity === "error" && issue.path.split(".").includes(objectId),
    );
  }

  private snapValue(value: number): number {
    return Math.round(value / this.snap) * this.snap;
  }

  private toScreen(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private toWorld(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const point = this.toScreen(event);
    return {
      x: point.x / this.camera.zoom + this.camera.x,
      y: point.y / this.camera.zoom + this.camera.y,
    };
  }
}

// ---------------------------------------------------------------------------

function insideBox(
  point: { x: number; y: number },
  box: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height
  );
}

function near(point: { x: number; y: number }, target: { x: number; y: number }, radius: number): boolean {
  return Math.hypot(point.x - target.x, point.y - target.y) <= radius;
}



function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function withAlpha(color: string, alpha: number): string {
  const value = color.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
