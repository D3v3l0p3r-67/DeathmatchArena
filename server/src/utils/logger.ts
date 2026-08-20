import { serverConfig } from "../config.js";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minimumLevel: Level = serverConfig.verboseLogging ? "debug" : "info";

function write(level: Level, scope: string, message: string, details?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minimumLevel]) return;

  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${message}`;
  const target = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (details === undefined) target(line);
  else target(line, details);
}

export interface Logger {
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
  child(childScope: string): Logger;
}

/** Scoped logger. Verbosity is controlled by VERBOSE_LOGGING so production stays quiet. */
export function createLogger(scope: string): Logger {
  return {
    debug: (message, details) => write("debug", scope, message, details),
    info: (message, details) => write("info", scope, message, details),
    warn: (message, details) => write("warn", scope, message, details),
    error: (message, details) => write("error", scope, message, details),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}
