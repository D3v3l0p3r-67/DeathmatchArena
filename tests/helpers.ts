/** Shared helpers for the integration tests. */

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
