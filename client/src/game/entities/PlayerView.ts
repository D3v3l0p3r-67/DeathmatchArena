import Phaser from "phaser";
import {
  PLAYER,
  clamp,
  getGaugesConfig,
  getPlayerConfig,
  getReloadDurationMs,
  getWeapon,
  lerpAngle,
  usesAmmo,
} from "@deathmatch/shared";
import { TextureKeys, getPlayerColor, weaponTextureKey } from "../TextureFactory.js";
import { DEATH_ANIMATION, POSE_SETTLE_RATE } from "../fx/effects.js";
import { settleStep } from "../fx/poseSettle.js";
import { TrailRenderer } from "../fx/TrailRenderer.js";

/** Where the wind-up arrow starts, in front of the hand. */
/** How far the weapon may be pushed out to clear the face, and in what steps. */
const HOLD_PUSH_STEPS = 10;
const HOLD_PUSH_PX = 3;

/**
 * How long a celebration may go untouched before the view finishes it itself.
 *
 * Long enough not to fight the finale over a slow frame, short enough that
 * nobody sees the winner hold a half-eased pose.
 */
const CELEBRATION_STALE_MS = 200;

const THROW_ARROW_START = 16;
/** How long it is at no charge, and at full charge. */
const THROW_ARROW_MIN = 14;
const THROW_ARROW_MAX = 62;

export interface PlayerViewState {
  x: number;
  y: number;
  aimAngle: number;
  facing: number;
  alive: boolean;
  onGround: boolean;
  health: number;
  speedX: number;
  /** Rounds left in the magazine, and whether one is being put in. */
  ammo: number;
  reloading: boolean;
  /** What they are carrying, so everyone can see who they are dealing with. */
  weaponId: string;
  /** Grenades on the belt. Server state, like everything else here. */
  grenades: number;
  /**
   * Whether the match is still being played.
   *
   * False the moment it is decided, and the reason a finished arena is still
   * rather than full of players walking on the spot -- see `settlePose`.
   */
  matchLive: boolean;
}

/**
 * Visual representation of one player.
 *
 * Deliberately dumb: it renders whatever state it is handed and owns no gameplay
 * logic. The local player's state comes from prediction, remote players' from
 * interpolation, and both feed the same class -- so they always look consistent.
 */
export class PlayerView {
  readonly container: Phaser.GameObjects.Container;

  private readonly body: Phaser.GameObjects.Image;
  private readonly visor: Phaser.GameObjects.Image;
  private readonly shadow: Phaser.GameObjects.Image;
  private readonly weapon: Phaser.GameObjects.Image;
  private readonly belt: Phaser.GameObjects.Graphics;
  private readonly label: Phaser.GameObjects.Text;
  private readonly healthBar: Phaser.GameObjects.Graphics;
  /** Under the health bar, in the same shape. See `drawAmmoBar`. */
  private readonly ammoBar: Phaser.GameObjects.Graphics;
  /** The wind-up indicator: an arrow from the hand, growing with the charge. */
  private readonly throwArrow: Phaser.GameObjects.Graphics;
  /** Drawn under everybody, so a trail never sits on top of a player. */
  private readonly trail: TrailRenderer;
  private readonly color: number;

  /** Smoothed aim so remote weapons swing rather than snap between patches. */
  private renderedAim = 0;
  private walkCycle = 0;
  /**
   * Null until the first state arrives.
   *
   * A view is created from whatever the room happens to hold -- which between
   * matches is everybody dead -- and assuming "alive" would play a death
   * animation for players who died before this client ever saw them.
   */
  private alive: boolean | null = null;
  /** Tracked so the weapon texture is only swapped when it actually changes. */
  private weaponId = "";
  /** The held weapon's extent around its grip, for keeping it off the face. */
  private weaponExtent: { left: number; right: number; top: number; bottom: number } | null = null;
  private beltCount = -1;
  /** What the bar last drew, so a full-health crowd costs no redraws. */
  private drawnHealth = -1;
  /** What the ammo bar last drew, or null when it drew nothing. */
  private drawnAmmo: string | null = null;
  /** The local clock for the reload sweep; -1 when no reload is running. */
  private reloadStartedAt = -1;
  private reloadFrom = 0;
  private reloadDurationMs = 0;
  /** Whether the throw arrow drew anything last frame; a clear is only owed if so. */
  private throwArrowDrawn = false;

