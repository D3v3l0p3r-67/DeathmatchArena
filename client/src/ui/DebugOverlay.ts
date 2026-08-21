import { query, requireElement, setText, toggleClass } from "./dom.js";

export interface DebugSnapshot {
  fps: number;
  ping: number;
  x: number;
  y: number;
  predictionErrorPx: number;
  pendingInputs: number;
  roomId: string;
  sessionId: string;
  playerCount: number;
  projectileCount: number;
  crateCount: number;
  powerUpCount: number;
}

/**
 * Development overlay: FPS, ping, local coordinates, prediction error, pending
 * inputs, room and session ids, and live entity counts.
 *
 * Off by default in production builds. Toggle at runtime with F3, force it on with
 * `?debug=1`, or set `VITE_DEBUG=true` at build time.
 */
export class DebugOverlay {
  private readonly root = query('[data-layer="debug"]');
  private readonly fields = {
    fps: requireElement("debug-fps"),
    ping: requireElement("debug-ping"),
    position: requireElement("debug-position"),
    error: requireElement("debug-error"),
    pending: requireElement("debug-pending"),
    room: requireElement("debug-room"),
    session: requireElement("debug-session"),
    players: requireElement("debug-players"),
    projectiles: requireElement("debug-projectiles"),
    crates: requireElement("debug-crates"),
    powerUps: requireElement("debug-powerups"),
  };

  private visible = false;

  constructor(initiallyVisible: boolean) {
    this.setVisible(initiallyVisible);

    window.addEventListener("keydown", (event) => {
      if (event.code !== "F3") return;
      event.preventDefault();
      this.setVisible(!this.visible);
    });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    toggleClass(this.root, "is-active", visible);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  update(snapshot: DebugSnapshot): void {
    if (!this.visible) return;

    setText(this.fields.fps, snapshot.fps.toFixed(0));
    setText(this.fields.ping, `${snapshot.ping.toFixed(0)} ms`);
    setText(this.fields.position, `${snapshot.x.toFixed(0)}, ${snapshot.y.toFixed(0)}`);
    setText(this.fields.error, `${snapshot.predictionErrorPx.toFixed(2)} px`);
    setText(this.fields.pending, String(snapshot.pendingInputs));
    setText(this.fields.room, snapshot.roomId || "-");
    setText(this.fields.session, snapshot.sessionId || "-");
    setText(this.fields.players, String(snapshot.playerCount));
    setText(this.fields.projectiles, String(snapshot.projectileCount));
    setText(this.fields.crates, String(snapshot.crateCount));
    setText(this.fields.powerUps, String(snapshot.powerUpCount));
  }
}
