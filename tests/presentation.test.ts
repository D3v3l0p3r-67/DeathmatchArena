/**
 * The sound and effect catalogues.
 *
 * Both are pure data consumed at runtime, which means a malformed entry fails
 * quietly -- a sound that never plays, or a burst that throws mid-frame. These
 * check the shapes instead, so a typo is caught here rather than in a match.
 *
 * Only the data modules are imported; neither touches the DOM.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { MatchState, PLAYER, PLAYER_HALF_WIDTH, listWeapons } from "@deathmatch/shared";

const { SOUNDS, SoundChannel, SoundId, getSound } = await import("../client/src/audio/sounds.js");
const { BURSTS, SHAKES, DEFAULT_EFFECTS_SETTINGS } = await import("../client/src/game/fx/effects.js");
const { SoundThrottle } = await import("../client/src/audio/SoundThrottle.js");
const { shouldHideCursor } = await import("../client/src/ui/cursor.js");
const { normalisePosition, withinRadius } = await import("../client/src/ui/minimapGeometry.js");

describe("sound catalogue", () => {
  const channels = new Set<string>(Object.values(SoundChannel));

  it("defines every sound the game asks for", () => {
    for (const [name, id] of Object.entries(SoundId)) {
      assert.ok(getSound(id), `SoundId.${name} ("${id}") has no definition`);
    }
  });

  it("keys every entry by its own id", () => {
    for (const [key, sound] of Object.entries(SOUNDS)) {
      assert.equal(sound.id, key, `"${key}" is keyed differently from its id`);
    }
  });

  it("routes every sound to a real mixer channel", () => {
    for (const sound of Object.values(SOUNDS)) {
      assert.ok(channels.has(sound.channel), `${sound.id} uses unknown channel "${sound.channel}"`);
    }
  });

  it("gives every sound layers the synthesiser can actually render", () => {
    for (const sound of Object.values(SOUNDS)) {
      assert.ok(sound.layers.length > 0, `${sound.id} has no layers`);

      for (const layer of sound.layers) {
        assert.ok(layer.gain > 0, `${sound.id} has a silent layer`);
        assert.ok(layer.duration > 0, `${sound.id} has a zero-length layer`);
        assert.ok(layer.attack >= 0, `${sound.id} has a negative attack`);
        assert.ok((layer.delay ?? 0) >= 0, `${sound.id} has a negative delay`);

        if (layer.kind === "tone") {
          // Audible range: an oscillator swept to 0 Hz would throw.
          assert.ok(layer.frequency > 20, `${sound.id} has a sub-audible tone`);
          if (layer.sweepTo !== undefined) {
            assert.ok(layer.sweepTo > 0, `${sound.id} sweeps to an invalid frequency`);
          }
        } else {
          assert.ok(layer.cutoff > 0, `${sound.id} has an invalid filter cutoff`);
          if (layer.cutoffTo !== undefined) {
            assert.ok(layer.cutoffTo > 0, `${sound.id} sweeps its filter to an invalid cutoff`);
          }
        }
      }
    }
  });

  it("keeps volumes and jitter within sane bounds", () => {
    for (const sound of Object.values(SOUNDS)) {
      const volume = sound.volume ?? 1;
      assert.ok(volume > 0 && volume <= 1, `${sound.id} has an out-of-range volume`);
      const jitter = sound.pitchJitter ?? 0;
      assert.ok(jitter >= 0 && jitter < 1, `${sound.id} has implausible pitch jitter`);
    }
  });

  it("throttles the sounds that can fire in bursts", () => {
    // A shotgun lands nine pellets at once; without a throttle they stack into
    // one distorted clack rather than a hit.
    for (const id of [SoundId.BulletImpact, SoundId.FleshImpact, SoundId.CrateHit]) {
      const sound = getSound(id)!;
      assert.ok((sound.throttleMs ?? 0) > 0, `${id} should be throttled`);
    }
  });
});

describe("hiding the OS cursor during play", () => {
  it("hides only while a match is running and nothing needs a click", () => {
    assert.equal(shouldHideCursor(MatchState.PLAYING, false), true);
    assert.equal(
      shouldHideCursor(MatchState.PLAYING, true),
      false,
      "the settings panel or debug console needs a real cursor",
    );
    assert.equal(shouldHideCursor(MatchState.WAITING, false), false);
    assert.equal(shouldHideCursor(MatchState.COUNTDOWN, false), false);
    assert.equal(shouldHideCursor(MatchState.FINISHED, false), false);
    assert.equal(shouldHideCursor(undefined, false), false);
  });
});

describe("placing a dot on the minimap", () => {
  it("normalises a world position to a 0..1 fraction of the arena", () => {
    const arena = { width: 2000, height: 1000 } as never;
    assert.deepEqual(normalisePosition(0, 0, arena), { nx: 0, ny: 0 });
    assert.deepEqual(normalisePosition(2000, 1000, arena), { nx: 1, ny: 1 });
    assert.deepEqual(normalisePosition(1000, 500, arena), { nx: 0.5, ny: 0.5 });
  });

  it("clamps a position outside the arena rather than drawing a dot off the panel", () => {
    // A player mid-knockback, or a power-up on the far side of a wall the
    // arena's own bounds do not quite match, still has to land somewhere on a
    // fixed-size panel.
    const arena = { width: 2000, height: 1000 } as never;
    assert.deepEqual(normalisePosition(-500, 2000, arena), { nx: 0, ny: 1 });
  });

  it("treats a radius of 0, or anything nonsensical, as no limit at all", () => {
    // The admin field's own description promises "0 shows the whole arena" --
    // this is the function that promise has to actually hold in.
    assert.equal(withinRadius(0, 0, 5000, 5000, 0), true);
    assert.equal(withinRadius(0, 0, 5000, 5000, -1), true);
    assert.equal(withinRadius(0, 0, 5000, 5000, NaN), true);
  });

  it("otherwise only reveals what is actually within range", () => {
    assert.equal(withinRadius(0, 0, 300, 400, 500), true, "exactly on the boundary (a 3-4-5 triangle)");
    assert.equal(withinRadius(0, 0, 300, 401, 500), false);
    assert.equal(withinRadius(100, 100, 100, 100, 1), true, "the center itself is always in range");
  });
});

describe("rate-limiting a sound", () => {
  it("counts your own hits and other people's separately", () => {
    /*
     * Every hit in the arena reaches every client now. With one window per
     * sound, a faint exchange between two bots across the map could land a few
     * milliseconds before the shot you just fired and silence it -- first come
     * wins, however little it mattered.
     */
    const throttle = new SoundThrottle();

    assert.equal(throttle.allows("flesh-impact", 45, 1.0, "other"), true);
    assert.equal(
      throttle.allows("flesh-impact", 45, 1.01),
      true,
      "somebody else's hit must not swallow your own",
    );
    assert.equal(
      throttle.allows("flesh-impact", 45, 1.02),
      false,
      "your own hits are still rate-limited against each other",
    );
    assert.equal(
      throttle.allows("flesh-impact", 45, 1.02, "other"),
      false,
      "and so are theirs",
    );
  });

  it("lets a sound through once its window has passed", () => {
    const throttle = new SoundThrottle();

    assert.equal(throttle.allows("bullet-impact", 45, 5), true);
    assert.equal(throttle.allows("bullet-impact", 45, 5.04), false);
    // A blocked play does not restart the window, so this is measured from the
    // one that was actually heard.
    assert.equal(throttle.allows("bullet-impact", 45, 5.06), true);
  });

  it("never limits a sound that asked for no limit", () => {
    const throttle = new SoundThrottle();

    for (let i = 0; i < 5; i++) {
      assert.equal(throttle.allows("death", undefined, 2, "other"), true);
    }
  });
});

