/** Shared helpers for the integration tests. */
import { getPlayerConfig } from "@deathmatch/shared";

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
