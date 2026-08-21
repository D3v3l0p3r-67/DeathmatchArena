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
  grenadeCount: number;
}

/**
 * Diagnostic overlay: FPS, ping, local coordinates, prediction error, pending
 * inputs, room and session ids, and live entity counts.
 *
 * Gated on the server's debug grant, not on the build or the environment: F3
 * does nothing until the server has authorized this session. That keeps every
 * piece of debug tooling behind one decision, made in one place.
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
    grenades: requireElement("debug-grenades"),
  };

  private visible = false;
  /** Set from the server's verdict; nothing local may turn this on. */
  private granted = false;

  constructor() {
    this.setVisible(false);

    window.addEventListener("keydown", (event) => {
      if (event.code !== "F3") return;
      event.preventDefault();
      if (!this.granted) return;
      this.setVisible(!this.visible);
    });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    toggleClass(this.root, "is-active", visible);
  }

  /** Apply the server's debug grant. Losing it hides the overlay immediately. */
  setGranted(granted: boolean): void {
    this.granted = granted;
    if (!granted) this.setVisible(false);
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
    setText(this.fields.grenades, String(snapshot.grenadeCount));
  }
}
