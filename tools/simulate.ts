/**
 * Play a lot of matches with nobody watching, and report what killed everybody.
 *
 * The question this exists to answer is not "do bots win" but "do bots die of
 * things a person would be embarrassed to die of". A bot shot by another bot is
 * the game working; a bot that walked into a fire, or blew itself up, or was
 * squeezed by the closing walls because it never went anywhere, is a bug with a
 * scoreboard in front of it.
 *
 *   npm run simulate -- --matches 100 --bots 2 --arena foundry
 *
 * Runs the real room: the same systems, the same fixed step, the same input
 * queue. Only the clock is ours.
 */
import {
  MatchState,
  getArena,
  listArenas,
  type ArenaDefinition,
} from "@deathmatch/shared";
import { clock, createHarness } from "../tests/harness.js";

interface Options {
  matches: number;
  bots: number;
  arenas: ArenaDefinition[];
  /** Give up on a match that will not end, in seconds. */
  timeoutSec: number;
  verbose: boolean;
  /** Print what the bot was doing every time the arena hurt it. */
  why: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const flag = (name: string, fallback: string): string => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1]! : fallback;
  };

  const arenaName = flag("arena", "all");
  const arenas =
    arenaName === "all"
      ? listArenas().filter((arena) => arena.enabled !== false)
      : [getArena(arenaName)];

  return {
    matches: Number(flag("matches", "100")),
    bots: Number(flag("bots", "2")),
    arenas,
    timeoutSec: Number(flag("timeout", "180")),
    verbose: argv.includes("--verbose"),
    why: argv.includes("--why"),
  };
}

/** What ended a bot's match, in the terms a person would use. */
type Cause =
  | { kind: "shot"; detail: string }
  | { kind: "own blast"; detail: string }
  | { kind: "trap"; detail: string }
  | { kind: "walls"; detail: string }
  | { kind: "survived"; detail: string };

interface Death {
  arena: string;
  cause: Cause;
  /** Seconds into the match. */
  at: number;
}

function classify(weaponId: string, attackerId: string, victimId: string): Cause {
  if (weaponId.startsWith("trap:")) {
    return { kind: "trap", detail: weaponId.slice("trap:".length) };
  }
  // The closing walls damage with no attacker and no weapon.
  if (weaponId === "" && attackerId === "") return { kind: "walls", detail: "crushed" };
  if (attackerId === victimId) return { kind: "own blast", detail: weaponId || "explosion" };
  return { kind: "shot", detail: weaponId || "unknown" };
}

