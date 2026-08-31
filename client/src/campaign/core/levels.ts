/**
 * How edited levels reach an offline game.
 *
 * The campaign plays with no connection, so an edited level can never be
 * something a level start *waits* for. Opening the campaign menu fires a
 * best-effort fetch of the server's edited documents into a local cache;
 * starting a level plays the cached document when there is one and the
 * shipped level otherwise. Everything leaving the cache is re-normalized and
 * re-validated first -- a cache written by an older build, or edited by hand,
 * is held to today's rules, and a document that fails simply yields to the
 * shipped level rather than to a broken run.
 */
import {
  CAMPAIGN_LEVELS,
  getCampaignArena,
  normalizeCampaignLevel,
  validateCampaignLevel,
  type CampaignLevelDefinition,
} from "@deathmatch/shared";

const STORAGE_KEY = "deathmatch-campaign-levels";

let cached: Map<string, CampaignLevelDefinition> | null = null;

function verify(id: string, raw: unknown): CampaignLevelDefinition | null {
  const { level, issues } = normalizeCampaignLevel(raw);
  if (!level || issues.length > 0 || level.id !== id) return null;
  const arena = getCampaignArena(level.arenaId);
  if (!arena) return null;
  const shippedIds = CAMPAIGN_LEVELS.map((shipped) => shipped.id);
  return validateCampaignLevel(level, arena, shippedIds).length === 0 ? level : null;
}

function load(): Map<string, CampaignLevelDefinition> {
  if (cached) return cached;
  cached = new Map();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    for (const [id, document] of Object.entries(parsed)) {
      const level = verify(id, document);
      if (level) cached.set(id, level);
    }
  } catch {
    // An unreadable cache is an empty cache; the shipped levels stand.
  }
  return cached;
}

/** The level the game should play: the edited document, or the shipped one. */
export function effectiveCampaignLevel(id: string): CampaignLevelDefinition | null {
  return load().get(id) ?? CAMPAIGN_LEVELS.find((level) => level.id === id) ?? null;
}

/**
 * The chain the menu shows, walked over effective levels -- so editing a
 * `nextLevelId` reorders the campaign the player actually sees. Guarded
 * against cycles, because an edited chain is a chain somebody typed.
 */
export function effectiveCampaignChain(): CampaignLevelDefinition[] {
  const chain: CampaignLevelDefinition[] = [];
  const seen = new Set<string>();
  let current = CAMPAIGN_LEVELS[0] ? effectiveCampaignLevel(CAMPAIGN_LEVELS[0].id) : null;
  while (current && !seen.has(current.id) && chain.length < 50) {
    chain.push(current);
    seen.add(current.id);
    current = current.nextLevelId ? effectiveCampaignLevel(current.nextLevelId) : null;
  }
  return chain;
}

/** Fetch the server's edited documents and refresh the cache. Never awaited by gameplay. */
export async function refreshCampaignLevels(httpBase: string): Promise<void> {
  try {
    const response = await fetch(`${httpBase}/api/campaign/levels`);
    if (!response.ok) return;
    const body = (await response.json()) as { levels?: Record<string, unknown> };
    const next = new Map<string, CampaignLevelDefinition>();
    for (const [id, document] of Object.entries(body.levels ?? {})) {
      const level = verify(id, document);
      if (level) next.set(id, level);
    }
    cached = next;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(next)));
  } catch {
    // Offline, or no server: the cache (or the shipped levels) stand.
  }
}
