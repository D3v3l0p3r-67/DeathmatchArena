/**
 * Environment-driven server configuration.
 *
 * Nothing else in the codebase reads `process.env` directly, so the server can be
 * moved between local development, a container and Colyseus Cloud purely through
 * environment variables.
 */
import { MATCH } from "@deathmatch/shared";

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
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

  match: {
    minPlayersToStart: readNumber("MIN_PLAYERS", MATCH.MIN_PLAYERS_TO_START),
    maxPlayers: readNumber("MAX_PLAYERS", MATCH.MAX_PLAYERS),
    countdownMs: readNumber("COUNTDOWN_MS", MATCH.COUNTDOWN_MS),
    resultsMs: readNumber("RESULTS_MS", MATCH.RESULTS_MS),
    /** Arena id from `@deathmatch/shared`; makes swapping maps a config change. */
    arenaId: process.env.ARENA_ID ?? "",
  },
} as const;

export type ServerConfig = typeof serverConfig;
