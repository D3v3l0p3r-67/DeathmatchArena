/** Shared helpers for the integration tests. */
import { ClientMessage, getPlayerConfig } from "@deathmatch/shared";

/** Just enough of a Colyseus room for the helpers below. */
interface StartableRoom {
  sessionId: string;
  state: { hostId: string };
  send(type: string, payload?: unknown): void;
}

/**
 * Start the match the way a person does: the host presses the button.
 *
 * Rooms no longer start themselves at a magic number of players -- they stay
 * open until whoever owns the room says otherwise -- so every test that wants a
 * match running has to say so too.
 */
export async function startMatch(...rooms: StartableRoom[]): Promise<void> {
  // Who owns the room is state the server publishes, so it arrives on a patch
  // like everything else -- and on a loaded machine that patch can be a beat
  // behind the join that caused it. Waiting for it is the difference between a
  // suite that passes locally and one that passes on a busy CI runner.
  await waitFor(
    () => rooms.some((room) => room.state?.hostId === room.sessionId),
    "one of these rooms to belong to its client",
  );

  const host = rooms.find((room) => room.state?.hostId === room.sessionId)!;
  host.send(ClientMessage.START_MATCH, {});
}

/**
 * The configured maximum health.
 *
 * Read from the configuration rather than written down, so a rebalance moves the
 * assertions with it instead of turning them red.
 */
export const MAX_HEALTH = getPlayerConfig().maxHealth;

export async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 15000,
  pollMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(pollMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pick a high port that is unlikely to collide with a running dev server. */
export function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}
