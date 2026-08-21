import type { Logger } from "../utils/logger.js";

/** What a client offered when asking for access. Nothing here is trusted. */
export interface DebugAuthAttempt {
  sessionId: string;
  /** Server-validated display name. Never an identity claim on its own. */
  playerName: string;
  /** Shared secret supplied by the client, if any. */
  token?: string;
}

export interface DebugAuthDecision {
  granted: boolean;
  /** Safe to show the user. Never echoes the token or names other grants. */
  reason: string;
}

/**
 * Decides whether an attempt earns debug access.
 *
 * Deliberately a separate interface from the service below, so the whole policy
 * can be swapped for the planned user/admin authentication system without any
 * caller changing: implement this, hand it to `DebugAuthorizationService`, done.
 */
export interface DebugAuthorizationPolicy {
  evaluate(attempt: DebugAuthAttempt): DebugAuthDecision;
}

export interface DebugPolicyConfig {
  /** Shared secrets. An attempt matching any of these is granted. */
  tokens: readonly string[];
  /**
   * Display names granted without a token.
   *
   * WEAK BY CONSTRUCTION: players choose their own name, so anyone who types a
   * whitelisted name is granted access. Only for a server you control and do not
   * mind others poking at. Use `tokens` for anything reachable by the public.
   */
  playerNames: readonly string[];
  /**
   * Grant everyone. Off by default and never implied by the environment — it has
   * to be switched on deliberately, and the server logs loudly when it is.
   */
  allowAll: boolean;
}

/**
 * The interim policy: a shared secret or a name whitelist.
 *
 * This is the "simple server-side mechanism" the debug tooling starts with. It
 * is intentionally boring, and intentionally the only thing that would need
 * replacing once real accounts exist -- implement `DebugAuthorizationPolicy`
 * against the account system and hand it to the service; nothing else changes.
 *
 * Of the two mechanisms, only `tokens` is a real credential. See the warning on
 * `playerNames`.
 */
export class ConfiguredDebugPolicy implements DebugAuthorizationPolicy {
  constructor(private readonly config: DebugPolicyConfig) {}

  evaluate(attempt: DebugAuthAttempt): DebugAuthDecision {
    if (this.config.allowAll) {
      return { granted: true, reason: "Debug access is open on this server" };
    }

    const token = attempt.token?.trim();
    if (token && this.config.tokens.some((candidate) => timingSafeEquals(candidate, token))) {
      return { granted: true, reason: "Authorized by token" };
    }

    const name = attempt.playerName.trim().toLowerCase();
    if (name && this.config.playerNames.some((candidate) => candidate.toLowerCase() === name)) {
      return { granted: true, reason: "Authorized by player whitelist" };
    }

    // One message for every failure: a caller must not be able to tell "wrong
    // token" from "no tokens configured" by probing.
    return { granted: false, reason: "Debug access denied" };
  }
}

/**
 * Tracks which sessions in one room hold debug access.
 *
 * This is the only thing that answers `canUseDebug`, and every debug entry point
 * asks it first. Grants are per session *and* per room instance: they are held in
 * memory here, so they cannot outlive the room or follow a player elsewhere.
 */
export class DebugAuthorizationService {
  private readonly granted = new Set<string>();

  constructor(
    private readonly policy: DebugAuthorizationPolicy,
    private readonly logger: Logger,
  ) {}

  /**
   * The single authorization check.
   *
   * Everything debug-related routes through this: opening the console, reading
   * the command catalogue, and every command execution.
   */
  canUseDebug(sessionId: string): boolean {
    return this.granted.has(sessionId);
  }

  /** Evaluate an access attempt and remember the outcome. */
  authorize(attempt: DebugAuthAttempt): DebugAuthDecision {
    const decision = this.policy.evaluate(attempt);

    if (decision.granted) {
      this.granted.add(attempt.sessionId);
      this.logger.info("Debug access granted", {
        sessionId: attempt.sessionId,
        name: attempt.playerName,
        reason: decision.reason,
      });
    } else {
      // Worth a log line: repeated denials are the signature of someone probing.
      this.logger.warn("Debug access denied", {
        sessionId: attempt.sessionId,
        name: attempt.playerName,
      });
    }

    return decision;
  }

  /** Drop a grant when its session leaves, so ids can never be reused into one. */
  revoke(sessionId: string): void {
    this.granted.delete(sessionId);
  }

  get grantedCount(): number {
    return this.granted.size;
  }
}

/**
 * Length-independent string comparison.
 *
 * Token comparison is not a realistic timing target here, but comparing secrets
 * with `===` is the kind of thing that gets copied into somewhere it does matter.
 */
function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
