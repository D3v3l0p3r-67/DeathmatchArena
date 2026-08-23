/**
 * End-to-end tests for the authoritative match loop.
 *
 * A real Colyseus server is started in-process and driven by real SDK clients, so
 * these cover the actual wire protocol: matchmaking, the match lifecycle, weapon
 * validation and the anti-cheat budget.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import os from "node:os";

// Speed the phases up. Must happen before `config.ts` is imported.
process.env.COUNTDOWN_MS = "400";
process.env.RESULTS_MS = "600";
process.env.VERBOSE_LOGGING = "false";
process.env.MIN_PLAYERS = "2";
// Store administration data somewhere disposable: these tests start a real
// server, and a real server loads and saves arenas and configuration.
process.env.DATA_DIR = `${os.tmpdir()}/deathmatch-test-${process.pid}-${Math.random().toString(36).slice(2)}`;

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client, getStateCallbacks, type Room } from "@colyseus/sdk";
import {
  ClientMessage,
  MatchState,
  ServerMessage,
  encodeInputBatch,
  createInputCommand,
  getWeapon,
  type ArenaChangedPayload,
  type KillPayload,
  type PlayerCareer,
  type MatchResultMessage,
  type InputCommand,
} from "@deathmatch/shared";
import { delay, randomPort, startMatch, waitFor } from "./helpers.js";

const { initialiseAdmin } = await import("../server/src/admin/index.js");
const { BattleRoom } = await import("../server/src/rooms/BattleRoom.js");
type BattleRoomType = InstanceType<typeof BattleRoom>;
type GameRoom = Room<BattleRoomType, BattleRoomType["state"]>;

const port = randomPort();
let gameServer: Server;
let sdk: Client;

before(async () => {
  // Exactly what a real server does before it listens: load stored arenas and
  // publish the configuration, so rooms are created from the same values.
  await initialiseAdmin();

  gameServer = new Server({ transport: new WebSocketTransport({}) });
  gameServer.define("battle", BattleRoom);
  await gameServer.listen(port);
  sdk = new Client(`ws://localhost:${port}`);
});

after(async () => {
  await gameServer.gracefullyShutdown(false);
});

async function join(name: string, playerId?: string): Promise<GameRoom> {
  return sdk.joinOrCreate<BattleRoomType>("battle", { name, playerId });
}

/** Send a batch of input commands the way the real client does. */
function sendInput(room: GameRoom, commands: InputCommand[]): void {
  room.send(ClientMessage.INPUT, encodeInputBatch(commands) as never);
}

