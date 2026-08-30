/**
 * Sides, in the loosest sense the engine needs.
 *
 * Deathmatch has none: everyone is hostile to everyone, which is what team 0
 * means -- no side at all. The campaign has exactly two: the human, and
 * everything the level throws at them. Its enemies all share one non-zero
 * team, and allies neither target one another nor hurt one another -- a
 * grenadier's blast that catches its own patrol does nothing, a runner's
 * chainsaw passes its own sniper by, and a stray rifle round flies straight
 * through an allied body on its way to you.
 *
 * The rule lives in the systems as one predicate, not as a mode: multiplayer
 * players and bots simply keep team 0 and behave exactly as before.
 */

/** No side: hostile to everyone, including other team-0 players. Deathmatch. */
export const NO_TEAM = 0;

/** Same non-zero team, and only that, makes two combatants allies. */
export function areAllies(teamA: number, teamB: number): boolean {
  return teamA !== NO_TEAM && teamA === teamB;
}
