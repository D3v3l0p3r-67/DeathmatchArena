/**
 * Client-side prediction, and specifically how it is *drawn*.
 *
 * The simulation advances in whole 60Hz steps; the display draws whenever it
 * likes. Everything here is about the seam between those two clocks, which is
 * where a jump either looks smooth or looks like it snagged.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CollisionWorld,
  createInputCommand,
  createMovementState,
  getArena,
  type SyncedPlayer,
} from "@deathmatch/shared";

const { PredictionController } = await import("../client/src/net/PredictionController.js");

const world = new CollisionWorld(getArena("foundry"));

/** Just enough of a synchronised player to seed the controller. */
function serverPlayer(overrides: Partial<SyncedPlayer> = {}): SyncedPlayer {
  return {
    ...(createMovementState(600, 1700) as unknown as SyncedPlayer),
    sessionId: "local",
    lastProcessedInput: 0,
    ...overrides,
  } as SyncedPlayer;
}

function controller() {
  const prediction = new PredictionController(world);
  prediction.reset(serverPlayer());
  return prediction;
}

/** One step of holding jump. */
function jump(prediction: InstanceType<typeof PredictionController>, seq: number): void {
  const input = createInputCommand(seq);
  input.jump = true;
  prediction.predict(input);
}

describe("drawing a prediction between steps", () => {
  it("places a frame between the last step and the next", () => {
    const prediction = controller();
    jump(prediction, 1);

    const before = prediction.renderY;
    jump(prediction, 2);

    prediction.setStepProgress(0);
    const atStart = prediction.renderY;
    prediction.setStepProgress(0.5);
    const halfway = prediction.renderY;
    prediction.setStepProgress(1);
    const atEnd = prediction.renderY;

    assert.equal(atStart, before, "no progress into the step means the step has not happened yet");
    assert.ok(atEnd < atStart, "a full step of a jump should have moved upwards");
    assert.ok(
      Math.abs(halfway - (atStart + atEnd) / 2) < 0.001,
      `halfway through should be halfway there, ${halfway}`,
    );
  });

  it("never redraws the same position twice while moving", () => {
    // The stutter this exists to remove: two frames drawn at one step's position
    // and then one frame drawn two steps along.
    const prediction = controller();
    const drawn: number[] = [];

    // A display running at 90Hz against a 60Hz simulation: some frames advance
    // the simulation and some do not.
    let accumulator = 0;
    let seq = 1;
    for (let frame = 0; frame < 60; frame++) {
      accumulator += 1000 / 90;
      while (accumulator >= 1000 / 60) {
        accumulator -= 1000 / 60;
        jump(prediction, seq++);
      }
      prediction.setStepProgress(accumulator / (1000 / 60));
      drawn.push(prediction.renderY);
    }

    let repeats = 0;
    for (let i = 1; i < drawn.length; i++) {
      if (Math.abs(drawn[i]! - drawn[i - 1]!) < 0.0001) repeats++;
    }

    assert.equal(repeats, 0, `${repeats} frames of ${drawn.length} were drawn twice`);
  });

  it("keeps every frame's movement in proportion to the time it covers", () => {
    // Not just "different every frame" -- evenly different. A frame that covers
    // a ninth of a step should move about a ninth of a step's worth.
    const prediction = controller();
    const drawn: number[] = [];

    let accumulator = 0;
    let seq = 1;
    for (let frame = 0; frame < 40; frame++) {
      accumulator += 1000 / 90;
      while (accumulator >= 1000 / 60) {
        accumulator -= 1000 / 60;
        jump(prediction, seq++);
      }
      prediction.setStepProgress(accumulator / (1000 / 60));
      drawn.push(prediction.renderY);
    }

    // While rising, consecutive frames should differ by similar amounts. Gravity
    // changes the speed steadily, so a big spread means the judder is back.
    const steps: number[] = [];
    for (let i = 1; i < 12; i++) steps.push(Math.abs(drawn[i]! - drawn[i - 1]!));
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    const worst = Math.max(...steps.map((step) => Math.abs(step - mean)));

    assert.ok(worst < mean * 0.5, `frames should advance evenly, mean ${mean.toFixed(2)} worst deviation ${worst.toFixed(2)}`);
  });

  it("draws where it was, not where the correction went", () => {
    // A server correction must not tear the interpolation: the frame after one
    // should still be next to the frame before it.
    const prediction = controller();
    for (let seq = 1; seq <= 6; seq++) jump(prediction, seq);

    prediction.setStepProgress(0.5);
    const before = prediction.renderY;

    // The server saw the same jump but is a few pixels off.
    const corrected = serverPlayer({ y: prediction.movement.y + 6, lastProcessedInput: 6 } as Partial<SyncedPlayer>);
    prediction.reconcile(corrected);

    const after = prediction.renderY;
    assert.ok(Math.abs(after - before) < 2, `a small correction should not jump the drawing, ${before} -> ${after}`);
  });
});

