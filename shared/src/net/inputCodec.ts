import { isFiniteNumber, normalizeAngle } from "../core/math.js";
import { NETWORK } from "../game/constants.js";
import { createInputCommand, type InputCommand } from "../game/types.js";

/**
 * Wire format for input commands.
 *
 * Inputs are the highest-frequency client->server traffic (30 flushes/second), so
 * each command is packed into a 3-element tuple instead of an object:
 *
 *   [ sequence, buttonBitmask, aimAngle * 1000 rounded ]
 *
 * That is ~10 bytes per command after msgpack instead of ~60 for the object form.
 */
export type EncodedInput = [number, number, number];

const BUTTON = {
  MOVE_LEFT: 1 << 0,
  MOVE_RIGHT: 1 << 1,
  JUMP: 1 << 2,
  FIRE: 1 << 3,
  RELOAD: 1 << 4,
} as const;

/** Radians are quantised to 1/1000 rad (~0.06°), well below aiming precision. */
const ANGLE_SCALE = 1000;
const MAX_ENCODED_ANGLE = Math.ceil(Math.PI * ANGLE_SCALE) + 1;

export function encodeInput(input: InputCommand): EncodedInput {
  let bits = 0;
  if (input.moveLeft) bits |= BUTTON.MOVE_LEFT;
  if (input.moveRight) bits |= BUTTON.MOVE_RIGHT;
  if (input.jump) bits |= BUTTON.JUMP;
  if (input.fire) bits |= BUTTON.FIRE;
  if (input.reload) bits |= BUTTON.RELOAD;

  return [input.seq >>> 0, bits, Math.round(normalizeAngle(input.aimAngle) * ANGLE_SCALE)];
}

/**
 * Decode a wire tuple back into an `InputCommand`.
 *
 * Returns `null` for anything malformed — this runs on the server against
 * untrusted data, so every field is range-checked.
 */
export function decodeInput(encoded: unknown, target?: InputCommand): InputCommand | null {
  if (!Array.isArray(encoded) || encoded.length !== 3) return null;

  const [seq, bits, angle] = encoded as [unknown, unknown, unknown];
  if (!isFiniteNumber(seq) || !isFiniteNumber(bits) || !isFiniteNumber(angle)) return null;
  if (seq < 0 || seq > 0xffffffff || Math.floor(seq) !== seq) return null;
  if (bits < 0 || bits > 0x1f || Math.floor(bits) !== bits) return null;
  if (angle < -MAX_ENCODED_ANGLE || angle > MAX_ENCODED_ANGLE) return null;

  const command = target ?? createInputCommand();
  command.seq = seq;
  command.moveLeft = (bits & BUTTON.MOVE_LEFT) !== 0;
  command.moveRight = (bits & BUTTON.MOVE_RIGHT) !== 0;
  command.jump = (bits & BUTTON.JUMP) !== 0;
  command.fire = (bits & BUTTON.FIRE) !== 0;
  command.reload = (bits & BUTTON.RELOAD) !== 0;
  command.aimAngle = normalizeAngle(angle / ANGLE_SCALE);
  return command;
}

export function encodeInputBatch(inputs: readonly InputCommand[]): EncodedInput[] {
  const limit = Math.min(inputs.length, NETWORK.MAX_INPUTS_PER_MESSAGE);
  const batch: EncodedInput[] = new Array(limit);
  const offset = inputs.length - limit;
  for (let i = 0; i < limit; i++) batch[i] = encodeInput(inputs[offset + i]!);
  return batch;
}

/** Decode a batch, dropping malformed entries. Returns `null` if the batch itself is invalid. */
export function decodeInputBatch(payload: unknown): InputCommand[] | null {
  if (!Array.isArray(payload)) return null;
  if (payload.length === 0 || payload.length > NETWORK.MAX_INPUTS_PER_MESSAGE) return null;

  const commands: InputCommand[] = [];
  for (const entry of payload) {
    const command = decodeInput(entry);
    if (command) commands.push(command);
  }
  return commands.length > 0 ? commands : null;
}
