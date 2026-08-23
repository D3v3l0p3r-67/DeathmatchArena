/**
 * Client configuration.
 *
 * The Colyseus endpoint is never hard-coded in game code: it comes from
 * `VITE_SERVER_URL` at build time, and falls back to the page origin so a build
 * served by the game server "just works" without configuration.
 */

function deriveEndpointFromLocation(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

function resolveServerUrl(): string {
  const configured = import.meta.env.VITE_SERVER_URL?.trim();
  if (configured) return configured;

  // In `vite dev` the page is on :5173 while the server listens on :2567.
  if (import.meta.env.DEV) return "ws://localhost:2567";

  return deriveEndpointFromLocation();
}

/**
 * The debug token this client will offer the server.
 *
 * Supplied once via `?debugToken=...` and then remembered, so a reload does not
 * mean pasting it again. It is only ever a *request*: the server decides whether
 * it earns anything, and this value grants nothing on its own.
 */
function resolveDebugToken(): string {
  const params = new URLSearchParams(window.location.search);
  const supplied = params.get("debugToken");

  if (supplied !== null) {
    const token = supplied.trim();
    try {
      if (token) window.localStorage.setItem(DEBUG_TOKEN_KEY, token);
      else window.localStorage.removeItem(DEBUG_TOKEN_KEY);
    } catch {
      // Private browsing or blocked storage: the token still works this session.
    }
    return token;
  }

  try {
    return window.localStorage.getItem(DEBUG_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

const DEBUG_TOKEN_KEY = "deathmatch-arena:debug-token";
const PLAYER_ID_KEY = "deathmatch-arena:player-id";

/**
 * A stable id for this browser.
 *
 * There are no accounts here, and this is not one: it is the key a player's own
 * record is filed under on the server, generated locally and never shown to
 * anybody else. Losing it (a cleared cache, another machine) means starting a
 * fresh record, which is the honest cost of not asking anyone to sign up.
 */
function resolvePlayerId(): string {
  try {
    const stored = window.localStorage.getItem(PLAYER_ID_KEY);
    if (stored) return stored;

    const created = crypto.randomUUID();
    window.localStorage.setItem(PLAYER_ID_KEY, created);
    return created;
  } catch {
    // Private browsing or blocked storage: play without a record rather than
    // failing to play.
    return "";
  }
}

export const clientConfig = {
  serverUrl: resolveServerUrl(),
  roomName: "battle",
  /**
   * Offered to the server when asking for debug access.
   *
   * Note what is absent: any local "debug enabled" flag. Debug tooling is gated
   * by a server-side grant, never by the build or the environment.
   */
  debugToken: resolveDebugToken(),
  /** Who this browser says it is, for its own statistics. See `resolvePlayerId`. */
  playerId: resolvePlayerId(),
  /** Key that remembers the player's display name between sessions. */
  nameStorageKey: "deathmatch-arena:name",
} as const;
