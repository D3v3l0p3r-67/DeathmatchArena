import config from "@colyseus/tools";
import { monitor } from "@colyseus/monitor";
import { playground } from "@colyseus/playground";
import cors from "cors";
import express from "express";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MATCH, RateLimiter, getGameConfig } from "@deathmatch/shared";
import { adminServices, createAdminRouter, initialiseAdmin } from "./admin/index.js";
import { initialisePlayerStats } from "./stats/index.js";
import { serverConfig } from "./config.js";
import { BattleRoom } from "./rooms/BattleRoom.js";
import { createLogger } from "./utils/logger.js";

const logger = createLogger("app");
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Colyseus application definition.
 *
 * Exported as the default so it works both with `npm run dev` (which calls
 * `listen()` from `index.ts`) and with Colyseus Cloud, which imports this file
 * directly. Nothing here hard-codes a host or port -- see `config.ts`.
 */
export default config({
  options: {
    devMode: !serverConfig.isProduction,
  },

  initializeGameServer: (gameServer) => {
    /**
     * A single room type backs every match.
     *
     * `joinOrCreate("battle")` on the client gives us matchmaking for free:
     * Colyseus fills existing rooms up to `maxClients` and spins up a new one when
     * they are full. Rooms also lock themselves once a match starts, so players
     * arriving mid-game land in a fresh room instead of an ongoing fight.
     */
    gameServer.define("battle", BattleRoom).enableRealtimeListing();

    logger.info("Registered room type", {
      room: "battle",
      reconnectionWindowSec: MATCH.RECONNECTION_WINDOW_SEC,
    });
  },

  initializeExpress: (app) => {
    app.use(
      cors({
        origin: serverConfig.corsOrigins.includes("*") ? true : serverConfig.corsOrigins,
        credentials: true,
      }),
    );

    /** Liveness probe for container platforms and Colyseus Cloud. */
    app.get("/health", (_req, res) => {
      res.json({ status: "ok", uptime: process.uptime(), env: serverConfig.nodeEnv });
    });

    /**
     * Lets the client discover the match rules before it joins anything.
     *
     * Read live from the configuration, so it reflects what an administrator has
     * set rather than what the process started with.
     */
    app.get("/config", (_req, res) => {
      const match = getGameConfig().match;
      res.json({
        minPlayersToStart: match.minPlayers,
        maxPlayers: match.maxPlayers,
        countdownMs: match.countdownMs,
      });
    });

    /**
     * The campaign's optional cloud persistence -- the single seam single
     * player has to a server, and a deliberately thin one: the client fires
     * rare, high-level events (level started, checkpoint, level completed,
     * progress changed) and never waits for the answer. Everything stored
     * here is a client claim; nothing may reward it without server-side
     * verification first.
     */
    app.use("/api/campaign", express.json({ limit: "64kb" }));
    app.post("/api/campaign/event", (req, res) => {
      const event = req.body as { kind?: string } | undefined;
      const allowed = new Set(["levelStarted", "checkpointReached", "levelCompleted", "progressChanged"]);
      if (!event || typeof event.kind !== "string" || !allowed.has(event.kind)) {
        res.status(400).json({ ok: false });
        return;
      }

      /*
       * An unauthenticated endpoint that appends to a file is a disk-filling
       * vector: a loop of valid requests would grow the journal without limit.
       * A caller sending more than a level's worth of events per minute is not
       * playing, so drop the excess rather than refuse service -- exactly what
       * the room does with a client that floods it with input.
       */
      if (!campaignEventLimiter.tryConsume(Date.now())) {
        res.status(429).json({ ok: false });
        return;
      }

      recordCampaignEvent(event);
      res.json({ ok: true });
    });

    /**
     * The administration API.
     *
     * Mounted unconditionally and *not* gated on the environment, for the same
     * reason the debug tooling is not: administration has to work in production.
     * What gates it is the token check inside, applied to every route before
     * anything else happens.
     */
    app.use("/admin/api", createAdminRouter(() => adminServices().arenas, () => adminServices().config));

    if (serverConfig.enablePlayground) {
      app.use("/playground", playground());
      logger.info("Colyseus playground enabled at /playground");
    }

    if (serverConfig.enableMonitor) {
      app.use("/colyseus", monitor());
      logger.info("Colyseus monitor enabled at /colyseus");
    }

    // Optionally serve the built Phaser client from the same origin. Useful for a
    // single-service deployment; in development Vite serves the client instead.
    if (serverConfig.serveClient) {
      // Resolved against this module first (server/src in dev, server/build once
      // bundled) and then the working directory, so the same setting works for
      // `npm run dev`, `npm start` and a container that starts elsewhere.
      const candidates = [
        path.resolve(moduleDir, serverConfig.clientDistPath),
        path.resolve(process.cwd(), serverConfig.clientDistPath),
      ];
      const distPath = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
      if (existsSync(distPath)) {
        app.use(express.static(distPath));

        // The administration interface is its own page in the build, so `/admin`
        // has to be pointed at it explicitly -- the fallback below deliberately
        // excludes anything under /admin so the API is never shadowed by it.
        app.get("/admin", (_req, res) => {
          res.sendFile(path.join(distPath, "admin.html"));
        });
        app.get(/^(?!\/(health|config|colyseus|playground|matchmake|admin)).*/, (_req, res) => {
          res.sendFile(path.join(distPath, "index.html"));
        });
        logger.info("Serving client build", { distPath });
      } else {
        logger.warn("SERVE_CLIENT is on but no client build was found", { searched: candidates });
      }
    }
  },

  beforeListen: async () => {
    // Stored arenas and configuration are loaded *before* the listener opens, so
    // the first room created can never run on the shipped defaults by accident.
    await initialiseAdmin();
    // Careers are loaded here too, so the first player to join is told what they
    // have done before rather than a row of zeroes.
    await initialisePlayerStats();

    logger.info("Server starting", {
      env: serverConfig.nodeEnv,
      port: serverConfig.port,
    });

    // Debug access is an explicit grant, never a property of the environment.
    // Say plainly what the running server will accept.
    const { tokens, playerNames, allowAll } = serverConfig.debug;
    if (tokens.length === 0) {
      logger.info("Administration is unreachable: DEBUG_TOKENS is empty, and only a token opens it");
    } else {
      logger.info("Administration reachable at /admin with any configured DEBUG_TOKENS value");
    }
    if (allowAll) {
      logger.warn("DEBUG_ALLOW_ALL is on: every player can use debug tooling");
    } else if (tokens.length === 0 && playerNames.length === 0) {
      logger.info("Debug tooling is unreachable: no DEBUG_TOKENS or DEBUG_PLAYERS configured");
    } else {
      logger.info("Debug tooling reachable by grant", {
        tokens: tokens.length,
        whitelistedNames: playerNames.length,
      });
    }
  },
});

