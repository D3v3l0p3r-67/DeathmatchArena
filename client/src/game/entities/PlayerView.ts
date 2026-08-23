import Phaser from "phaser";
import { PLAYER, clamp, getPlayerConfig, getWeapon, lerpAngle } from "@deathmatch/shared";
import { TextureKeys, getPlayerColor, weaponTextureKey } from "../TextureFactory.js";

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
  private alive = true;
  /** Tracked so the weapon texture is only swapped when it actually changes. */
  private weaponId = "";
  private beltCount = -1;

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
    this.container.setPosition(state.x, state.y);

    if (this.alive !== state.alive) {
      this.alive = state.alive;
      this.container.setVisible(state.alive);
    }
    if (!state.alive) return;

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
