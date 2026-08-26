import { POSE_SETTLE_RATE } from "./effects.js";

/**
 * One step of relaxing an animated pose back to neutral.
 *
 * Pure arithmetic, no Phaser: `PlayerView` owns the sprites, this owns the only
 * part with a decision in it -- how far to move this frame, and when to declare
 * the pose finished.
 *
 * `settled` is the whole point. A match that has been decided should end with
 * one stable frame and then *nothing further written to the body*, so the
 * caller latches on this and stops calling. Without a definite end the pose
 * approaches zero asymptotically and never arrives, which is a body that never
 * quite stops moving.
 */
export interface SettleStep {
  y: number;
  rotation: number;
  /** True once this step reached neutral exactly; the caller may stop. */
  settled: boolean;
}

/** Close enough to standing that the difference is not a frame anybody sees. */
const Y_EPSILON = 0.05;
const ROTATION_EPSILON = 0.002;

export function settleStep(y: number, rotation: number, deltaSeconds: number): SettleStep {
  // Clamped, so a long frame relaxes fully rather than overshooting past
  // neutral and coming back -- which would be a bounce, not a settle.
  const ease = Math.min(Math.max(deltaSeconds * POSE_SETTLE_RATE, 0), 1);
  const nextY = y * (1 - ease);
  const nextRotation = rotation * (1 - ease);

  if (Math.abs(nextY) < Y_EPSILON && Math.abs(nextRotation) < ROTATION_EPSILON) {
    return { y: 0, rotation: 0, settled: true };
  }
  return { y: nextY, rotation: nextRotation, settled: false };
}
