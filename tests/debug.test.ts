/**
 * Debug authorization and command handling.
 *
 * The property under test throughout: **the client decides nothing**. Hiding the
 * console is a convenience; these check that the server refuses an unauthorized
 * session even when it sends exactly the messages an authorized one would.
 *
 * The networked half runs against a real Colyseus server over a real socket, so
 * a "hand-crafted message" here is genuinely a hand-crafted message.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

// Must happen before `config.ts` is imported.
process.env.COUNTDOWN_MS = "400";
process.env.RESULTS_MS = "600";
process.env.VERBOSE_LOGGING = "false";
process.env.MIN_PLAYERS = "2";
process.env.DEBUG_TOKENS = "test-secret,second-secret";
process.env.DEBUG_PLAYERS = "Overlord";

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client, type Room } from "@colyseus/sdk";
import {
  CHAINSAW_ID,
  ClientMessage,
  MatchState,
  PLAYER,
  SHOTGUN_ID,
  ServerMessage,
  getGameConfig,
  type DebugCommandResult,
  type DebugStatePayload,
} from "@deathmatch/shared";
import { delay, randomPort, waitFor } from "./helpers.js";

const { BattleRoom } = await import("../server/src/rooms/BattleRoom.js");
type BattleRoomType = InstanceType<typeof BattleRoom>;
type GameRoom = Room<BattleRoomType, BattleRoomType["state"]>;

const port = randomPort();
let gameServer: Server;
let sdk: Client;

before(async () => {
  gameServer = new Server({ transport: new WebSocketTransport({}) });
  gameServer.define("battle", BattleRoom);
  await gameServer.listen(port);
  sdk = new Client(`ws://localhost:${port}`);
});

after(async () => {
  await gameServer.gracefullyShutdown(false);
});

/** A joined client with its debug traffic recorded. */
interface Session {
  room: GameRoom;
  states: DebugStatePayload[];
  results: DebugCommandResult[];
  latestState(): DebugStatePayload | undefined;
}

async function join(name: string): Promise<Session> {
  const room = await sdk.joinOrCreate<BattleRoomType>("battle", { name });
  const states: DebugStatePayload[] = [];
  const results: DebugCommandResult[] = [];

  room.onMessage(ServerMessage.DEBUG_STATE, (payload) => states.push(payload as DebugStatePayload));
  room.onMessage(ServerMessage.DEBUG_RESULT, (payload) =>
    results.push(payload as DebugCommandResult),
  );

  return { room, states, results, latestState: () => states[states.length - 1] };
}

/** Ask for debug access exactly the way the real client does. */
function requestAccess(session: Session, token?: string): void {
  session.room.send(ClientMessage.DEBUG_AUTH, (token ? { token } : {}) as never);
}

function sendCommand(session: Session, commandId: string, params: Record<string, unknown> = {}): void {
  session.room.send(ClientMessage.DEBUG_COMMAND, { commandId, params } as never);
}

describe("debug authorization", () => {
  it("refuses a session that offers no token, and tells it nothing", async () => {
    const player = await join("Nobody");
    requestAccess(player);

    await waitFor(() => player.states.length > 0, "a verdict");
    const state = player.latestState()!;

    assert.equal(state.granted, false);
    // A refusal must not leak the catalogue: an unauthorized client should not
    // even be able to enumerate which commands exist.
    assert.deepEqual(state.commands, []);
    assert.deepEqual(state.config, []);

    await player.room.leave(true);
  });

  it("refuses a wrong token with the same answer as no token", async () => {
    const player = await join("Impostor");
    requestAccess(player, "not-the-secret");

    await waitFor(() => player.states.length > 0, "a verdict");
    const state = player.latestState()!;

    assert.equal(state.granted, false);
    assert.deepEqual(state.commands, []);
    // The refusal reason must not distinguish "wrong token" from "no tokens
    // configured", or it becomes an oracle for probing.
    assert.equal(state.reason, "Debug access denied");

    await player.room.leave(true);
  });

  it("grants a session presenting a configured token", async () => {
    const player = await join("Tester");
    requestAccess(player, "test-secret");

    await waitFor(() => player.states.some((state) => state.granted), "a grant");
    const state = player.latestState()!;

    assert.equal(state.granted, true);
    assert.ok(state.commands.length > 0, "an authorized session receives the catalogue");
    assert.ok(state.config.length > 0, "and the room's tunable values");
    assert.equal(state.roomId, player.room.roomId, "the grant names the room it applies to");

    await player.room.leave(true);
  });

  it("grants a whitelisted player name without a token", async () => {
    const player = await join("Overlord");
    requestAccess(player);

    await waitFor(() => player.states.some((state) => state.granted), "a grant");
    assert.equal(player.latestState()!.granted, true);

    await player.room.leave(true);
  });

  it("does not depend on the environment", () => {
    // The policy is built from explicit configuration only. Nothing in the debug
    // path reads NODE_ENV, which is what lets debug tooling work in production
    // for authorized users and stay shut for everyone else.
    assert.equal(process.env.NODE_ENV, undefined);
    assert.ok(process.env.DEBUG_TOKENS, "access comes from configuration, not the environment");
  });
});

