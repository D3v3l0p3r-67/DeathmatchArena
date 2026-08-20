import { MATCH, type KillPayload } from "@deathmatch/shared";
import { requireElement } from "./dom.js";

interface FeedEntry {
  element: HTMLLIElement;
  expiresAt: number;
}

/**
 * Rolling list of recent eliminations.
 *
 * Kill events are broadcast as one-off messages rather than kept in the
 * synchronised state: they are ephemeral, so putting them in the state would mean
 * paying for them in every subsequent patch. Expiry is purely presentational and
 * therefore lives here.
 */
export class KillFeed {
  private readonly list = requireElement<HTMLUListElement>("kill-feed");
  private readonly entries: FeedEntry[] = [];

  constructor(private readonly localSessionId: () => string) {}

  add(event: KillPayload, now: number): void {
    const item = document.createElement("li");
    const localId = this.localSessionId();

    if (event.killerId === localId) item.classList.add("is-mine");
    else if (event.victimId === localId) item.classList.add("is-victim");

    if (event.selfInflicted || !event.killerName) {
      item.innerHTML = `<span class="victim"></span><span class="verb">was eliminated</span>`;
      item.querySelector(".victim")!.textContent = event.victimName;
    } else {
      item.innerHTML =
        `<span class="killer"></span><span class="verb">eliminated</span><span class="victim"></span>`;
      item.querySelector(".killer")!.textContent = event.killerName;
      item.querySelector(".victim")!.textContent = event.victimName;
    }

    this.list.appendChild(item);
    this.entries.push({ element: item, expiresAt: now + MATCH.KILL_FEED_ENTRY_TTL_MS });

    while (this.entries.length > MATCH.KILL_FEED_MAX_ENTRIES) {
      this.removeOldest();
    }
  }

  /** Expire entries whose time is up. Call once per frame. */
  tick(now: number): void {
    while (this.entries.length > 0 && this.entries[0]!.expiresAt <= now) {
      this.removeOldest();
    }
  }

  clear(): void {
    for (const entry of this.entries) entry.element.remove();
    this.entries.length = 0;
  }

  private removeOldest(): void {
    const entry = this.entries.shift();
    if (!entry) return;

    entry.element.classList.add("is-fading");
    window.setTimeout(() => entry.element.remove(), 400);
  }
}
