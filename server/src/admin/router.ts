import express, { type Request, type Response, type Router } from "express";
import { trapRegistry } from "@deathmatch/shared";
import { serverConfig } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { AdminAuthorizationService, createAdminAuthorization } from "./AdminAuthorization.js";
import type { ArenaService } from "./ArenaService.js";
import type { GameConfigService } from "./GameConfigService.js";
import type { CampaignLevelsService } from "./CampaignLevelsService.js";

const logger = createLogger("admin");

/**
 * How much administration traffic one caller may generate.
 *
 * Loose enough that a live editor -- which validates as you drag a platform --
 * never notices, tight enough that the endpoints are not a comfortable place to
 * guess tokens from.
 */
const RATE_LIMIT = { maxRequests: 240, windowMs: 60_000 } as const;

/**
 * The administration API.
 *
 * Every route is behind one authorization check, and the check is the *first*
 * thing that happens -- before a body is parsed, before a repository is touched,
 * before the caller learns whether an arena exists. An unauthorized caller can
 * tell that the API is there and nothing else.
 *
 * The routes are deliberately thin. Validation lives in `@deathmatch/shared`,
 * storage in the repositories, rules in the services; a route reads a request,
 * calls one service method and shapes the reply.
 */
export function createAdminRouter(
  /**
   * Accessors rather than instances: startup may swap the file-backed services
   * for in-memory ones when storage turns out to be unusable, and the routes must
   * follow that rather than keep serving from a repository that cannot be written.
   */
  getArenas: () => ArenaService,
  getConfig: () => GameConfigService,
  getCampaignLevels: () => CampaignLevelsService,
): Router {
  const router = express.Router();
  const authorization = createAdminAuthorization();
  const throttle = createThrottle();

  router.use(express.json({ limit: "2mb" }));

  router.use((request, response, next) => {
    if (!throttle(request)) {
      response.status(429).json({ ok: false, message: "Too many requests." });
      return;
    }

    const decision = authorization.authorize(request);
    if (!decision.granted) {
      logger.warn("Rejected an administration request", {
        path: request.path,
        method: request.method,
      });
      response.status(decision.status).json({ ok: false, message: decision.reason });
      return;
    }

    next();
  });

  // -- Session ---------------------------------------------------------------

  /** A cheap way for the interface to check a token before showing anything. */
  router.get("/session", (_request, response) => {
    response.json({ ok: true, persistent: serverConfig.admin.persistent });
  });

  // -- Campaign levels -------------------------------------------------------

  router.get("/campaign-levels", (_request, response) => {
    response.json({ ok: true, overrides: getCampaignLevels().current() });
  });

  router.put("/campaign-levels", (request, response) => {
    void (async () => {
      const body = request.body as { overrides?: unknown } | undefined;
      const overrides = await getCampaignLevels().replace(body?.overrides ?? {});
      response.json({ ok: true, overrides });
    })().catch((error) => {
      logger.error("Could not store campaign level overrides", {
        error: error instanceof Error ? error.message : String(error),
      });
      response.status(500).json({ ok: false, message: "Could not store the overrides." });
    });
  });

  // -- Game configuration ----------------------------------------------------

  router.get("/config", (_request, response) => {
    response.json({
      ok: true,
      categories: getConfig().categories(),
      fields: getConfig().listFields(),
    });
  });

  /** Apply a batch of changes. Rejected as a whole if any one of them is invalid. */
  router.put("/config", async (request, response) => {
    const changes = isRecord(request.body?.changes) ? request.body.changes : {};
    const result = await guard(response, () => getConfig().setMany(changes));
    if (result) response.status(result.ok ? 200 : 400).json(result);
  });

  /**
   * Reset one parameter, one subcategory, or a whole category.
   *
   * One route rather than three, because they are the same operation at three
   * scopes and the body already says which.
   */
  router.post("/config/reset", async (request, response) => {
    const body = isRecord(request.body) ? request.body : {};
    const key = typeof body.key === "string" ? body.key : "";
    const category = typeof body.category === "string" ? body.category : "";
    const subcategory = typeof body.subcategory === "string" ? body.subcategory : undefined;

    const result = await guard(response, () => {
      if (key) return getConfig().resetKey(key);
      if (category) return getConfig().resetGroup(category, subcategory);
      return getConfig().resetAll();
    });
    if (result) response.status(result.ok ? 200 : 400).json(result);
  });

  // -- Trap catalogue --------------------------------------------------------

  /** What the editor offers when placing a trap, straight from the registry. */
  router.get("/trap-types", (_request, response) => {
    response.json({ ok: true, types: trapRegistry.list() });
  });

  // -- Arenas ----------------------------------------------------------------

  router.get("/arenas", async (_request, response) => {
    const arenaList = await guard(response, () => getArenas().list());
    if (arenaList) response.json({ ok: true, arenas: arenaList });
  });

  router.get("/arenas/:id", async (request, response) => {
    const arena = await guard(response, () => getArenas().get(request.params.id));
    if (arena === undefined) return;
    if (!arena) {
      response.status(404).json({ ok: false, message: "No such arena." });
      return;
    }
    response.json({ ok: true, arena });
  });

  router.post("/arenas", async (request, response) => {
    const body = isRecord(request.body) ? request.body : {};
    const name = typeof body.name === "string" ? body.name : "New arena";
    const width = toNumber(body.width);
    const height = toNumber(body.height);

    const result = await guard(response, () => getArenas().create(name, width, height));
    if (result) response.status(result.ok ? 201 : 400).json(result);
  });

  router.put("/arenas/:id", async (request, response) => {
    const result = await guard(response, () => getArenas().save(request.params.id, request.body?.arena ?? request.body));
    if (result) response.status(result.ok ? 200 : 400).json(result);
  });

  /** Validate without storing, so the editor can show problems as they appear. */
  router.post("/arenas/:id/check", async (request, response) => {
    const result = await guard(response, () =>
      getArenas().check(request.params.id, request.body?.arena ?? request.body),
    );
    if (result) response.json(result);
  });

  router.post("/arenas/:id/duplicate", async (request, response) => {
    const result = await guard(response, () => getArenas().duplicate(request.params.id));
    if (result) response.status(result.ok ? 201 : 400).json(result);
  });

  router.post("/arenas/:id/enabled", async (request, response) => {
    const enabled = request.body?.enabled !== false;
    const result = await guard(response, () => getArenas().setEnabled(request.params.id, enabled));
    if (result) response.status(result.ok ? 200 : 400).json(result);
  });

  router.delete("/arenas/:id", async (request, response) => {
    const result = await guard(response, () => getArenas().delete(request.params.id));
    if (result) response.status(result.ok ? 200 : 400).json(result);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a service call, turning a thrown error into a 500 rather than a crashed
 * process. Returns `undefined` when it failed, and the caller stops there.
 */
async function guard<T>(response: Response, work: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    logger.error("Administration request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    response.status(500).json({ ok: false, message: "The server could not complete that request." });
    return undefined;
  }
}

/** A fixed-window counter per caller. Small, in-memory, and swept as it goes. */
function createThrottle(): (request: Request) => boolean {
  const windows = new Map<string, { count: number; resetAt: number }>();

  return (request) => {
    const now = Date.now();
    const key = request.ip ?? "unknown";

    // Sweep opportunistically rather than on a timer: the map only grows while
    // requests are arriving, so that is exactly when it should be pruned.
    if (windows.size > 512) {
      for (const [candidate, window] of windows) {
        if (window.resetAt <= now) windows.delete(candidate);
      }
    }

    const window = windows.get(key);
    if (!window || window.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
      return true;
    }

    window.count += 1;
    return window.count <= RATE_LIMIT.maxRequests;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export type { AdminAuthorizationService };
