import type { Request } from "express";
import { serverConfig } from "../config.js";

/**
 * Who may administer this server.
 *
 * A deliberately separate interface from the check itself, for the same reason
 * the debug system has one: when real accounts arrive, this is the only thing
 * that needs replacing. Implement it against the account system, hand it to
 * `AdminAuthorizationService`, and no route changes.
 */
export interface AdminAuthorizationPolicy {
  /** True when the presented credential is accepted. */
  accepts(token: string): boolean;
  /** False when nobody can possibly be admitted, so the routes can say why. */
  readonly configured: boolean;
}

/**
 * The interim policy: the shared secrets the debug system already uses.
 *
 * Two deliberate omissions from the debug policy:
 *
 *   - **The player-name whitelist is not honoured.** A display name is not a
 *     credential -- anyone can type one -- and an HTTP request has no player
 *     attached to it in the first place.
 *   - **`DEBUG_ALLOW_ALL` is not honoured.** It exists to make a match easy to
 *     poke at; it must not hand the world write access to the game's stored
 *     configuration and every arena.
 *
 * So with only `DEBUG_ALLOW_ALL` set, debug tooling opens and administration
 * stays shut. That asymmetry is the point.
 */
export class TokenAdminPolicy implements AdminAuthorizationPolicy {
  constructor(private readonly tokens: readonly string[]) {}

  get configured(): boolean {
    return this.tokens.length > 0;
  }

  accepts(token: string): boolean {
    if (!token) return false;
    return this.tokens.some((candidate) => timingSafeEquals(candidate, token));
  }
}

export interface AdminAuthResult {
  granted: boolean;
  /** Safe to return to the caller. Never distinguishes "wrong" from "none set". */
  reason: string;
  /** 401 for a missing or bad credential, 503 when none is configured at all. */
  status: number;
}

/**
 * The single authorization check for every administration route.
 *
 * Every route asks this first, exactly as every debug entry point asks
 * `canUseDebug` first. There is no route that reads or writes anything without
 * having come through here, and hiding the admin page proves nothing -- the API
 * is what is protected.
 */
export class AdminAuthorizationService {
  constructor(private readonly policy: AdminAuthorizationPolicy) {}

  get configured(): boolean {
    return this.policy.configured;
  }

  authorize(request: Request): AdminAuthResult {
    if (!this.policy.configured) {
      // Worth saying plainly: an operator who set no token needs to know that is
      // why nothing works, and it reveals nothing an attacker can use.
      return {
        granted: false,
        reason: "Administration is unavailable: no access token is configured on this server.",
        status: 503,
      };
    }

    const token = readToken(request);
    if (!this.policy.accepts(token)) {
      return { granted: false, reason: "Not authorized.", status: 401 };
    }

    return { granted: true, reason: "Authorized by token", status: 200 };
  }
}

/**
 * Read the credential from a request.
 *
 * A bearer header is the primary form. The `X-Admin-Token` header is accepted
 * too because it is what a browser fetch can set most simply, and a query string
 * is deliberately *not* accepted: query strings end up in access logs, browser
 * history and referrer headers.
 */
function readToken(request: Request): string {
  const authorization = request.header("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (bearer) return bearer[1]!.trim();

  return (request.header("x-admin-token") ?? "").trim();
}

/** Length-independent comparison, so secrets are never compared with `===`. */
function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The service the routes use, built from the server's environment. */
export function createAdminAuthorization(): AdminAuthorizationService {
  return new AdminAuthorizationService(new TokenAdminPolicy(serverConfig.debug.tokens));
}