/**
 * The whole server's budget for campaign events.
 *
 * Generous for real play -- a level start, a handful of checkpoints and a
 * completion is a few events a minute -- and far below what it takes to fill
 * a disk.
 */
const campaignEventLimiter = new RateLimiter({ maxEvents: 600, windowMs: 60_000 });

/** Past this the journal is rolled over, so it cannot grow without bound. */
const CAMPAIGN_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Append one campaign sync event to a local journal.
 *
 * Storage, not truth: a line of JSON per event under the data directory, so a
 * future verifier (leaderboards, unlocks) has the raw claims to check --
 * nothing reads this at runtime today.
 */
function recordCampaignEvent(event: unknown): void {
  try {
    mkdirSync(serverConfig.admin.dataDir, { recursive: true });
    const journalPath = `${serverConfig.admin.dataDir}/campaign-events.jsonl`;

    // One rollover kept, then overwritten: the journal is raw material for a
    // future verifier, not an archive worth unbounded disk.
    try {
      if (statSync(journalPath).size > CAMPAIGN_JOURNAL_MAX_BYTES) {
        renameSync(journalPath, `${journalPath}.1`);
      }
    } catch {
      // No journal yet, or it cannot be rolled; appending is still fine.
    }

    appendFileSync(journalPath, `${JSON.stringify({ at: Date.now(), event })}\n`);
  } catch {
    // Best-effort by design; the client neither knows nor cares.
  }
}