describe("effect catalogue", () => {
  it("describes bursts that produce visible, finite particles", () => {
    for (const [name, spec] of Object.entries(BURSTS)) {
      assert.ok(spec.count > 0, `${name} spawns nothing`);
      assert.ok(spec.maxSpeed >= spec.minSpeed, `${name} has an inverted speed range`);
      assert.ok(spec.minLife > 0, `${name} has a zero-length particle`);
      assert.ok(spec.maxLife >= spec.minLife, `${name} has an inverted lifetime range`);
      assert.ok(spec.scale > 0, `${name} has invisible particles`);
      assert.ok(Number.isFinite(spec.gravity), `${name} has a non-finite gravity`);
    }
  });

  it("keeps camera shakes short and subtle", () => {
    for (const [name, spec] of Object.entries(SHAKES)) {
      assert.ok(spec.durationMs > 0, `${name} has no duration`);
      // Phaser's intensity is a fraction of the viewport; anything approaching
      // 0.1 is unplayable.
      assert.ok(spec.intensity > 0 && spec.intensity < 0.05, `${name} shakes far too hard`);
    }
  });

  it("ships defaults a player can turn all the way down", () => {
    assert.ok(DEFAULT_EFFECTS_SETTINGS.particleIntensity > 0);
    assert.ok(DEFAULT_EFFECTS_SETTINGS.screenShake > 0);
    // Both are fractions, so 0 is a legal setting and means "off".
    assert.ok(DEFAULT_EFFECTS_SETTINGS.particleIntensity <= 1);
    assert.ok(DEFAULT_EFFECTS_SETTINGS.screenShake <= 1);
  });
});