describe("match lifecycle", () => {
  it("waits, counts down, plays, and crowns the last player standing", async () => {
    const alice = await join("Alice");
    await waitFor(() => alice.state?.players?.size === 1, "alice in state");
    assert.equal(alice.state.matchState, MatchState.WAITING, "a lone player waits in the lobby");

    const bob = await join("Bob");

    // Both players land in the same room -- matchmaking fills before it creates.
    assert.equal(alice.roomId, bob.roomId, "both players should share a room");

    await waitFor(() => alice.state.players.size === 2, "both players in state");

    // The room does not start itself: it belongs to whoever got here first, and
    // it waits for them. Alice arrived before Bob, so the room is hers.
    // Both of these are published by the server, so they arrive on a patch --
    // not necessarily the same one that carried Bob.
    await waitFor(() => alice.state.hostId === alice.sessionId, "the room to have an owner");
    assert.equal(alice.state.roomName, "Alice's Room");
    await waitFor(() => alice.state.canStart, "two players to count as a match");
    assert.equal(alice.state.matchState, MatchState.WAITING, "and it waits to be told");

    await startMatch(alice, bob);
    await waitFor(() => alice.state.matchState === MatchState.COUNTDOWN, "countdown to begin");
    await waitFor(() => alice.state.matchState === MatchState.PLAYING, "match to start");

    const alicePlayer = alice.state.players.get(alice.sessionId)!;
    const bobPlayer = alice.state.players.get(bob.sessionId)!;

    assert.equal(alicePlayer.alive, true);
    assert.equal(bobPlayer.alive, true);
    assert.equal(alice.state.aliveCount, 2);
    assert.equal(alice.state.startingPlayerCount, 2);
    assert.notEqual(
      `${alicePlayer.x},${alicePlayer.y}`,
      `${bobPlayer.x},${bobPlayer.y}`,
      "players must spawn at different spawn points",
    );

    // The server -- not the client -- decides the winner. Bob leaving ends the match.
    const results: MatchResultMessage[] = [];
    alice.onMessage(ServerMessage.MATCH_RESULT, (payload) => results.push(payload as MatchResultMessage));
    const kills: KillPayload[] = [];
    alice.onMessage(ServerMessage.KILL, (payload) => kills.push(payload as KillPayload));

    await bob.leave(true);

    await waitFor(() => alice.state.matchState === MatchState.FINISHED, "match to finish");
    assert.equal(alice.state.winnerId, alice.sessionId);
    assert.equal(alice.state.winnerName, "Alice");

    await waitFor(() => results.length > 0, "results payload");
    assert.equal(results[0]!.winnerId, alice.sessionId);
    assert.equal(results[0]!.standings[0]!.placement, 1);
    assert.equal(kills.length, 1, "a disconnect mid-match counts as an elimination");
    // Flagged by the server because the client cannot work it out: the kill
    // arrives immediately and the finished state only with the next patch, so
    // without this the last kill of a match looks like any other.
    assert.equal(kills[0]!.endsMatch, true, "the last elimination must announce itself");

    // The room recycles itself so the same players can queue again.
    const arenaBefore = alice.state.arenaId;
    const arenas: string[] = [];
    alice.onMessage(ServerMessage.ARENA_CHANGED, (payload) =>
      arenas.push((payload as ArenaChangedPayload).arena.id),
    );

    await waitFor(() => alice.state.matchState === MatchState.WAITING, "room to reset", 5000);
    assert.equal(alice.state.winnerId, "");
    assert.equal(alice.state.players.get(alice.sessionId)!.placement, 0);

    // And it is somewhere new: the next match deserves a different map, and the
    // client is sent the whole definition because it draws and predicts from it.
    assert.notEqual(alice.state.arenaId, arenaBefore, "the room should have rotated");
    assert.deepEqual(arenas, [alice.state.arenaId], "the client is told, once");

    await alice.leave(true);
  });

  it("keeps a record of what a player has done, and tells only them", async () => {
    // No accounts: the id comes from the client, which is why it is a personal
    // record rather than a ranking -- and why nobody is sent anybody else's.
    const alice = await join("Recorder", "career-test-alice");
    const bob = await join("Opponent", "career-test-bob");

    const mine: PlayerCareer[] = [];
    alice.onMessage(ServerMessage.CAREER, (payload) => mine.push(payload as PlayerCareer));

    await waitFor(() => alice.state.players.size === 2, "both players");
    await startMatch(alice, bob);
    await waitFor(() => alice.state.matchState === MatchState.PLAYING, "match to start");

    await bob.leave(true);
    await waitFor(() => alice.state.matchState === MatchState.FINISHED, "match to finish");
    await waitFor(() => mine.length > 0, "a career update");

    const career = mine.at(-1)!;
    assert.equal(career.matches, 1, "the match just played");
    assert.equal(career.wins, 1, "and she won it");
    assert.equal(career.bestPlacement, 1);

    await alice.leave(true);
  });

  it("routes players into a new room once a match has started", async () => {
    const alice = await join("Alpha");
    const bob = await join("Bravo");
    await startMatch(alice, bob);
    await waitFor(() => alice.state.matchState === MatchState.PLAYING, "first match to start");

    // The room locks on match start, so matchmaking must create a second room.
    const late = await join("Charlie");
    assert.notEqual(late.roomId, alice.roomId, "a late joiner must not land in a running match");
    await waitFor(() => late.state?.matchState === MatchState.WAITING, "the new room to be waiting");

    await Promise.all([alice.leave(true), bob.leave(true), late.leave(true)]);
  });
});

