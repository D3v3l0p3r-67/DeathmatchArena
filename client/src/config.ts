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

function resolveDebugEnabled(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.has("debug")) return params.get("debug") !== "0";
  return import.meta.env.VITE_DEBUG === "true";
}

export const clientConfig = {
  serverUrl: resolveServerUrl(),
  roomName: "battle",
  /** Debug overlay starts visible; F3 toggles it at runtime either way. */
  debugEnabled: resolveDebugEnabled(),
  /** Key that remembers the player's display name between sessions. */
  nameStorageKey: "deathmatch-arena:name",
} as const;