describe("weapon silhouettes", () => {
  it("gives every weapon a shape someone can recognise across the arena", () => {
    for (const weapon of listWeapons()) {
      const shape = weapon.silhouette;
      assert.ok(shape, `${weapon.id} has no silhouette`);
      assert.ok(shape.length > 0 && shape.height > 0, `${weapon.id} has no size`);
      assert.ok(shape.parts.length > 0, `${weapon.id} would draw as nothing`);
    }
  });

  it("keeps every part inside the texture it is drawn into", () => {
    // A part that overflows is silently clipped, which is the kind of thing you
    // only notice as a weapon that looks subtly wrong from across the map.
    for (const weapon of listWeapons()) {
      const shape = weapon.silhouette;
      for (const [index, part] of shape.parts.entries()) {
        const where = `${weapon.id} part ${index}`;
        assert.ok(part.width > 0 && part.height > 0, `${where} is empty`);
        assert.ok(part.x >= 0 && part.y >= 0, `${where} starts outside the texture`);
        assert.ok(part.x + part.width <= shape.length, `${where} overflows the length`);
        assert.ok(part.y + part.height <= shape.height, `${where} overflows the height`);
      }
    }
  });

  it("puts the grip inside the weapon", () => {
    for (const weapon of listWeapons()) {
      const shape = weapon.silhouette;
      assert.ok(shape.gripX >= 0 && shape.gripX <= shape.length, `${weapon.id} grips off the end`);
      assert.ok(shape.gripY >= 0 && shape.gripY <= shape.height, `${weapon.id} grips off the side`);
    }
  });

  it("puts a ranged weapon's muzzle where the flash is drawn", () => {
    // Three things have to agree about where the barrel ends: the drawn weapon,
    // the muzzle flash, and the point the server spawns projectiles from. The
    // weapon is held `WEAPON_FORWARD_X` in front of the shoulder, so its own
    // reach from grip to muzzle covers the rest of the distance.
    for (const weapon of listWeapons()) {
      if (!weapon.ranged) continue;

      const reach = weapon.silhouette.length - weapon.silhouette.gripX;
      const muzzle = PLAYER.WEAPON_FORWARD_X + reach;

      assert.ok(
        Math.abs(muzzle - PLAYER.MUZZLE_OFFSET_X) <= 4,
        `${weapon.id} reaches ${muzzle}px from the shoulder, but the flash is drawn at ${PLAYER.MUZZLE_OFFSET_X}px`,
      );
    }
  });

  it("never draws two weapons with the same silhouette", () => {
    // The whole point is that another player can read your loadout at a glance,
    // and the way that quietly breaks is a copy-pasted shape on a new weapon.
    const seen = new Map<string, string>();
    for (const weapon of listWeapons()) {
      const signature = JSON.stringify(weapon.silhouette);
      const twin = seen.get(signature);
      assert.equal(twin, undefined, `${weapon.id} is drawn identically to ${twin}`);
      seen.set(signature, weapon.id);
    }
  });
});

