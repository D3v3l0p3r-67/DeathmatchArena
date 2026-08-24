import { MatchState, type MatchStateValue } from "@deathmatch/shared";

/**
 * Whether the spectator banner belongs on screen.
 *
 * Being dead is not enough on its own, and that is the whole point of this
 * living somewhere it can be tested: between matches the room clears `alive`
 * for everybody, so a player sitting in the lobby is "not alive" exactly as an
 * eliminated player is. Reading only that put "You were eliminated --
 * spectating nobody" back over the lobby every time the scene announced a new
 * spectate target, which it does whenever somebody leaves.
 */
export function isSpectating(
  matchState: MatchStateValue | undefined,
  alive: boolean | undefined,
): boolean {
  return matchState === MatchState.PLAYING && alive === false;
}
