import config from "@colyseus/tools";
import { monitor } from "@colyseus/monitor";
import { playground } from "@colyseus/playground";
import cors from "cors";
import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MATCH } from "@deathmatch/shared";
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
      maxPlayers: serverConfig.match.maxPlayers,
      minPlayers: serverConfig.match.minPlayersToStart,
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

    /** Lets the client discover server-side match rules without duplicating them. */
    app.get("/config", (_req, res) => {
      res.json({
        minPlayersToStart: serverConfig.match.minPlayersToStart,
        maxPlayers: serverConfig.match.maxPlayers,
        countdownMs: serverConfig.match.countdownMs,
      });
    });

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
        app.get(/^(?!\/(health|config|colyseus|playground|matchmake)).*/, (_req, res) => {
          res.sendFile(path.join(distPath, "index.html"));
        });
        logger.info("Serving client build", { distPath });
      } else {
        logger.warn("SERVE_CLIENT is on but no client build was found", { searched: candidates });
      }
    }
  },

  beforeListen: () => {
    logger.info("Server starting", {
      env: serverConfig.nodeEnv,
      port: serverConfig.port,
    });

    // Debug access is an explicit grant, never a property of the environment.
    // Say plainly what the running server will accept.
    const { tokens, playerNames, allowAll } = serverConfig.debug;
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
