/**
 * How the admin's level overlay reaches an offline game.
 *
 * The campaign plays with no connection, so the overlay can never be
 * something a level *waits* for. Instead: opening the campaign menu fires a
 * best-effort fetch that refreshes a local cache, and starting a level reads
 * whatever the cache holds right now. First visit online: the fetch usually
 * wins the race against the player picking a level. Offline: the cache -- or
 * nothing, which means the shipped values. Either way the level starts
 * instantly and the values are sane, because everything entering the cache
 * passes the same sanitizer the server uses.
 */
import { sanitizeCampaignOverrides, type CampaignOverrides } from "@deathmatch/shared";

const STORAGE_KEY = "deathmatch-campaign-level-overrides";

let cached: CampaignOverrides | null = null;

/** The overlay as this client last saw it; {} when it has never seen one. */
export function campaignOverrides(): CampaignOverrides {
  if (cached) return cached;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    cached = raw ? sanitizeCampaignOverrides(JSON.parse(raw)) : {};
  } catch {
    cached = {};
  }
  return cached;
}

/** Fetch the server's overlay and refresh the cache. Never awaited by gameplay. */
export async function refreshCampaignOverrides(httpBase: string): Promise<void> {
  try {
    const response = await fetch(`${httpBase}/api/campaign/overrides`);
    if (!response.ok) return;
    const body = (await response.json()) as { overrides?: unknown };
    cached = sanitizeCampaignOverrides(body.overrides);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // Offline, or no server: the cache (or the shipped values) stand.
  }
}
