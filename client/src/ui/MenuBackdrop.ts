/**
 * The moving backdrop behind the menus.
 *
 * Every menu used to be a panel on flat near-black, which is the visual
 * signature of a prototype: nothing on screen is alive until you press Play.
 * This drifts a field of embers across three parallax planes behind the
 * panels -- slow enough to never compete with the text in front of it, and
 * cheap enough to run on a machine that has not started the game yet.
 *
 * Deliberately its own canvas in the DOM layer rather than a Phaser scene: it
 * has to be there before the game boots and while no arena is loaded, and it
 * must cost nothing once a match starts, which is a `stop()` away.
 */

interface Ember {
  x: number;
  y: number;
  /** Pixels per second upward. */
  speed: number;
  radius: number;
  alpha: number;
  /** Horizontal sway, so nothing rises in a straight line. */
  drift: number;
  phase: number;
}

/** Three planes: far ones are small, dim and slow. */
const PLANES = [
  { count: 26, speed: 6, radius: 1.1, alpha: 0.16 },
  { count: 16, speed: 11, radius: 1.7, alpha: 0.24 },
  { count: 9, speed: 18, radius: 2.4, alpha: 0.34 },
];

export class MenuBackdrop {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private embers: Ember[] = [];
  private frame = 0;
  private lastAt = 0;
  private running = false;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "menu-backdrop";
    parent.prepend(this.canvas);
    this.context = this.canvas.getContext("2d");

    window.addEventListener("resize", () => this.resize());
    this.resize();
    this.seed();
  }

  start(): void {
    if (this.running || !this.context) return;
    this.running = true;
    this.lastAt = performance.now();
    this.frame = requestAnimationFrame((now) => this.tick(now));
    this.canvas.style.opacity = "1";
  }

  /** Stop entirely while a match is on: a menu effect must cost a match nothing. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.canvas.style.opacity = "0";
  }

  private resize(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(window.innerWidth * ratio);
    this.canvas.height = Math.round(window.innerHeight * ratio);
    this.context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  private seed(): void {
    this.embers = [];
    for (const plane of PLANES) {
      for (let i = 0; i < plane.count; i++) {
        this.embers.push({
          x: Math.random() * window.innerWidth,
          y: Math.random() * window.innerHeight,
          speed: plane.speed * (0.7 + Math.random() * 0.6),
          radius: plane.radius * (0.8 + Math.random() * 0.5),
          alpha: plane.alpha * (0.6 + Math.random() * 0.8),
          drift: 4 + Math.random() * 10,
          phase: Math.random() * Math.PI * 2,
        });
      }
    }
  }

  private tick(now: number): void {
    if (!this.running || !this.context) return;

    // Clamped: a backgrounded tab must not teleport every ember on return.
    const deltaSeconds = Math.min(0.1, (now - this.lastAt) / 1000);
    this.lastAt = now;

    const width = window.innerWidth;
    const height = window.innerHeight;
    const context = this.context;
    context.clearRect(0, 0, width, height);

    for (const ember of this.embers) {
      ember.y -= ember.speed * deltaSeconds;
      ember.phase += deltaSeconds;
      // Wrap at the top, and re-cast across the width so the field never
      // settles into visible columns.
      if (ember.y < -8) {
        ember.y = height + 8;
        ember.x = Math.random() * width;
      }

      const x = ember.x + Math.sin(ember.phase) * ember.drift;
      context.globalAlpha = ember.alpha;
      context.fillStyle = "#4bc4ef";
      context.beginPath();
      context.arc(x, ember.y, ember.radius, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;

    this.frame = requestAnimationFrame((next) => this.tick(next));
  }
}
