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
| `/admin` | Arena editor and game configuration (needs a `DEBUG_TOKENS` value) |
| `/playground` | Colyseus playground |
| `/colyseus` | Colyseus monitor dashboard |

### Other commands

```bash
npm test           # 202 tests: physics, combat, grenades, power-ups, traps, arenas, configuration,
                   #            administration, presentation, debug access, protocol and a real networked match
npm run typecheck  # tsc --noEmit across all three packages
npm run build      # bundles the server and builds the client
npm start          # runs the built server
```

---

## Controls

```
A / Left Arrow      move left
D / Right Arrow     move right
Space / W / Up      jump (press again in mid-air for a second jump)
Mouse               aim
Left Mouse          fire (hold — the rifle is automatic)
Right Mouse         hold to charge a grenade throw, release to throw
R                   reload
Left / Right Arrow  switch spectated player (while dead)
O                   open settings (audio and effects)
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
| `config/types.ts` | The configuration data model: player, match, weapons, power-ups, crates, traps |
| `config/defaults.ts` | The values the game ships with — data, no logic |
| `config/registry.ts` | The accessors gameplay reads, and the hook for loading config from elsewhere |
| `config/schema.ts` | What every value *means*: category, label, type, range — generated from the config itself |
| `config/validator.ts` | Validation for one change and for a whole configuration |
| `arena/types.ts` | The arena data model: geometry, spawn points, traps |
| `arena/traps.ts` | The trap type catalogue and the registry that holds it |
| `arena/validator.ts` | Arena validation, with errors that block a save and warnings that do not |
| `arena/factory.ts` | Creating, duplicating and repairing arenas |
| `arena/defaults.ts` | The arena the game ships with, as a repository seed |
| `game/constants.ts` | Tick rates, network tuning and the sizes that are genuinely structural |
| `game/physics.ts` | The movement step (including the double jump), shared by server simulation and client prediction |
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
| `systems/ArenaShrinkSystem.ts` | The closing walls, and the damage they do |
| `systems/GrenadeSystem.ts` | Throw charging, grenade flight and bounces, fuses and blasts |
| `systems/TrapSystem.ts` | Trap activation, motion, overlap and damage — generic, with no per-trap code |
| `admin/AdminAuthorization.ts` | Who may administer the server; the only place that decides |
| `admin/ArenaRepository.ts` | Where arenas are stored, behind an interface a database could implement |
| `admin/ArenaService.ts` | Arena rules: validate, store, publish to the running server |
| `admin/GameConfigRepository.ts` | Where configuration *overrides* are stored |
| `admin/GameConfigService.ts` | The three configuration layers, and what reset means at each scope |
| `admin/router.ts` | The administration API. Every route behind one authorization check |
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
| `audio/sounds.ts` | The sound catalogue — every sound as synthesis parameters, no files |
| `audio/AudioEngine.ts` | Runtime synthesis, mixer channels, positional falloff and panning |
| `audio/SoundController.ts` | The one place that maps game events to sounds |
| `game/fx/effects.ts` | The effect catalogue — bursts and camera shakes as data |
| `admin/AdminApp.ts` | The administration interface's shell: token, tabs, status line |
| `admin/ArenaEditor.ts` | The visual arena editor: a canvas, a camera and a hit test |
| `admin/ArenaInspector.ts` | Properties of the selection, generated for traps from their type metadata |
| `admin/ConfigPanel.ts` | The game configuration editor, generated entirely from server metadata |
| `admin/controls.ts` | One control renderer, shared by the configuration editor and the trap inspector |
| `ui/*` | HUD, kill feed, settings, debug overlay, debug console and screen management (plain DOM) |

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

### The arena closes

A match cannot run forever. After a configured time the arena's left and right
edges start advancing towards each other, squeezing the survivors together until
someone wins.

The walls are authoritative and solid: the server owns their positions, and the
shared movement step clamps players to them, so a player is physically pushed
ahead of a wall rather than asked to move. Anyone the walls are pressing against
also takes damage -- without that, a player wedged between a closing wall and
solid geometry would simply stop, and the match could stall in exactly the
situation the shrink exists to end.

Everything about it is configurable (`arenaShrink`): whether it happens at all,
how long the match runs first, how fast the walls travel, how narrow the gap gets
before they stop, and how hard they hurt. The HUD counts down to it and then
warns while it is happening, both driven by whole seconds the server sends.

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

**Server** (`server/.env`) — port, CORS origins, arena id, where administration data
is stored, and whether the monitor, playground and verbose logging are enabled. All
have sensible development defaults; the tooling endpoints are off by default in
production.

`MIN_PLAYERS`, `MAX_PLAYERS`, `COUNTDOWN_MS` and `RESULTS_MS` still work, but they are
now *seeds*: they set the defaults an administrator then edits on top of, and become
what "reset to default" restores. See [Administration](#administration).

```
DATA_DIR=./data          # where arenas and configuration overrides are stored
DATA_PERSISTENT=false    # set true once DATA_DIR points at a mounted volume
```

`DATA_PERSISTENT` is declared, not detected — only the operator knows whether the
directory survives a restart. The administration interface shows the answer, so
nobody spends an afternoon building an arena that a redeploy will discard.

**Client** (`client/.env.local`):

```
VITE_SERVER_URL=ws://localhost:2567   # unset -> derived from the page origin
```

There is deliberately no client-side debug flag: debug tooling is unlocked by a
server grant (see [Debugging](#debugging)), never by the build.

Gameplay tuning (speeds, gravity, weapon stats, arena layout) is not environment
configuration. It is administered data: the shipped values live in `shared/`, an
administrator edits them through the interface below, and the server sends the result
to every client on join — which is what keeps client prediction and server simulation
stepping the same numbers.

---

## Administration

Everything a designer would want to change — arenas, traps, weapons, movement, match
pacing — is data an administrator edits at `/admin`, not a constant in the source.

### Getting in

Administration uses the same tokens as the debug console:

```
DEBUG_TOKENS=some-long-secret
```

Two things the debug policy allows are deliberately **not** honoured here:

- **The player-name whitelist.** A display name is not a credential — anyone can type
  one — and an HTTP request has no player attached to it in the first place.
- **`DEBUG_ALLOW_ALL`.** It exists to make a match easy to poke at. It must not hand
  the world write access to every arena and the stored game configuration.

So with only `DEBUG_ALLOW_ALL` set, the debug console opens and administration stays
shut. That asymmetry is the point.

With no token configured, `/admin` says so plainly rather than pretending to be
broken — an operator who set nothing needs to know that is why, and it reveals
nothing an attacker could use.

### Arenas

An arena is data: dimensions, geometry, spawn points and traps.

```ts
{
  id: "arena-01",              // stable and internal; fixed once created
  name: "Factory",             // what an administrator sees; free to change
  enabled: true,
  width: 3200,
  height: 1800,
  elements: [],                // floors, platforms, walls, obstacles
  playerSpawns: [],
  powerUpSpawns: [],
  traps: [],
}
```

Geometry is **one list with a `type`**, not four parallel arrays. Floors, platforms,
walls and obstacles collide identically and differ only in how they are drawn and how
the editor groups them, so one list means the collision world, the renderer, the
editor and the validator each have exactly one code path.

The editor is visual: pan and zoom, click to select, drag to move, drag a handle to
resize, arrow keys to nudge, `Ctrl`+`D` to duplicate, `Delete` to remove, and undo/redo
throughout. Layers can be hidden while working. Validation runs against the *server*
as you edit, not only when you save — the server is the authority either way, and
asking it continuously means a mistake shows up while it is still fresh in mind.

Errors block a save; warnings do not. The distinction matters: a spawn point buried in
a wall is recoverable (the server nudges it clear at match start) and an arena with no
spawn points at all is not, and an editor that refuses both equally is one people stop
using.

A saved arena reaches the running server immediately — rooms created afterwards use
it. A match already in progress keeps the arena it started on, because changing the
floor under a running match would desynchronise every client in it.

### Traps

A trap type is a **description**, not code: how its body moves, how it meters damage,
what it looks like, and which extra parameters it takes. `TrapSystem` reads that and
simulates it generically, so there is no `if (trap.type === "spikes")` anywhere on the
server. Adding a hazard is a registration in the catalogue.

Six ship, and between them they exercise every motion and damage mode:

| Type | Motion | Damage | Typically |
| --- | --- | --- | --- |
| Spikes | static | once per contact | permanently dangerous |
| Fire vent | static | per second | cycles on its own |
| Electric zone | static | per second | cycles on its own |
| Moving hazard | patrols its route | once per contact | permanently dangerous |
| Crusher | drives out and withdraws | once per contact | a player comes near |
| Falling object | drops under gravity | once per contact | a player comes near |

Each placement chooses what sets it off — always, on a cycle, on proximity, or on
contact — and may override any of damage, activation delay, active duration, cooldown,
movement speed and trigger radius. **Leaving an override unset is meaningful**: it
means "inherit", so retuning traps globally reaches that placement. The inspector
shows which is which.

The server is authoritative for all of it. Clients are told where a trap is, how big
it is and which phase of its cycle it is in — enough to draw it and to read the
warning. They never report a hit, never decide whether a trap is active, and never
influence how much damage it does.

### Game configuration

The second half of the interface edits the same values the game runs on. Nothing in
it is hard-coded: each value is described by metadata, and the interface renders
whatever the server sends.

```ts
{
  key: "weapons.shotgun.damage",
  category: "Weapons",
  subcategory: "Shotgun",
  label: "Damage",
  type: "number",              // number | boolean | string | select | percentage
  defaultValue: 13,
  min: 0, max: 500, step: 1,
  description: "Damage per projectile that hits, before distance falloff.",
  editable: true,
}
```

The field list is **generated from the configuration itself**, so a weapon or power-up
added to the catalogue becomes editable with no interface change — and only the fields
that make sense for it appear: a chainsaw has no magazine, a rifle has no swing arc, a
weapon without falloff has no falloff curve.

Categories: Player, Match, Weapons, Grenades, Power-ups, Crates, Arena and Traps.

Validation is server-side and covers ranges, whole numbers, allowed options, required
values, and the dependencies between fields — a minimum throw power that would exceed
the maximum, a falloff that ends before it starts, a lobby minimum above its own
capacity. Values out of range are **refused, never clamped**, so an administrator
finds out that a limit exists instead of silently getting a different number.

Every parameter can be reset to its default, and so can a whole subcategory or
category.

### What is stored, and what that means

Only the **deltas** are stored, never a whole configuration. Two reasons, and both
matter more than they look. A stored snapshot would freeze the shipped values at the
moment somebody first touched the interface, and every rebalance in every future
release would silently stop reaching this server. And it makes "reset to default"
exact: it deletes a key rather than trying to remember what the value used to be.

The three layers, applied in order:

1. the values the game ships with;
2. deployment seeds from environment variables;
3. stored administrator overrides.

Both arenas and overrides sit behind repository interfaces (`ArenaRepository`,
`GameConfigRepository`) with five methods between them. Moving from JSON files to a
database is a new class and one line of wiring; no gameplay code moves.

### Administration and the debug console

They share one catalogue. The debug console's tunables *are* the administration
fields, with the same limits and the same validator — so the two can no longer drift
apart, and adding a weapon adds it to both at once.

What differs is scope. A debug change applies to one room until it closes and is never
stored. An administrator's change is stored and becomes what every room created
afterwards starts from.

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

### Applying an environment variable change

Colyseus Cloud applies environment variables **on the next deployment**, and it has
no redeploy button — the Deployments tab is history only. A running instance
therefore keeps the values it started with until a new deployment happens, which
is triggered by **pushing to `main`**.

So after adding or changing a variable (a debug token, say), push a commit to
`main`. The startup logs report what the new instance actually read, which is the
quickest way to confirm the change landed.

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
| Grenades | `grenade-pack` | Hands over a configured number of grenades, up to the carrying limit. |
| Shotgun | `weapon-shotgun` | Grants the weapon named by `weaponId`. |
| Chainsaw | `weapon-chainsaw` | Same mechanism, different `weaponId`. |

Crate contents are drawn by **weight**, not uniformly. Weights are relative, so
`30 / 30 / 25 / 15` means the medkit is twice as likely as the chainsaw. A
power-up that is disabled — or one granting a disabled weapon — never spawns.

Adding another weapon power-up is one entry in `config/defaults.ts`: the applier
is registered per *type*, not per id, so `{ type: "weapon", weaponId: "..." }`
needs no new code.

### Grenades

Every player starts a match with one grenade; more come from crates like anything
else. Holding the right mouse button winds up a throw, and releasing it throws
along the current aim.

The client's entire contribution is *a held button and an aim angle*. It never
sends a charge duration, a velocity, a hit or a damage number. The server sees
the button go down, sees it come up, and measures the interval against its own
clock — which is why a modified client cannot claim a full-power throw it never
charged, and why holding for an hour still only yields the configured maximum.

From there the server owns everything: the arc under gravity, the bounces off
geometry and off the closing walls, the fuse, and the blast. Damage falls off
linearly from the centre of the explosion to a configured floor at the edge, and
the thrower is checked like everybody else — standing next to your own grenade
hurts. Blasts open crates too.

The HUD shows the grenade count, and a power bar while a throw is charging. The
bar is drawn from the client's own press time so it moves at frame rate, but it
fills against the same configured maximum the server measures with, so a full bar
really is a full-power throw.

Every value is configurable (`grenades`) and exposed as a room-scoped debug
tunable: starting and maximum count, minimum and maximum throw speed, maximum
charge time, gravity, bounciness, friction, fuse, blast radius, maximum damage,
damage at the edge, and how many a pickup grants.

### Spawn points

Power-up spawn points live on the **arena**, not in the game config, because a
position is only meaningful against that map's geometry — a new map brings its
own set, and points can be placed visually in the arena editor. The server picks a
free enabled one at random, never stacks two crates on the same point, and keeps a
point reserved until its revealed power-up has been collected or expired.

### Configuring it

All of it is editable at `/admin` — see [Administration](#administration). The values
themselves live in `shared/src/config/`, split deliberately:

- **`types.ts`** — the data model. Plain JSON-compatible types, so the same shape
  can come from a database or an HTTP API.
- **`defaults.ts`** — the values the game ships with. Data only, no logic.
- **`registry.ts`** — what gameplay actually reads, plus `loadGameConfig()`.
- **`schema.ts`** — what each value means, so an interface can render it.
- **`validator.ts`** — what each value may be set to.

Systems go through the registry, never through `defaults.ts`, and the administration
layer feeds `loadGameConfig()` at boot and on every save.

Configurable without touching TypeScript:

| Area | Values |
| --- | --- |
| Player | max health, move speed, accelerations, frictions |
| Jumping | gravity, jump strength, max jumps, mid-air jump strength, early-release cut, coyote time, jump buffer, fall speed |
| Match | min/max players, countdown, result screen, maximum match length |
| Weapons | enabled, damage, range, fire rate, magazine size, reload time, automatic |
| Shotgun | pellet count, spread, falloff curve, bullet speed |
| Chainsaw | damage, contact range, attack interval, arc |
| Grenades | starting and maximum count, min/max throw power, charge time, gravity, bounce, friction, fuse, blast radius, damage and falloff |
| Power-ups | enabled, spawn weight, display name, and the effect each type carries |
| Crates | health, size, lifetime |
| Spawning | interval, first-spawn delay, max active crates, pickup radius, revealed lifetime |
| Closing walls | enabled, start time, wall speed, minimum width, crush damage |
| Traps | global defaults for damage, delay, duration, cooldown, speed and trigger radius |
| Arenas | geometry, spawn points and trap placements, per arena |

Ids are stable and internal; `name` is what players see. The two are separate, so
renaming a weapon in the HUD never breaks a reference to it.

The player values are worth a note: they used to be compile-time constants, because
client prediction and server simulation must agree on them *exactly*. They are now
configurable, and the agreement is explicit instead of implicit — the server sends
the room's values with the welcome message and the client predicts with those, so
both sides still step the same integrator with the same numbers.

---

## Sound and effects

### Sound is synthesised, not loaded

There are no audio files in this repository. Every sound is built at runtime from
oscillators and filtered noise described in `client/src/audio/sounds.ts`, so the
game ships nothing to download and nothing to license — and retuning a gunshot is
editing numbers rather than opening an audio editor.

A sound is a stack of layers. Each layer is a tone (with an optional pitch sweep)
or filtered noise, shaped by an attack/decay envelope; layering a swept tone under
noise is what turns a beep into a gunshot or an explosion. Two details do most of
the work: **pitch jitter**, without which a rifle firing ten times a second sounds
like a machine rather than a gun, and **per-sound throttling**, without which a
shotgun's nine pellets land nine impacts in the same millisecond and are heard as
one distorted clack.

Sounds in the world are positional: they fade with distance from the camera and
pan towards the side they happened on, which is most of what makes a firefight
readable when you cannot see the shooter. Sounds *about you* — being hit, your own
pickup, a kill you scored — play unpositioned at full volume, so they cut through.

`SoundController` is the only place that maps events to sounds. Some of it needs
no messages at all: jumps, landings, reloads and a ticking fuse are simply visible
in the synchronised state, so they become audible without costing bandwidth.

### Effects are data too

`client/src/game/fx/effects.ts` holds every burst and camera shake as numbers
rather than constants inline, so the game's feel is tunable in one file. Bursts
carry particle counts, speed and lifetime ranges, gravity and an optional cone;
shakes carry a duration and an intensity.

Beyond the existing muzzle flashes and impacts, there are landing puffs, a ring
under the mid-air jump, sparks where a grenade bounces, debris when a crate
breaks, a burst tinted with a power-up's own colour when it is collected, and a
blast drawn at the radius the server actually used.

### What a player can change

Press **O** (or *Settings* on the menu) for master and per-channel volumes, mute,
particle density, screen shake and damage numbers. All of it is stored in the
player's own browser and none of it reaches the server — volumes and particle
counts are presentation, and presentation is the client's.

Turning particles or shake to zero is a supported setting, not a broken one: the
game still plays every flash and flourish, just without the debris or the camera
movement.

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
values. The console marks anything diverging from that baseline with a `*`.

The parameters the console offers are the same ones the administration interface
offers, with the same limits and the same validator — both are generated from one
description in `shared/src/config/schema.ts`. The difference is only what a change
means: room-scoped and temporary here, stored and server-wide there. That also means
"diverging from the baseline" is measured against what the *server is configured to
use*, not against what the game shipped with — an administrator's saved change is the
server's value, and must not show up in a console as a room override.

The server logs room lifecycle events, joins, leaves and match transitions; set
`VERBOSE_LOGGING=false` to quieten it.

---

## Tests

```bash
npm test
```

- **`tests/physics.test.ts`** — arena integrity (spawns are free, grounded and enclosed),
  movement, jump height, the double jump (two jumps and no more, refilled on landing,
  only one after walking off a ledge), the closing walls' clamp, wall collision, and
  determinism of the shared step.
- **`tests/combat.test.ts`** — projectile collision, tunnelling at high bullet speeds,
  friendly-fire-with-self, weapon validation, the elimination path, shotgun pellets
  and falloff, and chainsaw contact rules (range, arc, walls, attack interval).
- **`tests/debug.test.ts`** — debug authorization over a real socket: a refusal leaks
  no catalogue, a hand-crafted command from an unauthorized session changes nothing,
  arguments are clamped, unknown config paths are refused, and a room override never
  reaches the server configuration.
- **`tests/powerups.test.ts`** — the closing arena (timing, symmetry, minimum width,
  crush damage, disabling it) and the crate pipeline end to end: spawn points, weighted
  contents, crate damage and destruction, revealed pickups, collection, and every
  power-up effect including expiry. Also asserts a crate never exposes its contents.
- **`tests/grenades.test.ts`** — the loadout, charge-to-speed curve (including an
  absurd hold being clamped), flight under gravity, bouncing off geometry, the fuse,
  and a blast that falls off with distance and catches the thrower too.
- **`tests/presentation.test.ts`** — the sound and effect catalogues: every id has a
  definition, every sound routes to a real channel and renders (no sub-audible tones,
  no zero-length layers), burst-prone sounds are throttled, and no camera shake is
  set hard enough to be unplayable.
- **`tests/protocol.test.ts`** — input codec round-trips, malformed payload rejection,
  name validation, rate limiting.
- **`tests/match.test.ts`** — end-to-end against a real Colyseus server over a real
  socket: matchmaking, the full lifecycle, server-authoritative weapons, and anti-cheat
  (malformed input is ignored; an input flood cannot move a player further than the
  budget allows).
- **`tests/arena.test.ts`** — arena validation (bounds, duplicate ids, spawn points,
  trap types and ranges), the error/warning split, normalisation of arbitrary JSON, and
  the id helpers.
- **`tests/config.test.ts`** — the configuration metadata: that the field list is
  generated from the catalogue, that only the fields a weapon actually has appear, and
  that ranges, whole numbers, enums, dependencies and whole-configuration invariants are
  enforced.
- **`tests/traps.test.ts`** — traps from the server's side: contact damage that fires
  once and re-arms, continuous damage metered per second, the warning before the hurt,
  the full cycle, proximity triggering, a trap that moves into someone, inheritance and
  overrides, and every way a trap is switched off.
- **`tests/admin.test.ts`** — the administration services: nothing reaches storage
  unvalidated, the last playable arena cannot be deleted, a save publishes to the
  running server, and reset works at every scope while storing only deltas.

---

## Extending it

The seams are already in place for the obvious next features:

- **More weapons** — add an entry to `shared/src/config/defaults.ts`; nothing else
  hard-codes weapon behaviour, and it appears in the administration interface and the
  debug console on its own.
- **More power-ups** — another entry in the same file. A new *weapon* power-up needs
  no code at all; a genuinely new kind of effect needs one applier in `PowerUpSystem`.
- **More trap types** — register a `TrapTypeDefinition` describing how it moves and
  how it meters damage. The simulation, the validator and the editor all pick it up;
  the server has no per-trap code to add to.
- **A database instead of JSON files** — implement `ArenaRepository` and
  `GameConfigRepository` and change one line of wiring. No gameplay code moves.
- **Real accounts instead of shared tokens** — implement `AdminAuthorizationPolicy`
  and `DebugAuthorizationPolicy` against the account system. No route and no debug
  entry point changes.
- **More maps** — build them at `/admin`, or seed them in `shared/src/arena/defaults.ts`.
- **Pickups, grenades, destructibles** — new server systems driven from the room's fixed
  tick, plus schema entries for anything clients must see.
- **Teams, modes, rankings, bots** — the room already separates match lifecycle
  (`MatchManager`) from combat, and spawning is data-driven.
- **Real art** — sprites are generated placeholders behind `TextureFactory` and the view
  classes; swapping in spritesheets does not touch gameplay code.
