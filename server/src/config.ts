/**
 * Environment-driven server configuration.
 *
 * Nothing else in the codebase reads `process.env` directly, so the server can be
 * moved between local development, a container and Colyseus Cloud purely through
 * environment variables.
 */
import type { ConfigValue } from "@deathmatch/shared";

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Comma-separated list, trimmed, with empties dropped. */
function readList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProduction = nodeEnv === "production";

export const serverConfig = {
  nodeEnv,
  isProduction,

  /** Colyseus Cloud injects PORT; 2567 is the Colyseus convention locally. */
  port: readNumber("PORT", 2567),

  /** Comma-separated list, or "*" to allow any origin (development default). */
  corsOrigins: (process.env.CORS_ORIGIN ?? "*").split(",").map((value) => value.trim()).filter(Boolean),

  /** Serve the built Phaser client from the same process. Handy for single-service deploys. */
  serveClient: readBoolean("SERVE_CLIENT", !isProduction ? false : true),
  clientDistPath: process.env.CLIENT_DIST_PATH ?? "../../client/dist",

  /** @colyseus/monitor dashboard at /colyseus. Disabled in production unless enabled explicitly. */
  enableMonitor: readBoolean("ENABLE_MONITOR", !isProduction),
  /** @colyseus/playground at /playground. Development only. */
  enablePlayground: readBoolean("ENABLE_PLAYGROUND", !isProduction),

  /** Verbose per-room gameplay logging. */
  verboseLogging: readBoolean("VERBOSE_LOGGING", !isProduction),

  /**
   * Debug authorization.
   *
   * Deliberately NOT derived from `NODE_ENV`: debug tooling has to be usable in
   * production, so access is an explicit grant rather than a property of the
   * environment. With nothing configured, nobody gets access anywhere.
   */
  debug: {
    /** Shared secrets. A client presenting one of these is granted access. */
    tokens: readList("DEBUG_TOKENS"),
    /**
     * Display names granted without a token. Weak: players pick their own name,
     * so treat this as a local-testing convenience, not a credential.
     */
    playerNames: readList("DEBUG_PLAYERS"),
    /** Grant everyone. Never implied by the environment; must be set on purpose. */
    allowAll: readBoolean("DEBUG_ALLOW_ALL", false),
  },

  admin: {
    /**
     * Where arenas and configuration overrides are stored.
     *
     * A directory rather than a database for now, behind repository interfaces
     * that do not care which it is. On an ephemeral host (Colyseus Cloud, a
     * container without a volume) this directory does not survive a restart --
     * see `persistent` below.
     */
    dataDir: process.env.DATA_DIR ?? "./data",
    /**
     * Whether changes are expected to outlive a restart.
     *
     * Not detected, declared: only the operator knows whether `DATA_DIR` points
     * at a mounted volume. The admin interface shows this so nobody spends an
     * afternoon building an arena that a redeploy will quietly discard.
     */
    persistent: readBoolean("DATA_PERSISTENT", false),
  },

  match: {
    /** Arena id to prefer for new rooms; empty means the default. */
    arenaId: process.env.ARENA_ID ?? "",
  },
} as const;

/**
 * Match settings an operator pinned through the environment.
 *
 * These seed the *defaults* an administrator then edits on top of, so the old
 * environment variables keep working while the admin interface stays the source
 * of truth. A value set here becomes what "reset to default" restores.
 */
export function readConfigSeed(): Record<string, ConfigValue> {
  const seed: Record<string, ConfigValue> = {};
  const map: Record<string, string> = {
    MIN_PLAYERS: "match.minPlayers",
    MAX_PLAYERS: "match.maxPlayers",
    COUNTDOWN_MS: "match.countdownMs",
    RESULTS_MS: "match.resultsMs",
  };

  for (const [variable, key] of Object.entries(map)) {
    const raw = process.env[variable];
    if (raw === undefined || raw.trim() === "") continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) seed[key] = parsed;
  }

  return seed;
}

export type ServerConfig = typeof serverConfig;
