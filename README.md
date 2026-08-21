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
npm test           # 72 tests: physics, combat, power-ups, debug access, protocol and a real networked match
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
shared/    constants, types, physics, configuration, network contracts
server/    authoritative Colyseus server
client/    Phaser 3 client
tests/     unit + end-to-end tests (run against a real server over a real socket)
```

`shared/` is the single source of truth. A gameplay number lives there exactly once
and is imported by both sides — nothing in `client/` or `server/` redefines it.

### Shared

| File | Contents |
| --- | --- |
| `config/types.ts` | The configuration data model: weapons, power-ups, crates, spawning |
| `config/defaults.ts` | The values the game ships with — data, no logic |
| `config/registry.ts` | The accessors gameplay reads, and the hook for loading config from elsewhere |
| `game/constants.ts` | Tick rates, network tuning, match rules, player physics |
| `game/physics.ts` | The movement step, used by both server simulation and client prediction |
| `game/arena.ts` | Arena geometry, player spawn points and power-up spawn points |
| `game/weapons.ts` | Weapon behaviour derived from weapon data (fire interval, damage falloff, melee arc) |
| `game/powerups.ts` | Power-up behaviour derived from power-up data (health restore, weighted picks) |
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
| `systems/PowerUpSystem.ts` | Crate spawning and destruction, revealed pickups, active effects |
| `debug/DebugAuthorizationService.ts` | Who may use debug tooling; the only place that decides |
| `debug/DebugRegistry.ts` | The debug command catalogue and the room's tunable values |
| `debug/DebugCommandService.ts` | Authorization gate, argument validation and dispatch |

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
| `ui/*` | HUD, kill feed, debug overlay, debug console and screen management (plain DOM) |

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
```

There is deliberately no client-side debug flag: debug tooling is unlocked by a
server grant (see [Debugging](#debugging)), never by the build.

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

### Required settings

Deploy from the repository root: the server build inlines `shared/`, and the root
`npm run build` produces both the server bundle and the client.

| Setting | Value |
| --- | --- |
| Root directory | the repository root (not `server/`) |
| Build command | `npm install && npm run build` |
| Start command | `npm start` |

`ecosystem.config.cjs` in the repository root is required: Colyseus Cloud runs the
app under PM2 and its post-deploy hook aborts with "missing ecosystem config file"
if it is absent. It pins the process count to 1, which suits a shared-vCPU plan and
keeps every room in one memory space — raise it only alongside a larger plan.

Set one environment variable in addition to the environment's own `NODE_ENV`:

```
NPM_CONFIG_PRODUCTION=false
```

Colyseus Cloud installs with npm's production flag on, which skips `devDependencies`.
The build tooling (`esbuild`, `vite`, `typescript`) lives there, so without this the
deploy fails during `npm run build` with `vite: not found` or `esbuild: not found`.

### Serving the client

With `NODE_ENV=production` the server also serves `client/dist` from the same process
(`SERVE_CLIENT` defaults to on), so a single deployment covers both the game and the
multiplayer. The client derives its endpoint from the page origin, which means
`VITE_SERVER_URL` can stay unset and there is no CORS to configure. Look for
`Serving client build` in the startup logs to confirm.

### Hosting the client elsewhere

To serve the client from your own web server instead, set `SERVE_CLIENT=false` on the
deployment and point the client at the endpoint at build time:

```bash
VITE_SERVER_URL=wss://<your-app>.colyseus.cloud npm run build:client
```

`VITE_SERVER_URL` is baked in at build time, not read at runtime, so the client must be
rebuilt whenever the endpoint changes. Set `CORS_ORIGIN` to the site's origin, since the
matchmaking request is then cross-origin.

---

## Weapons, power-ups and crates

All of it is data. Gameplay systems read definitions and act on them; nothing
branches on a weapon or power-up id, so a new weapon or a retuned drop rate is a
configuration change rather than a code change.

### Weapons

| Weapon | Id | Character |
| --- | --- | --- |
| Assault Rifle | `assault-rifle` | The starting weapon. Automatic, accurate, flat damage at any range. |
| Shotgun | `shotgun` | Nine pellets per shot, wide spread, brutal in a corridor and nearly harmless across the arena. |
| Chainsaw | `chainsaw` | Melee. No projectile, no ammunition, very high damage — but it only hurts what it can actually touch. |

A weapon definition carries `damage`, `range`, `fireRate`, `magazineSize` and
`reloadTime` in common, plus one optional block for what only its kind needs:

- **`ranged`** — `bulletSpeed`, `spread`, `pellets`, and an optional `falloff`
  curve. The shotgun is simply a weapon whose definition asks for nine pellets
  and a steep falloff; there is no shotgun-specific branch anywhere.
- **`melee`** — `arcDegrees` and `attackIntervalMs`. The server tests, from its
  own positions, whether anything is inside the arc, within range, and not behind
  a wall. The client only ever says *"I swung"* — it cannot name a victim.

Damage falloff holds full damage to `startDistance`, falls linearly to
`minMultiplier` at `endDistance`, and stays there. It is evaluated against the
distance a projectile actually flew, so a weapon is only as strong as the range
it hit from.

### Power-ups

Power-ups never appear directly in the arena. The flow is entirely server-owned:

```
spawn timer -> free spawn point -> crate (contents chosen by weight)
            -> damage -> destruction -> revealed pickup -> contact -> effect
```

A crate's contents are held server-side and are **not** part of the synchronised
state, so no client can see inside an unopened crate. Only when the crate breaks
does the power-up become an entity clients can see.

| Power-up | Id | Effect |
| --- | --- | --- |
| Medkit | `health-50` | Restores a configured fraction of maximum health, capped at the maximum. |
| Speed Boost | `speed-boost` | Multiplies movement speed for a configured duration. |
| Shotgun | `weapon-shotgun` | Grants the weapon named by `weaponId`. |
| Chainsaw | `weapon-chainsaw` | Same mechanism, different `weaponId`. |

Crate contents are drawn by **weight**, not uniformly. Weights are relative, so
`30 / 30 / 25 / 15` means the medkit is twice as likely as the chainsaw. A
power-up that is disabled — or one granting a disabled weapon — never spawns.

Adding another weapon power-up is one entry in `config/defaults.ts`: the applier
is registered per *type*, not per id, so `{ type: "weapon", weaponId: "..." }`
needs no new code.

### Spawn points

Power-up spawn points live on the **arena**, not in the game config, because a
position is only meaningful against that map's geometry — a new map brings its
own set, and points can be added or removed freely. The server picks a free one
at random, never stacks two crates on the same point, and keeps a point reserved
until its revealed power-up has been collected or expired.

### Configuring it

Every tunable value lives in `shared/src/config/`, split deliberately:

- **`types.ts`** — the data model. Plain JSON-compatible types, so the same shape
  can come from a database or an HTTP API.
- **`defaults.ts`** — the values the game ships with. Data only, no logic.
- **`registry.ts`** — what gameplay actually reads, plus `loadGameConfig()`.

Systems go through the registry, never through `defaults.ts`. That is the seam an
administration interface will use: hand `loadGameConfig()` a config fetched from
anywhere at boot and every system picks it up, with no gameplay change.

Configurable today, without touching TypeScript logic:

| Area | Values |
| --- | --- |
| Weapons | enabled, damage, range, fire rate, magazine size, reload time, automatic |
| Shotgun | pellet count, spread, falloff curve, bullet speed |
| Chainsaw | damage, contact range, attack interval, arc |
| Power-ups | enabled, spawn weight, display name, colour |
| Health | restore fraction (percentage of maximum, not a fixed number) |
| Speed boost | multiplier, duration |
| Crates | health, size, lifetime |
| Spawning | interval, first-spawn delay, max active crates, pickup radius, revealed lifetime |
| Spawn points | per arena, in `game/arena.ts` |

Ids are stable and internal; `name` is what players see. The two are separate, so
renaming a weapon in the HUD never breaks a reference to it.

---

## Debugging

Debug tooling is gated by **server-side authorization**, not by the build or the
environment. That is deliberate: it has to be usable on the production server, so
access is a grant rather than a property of where the code is running.

```
Production + authorized session -> debug allowed
Production + ordinary player    -> debug denied
Development + no grant          -> debug denied
```

### Getting access

Configure who may be granted access on the server:

```
DEBUG_TOKENS=some-long-secret       # a client presenting this is granted access
DEBUG_PLAYERS=Overlord              # display names granted without a token
DEBUG_ALLOW_ALL=false               # grant everyone; only for a private server
```

With none of these set, nobody has debug access anywhere. The server logs which
of them is active at boot.

A client offers a token by opening the game with `?debugToken=some-long-secret`;
it is remembered afterwards so a reload does not need it again. Sending it is
only a *request* -- the server evaluates it and replies either way.

> `DEBUG_PLAYERS` is weak by construction: players choose their own names, so
> anyone who types a listed name is granted access. Use `DEBUG_TOKENS` on any
> server the public can reach.

### What a grant unlocks

| Key | Opens |
| --- | --- |
| **Shift + D** | The debug console: commands and this room's tuning values |
| **F3** | The diagnostic overlay: FPS, ping, coordinates, prediction error, entity counts |

Both do nothing at all without a grant.

The console can grant weapons and power-ups, set health, eliminate a player,
spawn or clear crates, and retune any of the room's parameters. Its contents --
the command catalogue, the forms, the current values -- are all sent by the server
and only to authorized sessions, so the client ships no catalogue of its own and
an unauthorized one cannot even enumerate what exists.

### How it is enforced

Three services, each with one job:

| Service | Responsibility |
| --- | --- |
| `DebugAuthorizationService` | Answers `canUseDebug(sessionId)`. The only thing that decides. |
| `DebugRegistry` | Describes commands and tunables, and holds their handlers. |
| `DebugCommandService` | The entry point. Checks authorization, validates arguments, dispatches. |

Every debug entry point asks `canUseDebug` before doing anything else, so a
client that hand-crafts `debugCommand` messages gets the same refusal as one that
never asked -- hiding the console is a convenience for the player, never a
control. Arguments are coerced against each command's own spec, so out-of-range
values are clamped and undeclared keys are dropped before a handler runs.

Authorization policy sits behind a `DebugAuthorizationPolicy` interface. Swapping
the interim token/whitelist mechanism for the planned account system means
implementing that one interface; nothing else changes.

### Runtime overrides are room-scoped

Each room holds its own `GameConfigView`. A parameter changed through the console
replaces **that room's** configuration and nothing else: other matches are
unaffected, and the server's own configuration is never written to. Overrides are
never persisted, and **Reset parameters** hands the room back to the server's
values. The console marks anything diverging from the baseline with a `*`.

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
  friendly-fire-with-self, weapon validation, the elimination path, shotgun pellets
  and falloff, and chainsaw contact rules (range, arc, walls, attack interval).
- **`tests/debug.test.ts`** — debug authorization over a real socket: a refusal leaks
  no catalogue, a hand-crafted command from an unauthorized session changes nothing,
  arguments are clamped, unknown config paths are refused, and a room override never
  reaches the server configuration.
- **`tests/powerups.test.ts`** — the crate pipeline end to end: spawn points, weighted
  contents, crate damage and destruction, revealed pickups, collection, and every
  power-up effect including expiry. Also asserts a crate never exposes its contents.
- **`tests/protocol.test.ts`** — input codec round-trips, malformed payload rejection,
  name validation, rate limiting.
- **`tests/match.test.ts`** — end-to-end against a real Colyseus server over a real
  socket: matchmaking, the full lifecycle, server-authoritative weapons, and anti-cheat
  (malformed input is ignored; an input flood cannot move a player further than the
  budget allows).

---

## Extending it

The seams are already in place for the obvious next features:

- **More weapons** — add an entry to `shared/src/config/defaults.ts`; nothing else
  hard-codes weapon behaviour.
- **More power-ups** — another entry in the same file. A new *weapon* power-up needs
  no code at all; a genuinely new kind of effect needs one applier in `PowerUpSystem`.
- **An admin interface** — the data model is already separate from the logic. Point
  `loadGameConfig()` at an API or a database and the values stop being source code.
- **More maps** — add an arena to `shared/src/game/arena.ts`, including its own
  power-up spawn points, and select it with `ARENA_ID`.
- **Pickups, grenades, destructibles** — new server systems driven from the room's fixed
  tick, plus schema entries for anything clients must see.
- **Teams, modes, rankings, bots** — the room already separates match lifecycle
  (`MatchManager`) from combat, and spawning is data-driven.
- **Real art** — sprites are generated placeholders behind `TextureFactory` and the view
  classes; swapping in spritesheets does not touch gameplay code.
