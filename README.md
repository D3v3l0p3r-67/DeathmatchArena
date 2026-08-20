# Deathmatch Arena

A fast 2D side-view online deathmatch shooter for the browser. Up to 10 players fight
in one large arena; there are no respawns, and the last player standing wins.

The whole simulation runs on the server. The client sends intentions (`moveLeft`,
`jump`, `fire`, an aim angle) and renders what the server says happened — it never
decides its own position, health, hits, kills, ammo or the winner.

- **Client:** TypeScript + Phaser 3 (WebGL/Canvas)
- **Server:** TypeScript + Colyseus on Node.js, deployable to Colyseus Cloud
- **Shared:** one copy of the constants, physics, weapon data and network contracts,
  imported by both sides

---

## Quick start

```bash
npm install
npm run dev
```

That starts both processes:

| Service | URL |
| --- | --- |
| Colyseus server | http://localhost:2567 |
| Phaser client (Vite) | http://localhost:5173 |

Open **http://localhost:5173 in two browser windows**, enter a name in each and press
Play. A match starts as soon as two players are in the lobby, so two windows are
enough to play a full round.

Useful server endpoints in development:

| Path | What it is |
| --- | --- |
| `/health` | Liveness probe |
| `/config` | Match rules (min/max players, countdown) so the client need not hard-code them |
| `/playground` | Colyseus playground |
| `/colyseus` | Colyseus monitor dashboard |

### Other commands

```bash
npm test           # 33 tests: physics, combat, protocol, and a real networked match
npm run typecheck  # tsc --noEmit across all three packages
npm run build      # bundles the server and builds the client
npm start          # runs the built server
```

---

## Controls

```
A / Left Arrow      move left
D / Right Arrow     move right
Space / W / Up      jump
Mouse               aim
Left Mouse          fire (hold — the rifle is automatic)
R                   reload
Left / Right Arrow  switch spectated player (while dead)
F3                  toggle the debug overlay
```

---

## Repository layout

```
shared/    constants, types, physics, weapon data, network contracts
server/    authoritative Colyseus server
client/    Phaser 3 client
tests/     unit + end-to-end tests (run against a real server over a real socket)
```

`shared/` is the single source of truth. A gameplay number lives there exactly once
and is imported by both sides — nothing in `client/` or `server/` redefines it.

### Shared

| File | Contents |
| --- | --- |
| `game/constants.ts` | Tick rates, network tuning, match rules, player physics |
| `game/physics.ts` | The movement step, used by both server simulation and client prediction |
| `game/arena.ts` | Arena geometry and spawn points |
| `game/weapons.ts` | Data-driven weapon definitions |
| `game/CollisionWorld.ts` | Broadphase + raycasting against arena geometry |
| `net/messages.ts` | Message names and payload types |
| `net/inputCodec.ts` | Compact input encoding, with decode-side validation |
| `net/validation.ts` | Player-name rules |
| `net/RateLimiter.ts` | Token bucket used to bound client message rates |

### Server

| File | Responsibility |
| --- | --- |
| `rooms/BattleRoom.ts` | Composition root: owns the room, wires the systems, handles messages |
| `rooms/schema/*` | The synchronised state (`GameState`, `PlayerState`, `ProjectileState`) |
| `systems/MovementSystem.ts` | Applies queued inputs through the shared physics step |
| `systems/WeaponSystem.ts` | Fire-rate, magazine and reload validation; spawns projectiles |
| `systems/ProjectileSystem.ts` | Projectile movement, lifetime, and swept collision |
| `systems/CollisionSystem.ts` | Segment-vs-world and segment-vs-player tests |
| `systems/MatchManager.ts` | Match lifecycle, spawning, damage resolution, eliminations, winner |

Systems depend on a small `RoomContext` interface rather than on `BattleRoom`, which
keeps them unit-testable and free of circular imports.

### Client

| File | Responsibility |
| --- | --- |
| `App.ts` | Screen flow and the bridge between the network, the scene and the DOM UI |
| `game/scenes/GameScene.ts` | Rendering plus the local prediction loop |
| `net/NetworkManager.ts` | Connection, message plumbing, state callbacks, ping |
| `net/PredictionController.ts` | Local prediction and server reconciliation |
| `net/SnapshotBuffer.ts` | Snapshot history and interpolation for remote entities |
| `game/CameraController.ts` | Smooth follow, world clamping, screenshake |
| `game/InputController.ts` | The only place that knows about key bindings |
| `ui/*` | HUD, kill feed, debug overlay and screen management (plain DOM) |

---

## How the multiplayer works

### Authority

The server simulates at a fixed **60 Hz** and broadcasts state deltas at **20 Hz**
using Colyseus's own state synchronisation — no manual per-frame snapshots.

Clients send only intentions. Every gameplay message is validated server-side:

- Input is decoded from a compact binary form; malformed batches are dropped, not coerced.
- A token bucket limits how many simulation steps a player may consume, so a modified
  client cannot fast-forward its own character by flooding inputs.
