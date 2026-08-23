import Phaser from "phaser";
import { PLAYER, clamp, getPlayerConfig, getWeapon, lerpAngle } from "@deathmatch/shared";
import { TextureKeys, getPlayerColor, weaponTextureKey } from "../TextureFactory.js";
import { DEATH_ANIMATION } from "../fx/effects.js";

export interface PlayerViewState {
  x: number;
  y: number;
  aimAngle: number;
  facing: number;
  alive: boolean;
  onGround: boolean;
  health: number;
  speedX: number;
  /** What they are carrying, so everyone can see who they are dealing with. */
  weaponId: string;
  /** Grenades on the belt. Server state, like everything else here. */
  grenades: number;
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
  private beltCount = -1;

  /** Elapsed time in the celebration, in ms. Negative when not celebrating. */
  private celebratingFor = -1;
  /** How far off the ground the celebration currently has them, in px. */
  private celebrationLift = 0;

  /** Elapsed time in the death animation, in ms. Negative when not dying. */
  private dyingFor = -1;
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

    this.label = scene.add
      .text(0, PLAYER.NAME_LABEL_OFFSET_Y, name, {
        fontFamily: '"Rajdhani", "Segoe UI", sans-serif',
        fontSize: "14px",
        color: isLocal ? "#37d0ff" : "#e8eefc",
      })
      .setOrigin(0.5, 1)
      .setShadow(0, 2, "#000000", 4, false, true);

    this.container = scene.add
      // Order matters: the weapon draws in front of the body so the barrel is
      // always visible, whichever way the player is aiming.
      .container(0, 0, [
        this.shadow,
        this.body,
        this.visor,
        this.belt,
        this.weapon,
        this.healthBar,
        this.label,
      ])
      .setDepth(isLocal ? 20 : 10);
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

    this.updateWalkCycle(state, deltaSeconds);
    this.updateShadow(state);
    this.drawBelt(state.grenades, aimingLeft);
    this.drawHealthBar(state.health);
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
    this.deathVelocityY = -DEATH_ANIMATION.lift;
    // Thrown away from where the body was facing, which is roughly away from
    // whoever was in front of it.
    this.deathDrift = -this.facingSign() * DEATH_ANIMATION.driftSpeed;

    this.container.setVisible(true);
    this.container.setAlpha(1);
    this.label.setVisible(false);
    this.healthBar.setVisible(false);
    this.weapon.setVisible(false);
    this.belt.setVisible(false);
    this.shadow.setVisible(false);
  }

  /** Put everything back for a new life. */
  private reviveVisuals(): void {
    this.dyingFor = -1;
    this.container.setVisible(true);
    this.container.setAlpha(1);
    this.body.setRotation(0);
    this.body.setScale(1);
    this.label.setVisible(true);
    this.healthBar.setVisible(true);
    this.weapon.setVisible(true);
    this.belt.setVisible(true);
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
      if (this.celebratingFor < 0) this.celebratingFor = 0;
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
  tickCelebration(deltaSeconds: number, hop: number, hz: number): void {
    if (this.celebratingFor < 0) return;

    this.celebratingFor += deltaSeconds * 1000;
    const phase = (this.celebratingFor / 1000) * hz * Math.PI * 2;

    // Absolute sine: the arc of a bounce rather than the sway of a float, and it
    // never dips below the floor they are standing on.
    this.celebrationLift = Math.abs(Math.sin(phase)) * hop;
    // A little tilt with each hop, so it reads as jumping for joy rather than as
    // being lifted.
    this.body.setRotation(Math.sin(phase * 0.5) * 0.14);
  }

  /**
   * Advance the death animation.
   *
   * Called every frame for every view, and a no-op for anyone alive. The delta
   * is whatever the scene hands over -- which is how the same animation plays in
   * slow motion for the kill that ends a match.
   */
  tickDeath(deltaSeconds: number): void {
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

  private updateShadow(state: PlayerViewState): void {
    this.shadow.setVisible(state.onGround);
    this.shadow.setAlpha(state.onGround ? 0.35 : 0);
  }

  private drawHealthBar(health: number): void {
    const width = 34;
    const height = 4;
    const ratio = clamp(health / getPlayerConfig().maxHealth, 0, 1);

    this.healthBar.clear();
    // Hide a full bar to keep the screen calm; damage is what needs attention.
    if (ratio >= 1) return;

    const x = -width / 2;
    const y = PLAYER.NAME_LABEL_OFFSET_Y + 4;

    this.healthBar.fillStyle(0x000000, 0.6);
    this.healthBar.fillRect(x - 1, y - 1, width + 2, height + 2);

    const color = ratio > 0.6 ? 0x52e08a : ratio > 0.3 ? 0xffc857 : 0xff4d5e;
    this.healthBar.fillStyle(color, 1);
    this.healthBar.fillRect(x, y, width * ratio, height);
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
    this.container.destroy(true);
    void this.scene;
  }
}