describe("server-authoritative weapons", () => {
  it("spends ammunition, spawns projectiles and reloads on the server's terms", async () => {
    const shooter = await join("Shooter");
    const target = await join("Target");
    await startMatch(shooter, target);
    await waitFor(() => shooter.state.matchState === MatchState.PLAYING, "match to start");

    const player = shooter.state.players.get(shooter.sessionId)!;
    const weapon = getWeapon(player.weaponId);
    assert.equal(player.ammo, weapon.magazineSize, "magazine should be full at spawn");

    let projectilesSeen = 0;
    const $ = getStateCallbacks(shooter);
    $(shooter.state).projectiles.onAdd(() => {
      projectilesSeen++;
    });

    // Hold the trigger for ~0.5s worth of input commands.
    for (let batch = 0; batch < 4; batch++) {
      const commands = Array.from({ length: 8 }, (_, i) => {
        const input = createInputCommand(batch * 8 + i + 1);
        input.fire = true;
        input.aimAngle = 0;
        return input;
      });
      sendInput(shooter, commands);
      await delay(130);
    }

    await waitFor(() => player.ammo < weapon.magazineSize, "ammunition to be spent");
    assert.ok(projectilesSeen > 0, "the server should have spawned projectiles");

    // Fire rate is enforced server-side: 520rpm over ~0.5s cannot exceed ~6 rounds.
    const spent = weapon.magazineSize - player.ammo;
    assert.ok(spent <= 8, `fire rate not enforced: ${spent} rounds in ~500ms`);

    await Promise.all([shooter.leave(true), target.leave(true)]);
  });
});

describe("anti-cheat", () => {
  it("ignores malformed input instead of trusting it", async () => {
    const alice = await join("Malformed");
    const bob = await join("Partner");
    await startMatch(alice, bob);
    await waitFor(() => alice.state.matchState === MatchState.PLAYING, "match to start");

    const player = alice.state.players.get(alice.sessionId)!;
    const startX = player.x;

    // Not an array, wrong arity, out-of-range bitmask, absurd angle.
    alice.send(ClientMessage.INPUT, { moveRight: true } as never);
    alice.send(ClientMessage.INPUT, [[1, 2]] as never);
    alice.send(ClientMessage.INPUT, [[2, 9999, 0]] as never);
    alice.send(ClientMessage.INPUT, [[3, 2, 1e9]] as never);
    await delay(300);

    assert.equal(player.x, startX, "malformed input must not move the player");
    assert.equal(alice.state.matchState, MatchState.PLAYING, "server should stay healthy");

    await Promise.all([alice.leave(true), bob.leave(true)]);
  });

  it("caps how far a flood of inputs can move a player", async () => {
    const cheater = await join("Cheater");
    const bob = await join("Honest");
    await startMatch(cheater, bob);
    await waitFor(() => cheater.state.matchState === MatchState.PLAYING, "match to start");

    const player = cheater.state.players.get(cheater.sessionId)!;
    const startX = player.x;

    // Dump far more input than real time allows. The token bucket should absorb it.
    for (let batch = 0; batch < 20; batch++) {
      const commands = Array.from({ length: 8 }, (_, i) => {
        const input = createInputCommand(batch * 8 + i + 1);
        input.moveRight = true;
        return input;
      });
      sendInput(cheater, commands);
    }
    await delay(400);

    const travelled = Math.abs(player.x - startX);
    // 0.4s of legitimate movement is at most ~132px; allow generous headroom for
    // the burst allowance, but far below the ~53000px the flood asked for.
    assert.ok(travelled < 400, `input flood moved the player ${travelled.toFixed(0)}px`);

    await Promise.all([cheater.leave(true), bob.leave(true)]);
  });
});
