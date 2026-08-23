import type { Brain } from "../Brain.js";
import { attackAction } from "./attack.js";
import { chaseAction } from "./chase.js";
import { dodgeAction } from "./dodge.js";
import { getPowerUpAction } from "./getPowerUp.js";
import { getWeaponAction } from "./getWeapon.js";
import { retreatAction } from "./retreat.js";
import { searchEnemyAction } from "./searchEnemy.js";
import { takePositionAction } from "./takePosition.js";
import { throwGrenadeAction } from "./throwGrenade.js";

/**
 * The actions every brain starts with.
 *
 * A deployment can register more, or replace one of these by registering an
 * action with the same id -- the brain has no list of its own, so nothing here
 * needs to know that happened.
 */
export function registerDefaultActions(brain: Brain): void {
  brain.registerAction(attackAction);
  brain.registerAction(chaseAction);
  brain.registerAction(retreatAction);
  brain.registerAction(dodgeAction);
  brain.registerAction(getPowerUpAction);
  brain.registerAction(getWeaponAction);
  brain.registerAction(throwGrenadeAction);
  brain.registerAction(takePositionAction);
  brain.registerAction(searchEnemyAction);
}

export {
  attackAction,
  chaseAction,
  dodgeAction,
  getPowerUpAction,
  getWeaponAction,
  retreatAction,
  searchEnemyAction,
  takePositionAction,
  throwGrenadeAction,
};