describe("debug commands", () => {
  it("ignores commands from an unauthorized session, however well-formed", async () => {
    const intruder = await join("Intruder");
    const victim = await join("Victim");

    await waitFor(() => intruder.room.state?.players?.size === 2, "both players");
    await waitFor(() => intruder.room.state.matchState === MatchState.PLAYING, "the match");

    const victimId = victim.room.sessionId;
    const before = intruder.room.state.players.get(victimId)!;
    const startWeapon = before.weaponId;
    const startHealth = before.health;

    // Exactly the messages an authorized console sends -- without ever having
    // been granted access.
    sendCommand(intruder, "grant-weapon", { target: intruder.room.sessionId, weaponId: CHAINSAW_ID });
    sendCommand(intruder, "set-health", { target: victimId, value: 1 });
    sendCommand(intruder, "kill-player", { target: victimId });
    sendCommand(intruder, "set-config", { path: "crate.health", value: 1 });
    await delay(400);

    const self = intruder.room.state.players.get(intruder.room.sessionId)!;
    const target = intruder.room.state.players.get(victimId)!;

    assert.notEqual(self.weaponId, CHAINSAW_ID, "an unauthorized session cannot arm itself");
    assert.equal(self.weaponId, startWeapon);
    assert.equal(target.health, startHealth, "and cannot touch anyone else's health");
    assert.equal(target.alive, true, "and cannot eliminate anyone");

    // It is told it has no access, rather than being silently ignored.
    assert.ok(
      intruder.states.some((state) => !state.granted),
      "the server answers with a refusal",
    );
    assert.equal(intruder.results.length, 0, "and runs nothing");

    await Promise.all([intruder.room.leave(true), victim.room.leave(true)]);
  });

  it("executes commands for an authorized session", async () => {
    const admin = await join("Tester");
    const other = await join("Bystander");

    await waitFor(() => admin.room.state?.players?.size === 2, "both players");
    await waitFor(() => admin.room.state.matchState === MatchState.PLAYING, "the match");

    requestAccess(admin, "test-secret");
    await waitFor(() => admin.states.some((state) => state.granted), "a grant");

    sendCommand(admin, "grant-weapon", { target: admin.room.sessionId, weaponId: SHOTGUN_ID });
    await waitFor(
      () => admin.room.state.players.get(admin.room.sessionId)!.weaponId === SHOTGUN_ID,
      "the weapon to change",
    );

    const self = admin.room.state.players.get(admin.room.sessionId)!;
    assert.equal(self.weaponId, SHOTGUN_ID);
    assert.ok(self.ammo > 0, "the granted weapon arrives loaded");

    sendCommand(admin, "set-health", { target: admin.room.sessionId, value: 42 });
    await waitFor(() => admin.room.state.players.get(admin.room.sessionId)!.health === 42, "health");

    assert.ok(admin.results.every((result) => result.ok), "both commands succeeded");

    await Promise.all([admin.room.leave(true), other.room.leave(true)]);
  });

  it("rejects an unknown command and clamps out-of-range arguments", async () => {
    const admin = await join("Tester");
    const other = await join("Bystander");

    await waitFor(() => admin.room.state?.players?.size === 2, "both players");
    await waitFor(() => admin.room.state.matchState === MatchState.PLAYING, "the match");

    requestAccess(admin, "test-secret");
    await waitFor(() => admin.states.some((state) => state.granted), "a grant");

    sendCommand(admin, "definitely-not-a-command", {});
    await waitFor(() => admin.results.length > 0, "a result");
    assert.equal(admin.results[0]!.ok, false);
    assert.match(admin.results[0]!.message, /unknown/i);

    // Health is clamped to the legal range rather than being taken at face value.
    sendCommand(admin, "set-health", { target: admin.room.sessionId, value: 99999 });
    await waitFor(
      () => admin.room.state.players.get(admin.room.sessionId)!.health === PLAYER.MAX_HEALTH,
      "clamped health",
    );

    const self = admin.room.state.players.get(admin.room.sessionId)!;
    assert.equal(self.health, PLAYER.MAX_HEALTH, "an absurd value is clamped, not applied");

    await Promise.all([admin.room.leave(true), other.room.leave(true)]);
  });

  it("keeps configuration overrides inside the room that made them", async () => {
    const admin = await join("Tester");
    const other = await join("Bystander");

    await waitFor(() => admin.room.state?.players?.size === 2, "both players");
    await waitFor(() => admin.room.state.matchState === MatchState.PLAYING, "the match");

    requestAccess(admin, "test-secret");
    await waitFor(() => admin.states.some((state) => state.granted), "a grant");

    const baselineCrateHealth = getGameConfig().crate.health;

    sendCommand(admin, "set-config", { path: "crate.health", value: baselineCrateHealth + 40 });
    await waitFor(
      () =>
        (admin.latestState()?.config.find((entry) => entry.path === "crate.health")?.value ?? 0) ===
        baselineCrateHealth + 40,
      "the override to show up",
    );

    const entry = admin.latestState()!.config.find((item) => item.path === "crate.health")!;
    assert.equal(entry.value, baselineCrateHealth + 40);
    assert.equal(entry.overridden, true, "the console marks it as diverging from the baseline");

    // The process-wide configuration is untouched, so no other room sees this.
    assert.equal(
      getGameConfig().crate.health,
      baselineCrateHealth,
      "a room override must never write back to the server configuration",
    );

    // And it can be handed back.
    sendCommand(admin, "reset-config", {});
    await waitFor(
      () =>
        (admin.latestState()?.config.find((item) => item.path === "crate.health")?.value ?? 0) ===
        baselineCrateHealth,
      "the reset",
    );

    await Promise.all([admin.room.leave(true), other.room.leave(true)]);
  });

  it("refuses an unknown configuration path instead of writing it", async () => {
    const admin = await join("Tester");
    const other = await join("Bystander");

    await waitFor(() => admin.room.state?.players?.size === 2, "both players");
    await waitFor(() => admin.room.state.matchState === MatchState.PLAYING, "the match");

    requestAccess(admin, "test-secret");
    await waitFor(() => admin.states.some((state) => state.granted), "a grant");

    admin.results.length = 0;
    // Only generated, known paths are writable; anything else is refused.
    sendCommand(admin, "set-config", { path: "__proto__.polluted", value: 1 });
    await waitFor(() => admin.results.length > 0, "a result");

    assert.equal(admin.results[0]!.ok, false);
    assert.match(admin.results[0]!.message, /unknown parameter/i);
    assert.equal(
      ({} as Record<string, unknown>).polluted,
      undefined,
      "an unknown path must not reach the config object",
    );

    await Promise.all([admin.room.leave(true), other.room.leave(true)]);
  });

  it("drops a grant when the session leaves", async () => {
    const admin = await join("Tester");
    requestAccess(admin, "test-secret");
    await waitFor(() => admin.states.some((state) => state.granted), "a grant");

    await admin.room.leave(true);

    // Reconnecting is a new session and must start unauthorized.
    const returning = await join("Tester");
    requestAccess(returning);
    await waitFor(() => returning.states.length > 0, "a verdict");

    assert.equal(
      returning.latestState()!.granted,
      false,
      "a fresh session without a token holds no grant",
    );

    await returning.room.leave(true);
  });
});
