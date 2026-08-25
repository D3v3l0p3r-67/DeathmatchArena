import { MatchState, type MatchStateValue } from "@deathmatch/shared";

/**
 * Whether the OS pointer should stay hidden in favour of the crosshair.
 *
 * The crosshair is the pointer during a match; the system arrow sitting on top
 * of it doubled up as two cursors aiming at slightly different pixels. But a
 * match does not mean nothing ever needs a click -- the settings panel and the
 * debug console both open with a key press mid-match -- so this is not simply
 * "are we playing".
 */
export function shouldHideCursor(matchState: MatchStateValue | undefined, needsPointer: boolean): boolean {
  return matchState === MatchState.PLAYING && !needsPointer;
}
