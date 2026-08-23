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