  /** Phase clock for the hop, on the scene's (slowed) time. -1 when not celebrating. */
  private celebratingFor = -1;
  /**
   * The same celebration measured on real time, which is what ends it.
   *
   * Two clocks because they answer different questions. The hop *animates* on
   * the scene's clock so it slows with the finale; the *deadline* cannot, or
   * `celebrateMs` would mean whatever the time scale happened to be -- measured
   * at 8.07s of wall time for a 2200ms constant, most of it spent bouncing
   * behind the results screen.
   */
  private celebratingRealMs = 0;
  /** Scene time of the last celebration tick, to notice when one stops being driven. */
  private celebrationTickedAt = 0;
  /** How far off the ground the celebration currently has them, in px. */
  private celebrationLift = 0;
  /**
   * True once the pose has reached neutral and stopped being written.
   *
   * The whole point of the flag: after a match ends there is one stable frame
   * and then *nothing touches the body again* until play resumes.
   */
  private settled = false;

  /** Elapsed time in the death animation, in ms. Negative when not dying. */
  private dyingFor = -1;
  /** Whether the trail is still fading out behind a body being thrown. */
  private dyingTrailFade = false;
  private deathVelocityY = 0;
  private deathDrift = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    readonly sessionId: string,
    name: string,
    readonly isLocal: boolean,
  ) {
    this.color = getPlayerColor(sessionId, isLocal);

    this.shadow = scene.add
      .image(0, PLAYER.HEIGHT / 2, TextureKeys.PlayerShadow)
      .setOrigin(0.5, 0.5)
      .setAlpha(0.35);

    // The texture and pivot are set from the weapon on the first frame; this is
    // only a placeholder until one is known.
    this.weapon = scene.add.image(0, PLAYER.AIM_ORIGIN_Y, TextureKeys.Weapon).setOrigin(0.15, 0.5);

    this.belt = scene.add.graphics();

    this.body = scene.add.image(0, 0, TextureKeys.PlayerBody).setOrigin(0.5, 0.5).setTint(this.color);

    this.visor = scene.add
      .image(0, -PLAYER.HEIGHT / 2 + 12, TextureKeys.PlayerVisor)
      .setOrigin(0.5, 0.5)
      .setTint(0x0b1220);

    this.healthBar = scene.add.graphics();
    this.ammoBar = scene.add.graphics();
    this.throwArrow = scene.add.graphics();

    this.label = scene.add
      .text(0, PLAYER.NAME_LABEL_OFFSET_Y, name, {
        fontFamily: '"Rajdhani", "Segoe UI", sans-serif',
        fontSize: "14px",
        color: isLocal ? "#37d0ff" : "#e8eefc",
      })
      .setOrigin(0.5, 1)
      .setShadow(0, 2, "#000000", 4, false, true);

    this.container = scene.add
      /*
       * Order matters. The weapon draws in front of the body, so the whole of it
       * is visible whichever way the player is aiming -- which is the point of
       * giving each weapon a silhouette at all. It draws in front of the visor
       * too: a dark bar cut across a rifle reads as a hole in the rifle.
       *
       * Nothing is hidden by that, because the two are kept apart rather than
       * layered apart -- the weapon is held out along the aim, and pushed
       * further out on the angles where it would otherwise cross the face. See
       * `holdDistance`.
       */
      .container(0, 0, [
        this.shadow,
        this.body,
        this.belt,
        this.visor,
        this.weapon,
        this.healthBar,
        this.ammoBar,
        this.throwArrow,
        this.label,
      ])
      .setDepth(isLocal ? 20 : 10);

    this.trail = new TrailRenderer(scene, "player", 8);
  }

  setName(name: string): void {
    if (this.label.text !== name) this.label.setText(name);
  }

  /** Highlight the player currently being spectated. */
  setSpectated(spectated: boolean): void {
    this.label.setColor(spectated ? "#ffc857" : this.isLocal ? "#37d0ff" : "#e8eefc");
    this.body.setAlpha(spectated || !this.isLocal ? 1 : 1);
  }

  apply(state: PlayerViewState, deltaSeconds: number): void {
    if (this.alive !== state.alive) {
      const known = this.alive !== null;
      this.alive = state.alive;

      if (!known) this.container.setVisible(state.alive);
      else if (state.alive) this.reviveVisuals();
      else this.beginDying();
    }

    // A dying body is thrown by `tickDeath`, so its position is its own until
    // the animation ends.
    if (!state.alive) return;

    /*
     * Fed the position being drawn, so the streak follows the path actually
     * taken -- prediction and interpolation included -- rather than a straight
     * line between server patches. Offered every frame whatever the speed is;
     * `TrailPath` decides what is worth recording, and a player who slows down
     * leaves a trail that fades where it is rather than one that cuts out.
     */
    this.trail.update(state.x, state.y, this.scene.time.now);

    // The celebration is an offset on top of the server's position rather than a
    // position of its own: the winner is still a player standing where the
    // server says they are, and this is only how they are drawn.
    this.container.setPosition(state.x, state.y - this.celebrationLift);

    this.applyWeapon(state.weaponId);

    // Aim is smoothed towards the target so 20Hz updates do not look like ratcheting.
    this.renderedAim = lerpAngle(this.renderedAim, state.aimAngle, clamp(deltaSeconds * 22, 0, 1));
    this.weapon.setRotation(this.renderedAim);

    // Flip the body to match the aim rather than the movement direction: in a
    // shooter you look where you shoot.
    const aimingLeft = Math.abs(this.renderedAim) > Math.PI / 2;
    this.body.setFlipX(aimingLeft);
    this.visor.setX(aimingLeft ? -4 : 4);
    this.weapon.setFlipY(aimingLeft);

    // Held out in front, at chest height, and far enough out to clear the face.
    const hold = this.holdDistance(aimingLeft);
    this.weapon.setPosition(
      Math.cos(this.renderedAim) * hold,
      PLAYER.AIM_ORIGIN_Y + Math.sin(this.renderedAim) * hold,
    );

    this.updateWalkCycle(state, deltaSeconds);
    this.updateShadow(state);
    this.drawBelt(state.grenades, aimingLeft);
    this.drawHealthBar(state.health);
    this.drawAmmoBar(state);
  }

  /**
   * Throw the body.
   *
   * Started on the transition to dead and advanced by `tickDeath`, which the
   * scene calls every frame -- deliberately not from `apply`, because the state
   * of a dead player stops changing and there would be nothing to drive it.
   */
  private beginDying(): void {
    this.dyingFor = 0;
    // A thrown body is moving but no longer travelling. `tickDeath` keeps
    // fading whatever the trail already holds, so it thins out behind the
    // corpse instead of disappearing with the last frame of running.
    this.dyingTrailFade = true;
    this.deathVelocityY = -DEATH_ANIMATION.lift;
    // Thrown away from where the body was facing, which is roughly away from
    // whoever was in front of it.
    this.deathDrift = -this.facingSign() * DEATH_ANIMATION.driftSpeed;

    this.container.setVisible(true);
    this.container.setAlpha(1);
    this.label.setVisible(false);
    this.healthBar.setVisible(false);
    this.ammoBar.setVisible(false);
    this.weapon.setVisible(false);
    this.throwArrow.setVisible(false);
    this.belt.setVisible(false);
    this.shadow.setVisible(false);
  }

  /** Put everything back for a new life. */
  private reviveVisuals(): void {
    this.dyingFor = -1;
    this.dyingTrailFade = false;
    this.drawnAmmo = null;
    // A respawn is a teleport: the path from where they died to where they came
    // back is not a path anything travelled.
    this.trail.clear();
    this.drawnHealth = -1;
    this.container.setVisible(true);
    this.container.setAlpha(1);
    this.body.setRotation(0);
    this.body.setScale(1);
    this.label.setVisible(true);
    this.healthBar.setVisible(true);
    this.ammoBar.setVisible(true);
    this.weapon.setVisible(true);
    this.throwArrow.setVisible(true);
    this.belt.setVisible(true);
    // Every part the death animation touched has to come back, and the visor is
    // the one it fades rather than hides -- so it is also the one that is easy
    // to forget. Left out, a player who has died once has no eyes for the rest
    // of the session, and by the second match nobody in the arena has any.
    this.visor.setAlpha(1);
    this.visor.setVisible(true);
    this.beltCount = -1;
  }

  /**
   * Start or stop celebrating.
   *
   * Presentation only, and only ever used on the winner after a match has been
   * decided: nothing here touches where the player actually is.
   */
  setCelebrating(celebrating: boolean): void {
    if (celebrating) {
      if (this.celebratingFor < 0) {
        this.celebratingFor = 0;
        this.celebratingRealMs = 0;
      }
      return;
    }

    this.celebratingFor = -1;
    this.celebrationLift = 0;
    this.body.setRotation(0);
  }

  /**
   * Advance the celebration: a series of hops on the spot.
   *
   * Driven by the scene's clock like the death animation, so it slows down with
   * the finale rather than running at full speed underneath it.
   */
  tickCelebration(
    scaledSeconds: number,
    realSeconds: number,
    hop: number,
    hz: number,
    durationMs: number,
  ): void {
    if (this.celebratingFor < 0) return;

    this.celebrationTickedAt = this.scene.time.now;
    this.celebratingFor += scaledSeconds * 1000;
    this.celebratingRealMs += realSeconds * 1000;

    /*
     * The view ends its own celebration rather than waiting to be told. An
     * earlier attempt had the scene decide, from the finale's elapsed time --
     * and the call never fired even once, because that clock is not the one
     * this animation actually runs on. A hop that only stops when somebody
     * else remembers to stop it is how the winner ended up bouncing with no
     * resting frame in the first place.
     */
    if (this.celebratingRealMs >= durationMs) {
      this.endCelebration(scaledSeconds);
      return;
    }

    const phase = (this.celebratingFor / 1000) * hz * Math.PI * 2;

    // Absolute sine: the arc of a bounce rather than the sway of a float, and it
    // never dips below the floor they are standing on.
    this.celebrationLift = Math.abs(Math.sin(phase)) * hop;
    // A little tilt with each hop, so it reads as jumping for joy rather than as
    // being lifted.
    this.body.setRotation(Math.sin(phase * 0.5) * 0.14);
  }

  /**
   * Bring the celebration to a close and stop it.
   *
   * Eased rather than cut: the hop comes down to the floor and the tilt
   * straightens before anything stops, so the animation concludes instead of
   * being switched off mid-air. Once it is close enough to standing,
   * `setCelebrating(false)` clears both and every later call is a no-op --
   * which is what leaves the winner on one stable frame rather than bouncing
   * for as long as anybody is watching.
   *
   * Called by `tickCelebration` once the celebration has had its time, and
   * safe to call directly to cut one short.
   */
  endCelebration(deltaSeconds: number): void {
    if (this.celebratingFor < 0) return;

    this.celebrationTickedAt = this.scene.time.now;
    const ease = clamp(deltaSeconds * POSE_SETTLE_RATE, 0, 1);
    this.celebrationLift *= 1 - ease;
    this.body.setRotation(this.body.rotation * (1 - ease));

    if (this.celebrationLift < 0.4 && Math.abs(this.body.rotation) < 0.004) {
      this.setCelebrating(false);
    }
  }

  /**
   * Advance the death animation.
   *
   * Called every frame for every view, and a no-op for anyone alive. The delta
   * is whatever the scene hands over -- which is how the same animation plays in
   * slow motion for the kill that ends a match.
   */
  tickDeath(deltaSeconds: number): void {
    if (this.dyingTrailFade) {
      // Not fed, only aged: whatever the trail held at the moment of death
      // finishes fading instead of being cut off with the last living frame.
      this.trail.fade(this.scene.time.now);
      if (this.dyingFor < 0) this.dyingTrailFade = false;
    }

    if (this.dyingFor < 0) return;

    this.dyingFor += deltaSeconds * 1000;
    const progress = clamp(this.dyingFor / DEATH_ANIMATION.durationMs, 0, 1);

    this.deathVelocityY += DEATH_ANIMATION.gravity * deltaSeconds;
    this.container.x += this.deathDrift * deltaSeconds;
    this.container.y += this.deathVelocityY * deltaSeconds;

    this.body.setRotation(this.body.rotation + DEATH_ANIMATION.spin * deltaSeconds);
    // Fades late and shrinks throughout, so the throw is legible before it goes.
    this.container.setAlpha(1 - progress * progress);
    this.body.setScale(1 - progress * 0.35);
    this.visor.setAlpha(1 - progress);

    if (progress < 1) return;

    this.dyingFor = -1;
    this.container.setVisible(false);
  }

  private facingSign(): number {
    return Math.abs(this.renderedAim) > Math.PI / 2 ? -1 : 1;
  }

  /**
   * Show what this player is carrying.
   *
   * The silhouette comes from the weapon definition, so a weapon added through
   * configuration is recognisable across the arena without a change here -- and
   * the pivot comes with it, which is what keeps the muzzle flash on the barrel
   * whatever shape the weapon is.
   */
  private applyWeapon(weaponId: string): void {
    if (weaponId === this.weaponId) return;
    this.weaponId = weaponId;

    const shape = getWeapon(weaponId).silhouette;
    const key = weaponTextureKey(weaponId);
    if (!this.scene.textures.exists(key) || !shape) return;

    this.weapon.setTexture(key);
    this.weapon.setOrigin(shape.gripX / shape.length, shape.gripY / shape.height);

    // The silhouette's extent around the grip, which is what has to be kept off
    // the face. Measured once per weapon rather than per frame.
    this.weaponExtent = {
      left: -shape.gripX,
      right: shape.length - shape.gripX,
      top: -shape.gripY,
      bottom: shape.height - shape.gripY,
    };
  }

  /**
   * How far along the aim to hold the weapon.
   *
   * `WEAPON_FORWARD_X` at rest, and further out on the angles where the
   * silhouette would otherwise cross the visor -- which is every steep upward
   * aim, because a weapon held in front of the chest and pointed at the sky
   * passes the head on its way there.
   *
   * Pushing it *along the aim* rather than layering it behind the face keeps
   * both readable: the whole weapon is visible, the eyes are visible, and the
   * barrel stays on the line the shot leaves along, so the muzzle flash still
   * sits on it.
   */
  private holdDistance(aimingLeft: boolean): number {
    const extent = this.weaponExtent;
    if (!extent) return PLAYER.WEAPON_FORWARD_X;

    const cos = Math.cos(this.renderedAim);
    const sin = Math.sin(this.renderedAim);
    // The visor, in the same body-centred coordinates, with a little room.
    const eyes = {
      left: (aimingLeft ? -4 : 4) - 8,
      right: (aimingLeft ? -4 : 4) + 8,
      top: -PLAYER.HEIGHT / 2 + 12 - 5,
      bottom: -PLAYER.HEIGHT / 2 + 12 + 5,
    };

    for (let step = 0; step <= HOLD_PUSH_STEPS; step++) {
      const hold = PLAYER.WEAPON_FORWARD_X + step * HOLD_PUSH_PX;
      const originX = cos * hold;
      const originY = PLAYER.AIM_ORIGIN_Y + sin * hold;

      // The rotated silhouette's bounding box. Conservative on purpose: a box
      // is easier to reason about than the shape, and erring outwards only ever
      // means holding the weapon a few pixels further from the face.
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const [ex, ey] of [
        [extent.left, extent.top],
        [extent.right, extent.top],
        [extent.right, extent.bottom],
        [extent.left, extent.bottom],
      ] as const) {
        const flipped = aimingLeft ? -ey : ey;
        const x = originX + ex * cos - flipped * sin;
        const y = originY + ex * sin + flipped * cos;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }

      const clear = maxX <= eyes.left || minX >= eyes.right || maxY <= eyes.top || minY >= eyes.bottom;
      if (clear) return hold;
    }

    return PLAYER.WEAPON_FORWARD_X + HOLD_PUSH_STEPS * HOLD_PUSH_PX;
  }

  /**
   * Grenades, worn on the belt.
   *
   * On the character rather than in a corner of the screen, because it is worth
   * knowing how many the *other* player has left -- and because a number in the
   * HUD tells you nothing about the figure charging at you.
   */
  private drawBelt(grenades: number, aimingLeft: boolean): void {
    if (this.beltCount === grenades && this.belt.visible) {
      // Only the side changes with the aim, and that is a flip, not a redraw.
      this.belt.setScale(aimingLeft ? -1 : 1, 1);
      return;
    }
    this.beltCount = grenades;

    this.belt.clear();
    this.belt.setScale(aimingLeft ? -1 : 1, 1);
    if (grenades <= 0) return;

    // Hip height, on the trailing side so the weapon never covers them.
    const radius = 2.6;
    const spacing = 6;
    const startX = -PLAYER.WIDTH / 2 - 1;
    const y = 6;

    for (let i = 0; i < grenades; i++) {
      const x = startX + i * spacing;
      this.belt.fillStyle(0x0b1220, 0.85);
      this.belt.fillCircle(x, y, radius + 1);
      this.belt.fillStyle(0x8fd14f, 1);
      this.belt.fillCircle(x, y, radius);
    }
  }

  /** Cheap procedural "animation": a subtle bob while running, a lean while airborne. */
  private updateWalkCycle(state: PlayerViewState, deltaSeconds: number): void {
    /*
     * A decided match freezes everybody. Without this the walk cycle keeps
     * running off the last velocity the server sent -- which is whatever the
     * player happened to be doing when it ended -- so a match that finishes
     * mid-sprint leaves everyone jogging on the spot for the whole results
     * screen, bobbing between two poses and going nowhere.
     */
    if (!state.matchLive) {
      this.settlePose(deltaSeconds);
      return;
    }

    this.settled = false;
    const speed = Math.abs(state.speedX);

    if (state.onGround && speed > 20) {
      this.walkCycle += deltaSeconds * (6 + speed * 0.03);
      this.body.setY(Math.sin(this.walkCycle * Math.PI) * 1.6);
      this.body.setRotation(Math.sin(this.walkCycle * Math.PI) * 0.03);
    } else if (!state.onGround) {
      this.body.setY(0);
      this.body.setRotation(clamp(state.speedX / 3000, -0.12, 0.12));
    } else {
      this.walkCycle = 0;
      this.body.setY(0);
      this.body.setRotation(0);
    }
    this.visor.setY(-PLAYER.HEIGHT / 2 + 12 + this.body.y);
  }

  /**
   * Bring the pose to rest, once, and then leave it alone.
   *
   * Eased rather than snapped, because the requirement is that an animation in
   * progress *concludes*: a running player settles out of their stride instead
   * of jumping to attention. Once it is close enough the values are set exactly
   * and `settled` latches, after which this writes nothing at all -- which is
   * what stops a finished arena from spending twelve seconds of results screen
   * re-rendering poses that are not changing.
   *
   * A celebrating winner is skipped entirely: the hop owns the pose while it
   * runs, and settling picks up where it leaves off.
   */
  private settlePose(deltaSeconds: number): void {
    if (this.celebratingFor >= 0) {
      /*
       * A celebration still being driven owns the pose; settling picks up
       * after it. But one that has *stopped* being driven has to be finished
       * here, or the winner is left frozen wherever the last tick happened to
       * leave them -- measured at 4.5px off the ground with a 0.009rad tilt,
       * held for the rest of the results screen. The finale stops ticking on
       * its own schedule; the pose cannot depend on that.
       */
      if (this.scene.time.now - this.celebrationTickedAt < CELEBRATION_STALE_MS) return;
      this.endCelebration(deltaSeconds);
      return;
    }

    if (this.settled) return;

    const step = settleStep(this.body.y, this.body.rotation, deltaSeconds);
    if (step.settled) this.walkCycle = 0;
    this.settled = step.settled;

    this.body.setY(step.y);
    this.body.setRotation(step.rotation);
    this.visor.setY(-PLAYER.HEIGHT / 2 + 12 + step.y);
  }

  private updateShadow(state: PlayerViewState): void {
    this.shadow.setVisible(state.onGround);
    this.shadow.setAlpha(state.onGround ? 0.35 : 0);
  }

  private drawHealthBar(health: number): void {
    // Redrawing a Graphics object means re-tessellating it; health changes on
    // hits, not on frames, so a bar that has not changed is not redrawn.
    if (health === this.drawnHealth) return;
    this.drawnHealth = health;

    const width = 34;
    const height = 4;
    const ratio = clamp(health / getPlayerConfig().maxHealth, 0, 1);

    const x = -width / 2;
    const y = PLAYER.NAME_LABEL_OFFSET_Y + 4;

    this.healthBar.clear();

    // Always drawn, full or not. Hiding a full bar kept the screen calmer, but
    // it also meant the one thing you most want to know about somebody across
    // the arena -- whether they are hurt -- was only legible once they were, and
    // an empty space reads as "no information" rather than as "unhurt".
    this.healthBar.fillStyle(0x000000, 0.55);
    this.healthBar.fillRect(x - 1, y - 1, width + 2, height + 2);

    // The empty part stays visible so a short bar reads as a short bar rather
    // than as a small one.
    this.healthBar.fillStyle(0xffffff, 0.12);
    this.healthBar.fillRect(x, y, width, height);

    const color = ratio > 0.6 ? 0x52e08a : ratio > 0.3 ? 0xffc857 : 0xff4d5e;
    this.healthBar.fillStyle(color, 1);
    this.healthBar.fillRect(x, y, width * ratio, height);
  }

  /**
   * The magazine, under the health bar and in the same shape.
   *
   * Same width, same border, same empty track, so the pair reads as one block
   * rather than two unrelated marks -- and drawn for everybody, exactly as the
   * health bar is. That is not an accident of consistency: a bar over somebody
   * says whether they are hurt *and* whether they are out, and an enemy who
   * just started a reload is the clearest opening the game offers.
   *
   * A weapon with no magazine draws nothing at all. The chainsaw never runs
   * out, and an empty track under it would say it can.
   */
  private drawAmmoBar(state: PlayerViewState): void {
    if (!getGaugesConfig().overPlayer) {
      if (this.drawnAmmo !== null) {
        this.ammoBar.clear();
        this.drawnAmmo = null;
      }
      return;
    }

    const weapon = getWeapon(state.weaponId);
    if (!usesAmmo(weapon)) {
      if (this.drawnAmmo !== null) {
        this.ammoBar.clear();
        this.drawnAmmo = null;
      }
      return;
    }

    /*
     * A reload has to animate, so while one is running this redraws every
     * frame; the rest of the time it is skipped exactly as the health bar is.
     * Keyed on the drawn *ratio* rather than the round count, because that is
     * what is actually on screen -- the sweep moves while `ammo` does not.
     */
    const ratio = this.ammoFillRatio(state, weapon);
    const key = `${state.weaponId}:${ratio.toFixed(3)}:${state.reloading}`;
    if (key === this.drawnAmmo) return;
    this.drawnAmmo = key;

    const width = 34;
    const height = 3;
    const x = -width / 2;
    // Directly under the health bar: its own 4px plus a 2px gap.
    const y = PLAYER.NAME_LABEL_OFFSET_Y + 4 + 4 + 2;

    this.ammoBar.clear();
    this.ammoBar.fillStyle(0x000000, 0.55);
    this.ammoBar.fillRect(x - 1, y - 1, width + 2, height + 2);
    this.ammoBar.fillStyle(0xffffff, 0.12);
    this.ammoBar.fillRect(x, y, width, height);

    // Amber while reloading, pale blue otherwise -- the HUD gauge's own two
    // colours, so moving the gauge here did not also change what it means.
    this.ammoBar.fillStyle(state.reloading ? 0xffc857 : 0xdfe9fb, 1);
    this.ammoBar.fillRect(x, y, width * ratio, height);
  }

  /**
   * How full the magazine reads right now, 0..1.
   *
   * Mid-reload that is not the round count: the server does not refill until
   * the reload completes, so a bar drawn from `ammo` would sit frozen and then
   * jump. It sweeps from where the magazine was to full over exactly the
   * duration the server is enforcing -- the same `getReloadDurationMs` the HUD
   * gauge and the weapon system use, so all three agree.
   */
  private ammoFillRatio(state: PlayerViewState, weapon: ReturnType<typeof getWeapon>): number {
    const magazine = Math.max(1, weapon.magazineSize);
    const resting = clamp(state.ammo / magazine, 0, 1);

    if (!state.reloading) {
      this.reloadStartedAt = -1;
      return resting;
    }

    if (this.reloadStartedAt < 0) {
      this.reloadStartedAt = this.scene.time.now;
      this.reloadFrom = resting;
      this.reloadDurationMs = getReloadDurationMs(weapon, state.ammo);
    }

    const elapsed = this.scene.time.now - this.reloadStartedAt;
    const progress = this.reloadDurationMs > 0 ? clamp(elapsed / this.reloadDurationMs, 0, 1) : 1;
    return this.reloadFrom + (1 - this.reloadFrom) * progress;
  }

  /**
   * Show how hard a throw is being wound up.
   *
   * At the hand rather than at the bottom of the screen: the throw happens here,
   * the direction is here, and -- because `chargingGrenade` is synchronised --
   * everybody else can see you winding one up too. A power bar on your own HUD
   * could only ever tell you something you already knew.
   *
   * `progress` is 0..1; anything at or below zero clears it.
   */
  setThrowCharge(progress: number): void {
    // Nobody charging is the common case, and it should cost nothing: the
    // arrow is only cleared when there is something drawn to clear.
    if (progress <= 0) {
      if (this.throwArrowDrawn) {
        this.throwArrow.clear();
        this.throwArrowDrawn = false;
      }
      return;
    }

    this.throwArrow.clear();
    this.throwArrowDrawn = true;

    const charge = clamp(progress, 0, 1);
    const originX = Math.cos(this.renderedAim) * THROW_ARROW_START;
    const originY = PLAYER.AIM_ORIGIN_Y + Math.sin(this.renderedAim) * THROW_ARROW_START;
    const length = THROW_ARROW_MIN + (THROW_ARROW_MAX - THROW_ARROW_MIN) * charge;

    const tipX = originX + Math.cos(this.renderedAim) * length;
    const tipY = originY + Math.sin(this.renderedAim) * length;

    // Green through amber to red, the same reading the health bar uses: how full
    // a thing is, in the colours this game already uses for it.
    const color = charge > 0.75 ? 0xff4d5e : charge > 0.45 ? 0xffc857 : 0x8fd14f;

    this.throwArrow.lineStyle(3, color, 0.9);
    this.throwArrow.beginPath();
    this.throwArrow.moveTo(originX, originY);
    this.throwArrow.lineTo(tipX, tipY);
    this.throwArrow.strokePath();

    // A head, so it reads as a direction rather than as a bar lying on its side.
    const wing = 7;
    const spread = 0.55;
    this.throwArrow.fillStyle(color, 0.95);
    this.throwArrow.fillTriangle(
      tipX,
      tipY,
      tipX - Math.cos(this.renderedAim - spread) * wing,
      tipY - Math.sin(this.renderedAim - spread) * wing,
      tipX - Math.cos(this.renderedAim + spread) * wing,
      tipY - Math.sin(this.renderedAim + spread) * wing,
    );
  }

  /** World position of the muzzle, used for local muzzle-flash placement. */
  getMuzzlePosition(): { x: number; y: number } {
    return {
      x: this.container.x + Math.cos(this.renderedAim) * PLAYER.MUZZLE_OFFSET_X,
      y: this.container.y + PLAYER.AIM_ORIGIN_Y + Math.sin(this.renderedAim) * PLAYER.MUZZLE_OFFSET_X,
    };
  }

  get colorValue(): number {
    return this.color;
  }

  destroy(): void {
    this.trail.destroy();
    this.container.destroy(true);
    void this.scene;
  }
}