function playMatch(
  arena: ArenaDefinition,
  bots: number,
  timeoutSec: number,
  seed: number,
  why = false,
): Death[] {
  const harness = createHarness(arena, seed);
  harness.state.matchState = MatchState.WAITING;

  // Somebody has to be in the room or the bots are sent home, but they are not
  // playing: this is a match between bots, watched.
  const watcher = harness.addPlayer("watcher", 0, 0);
  watcher.connected = true;
  watcher.alive = false;
  watcher.inMatch = false;
  harness.state.hostId = "watcher";

  for (let i = 0; i < bots; i++) harness.npcs.spawn();
  harness.matchManager.requestStart();

  const startedAt = clock.now;
  const deaths: Death[] = [];
  const alive = new Map<string, boolean>();

  let seen = 0;
  for (let elapsed = 0; elapsed < timeoutSec; elapsed += 0.25) {
    harness.run(0.25);

    if (why) {
      for (; seen < harness.damage.length; seen++) {
        const record = harness.damage[seen]!;
        if (!record.weaponId.startsWith("trap:")) continue;

        const agent = harness.npcs.list().find((a) => a.sessionId === record.victimId);
        const runtime = harness.runtimes.get(record.victimId);
        const player = harness.state.players.get(record.victimId);
        if (!agent || !runtime || !player) continue;

        const info = harness.npcs.describe().find((entry) => entry.sessionId === record.victimId);
        const goal = agent.movement.goal;
        const inner = agent.movement as unknown as {
          intent: { direction: number };
          jumpPhase: string;
        };
        const traps = agent.lastContext?.traps ?? [];
        const nearest = traps[0];
        console.log(
          `    ${elapsed.toFixed(1).padStart(5)}s ${record.weaponId.padEnd(12)} -${Math.round(record.amount)}hp ` +
            `${record.victimId} at ${Math.round(player.x)},${Math.round(player.y)} ` +
            `v=${Math.round(runtime.movement.velocityX)},${Math.round(runtime.movement.velocityY)} ` +
            `ground=${runtime.movement.onGround ? "y" : "n"} ` +
            `${info?.action ?? "?"}/${info?.state ?? "?"} ` +
            `goal=${goal ? Math.round(goal.x) + "," + Math.round(goal.y) : "-"} ` +
            `hp=${Math.round(player.health)} dir=${inner.intent.direction} jump=${inner.jumpPhase} ` +
            `traps=${traps.length}${nearest ? `(${nearest.hot ? "hot" : "cold"},${nearest.harmful ? "harmful" : "harmless"},d=${Math.round(nearest.distance)})` : ""} ` +
            `input=${runtime.lastInput.moveLeft ? "L" : ""}${runtime.lastInput.moveRight ? "R" : ""}${runtime.lastInput.jump ? "J" : ""}${runtime.lastInput.moveLeft || runtime.lastInput.moveRight || runtime.lastInput.jump ? "" : "-"} ` +
            `mult=${runtime.movement.speedMultiplier.toFixed(2)} kb=${runtime.movement.knockbackTimer.toFixed(2)}`,
        );
      }
    }

    for (const agent of harness.npcs.list()) {
      const player = harness.state.players.get(agent.sessionId);
      if (!player) continue;

      const was = alive.get(agent.sessionId);
      alive.set(agent.sessionId, player.alive);
      if (was !== true || player.alive) continue;

      // The blow that finished them: the last damage this bot took.
      let last: (typeof harness.damage)[number] | undefined;
      for (const record of harness.damage) {
        if (record.victimId === agent.sessionId) last = record;
      }

      deaths.push({
        arena: arena.id,
        cause: last
          ? classify(last.weaponId, last.attackerId, last.victimId)
          : { kind: "walls", detail: "no damage recorded" },
        at: (clock.now - startedAt) / 1000,
      });
    }

    // Once it has started, anything that is not still playing means it is over.
    const state: string = harness.state.matchState;
    if (elapsed > 5 && state !== MatchState.PLAYING) break;
  }

  // Anybody still standing when the match ended.
  for (const agent of harness.npcs.list()) {
    const player = harness.state.players.get(agent.sessionId);
    if (player?.alive) {
      deaths.push({ arena: arena.id, cause: { kind: "survived", detail: "won" }, at: (clock.now - startedAt) / 1000 });
    }
  }

  harness.damage.length = 0;
  return deaths;
}

const options = parseOptions(process.argv.slice(2));
const all: Death[] = [];

for (let match = 0; match < options.matches; match++) {
  const arena = options.arenas[match % options.arenas.length]!;
  // A different seed each time, or this is one match played a hundred times.
  if (options.why) console.log(`match ${match + 1} on ${arena.id}:`);
  const deaths = playMatch(arena, options.bots, options.timeoutSec, 1000 + match * 7919, options.why);
  all.push(...deaths);

  if (options.verbose) {
    const summary = deaths.map((d) => `${d.cause.kind}/${d.cause.detail}@${d.at.toFixed(0)}s`).join(" ");
    console.log(`match ${String(match + 1).padStart(3)} ${arena.id.padEnd(8)} ${summary}`);
  }
}

// ---------------------------------------------------------------------------
// What happened
// ---------------------------------------------------------------------------

const byKind = new Map<string, number>();
const byDetail = new Map<string, number>();

for (const death of all) {
  byKind.set(death.cause.kind, (byKind.get(death.cause.kind) ?? 0) + 1);
  const key = `${death.cause.kind}: ${death.cause.detail}`;
  byDetail.set(key, (byDetail.get(key) ?? 0) + 1);
}

const ended = all.filter((death) => death.cause.kind !== "survived");
console.log(`\n${options.matches} matches, ${options.bots} bots, ${options.arenas.map((a) => a.id).join("+")}`);
console.log(`${ended.length} deaths\n`);

for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
  if (kind === "survived") continue;
  const share = ((count / Math.max(1, ended.length)) * 100).toFixed(1);
  console.log(`  ${kind.padEnd(12)} ${String(count).padStart(4)}  ${share.padStart(5)}%`);
}

console.log("\nin detail:");
for (const [key, count] of [...byDetail].sort((a, b) => b[1] - a[1])) {
  if (key.startsWith("survived")) continue;
  console.log(`  ${key.padEnd(28)} ${String(count).padStart(4)}`);
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
console.log(`\nmedian time of death: ${median(ended.map((d) => d.at)).toFixed(1)}s`);