describe("reading a player at a glance", () => {
  it("reaches past the body it is held against", () => {
    // A weapon drawn entirely inside the figure is a weapon nobody can identify,
    // which defeats the whole point of giving each one a shape.
    for (const weapon of listWeapons()) {
      const shape = weapon.silhouette;
      const reach = PLAYER.WEAPON_FORWARD_X + (shape.length - shape.gripX);

      assert.ok(
        reach > PLAYER_HALF_WIDTH + 6,
        `${weapon.id} reaches ${reach}px, which is inside the ${PLAYER_HALF_WIDTH}px-wide body`,
      );
    }
  });

  it("keeps a level aim off the visor, whatever is being carried", () => {
    /*
     * The visor is the one part of the figure that says where somebody is
     * looking, so it must stay readable. Two things keep it that way, and this
     * is the first: the hold. Held at chest height and forward along the aim,
     * no weapon in the catalogue touches the face while the aim is level --
     * which is most of a match, since most shots are at somebody standing on
     * the same floor.
     *
     * Aiming steeply up is the case geometry cannot win. A weapon held in front
     * of the chest and pointed at the sky crosses the head at *some* offset:
     * lowering the hold only moves the angle at which it starts. There the draw
     * order does the work instead, which the next test pins.
     */
    const visor = { left: -3, right: 11, top: -15, bottom: -9 };

    for (const weapon of listWeapons()) {
      const shape = weapon.silhouette;

      for (const part of shape.parts) {
        const left = PLAYER.WEAPON_FORWARD_X + (part.x - shape.gripX);
        const right = left + part.width;
        const top = PLAYER.AIM_ORIGIN_Y + (part.y - shape.gripY);
        const bottom = top + part.height;

        const overlapX = Math.min(right, visor.right) - Math.max(left, visor.left);
        const overlapY = Math.min(bottom, visor.bottom) - Math.max(top, visor.top);

        assert.ok(
          overlapX <= 0 || overlapY <= 0,
          `${weapon.id} covers ${Math.max(0, overlapX) * Math.max(0, overlapY)}px² of the visor`,
        );
      }
    }
  });

  it("puts every part of the figure back after a death", () => {
    /*
     * The death animation hides some parts and fades others, and reviving has
     * to undo all of it. The visor is faded rather than hidden, which made it
     * the easy one to forget: leave it out and a player who has died once has
     * no eyes for the rest of the session -- by the second match, nobody in the
     * arena has any. Read from the source, because this is about one method
     * agreeing with two others rather than about any single value.
     */
    const source = readFileSync(
      new URL("../client/src/game/entities/PlayerView.ts", import.meta.url),
      "utf8",
    );

    const body = (name: string): string => {
      // The declaration, not a call site or a mention in a comment: a method on
      // this class starts at two spaces of indentation. `tickDeath` is public
      // because the scene drives it; the rest are private.
      const start = source.search(new RegExp(`\\n  (private )?${name}\\(`));
      assert.ok(start > 0, `PlayerView no longer has ${name}`);
      const open = source.indexOf("{", start);
      let depth = 0;
      for (let i = open; i < source.length; i++) {
        if (source[i] === "{") depth++;
        if (source[i] === "}" && --depth === 0) return source.slice(open, i);
      }
      throw new Error(`could not read ${name}`);
    };

    const dimmed = new Set<string>();
    for (const method of ["beginDying", "tickDeath"]) {
      for (const match of body(method).matchAll(/this\.(\w+)\.set(?:Visible\(false\)|Alpha\()/g)) {
        dimmed.add(match[1]!);
      }
    }
    assert.ok(dimmed.size > 0, "the death animation no longer dims anything");

    const revive = body("reviveVisuals");
    for (const part of dimmed) {
      // The shadow is the one exception, and only because it is not restored so
      // much as re-decided: `updateShadow` sets it from `onGround` every frame.
      if (part === "shadow" || part === "container") continue;
      assert.ok(
        revive.includes(`this.${part}.`),
        `${part} is dimmed when a player dies and never put back when they respawn`,
      );
    }
  });

  it("draws the weapon in front of the visor, and holds it clear of one", () => {
    /*
     * Two rules that only work together. The weapon draws in front of the
     * visor, because a dark bar cut across a rifle reads as a hole in the
     * rifle. Nothing is hidden by that only because the weapon is *held* clear
     * of the face -- out along the aim, and pushed further out on the angles
     * where it would otherwise cross it. Layer them the other way and the eyes
     * cut the gun; hold them together and the gun blanks the eyes.
     */
    const source = readFileSync(
      new URL("../client/src/game/entities/PlayerView.ts", import.meta.url),
      "utf8",
    );
    const children = source.slice(source.indexOf(".container(0, 0, ["));

    const weapon = children.indexOf("this.weapon,");
    const visor = children.indexOf("this.visor,");
    const body = children.indexOf("this.body,");

    assert.ok(weapon > 0 && visor > 0 && body > 0, "the player container no longer lists its parts");
    assert.ok(weapon > body, "the weapon is drawn behind the body, hiding the silhouette");
    assert.ok(weapon > visor, "the visor is drawn over the weapon, cutting a hole in it");
    assert.ok(
      source.includes("holdDistance"),
      "with the weapon in front, only the hold keeps it off the face",
    );
  });
});
