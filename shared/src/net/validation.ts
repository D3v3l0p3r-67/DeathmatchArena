import { NAME_RULES } from "../game/constants.js";

export interface NameValidationResult {
  valid: boolean;
  /** Sanitised name, safe to display. Always populated (falls back to a generated name). */
  name: string;
  reason?: string;
}

/** Control characters (C0 + DEL + C1) are stripped before a name is measured. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Validate and sanitise a display name.
 *
 * Runs on the client for instant feedback and again on the server, which is the
 * only side whose verdict counts. Display names are never used as identifiers --
 * the Colyseus session id is.
 */
export function validatePlayerName(raw: unknown, fallbackSeed = ""): NameValidationResult {
  const fallback = generateFallbackName(fallbackSeed);

  if (typeof raw !== "string") {
    return { valid: false, name: fallback, reason: "Name must be text." };
  }

  const trimmed = raw.replace(CONTROL_CHARACTERS, "").replace(/\s+/g, " ").trim();

  if (trimmed.length === 0) {
    return { valid: false, name: fallback, reason: "Name cannot be empty." };
  }
  if (trimmed.length < NAME_RULES.MIN_LENGTH) {
    return {
      valid: false,
      name: fallback,
      reason: `Name must be at least ${NAME_RULES.MIN_LENGTH} characters.`,
    };
  }
  if (trimmed.length > NAME_RULES.MAX_LENGTH) {
    return {
      valid: false,
      name: fallback,
      reason: `Name must be at most ${NAME_RULES.MAX_LENGTH} characters.`,
    };
  }
  if (!NAME_RULES.ALLOWED_PATTERN.test(trimmed)) {
    return {
      valid: false,
      name: fallback,
      reason: "Only letters, numbers, spaces, - and _ are allowed.",
    };
  }

  return { valid: true, name: trimmed };
}

/** Placeholder name used when validation fails, seeded from the session id when possible. */
export function generateFallbackName(seed: string): string {
  const digits = seed.replace(/[^A-Za-z0-9]/g, "").slice(-4).toUpperCase();
  const suffix = digits.length >= 3 ? digits : String(Math.floor(1000 + Math.random() * 9000));
  return `${NAME_RULES.FALLBACK_PREFIX}${suffix}`;
}

/**
 * Ensure a name is unique inside a room by appending a counter.
 * Keeps the kill feed readable when two people pick the same name.
 */
export function makeNameUnique(name: string, taken: Iterable<string>): string {
  const existing = new Set<string>();
  for (const entry of taken) existing.add(entry.toLowerCase());
  if (!existing.has(name.toLowerCase())) return name;

  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${name.slice(0, NAME_RULES.MAX_LENGTH - 3)}(${suffix})`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}