- Firing checks the server clock, the magazine, the reload state and the weapon
  definition. The client says *"I fired in this direction"*; the server decides whether
  anything was hit.
- Damage is only ever applied in `MatchManager.applyDamage`, from a weapon definition
  and a collision the server computed itself.
- The winner is decided solely by the server, when the alive count drops to one.

### Prediction and interpolation

The local player is predicted immediately, so controls feel instant. Each input command
carries a sequence number; the server reports the last one it processed, and the client
replays anything newer on top of the authoritative position. Small errors are eased
away over a few frames, and only a large divergence snaps.

Remote players and projectiles are rendered ~110 ms in the past, interpolated between
buffered snapshots, so they stay smooth even though updates arrive at 20 Hz while the
client renders at 60+ FPS.

Physics never depends on frame rate or on packet arrival: both sides advance in exact
multiples of a fixed 1/60 s step, carrying the remainder in an accumulator.

### Match flow

```
WAITING -> COUNTDOWN -> PLAYING -> FINISHED -> WAITING
```

Two players are enough to start (configurable via `MIN_PLAYERS`); ten is the maximum.
When a match starts the room locks itself, so Colyseus routes new arrivals into a fresh
room instead of an ongoing fight. Dead players stay connected as spectators and can
cycle through the survivors. After the results screen the room recycles itself so the
same group can immediately play again.

Disconnects are handled: a leaving player is eliminated, the alive count is
recalculated, and the match continues. Colyseus reconnection is supported within a
short grace window.

---

## Configuration

Nothing environment-specific is hard-coded. Copy the example files to override:

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env.local
```

**Server** (`server/.env`) — port, CORS origins, `MIN_PLAYERS`/`MAX_PLAYERS`, countdown
and results durations, arena id, and whether the monitor, playground and verbose
logging are enabled. All have sensible development defaults; the tooling endpoints are
off by default in production.

**Client** (`client/.env.local`):

```
VITE_SERVER_URL=ws://localhost:2567   # unset -> derived from the page origin
VITE_DEBUG=false                      # or press F3 / append ?debug=1
```

Gameplay tuning (speeds, gravity, weapon stats, arena layout) lives in `shared/`, not
in environment variables, because the client and server must agree on it exactly.

---

## Deploying to Colyseus Cloud

`server/` is already shaped the way Colyseus Cloud expects:

- `src/app.config.ts` exports the application via `@colyseus/tools`, with no host or
  port baked in. `src/index.ts` is only the local entry point.
- `npm run build` bundles the server to a single `build/index.js` with esbuild. The
  bundler inlines `@deathmatch/shared` (a TypeScript-source workspace package) so the
  output needs nothing but the runtime dependencies in `server/package.json`.
- `npm start` runs the build. `PORT` is read from the environment.
- `/health` is available as a liveness probe.

Deploy from the repository root so `shared/` is present at build time, then point the
client at the deployed endpoint:

```
VITE_SERVER_URL=wss://<your-app>.colyseus.cloud
```

Alternatively set `SERVE_CLIENT=true` on the server to serve the built client from the
same process, in which case the client derives the endpoint from the page origin and
`VITE_SERVER_URL` can be left unset.

---

## Debugging

Press **F3** (or append `?debug=1`) for an overlay showing FPS, ping, the local
player's world coordinates, current prediction error, pending unacknowledged inputs,
the room id, the session id, and the connected player and projectile counts. It is off
by default in production builds.

The server logs room lifecycle events, joins, leaves and match transitions; set
`VERBOSE_LOGGING=false` to quieten it.

---

## Tests

```bash
npm test
```

- **`tests/physics.test.ts`** — arena integrity (spawns are free, grounded and enclosed),
  movement, jump height, wall collision, and determinism of the shared step.
- **`tests/combat.test.ts`** — projectile collision, tunnelling at high bullet speeds,
  friendly-fire-with-self, weapon validation, and the elimination path.
- **`tests/protocol.test.ts`** — input codec round-trips, malformed payload rejection,
  name validation, rate limiting.
- **`tests/match.test.ts`** — end-to-end against a real Colyseus server over a real
  socket: matchmaking, the full lifecycle, server-authoritative weapons, and anti-cheat
  (malformed input is ignored; an input flood cannot move a player further than the
  budget allows).

---

## Extending it

The seams are already in place for the obvious next features:

- **More weapons** — add an entry to `shared/game/weapons.ts`; nothing else hard-codes
  weapon behaviour.
- **More maps** — add an arena to `shared/game/arena.ts` and select it with `ARENA_ID`.
- **Pickups, grenades, destructibles** — new server systems driven from the room's fixed
  tick, plus schema entries for anything clients must see.
- **Teams, modes, rankings, bots** — the room already separates match lifecycle
  (`MatchManager`) from combat, and spawning is data-driven.
- **Real art** — sprites are generated placeholders behind `TextureFactory` and the view
  classes; swapping in spritesheets does not touch gameplay code.
