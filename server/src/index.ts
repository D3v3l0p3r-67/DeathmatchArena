/**
 * Local / container entry point.
 *
 * Colyseus Cloud imports `app.config.ts` directly, so keep this file free of
 * anything the app itself depends on.
 */
import { listen } from "@colyseus/tools";
import appConfig from "./app.config.js";
import { serverConfig } from "./config.js";

await listen(appConfig, serverConfig.port);