describe("predicting your own recoil", () => {
  /*
   * The server shoves the shooter when a shot fires. Before the fire model
   * existed the client never predicted that shove, so every single shot became
   * a reconciliation correction -- the stutter you feel when firing over a real
   * connection. These pin the two halves of the fix: the shove happens on the
   * tick of the trigger pull, and reconciliation replays it for shots the
   * server has not confirmed yet.
   */
  const armed = () =>
    serverPlayer({ weaponId: "assault-rifle", ammo: 30, reloading: false } as Partial<SyncedPlayer>);

  function fire(prediction: InstanceType<typeof PredictionController>, seq: number) {
    const input = createInputCommand(seq);
    input.fire = true;
    return prediction.predict(input);
  }

  it("kicks the shooter backwards on the tick of the trigger pull", () => {
    const prediction = new PredictionController(world);
    prediction.reset(armed());

    const shot = fire(prediction, 1);

    assert.ok(shot, "holding the trigger with a full magazine fires");
    assert.ok(
      prediction.movement.velocityX < -50,
      `firing to the right should shove leftwards, got ${prediction.movement.velocityX}`,
    );
    assert.ok(prediction.movement.knockbackTimer > 0, "recoil opens the knockback decay window");
  });

  it("respects the weapon's fire rate", () => {
    const prediction = new PredictionController(world);
    prediction.reset(armed());

    let shots = 0;
    for (let seq = 1; seq <= 60; seq++) if (fire(prediction, seq)) shots++;

    // 115.4ms between shots at 60 ticks/s: one shot, then one per 7 ticks.
    const expected = 1 + Math.floor((60 - 1) / 7);
    assert.ok(
      Math.abs(shots - expected) <= 1,
      `a second of automatic fire should land about ${expected} shots, got ${shots}`,
    );
  });

  it("replays unconfirmed recoil through reconciliation", () => {
    const prediction = new PredictionController(world);
    const spawn = armed();
    prediction.reset(spawn);

    for (let seq = 1; seq <= 6; seq++) fire(prediction, seq);

    // The server has seen none of it: reconciling against the spawn state must
    // rebuild the same shots on replay, or predicting the recoil would create
    // the very per-shot error it exists to remove.
    prediction.reconcile(spawn);

    assert.ok(
      prediction.getDebugInfo().lastErrorPx < 0.5,
      `replaying pending shots should reproduce the prediction exactly, error was ${
        prediction.getDebugInfo().lastErrorPx
      }px`,
    );
  });

  it("stops predicting when the magazine the server knows about is spent", () => {
    const prediction = new PredictionController(world);
    prediction.reset(armed());

    // Empty the magazine and keep holding the trigger through the reload:
    // ~3.4s to spend 30 rounds, a 1.8s reload, then it resumes.
    let shots = 0;
    for (let seq = 1; seq <= 60 * 8; seq++) if (fire(prediction, seq)) shots++;

    assert.ok(shots > 30, `the reload should complete and firing resume, got ${shots}`);
    assert.ok(shots <= 60, `eight seconds of fire cannot spend two full magazines, got ${shots}`);
  });

  it("adopts the server's weapon on a pickup instead of guessing", () => {
    const prediction = new PredictionController(world);
    prediction.reset(armed());

    fire(prediction, 1);
    // The server re-equipped us (a weapon crate): the model must follow suit.
    prediction.reconcile(
      serverPlayer({ weaponId: "shotgun", ammo: 6, reloading: false, lastProcessedInput: 1 } as Partial<SyncedPlayer>),
    );

    // Release the trigger for a tick -- the new weapon is a semi-automatic, and
    // the model, like the server, demands a fresh pull.
    prediction.predict(createInputCommand(2));
    const shot = fire(prediction, 3);
    assert.ok(shot, "the fresh weapon fires immediately");
    assert.equal(shot!.weaponId, "shotgun");
    assert.equal(shot!.pellets > 1, true, "a shotgun shot carries its pellet count");
  });

  it("semi-automatics need a fresh trigger pull", () => {
    const prediction = new PredictionController(world);
    prediction.reset(
      serverPlayer({ weaponId: "shotgun", ammo: 6, reloading: false } as Partial<SyncedPlayer>),
    );

    assert.ok(fire(prediction, 1), "the first pull fires");
    let shots = 0;
    for (let seq = 2; seq <= 120; seq++) if (fire(prediction, seq)) shots++;
    assert.equal(shots, 0, "holding the trigger on a semi-automatic fires nothing more");
  });
});
