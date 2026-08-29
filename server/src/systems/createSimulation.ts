/**
 * The one place the simulation is wired together.
 *
 * The engine is nine systems with a specific dependency graph, and that graph
 * used to be hand-built in three places: the multiplayer room, the campaign's
 * in-browser match, and the test harness. All three had to agree -- the whole
 * point of the campaign running "the server's own systems" and of the tests
 * meaning anything is that the wiring is *identical* -- but nothing enforced
 * it beyond diligence. A new system, or a new constructor argument, meant
 * three edits and two chances to quietly diverge.
 *
 * Now the graph exists once. A caller brings a `RoomContext` (which already
 * carries the state, arena, world, config and clock) and gets back the wired
 * engine, with the arena's traps loaded and the shrink walls at the arena's
 * own edges -- the same starting posture in a room, a campaign level and a
 * test.
 */
import type { CollisionWorld } from "@deathmatch/shared";
import type { RoomContext } from "../rooms/RoomContext.js";
import { ArenaShrinkSystem } from "./ArenaShrinkSystem.js";
import { CollisionSystem } from "./CollisionSystem.js";
import { GrenadeSystem } from "./GrenadeSystem.js";
import { MatchManager } from "./MatchManager.js";
import { MovementSystem } from "./MovementSystem.js";
import { NpcSystem } from "../npc/NpcSystem.js";
import { PowerUpSystem } from "./PowerUpSystem.js";
import { ProjectileSystem } from "./ProjectileSystem.js";
import { TrapSystem } from "./TrapSystem.js";
import { WeaponSystem } from "./WeaponSystem.js";

export interface SimulationOptions {
  /** Seeds the bots, so a room varies and a test repeats. */
  seed: number;
  /** Called whenever a bot joins or leaves; the lobby shows the headcount. */
  onRosterChanged?: () => void;
}

/** The wired engine. Every field is the same class every caller ran before. */
export interface Simulation {
  collision: CollisionSystem;
  projectiles: ProjectileSystem;
  weapons: WeaponSystem;
  arenaShrink: ArenaShrinkSystem;
  grenades: GrenadeSystem;
  powerUps: PowerUpSystem;
  traps: TrapSystem;
  movement: MovementSystem;
  matchManager: MatchManager;
  npcs: NpcSystem;
}

export function createSimulation(context: RoomContext, options: SimulationOptions): Simulation {
  const world: CollisionWorld = context.world;

  const collision = new CollisionSystem(world);
  const projectiles = new ProjectileSystem(context, collision);
  const weapons = new WeaponSystem(context, projectiles, collision);
  const arenaShrink = new ArenaShrinkSystem(context);
  // The closure, not the value: the walls move and the grenades must see it.
  const grenades = new GrenadeSystem(context, () => arenaShrink.bounds);
  const powerUps = new PowerUpSystem(context, weapons, grenades);
  const traps = new TrapSystem(context);
  const movement = new MovementSystem(context, world, weapons, grenades, () => arenaShrink.bounds);
  const matchManager = new MatchManager(context, weapons, projectiles, powerUps, arenaShrink, grenades, traps);

  // Bots feed the movement system the same input commands a browser sends, so
  // they are created after it and go through no other door.
  const npcs = new NpcSystem(context, movement, options.seed, options.onRosterChanged);
  matchManager.setNpcSystem(npcs);

  // The arena is data: hazards are whatever it defines, and the walls start at
  // its own edges so there are sane limits before a match ever begins.
  traps.load(context.arena);
  arenaShrink.reset();

  return { collision, projectiles, weapons, arenaShrink, grenades, powerUps, traps, movement, matchManager, npcs };
}
