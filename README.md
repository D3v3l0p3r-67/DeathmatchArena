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
npm test           # 290 tests: physics, combat, grenades, power-ups, traps, arenas, configuration,
                   #            administration, NPC brains, presentation, debug access, protocol,
                   #            and real networked matches
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
A / D / Arrows      switch spectated player (while dead) — the same keys that moved you
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
| `npc/*` | The NPC brain: perception, memory, utility scoring, navigation, controllers |
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
client renders at 60+ FPS. A spawn is the exception, because it is a teleport
rather than a journey: a player's snapshot history is dropped the moment they
come alive, or the interpolator would glide them across the arena from wherever
they last were — which at the start of a match is last match's death spot, and
which read as everybody flying in to their spawn points.

Physics never depends on frame rate or on packet arrival: both sides advance in exact
multiples of a fixed 1/60 s step, carrying the remainder in an accumulator.

### Firing is predicted too

Movement prediction alone leaves one seam, and it is exactly where a player is
looking hardest: the trigger. The server applies recoil when a shot fires, and a
shove the client does not predict becomes a reconciliation correction on *every
single shot* — around latency × recoil speed, which on an ordinary Wi-Fi round
trip is a visible 10–30 px rubber-band per shot. The flash and the bang used to
wait for the projectile to come back over the wire too, so firing was the one
action in the game that felt the connection.

The client therefore runs a local mirror of the server's fire gate
(`LocalFireModel`) for its own player: same weapon definition, same rules —
ammunition, fire-rate cooldown, reload, fresh trigger pull for semi-automatics —
advanced one fixed tick per input, exactly as the server drains one input per
tick. When the model says "the server will fire here", three things happen on
that tick instead of a round trip later: the same `applyKnockback` recoil lands
on the predicted movement, the muzzle flash and camera kick play, and the shot
sound fires. Reconciliation replays the recoil of still-unconfirmed shots when
it replays pending inputs, so a predicted shot produces no error at all.

Nothing about authority moves. The server still decides what every shot *does* —
projectiles, damage, ammunition are simulated there and nowhere else — and the
model is self-healing: each patch it rebuilds its magazine from the server's
count minus the shots the server has not yet simulated, so a wrong guess (or an
ammunition refill it cannot see) is corrected within one patch. A misprediction
costs one smoothed correction, which is what every shot cost before the model
existed. The one honest limit: the server measures cooldowns on its own clock
and the model measures them in ticks, so around the edge of a cooldown the two
can disagree by one tick — a couple of pixels, inside the smoothing threshold.

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

A room seats ten and starts at two, one of whom must be a person. It belongs to
its host, who adds bots at whatever difficulty they like and decides when to
begin — the room never waits for a number — see [NPCs](#npcs).
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

## NPCs

Bots that play the game rather than simulate playing it. No LLM, no neural
network, no external service: perception, a utility brain, a state machine and
two controllers, which is what game AI has been made of for thirty years and
what makes it debuggable.

### An NPC is a player

The constraint everything else follows from: a bot gets a `PlayerState` and a
`PlayerRuntime` like anyone else, its decisions come out as `InputCommand`s, and
those go into the same queue a browser's inputs go into. It is spawned by the
same match manager, moved by the same integrator, bounded by the same input
budget, and shot by the same collision code.

So there is no bot movement code anywhere. If a bot could be moved by anything
other than an input command it would stop being bound by the rules it is playing
under, and "the AI cheats" is the one criticism a shooter never recovers from.

### The parts

```
Perception → Context → Utility scoring → Intent → State machine → Controllers
```

| File | Responsibility |
| --- | --- |
| `npc/Perception.ts` | The only thing that reads the room, and it throws most of it away |
| `npc/Memory.ts` | Where an enemy went, until it is forgotten |
| `npc/context.ts` | What a bot believes, normalised to 0..1 |
| `npc/TargetSelector.ts` | *Who*, scored separately from *what* |
| `npc/Brain.ts` | Scores registered actions, with hysteresis and noise |
| `npc/actions/*` | One file per action: a score and a small state machine |
| `npc/CombatController.ts` | Aim, lead, shoot, throw — deliberately imperfect |
| `npc/MovementController.ts` | Left, right, jump, double jump, drop, and nothing else |
| `npc/Navigation.ts` | A graph of standing room, with walk / jump / drop links |
| `npc/NpcAgent.ts` | One bot: owns the parts and runs them at the right rates |
| `npc/NpcSystem.ts` | The bots in one room: population, input, debug |

The layering is enforced by what each part is handed. The brain receives a
context and returns an intent; it holds no reference to the controllers and could
not move a bot if it wanted to. The controllers receive the intent and have no
idea why they were asked. Only `NpcAgent` knows both.

### Perception is the honesty boundary

The server knows everything. Perception narrows that to what a bot could
plausibly sense, and it is the only place with access to the room:

- an enemy behind a wall is not in the result (three rays — head, chest, knees —
  because one centre-to-centre ray is hidden by a knee-high crate);
- an enemy beyond the configured sight range is not in the result;
- **a crate never reports its contents**, because the server does not tell anyone
  what is inside one, and a bot that knew would be cheating in exactly the way
  crates exist to prevent.

It runs at the configured perception rate — eight times a second by default,
faster than a person reacts and a fraction of the cost of doing it per frame.

### Behaviour is scored, not branched

Nine actions ship: attack, chase, retreat, dodge, get power-up, get weapon, throw
grenade, take position, search. Each is a score built from normalised terms and
profile weights, and the highest wins:

```ts
score = lowHealth * danger * profile.survival * 100;
```

Not `if (health < 20) retreat()`. The same expression makes a Coward leave early
and a Berserker ignore it, which a threshold cannot, and it can be balanced by
moving a number rather than rewriting a condition. Even the emergencies are
scored: a grenade at your feet simply produces a number no ordinary action can
reach, so a Berserker one shot from a kill will occasionally eat it.

Two mechanisms stop pure scoring from looking insane, both profile-driven:
whatever a bot is already doing gets a bonus and a challenger must beat it by a
threshold, and an action cannot be replaced until it has had a minimum time to
show what it was going to do. Without them, two actions whose scores cross
produce attack/retreat/attack/retreat several times a second. A small random
spread on every score does the opposite job: it stops two bots with the same
profile moving in lockstep.

### Personality is configuration

There is no `AggressiveNpc` class. Every bot runs the same brain and differs only
by a `BrainProfile` — twelve of them ship (Aggressive, Defensive, Rusher, Hunter,
Opportunist, Collector, Grenadier, Camper, Trickster, Coward, Berserker,
Balanced), and every value is editable at `/admin` under **NPCs** or live in the
debug console. A bot re-reads its profile on every decision, so a change lands on
its next thought.

The profile is who a bot *is*; the situation bends it into who they are right
now. Being hurt lowers aggression and raises survival in proportion, a bad weapon
raises the appetite for a pickup — expressed once, in `deriveEffectiveProfile`,
so no action's scoring carries an "except when hurt" clause. A hurt Berserker is
still the most aggressive thing in the room, just less so.

### Being beatable

A weak bot is not one with less health or a damage penalty. It is one that:

- takes longer to notice you (`reactionTimeMs`),
- swings its aim more slowly (`aimSkill`),
- misjudges where you are going (`predictionSkill`),
- and holds its crosshair a little off — a slow drift re-rolled a few times a
  second, not per-tick noise, which averages to nothing and looks like a
  vibrating gun.

Targeting is scored separately from acting, so bots do not all converge on
whoever is nearest: a Hunter peels off after the wounded one across the room
while a Coward takes what is in front of it.

### Watching one think

The debug console (`Shift`+`D`) gains an **NPC AI** section: every bot's profile,
current action and state, its target, and every action's score with the winner
marked, alongside the context that produced them. **Add bot**, **Remove bots** and
**Watch bot** are ordinary debug commands.

Decision logging is off by default and only ever on for one bot at a time — a
dozen of them logging at eight hertz is noise nobody can read.

### Three arenas, and the room moves between them

```
The Foundry   3200x1800   three lanes, a central mesa, a passage underneath
The Gantry    3600x1200   wide and low: four staggered decks and long sightlines
The Silo      2000x2400   tall and narrow: a spiral around a solid column
```

A room changes arena while it resets between matches — never mid-fight, and
never to the one just played. Everything that reads geometry does so through
`context.arena` and `context.world`, which are getters, so most of the server
follows on its own; what is left is the handful of places holding a direct
reference: the two systems that raycast, the traps the arena defines, the closing
walls, and the bots, whose navigation graph describes a map that no longer
exists. The client is sent the whole definition rather than an id, for the same
reason the welcome carries one: an administrator can create an arena after the
client was built, and prediction steps against this geometry.

Every shipped arena is checked in the suite for more than validity: that it seats
a full room, that its traps are types the simulation knows, that it produces no
warnings at all — and that **every spawn can reach every other**. That last one
catches the failure a validator cannot: a map that looks fine and plays as two
separate arenas, where half the players never meet anybody.

### The room, and whose it is

**A room belongs to a person, not to a number.** It seats ten, it starts at two,
and it never starts itself — the host decides when, with whoever is standing
there.

```
Room: Ada's Room
WAITING FOR PLAYERS
Players: 3 / 10

  ● Ada (you)        HOST
  ● Blaz
  ● Vex - Easy       BOT   x
  ● Rook - Hard      BOT   x

           [ + Add bot ]
      [ Leave ]    [ Start ]
```

The host is whoever has been in the room longest. Only they may add a bot, remove
one, or start the match; everybody else waits and may leave. When the host leaves
the room passes to the next-longest-present person, and its name goes with it —
`joinOrder` is what makes that handover predictable rather than whichever entry a
map iterator happens to yield first. A dropped connection does not hand the room
over while the seat is being held, because the host of a room nobody can talk to
would be a room nobody can start.

Adding a bot opens a picker, and choosing a rung *is* the confirmation:

```
BOT DIFFICULTY
  [1] Very Easy   [2] Easy   [3] Normal   [4] Hard   [5] Very Hard
  [ Cancel ]
```

Each bot carries its own difficulty, so a room can hold an Easy one and a Hard
one at once — the level lives on the player rather than on the room, which is
what makes that possible. Bots share the roster with everybody else, because they
are playing the same match, and they say what they are.

Two conditions decide whether a match may begin, and there is no third:

```
totalPlayers >= 2        somebody to fight
humanPlayers >= 1        somebody to fight for
```

`canStart` is computed on the server and synchronised, so the host's button and
the server cannot disagree about what pressing it would do. Everything the client
could get wrong is decided server-side anyway: that the asker is the host, that
the room is between matches, that a place is free, and which rung of the ladder a
requested difficulty lands on. A client sending `addBot` by hand gets exactly
nothing.

The one thing that starts a room without being told is a full one — at ten
players there is nobody left it could be waiting for.

```
1 person              ->  waits. Start is disabled: a match of one is over on
                          the tick it begins.
1 person + 1 bot      ->  Start                               (2 players)
2 people              ->  Start                               (2 players)
3 people + 2 bots     ->  Start                               (5 players)
1 person + 9 bots     ->  Start                               (10 players)
10 people             ->  starts by itself; the room is full
```

There is no hold, no countdown to a full room, and no "waiting for 4 more
players". A room is open until its host starts it or it fills, and the only thing
the lobby says is that it is waiting.

Bots are only added and removed between matches: dropping one into a running
match would give it a free spawn among people who have been fighting, and the
same goes for difficulty — a match is played at the level it started at.

### An installation that had one map

The map picker arrived and, on the machine it was written for, had nothing to
pick from. The store explains it: arenas are written to `data/arenas.json` on
first run and treated as ordinary data ever after -- so an installation seeded
before the Gantry and the Silo existed held exactly one arena, for good. The
picker had one entry and hid itself, the between-match rotation was a permanent
no-op, and every match was played on the Foundry. The map had never been "always
the same" as a matter of taste; there had only ever been one.

Newly shipped arenas are now merged in on load, and the document remembers which
ids it has been *offered* rather than which it holds. That is what keeps both
promises: a map you have never seen arrives, a map you deleted stays deleted,
and a map you edited stays yours. A store written before that flag existed is
read as having been offered exactly what it holds, which is the migration --
no version stamp, just an honest reading of an older file.

### The lobby says what matters, in that order

The lobby's headline is the room's own name -- the one thing that
distinguishes this lobby from any other -- with "waiting for players" beneath
it and the seat count beneath that. The hint line ("start whenever you like")
is gone: the enabled Start button already says exactly that.

Below the count sits the map row. Everyone sees which arena the coming match
is on; the host sees a Change button that opens a picker listing what the
server says is playable -- from the server, not the client's bundle, because
an administrator can add arenas after the client was built. Choosing one is a
request like every other lobby action: the server checks that the asker is the
host, that the room is still waiting, and that the id names a playable arena,
then switches through the same path the between-match rotation uses, so the
world, the traps and the bots' navigation all follow. A test drives all four
refusals and the happy path against a live server.

### Difficulty is skill, not a second personality

**A brain profile says what a bot wants. A difficulty level says how well it
manages any of it.** Multiplying one by the other is what gives twelve
personalities × five levels — sixty kinds of opponent — without a single extra
profile being written. An Aggressive bot at level 2 is the same Aggressive bot:
it still walks at you, it is simply worse at it.

A level scales two separate things, and keeping them separate is the whole
design: **how well a bot plays**, and **how much its mistakes cost**. Neither
touches the weapon catalogue — a rifle does what the rifle says whoever is
holding it — and neither reaches into the other, so the AI work and the balance
work can be done without one quietly undoing the other.

```
                         L1 Very Easy   L3 Normal   L5 Very Hard
reaction time x                  2.40        1.25           1.00
aim skill x                      0.40        0.75           1.00
prediction skill x               0.15        0.60           1.00
dodge skill x                    0.30        0.70           1.00
decision noise x                 2.50        1.35           1.00
decision interval x              2.40        1.30           1.00
grenade accuracy                 0.25        0.65           1.00
navigation skill                 0.30        0.70           1.00
target selection                 0.25        0.70           1.00

damage taken x                   1.50        1.15           1.00
damage dealt x                   0.60        0.90           1.00
environmental damage x           1.00        1.00           1.00
```

Level 5 is the reference point: every multiplier is 1, so it plays the profiles
exactly as written, takes a weapon's full damage and deals it — which is where
the bots were before difficulty existed, and why the shipped default is 3. And
even level 5 aims through the same imperfect-aim machinery as every other rung:
there is no perfect aim at any difficulty, and no level is given information a
bot could not sense.

**The multiplier belongs to the bot, never to its target.** A level-1 bot
shooting a level-5 bot deals 60% into somebody who takes 100%; the same rifle
fired back is a full-strength hit into somebody who takes 150% of it. Both sides
can therefore apply to one hit, which is the honest reading of "each bot's
difficulty describes that bot". A human is scaled in neither direction.

Three cases are deliberately not what a naive implementation would do:

- **The arena's own damage has its own setting**, defaulting to 1. Traps and the
  closing walls are exactly what a bot is supposed to avoid by playing better,
  and softening them for an easy bot would hide the failure the AI measurements
  exist to find, rather than fix it.
- **A bot blowing itself up is counted once**, as damage taken. It is one bot on
  both sides of the same hit, and multiplying dealt by taken would square a
  mistake for a number nobody could read off the settings.
- **Where the hit came from is passed explicitly, not sniffed from the weapon
  id.** The closing walls report the *victim's own* weapon, so a crushed player
  holding a rifle is indistinguishable from a player who was shot — guessing
  would mis-scale every crush in the game.

All of it lands in `applyDamage`, the one place health ever drops, so it covers
bullets, pellets, blasts, melee and every weapon not written yet without each
system having to remember. And all six numbers per rung are ordinary
configuration: they appear in the admin interface and the debug console like
anything else, they are validated and clamped server-side, and a change reaches
the next hit rather than the next match.

Measured head-to-head over 40 matches per arm, a Very Easy bot against a Very
Hard one: **skill alone gave level 5 57% of the decided matches; with the damage
multipliers it takes 68%.**

The four values that are not multipliers have nowhere in a personality to come
from, so difficulty owns them outright:

- **grenade accuracy** — a misjudged throw angle and a misjudged charge, drawn
  once when the wind-up starts rather than re-rolled every tick;
- **navigation skill** — how far ahead it looks for hazards, and how quickly it
  notices that what it is doing is not working. It buys no extra information: the
  hazards are the ones it can already perceive;
- **target selection** — how reliably it acts on its own ranking. Below 1 it
  often stays on whoever it was already shooting at rather than switching to the
  better target. Modelled as reluctance to switch rather than as a random pick,
  because re-rolling a target eight times a second reads as a *broken* bot rather
  than a bad one;
- **decision interval** — how often it reconsiders at all, so a fight turning
  against a poor bot takes longer to register.

### How a bot flies a jump

A jump is not a button press. Its height comes from *how long the button is
held*, and the mid-air jump needs a fresh press, which means a release first. The
movement controller used to script that as a fixed list of ticks —
`[press, release]` — which is exactly the input the variable-jump-height rule
cuts short. **Every bot jump was a 35px hop.** Meanwhile the navigation graph was
linking ledges 138px up, and pairs of jumps reaching 237px, so bots were
confidently planning routes they physically could not fly. That is where the
pacing under platforms, the run-ups and the abandoned goals were coming from.

It is now a small state machine over what the body is actually doing, which needs
no knowledge of gravity or jump strength:

```
rising      hold while still going up and still below the target
apex        release -- and if the target is still out of reach, this is the
            moment the second jump is worth spending
airRising   hold again, release at the top
```

Releasing at the apex costs nothing, because there is no ascent left to cut, and
it is the only moment the mid-air jump is worth its full value: it *replaces* the
current upward speed rather than adding to it, so pressing it early throws away
most of what the first jump bought.

Measured by asking a bot to climb a ledge and watching whether it ends up
standing on it:

```
              before   after
 40px ledge   climbed  climbed
 80px ledge      —     climbed
120px ledge      —     climbed
170px ledge      —     climbed     (the second jump earns its keep here)
200px ledge      —     climbed
260px ledge      —        —        (and it does not pretend otherwise)
```

The graph's reach was tightened to match — 237px of theory became ~200px of
practice — because a link a bot cannot fly is how a route turns into a bot
pressed against the underside of a platform.

### Hazards, and when a grenade is the right answer

**A bot routes around the spikes.** The navigation graph prices every trap the
arena defines: standing where one can reach costs 1400px of detour, walking
through one on the way costs 1100. It is a cost and not a wall on purpose — an
arena is allowed to put the only route through a fire vent, and a bot that
refused to move would be worse than one that takes the risk. What it prices is
where the traps *are*, never what phase they are in: spikes that are down now
come back up, and routing around the schedule would be routing around information
a bot has no business having. Reacting to one going off is perception's job,
separately and later.

Perception was the other half of the problem. A trap was noticed only within
220px, which at running speed is about two thirds of a second to see it, decide
and stop — which is how bots walked into spikes they had every right to have seen
coming. Awareness now reaches 460px while *fear* still starts at 220, because
seeing further should not turn scenery into panic.

**A grenade is for the shot a rifle does not have.** The old scoring could never
beat plain shooting, so bots finished matches with three grenades in their
pockets. It now recognises the three situations that are actually worth one:

- the target has just gone behind cover — an arc reaches where a bullet does not,
  and this is the case attack scores zero for;
- they are on another level, where a flat shot never lands;
- two or three of them are standing inside one blast radius.

A sighting older than 1.8s is not worth a grenade at all, the last one is held a
little harder than the first, and a bot with a good angle and a good weapon still
just shoots. Measured over a minute of bots left to fight each other: none thrown
before, two at difficulty 2 and five in the first ten seconds at difficulty 5.

The ladder is data like everything else (`npc.difficulties`), generated into the
admin interface and the debug console from the levels themselves, so a sixth rung
is a configuration change rather than a code change. Every bot's card in the
**NPC AI** debug section is labelled with the rung it is playing at, and retuning
a rung reaches the bots already in a match on their very next thought.

Measured through the combat controller — same personality, same weapon, a target
running across at 260px/s:

```
                first shot    shots on target (3s)
level 1              767ms                      67
level 3              267ms                      97
level 5              217ms                     122
```

---

### A wall is not a door

The most recognisable form of stuck bot — pressed flat against a solid block,
leaping on the spot at a goal just the other side of it — turned out to be three
smaller bugs agreeing with each other, and all three are fixed at the layer that
owned them.

**The graph linked routes through walls.** Two nodes on the same floor were
walk-linked whenever they were close, but a wall can stand *on* that floor
between them — SILO's central column does exactly this — and a route through one
is a route a bot follows face-first into the wall. Walk links and level hops are
now corridor-checked: a body-sized box is sampled along the line between the
nodes, and anything solid on it kills the link. Climbs and drops are deliberately
not checked, because they arc far above or fall below that line, and checking the
chord would delete routes a bot can genuinely fly.

**Every wall was answered with a maximum jump.** Something solid ahead used to
trigger a blind full jump, however tall the something was. Steering now measures
the obstacle first, probing upward with the same body-sized box against the same
climb ceiling the graph builds links from: a wall a jump can clear gets a jump
flown to exactly its top, and a wall no jump can clear gets a replan instead of a
leap — and if the replan finds nothing, the goal is abandoned on the spot.

**Giving up did not stick.** The brain re-decides eight times a second, and an
action that wants an enemy's last-seen position hands the goal straight back the
tick after the controller abandoned it. Worse, replanning restarted the
no-progress clock, so the "give this up" deadline receded forever while the bot
ground against the wall. The progress clock now starts with the *goal* rather
than the plan, and an abandoned goal is remembered for a few seconds and refused
if it is asked for again — a memory, not a ban, so the same place is worth another
try once the arena has had a chance to change. Three tests drive the whole loop
against a wall: over it when a jump can clear it, walking away when nothing can,
and refusing the goal the brain keeps asking for.

### A bot always knows where its own feet are

The most expensive bug in the AI was a category error. A bot's picture of the
world — enemies, traps, items, line of sight — is rebuilt eight times a second,
and everything in between is deliberately stale: that staleness *is* the reaction
time the design asks for. Its own body was in the same picture, and that is not
perception. Nobody has to look to find out whether they are rising or falling.

Flying a jump on a snapshot up to seven ticks old goes wrong in exactly one
place, and it is the worst one. The jump machine holds the button while
`velocityY < 0`; on the tick after the press the snapshot still said zero, so it
concluded the jump was over, released — which is precisely the input the
variable-jump-height rule cuts short — and then spent the mid-air jump at ankle
height. A 170px climb came out as a 50px hop. On a test bench that handed the
controller a fresh body every tick, all of this passed; in a match, two bots
would stand either side of a block they could clear and hop against it until
something killed them.

The body is now refreshed every tick and the rest of the picture is not. Two
tests hold the line: a bot's idea of itself never drifts from where it actually
is, and a bot in a *real match* — perception at its cadence, brain at its own,
input through the ordinary queue — gets on top of a block that takes both jumps.
Both fail on the old code.

### Seeing somebody is not having a shot

Line of sight is generous on purpose: three rays, head, chest and knees, because
a single centre-to-centre ray means a crate at shin height hides somebody
standing in plain view. A shot is not generous at all — it leaves the chest and
travels one line.

Bots used to conflate the two, and it showed. A head above a low wall counted as
a target, so a bot stood there emptying magazines into the wall; the same
mistake with a launcher put the blast on its own feet. Perception now reports
`shootable` alongside `visible` — one ray, from the pivot a shot actually leaves
from — and it gates both the trigger and the *decision*: with no shot, attacking
scores zero, chasing wins, and the bot goes and finds an angle. Which it can now
do, because it can jump again.

Grenades got the same treatment from the other end. The action already refused
to throw at something inside its own blast radius, but distance to the target
says nothing about the ledge overhead: a grenade that clips it comes straight
back down. So a throw is now *flown* before it is made — the opening of the arc,
up to the first thing it hits — and refused if it lands inside the thrower's own
blast. Measured across the three arenas at two, four and six bots, self-inflicted
damage fell from 1963 to 1222 over the same two-minute samples, and improved in
every one of the nine.

### How bots die, and what that says

`npm run simulate -- --matches 100 --bots 2` plays a hundred matches with nobody
watching and reports what killed everybody. `--difficulty 1,5` deals the rungs
out to the bots in turn, which is how the damage multipliers were measured. It runs the real room -- the same
systems, the same fixed step, the same input queue -- and it exists because the
interesting question about bots is not whether they win but whether they die of
things a person would be embarrassed by.

The first run of it was damning: **74% of bot deaths were spikes and 20% were
gunfire.** Bots were not losing fights, they were walking into scenery. Chasing
that number down turned up a series of faults, each real, each fixed:

| | at the start | now |
|---|---|---|
| killed by a trap | 73.8% | 45.2% |
| killed by another bot | 20.4% | 47.1% |
| killed by its own grenade | 5.8% | 7.7% |
| median time of death | 16.3s | 37.7s |

Being shot is the leading cause of death now, which is the game working.

The largest single fault was not in the hazard code at all. An action that
scores zero -- attacking with no target -- was being *kept* by the brain's
commitment bonus, and attacking with no target issues no movement, so a bot
whose target went out of sight stood still for the rest of the match. Next to
that: goals were being invented outside the arena (`self.x + 180` runs off the
end of the world), a bot standing in spikes escaped by the nearest edge even
when a column stood in the way, and it hopped on the spot to get out of a strip
that hurts on entry -- landing back in it for another full hit.

The largest gain came from a bug that had eaten every planned jump for as long
as bots have existed. The jump machine's press was judged in the same tick it
was made, before the physics had seen it: the body read as not rising, so the
machine concluded the ascent was over, spent its rising phase and the mid-air
flag on the spot -- and every commanded jump flew as a single one, about 135px
against the 203 the navigation graph plans with. Bots planned routes they could
not fly, bounced under ledges, and dropped into whatever was beneath. One tick
of patience fixed it, a bench test pins it, and with jumps real again two more
things became safe to do: the graph now refuses jump links whose height and
length cannot be flown *together* (they were checked separately, which linked
leaps like "353px across and 180px up"), and a coming climb starts its jump on
the run-up -- pressed at the ledge's base, a jump rises into the ledge's
underside.

Falls got their own steering, because the measurements said falls were the
killer: of the harmful trap hits bots took, five in six landed while falling.
A fall's landing spot is known the moment it starts -- it is ballistics -- so
an airborne bot now flies its landing point and steers off anything that hurts.

Verified after the changes: 98% of jumps that need the mid-air press spend it,
achieved rises run to 248px, and the bench climbs that used to take several
attempts land on the first one.

### Bots open crates now

They could not before, and the reason was one line. The action that fetches
things had a branch for a sealed crate, a comment reading "the bot only points
and pulls", and a call to `lookAt` -- which points and does not pull. No bot in
this game had ever opened a crate, which means no bot ever had a better weapon
than the one it spawned with, or ever healed.

Fixing it took four things, each of which was doing nothing useful on its own:

- **A way to shoot at something that is not a person.** `shootAt` aims at a
  spot and fires. Everything a shot at a person needs is skipped, on purpose:
  no reaction time (a crate is not a surprise), no lead (it does not move), and
  no aim wobble -- the wobble exists so a poor bot misses a *person*, and at
  400px it is wider than the crate, so bots holding the trigger never once hit
  one. Nobody's idea of skill includes missing the furniture.
- **An aim tolerance from the size of the thing.** A fixed angle is the wrong
  shape: a tenth of a radian is 40px of error at 400px, which misses a 44px box
  entirely.
- **A clear line, checked.** Crates sit on platforms and bots stand under them.
  Nine thousand trigger pulls across thirty matches opened seven crates,
  because the rest went into the underside of the platform. Asking first cut
  that to three hundred pulls for the same seven crates.
- **A reason to go at all.** Fetching scored a fraction of what wandering the
  arena scores, so bots walked past crates for whole matches. With nobody to
  fight and nothing to fear it now wins outright, which is when a person goes
  and opens the box.

Bots now spend about a quarter of their time going for things, and what stops
them getting more is the same weakness as everything else: crates spawn on high
platforms, and climbing is the thing this movement controller does least well.

### Bots that actually cross the arena

A blunt probe -- put one bot and one idle victim in an arena, start the clock --
returned the worst number of the project: **the bot never found the victim.
Not once, in eighteen runs of two minutes each, in any arena.** Tracking its
position showed why: bots roamed a small box around wherever they spawned. In
the Silo the box was 200 by 375 pixels of a 2000-by-2400 arena.

Four out of five wander journeys were being abandoned halfway, each for a
mechanical reason, each found by tracing one journey tick by tick:

- **"Progress" meant closing on the destination.** A real route walks *away*
  from the goal for seconds at a time -- around a wall, up the far side of a
  spiral -- and the stall detector read that as being stuck. Progress is now
  measured against the next waypoint, and consuming one is progress by
  definition.
- **Jumps launched into the underside of their own destination.** The climb to
  a ledge started at the ledge's base, under it. The run-up now continues until
  the launch column is open all the way up, short launch windows are accepted
  (a jump is flown by held height, not speed), and a waypoint not consumed in
  four seconds hands the route back to the planner.
- **The graph linked climbs with no launch spot.** Where platforms stack like
  shelves, every inch of a lower shelf can sit under another one; a link is now
  built only if somewhere near its start has open sky to the landing height.
- **A trap's edge was a tollbooth.** Escaping a strip of spikes ended exactly
  on its boundary, the route marched straight back in, and the trap re-arms on
  exit -- so a bot oscillated across the edge paying 25 health per wobble.
  Escapes now end a stride clear and force a replan from the safe side.

After the fixes, two bots meet in a median of **3.8 seconds** (previously they
could wander past each other for whole matches), and they cross arenas
end-to-end. Two perception changes ride along: the sight range is 1500 (measured
across sixty matches, the wider view turns a few percent of trap deaths into
gunfights), and bots *hear* -- an enemy bullet in flight leaves a decaying lead
at the bullet's position, never overwriting a fresh sighting, so a fight can be
rejoined without wallhacks.

The same probes found a genuine map defect: the Silo's crown had a crate spawn
and no way up -- a 440px gap in its ladder, past any jump, for people as much as
bots. The ladder got its missing rung, and a test now walks every arena's crate
spawns from a player spawn.

### A jump pad is not a hazard

Traps are one system: placed the same way, simulated the same way, drawn the
same way. A jump pad is one of them, and it is the odd one out — it throws you
rather than hurting you, and the arena puts them there as routes. Everything
that reasoned about danger treated it like spikes, so bots routed *around* the
shortcuts, flinched away from them, and scored fleeing one as highly as fleeing
a fire. `trapHarms` says which is which, once, and the navigation costs, the
steering and the dodge scoring all ask it.

### Standing in it is not the same as walking towards it

Hazard handling used to live inside the part of steering that follows a goal,
below two guards: *do I have a goal* and *am I already walking somewhere*. Both
are false in exactly the situation that matters. A bot that stopped inside a
strip of spikes had `direction === 0`, so nothing looked at the spikes; a bot
whose goal had just been dropped *because* of a hazard returned at the first
line of `steer`, so nothing looked at anything. The avoidance switched itself
off at the moment it was needed.

Getting out of what is burning you now runs before either guard, and three other
things changed with it:

- **A destination inside a trap is moved to its edge.** Chasing somebody
  standing in the fire is reasonable; following them in is not. The goal is
  nudged out rather than refused, so the chase still happens and stops short.
- **Progress means getting closer, not moving.** The stuck detector asked
  whether the bot's x had changed by 12px, which a bot bouncing on the spot
  satisfies forever — so the behaviour most in need of being abandoned was the
  one thing that never counted as stuck. A bot rebounding off a ledge into the
  spikes underneath would do it until something killed it.
- **The test harness loads the arena's traps**, as a room does. It did not, so
  every previous measurement of how bots handle hazards was measuring an arena
  that had none.

Measured as the share of bot-time spent inside a trap that actually hurts,
across three arenas at two, four and six bots: **2.37% → 0.77%**, better or
unchanged in all nine.

### The wall coming towards you

The closing walls were invisible to bots. Not by omission -- nothing about the
shrink ever reached the movement code, and no simulation caught it, because the
shrink starts at two minutes and a bot match ends in well under one. In a real
match with the walls in play a bot chased a memory the walls had already
swallowed, walked into the edge, and stood there being pushed along and ground
down: across six closing matches, bots spent **37% of the endgame flat against
an edge**.

Two things fixed it, both feeding the movement controller the playable bounds
each think:

- **A goal the walls have swallowed is brought inside.** Clamped into the
  playable strip before the route is planned, so a chase across a boundary that
  no longer exists becomes a chase to the last place inside that does.
- **Stepping in from a wall runs before everything else.** A wall does not miss,
  cannot be shot back at, and is coming whatever the bot decides -- so getting
  off it outranks the goal, the hazard flinch and the fall steering, the same
  way "get out of the fire" outranks them.

Measured over the same six matches: **37.4% → 9.4%** of the endgame spent
against an edge, and crush damage taken 11615 → 7302.

### Routes a bot cannot fly

Three fixes in the navigation graph, all the same shape: a link that describes a
journey nobody can make is worse than no link at all, because a bot will commit
to it.

- **Walk links through walls.** Two nodes on one floor were linked whenever they
  were close, but a wall can stand *on* that floor between them. Walk links and
  level hops are now corridor-checked with a body-sized box.
- **Drops through solid ground.** You leave a surface by walking off its edge, so
  a drop is only real if the column you would fall down is clear. This also rules
  out the case that reads as a route and is not: a node directly beneath the
  floor you are standing on.
- **Wandering into a trap.** Steering flinches away from a hazard on the way
  past, but a *destination* inside one is a bot walking into spikes deliberately
  and then standing in them. Hazardous nodes are no longer offered as somewhere
  to go, and neither is anywhere the bot gave up on in the last few seconds.

## Jump pads, and holding a seat open

Two smaller things, both of which reuse a mechanism rather than adding one.

**A jump pad is a trap that helps.** The trap system already answers "what does
contact with this do to you", so a pad is a third answer -- `TrapDamageMode.LAUNCH`
-- alongside continuous and on-enter damage. Same placement, same activation
modes, same editor, and the throw goes through the same knockback the weapons
use, so a mistyped force is capped by the player's own knockback limit rather
than launching somebody into orbit. It fires once per contact, because a pad that
fired every tick would pin whoever stood on it in the air above it. Every arena
now has at least one, as a route the staircase-watchers are not covering.

**A dropped connection is not a disconnection.** The server has always held a
player's seat for twenty seconds; the client used to throw them straight back to
the menu anyway, which was the client giving up before the server did. Now a lost
connection shows a banner with the time remaining, keeps the scene standing, and
asks for the seat back every 1.2s until it either succeeds or the window closes.

Getting that right meant finding where a dropped connection actually surfaces:
`onLeave` fires only for a close both ends agreed on, and a socket that simply
dies -- a restarted server, a closed tunnel, a laptop lid -- arrives as an
*error*. Both now lead to the same place.

---

## Playing with thumbs

The game is keyboard and mouse, and on a phone that made it unplayable rather
than merely awkward. There are now on-screen controls — move, jump, fire, reload
and grenade — and the interesting part is when they appear.

**Only when they are wanted.** A phone gets them immediately; a desktop never
sees them; a laptop with a touchscreen gets them the moment a finger arrives and
loses them again the moment a key is pressed. The last input actually used
decides, rather than a guess made at boot: permanent thumb pads on a machine with
a keyboard are clutter, and a `Space to jump` hint on a phone is a lie. They also
follow the HUD in and out, because controls have no business over a menu.

**They are DOM buttons, not painted on the canvas.** That is what makes aiming
and shooting at the same time work: a finger on a button never reaches the game's
own pointer handling, so the buttons take their touches, the canvas takes the
rest, and the browser keeps them apart at no cost. Aiming is unchanged — you
point at where you want to shoot, exactly as the mouse does.

Nothing here is a new authority. The controls produce the same intent a key
produces, and the server trusts it exactly as little.

Two things fell out of testing it on a real phone viewport: the lobby panel now
scrolls inside itself and sheds its decoration below 520px of height, because a
landscape phone is under 400px tall and the start button was falling off the
bottom of the screen.

---

## A record, not a ranking

Every player carries a small career across matches: matches played, matches won,
kills, deaths and the best finish ever reached. It appears on the menu once there
is something to show, and as a line under the standings when a match ends.

The identity behind it is deliberately weak. There are no accounts: the client
generates a UUID, keeps it in `localStorage`, and offers it when joining. That is
a *claim*, not an identity — anyone can send any id — so the design follows the
strength of the evidence:

- a career is only ever sent to the player it belongs to;
- there is no leaderboard, and no comparison between players anywhere;
- nothing in the game is unlocked, weighted or matched by it.

Which makes forging one pointless rather than merely detectable. Losing it — a
cleared cache, a different machine — starts a fresh record, and that is the
honest cost of not asking anybody to sign up.

Storage follows the same shape as the administration data: a repository
interface, a JSON file behind it, an in-memory fallback when the directory turns
out to be unusable. A match ending never waits on the disk — the write is
coalesced and fire-and-forget, because losing a kill count is not worth
interrupting a game for.

---

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request: typecheck, the
whole suite, then both bundles. One machine, one install, one red or green — the
suite is deterministic and finishes in well under a minute, so splitting it
across jobs would buy nothing but complexity.

It typechecks the *tests* as well as the source, which `npm test` does not: `tsx`
strips types rather than checking them, so a test can pass while carrying a type
error. That is not hypothetical — adding this caught one on its first run.

The test script lists its files as `tests/*.test.ts` rather than
`tests/**/*.test.ts`, and the difference is the difference between CI running
and CI only appearing to. `sh` does not expand `**`, so the literal pattern
reached the test runner — which globs it on Node 22 and treats it as a filename
on Node 20, the version this workflow pins. Locally it worked; in CI every run
died with `Could not find .../tests/**/*.test.ts` before a single test executed,
and the build step after it never ran at all. A single-level glob is expanded by
the shell on every version of both, so the runner is handed paths and never has
to glob anything.

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

### Crates announce themselves

A crate never simply appears. The spot it is about to land on is marked, the
marking builds towards the moment, and only then does the crate arrive — so
contesting one is a decision somebody had time to make rather than a race
against a surprise.

```
spot chosen  ->  warning  ->  configurable delay (5s)  ->  crate lands  ->  warning gone
```

The marker is a ring that tightens onto the spot, with a shadow and a glow
building underneath it — the pulse quickening from a slow beat to an urgent one as
the moment approaches. Round, and only round: an arrow above the spot was tried
and read as an icon stuck to the crate rather than as a warning about the ground.

It is purely visual. A warning has no collision, holds nothing, and gives away
only the *place*: the contents stay secret exactly as they do for a sealed crate.
The spawn point is reserved for the whole wait, so the crate really does arrive
where it was promised, and announced crates count against the crate limit —
three warnings and no crates is still three crates on the way.

`powerUpSpawning.warningMs` sets the wait; 0 drops crates with no warning at all.

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
| Player | max health, move speed, accelerations, frictions, knockback limit, damping, window and lift |
| Jumping | gravity, jump strength, max jumps, mid-air jump strength, early-release cut, coyote time, jump buffer, fall speed |
| Match | min/max players, countdown, result screen, maximum match length |
| Weapons | enabled, damage, range, fire rate, magazine size, reload time, automatic, knockback, recoil |
| Shotgun | pellet count, spread, falloff curve, bullet speed |
| Chainsaw | damage, contact range, attack interval, arc |
| Grenades | starting and maximum count, min/max throw power, charge time, gravity, bounce, friction, fuse, blast radius, damage, falloff and knockback |
| Power-ups | enabled, spawn weight, display name, and the effect each type carries |
| Crates | health, size, lifetime, landing warning |
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

## Movement that does not snag

Two things stand between a fixed-timestep simulation and a jump that feels right,
and neither of them is the physics.

**A ledge corner must not eat a jump.** Clipping the edge of a platform with the
side of your head used to stop the whole ascent dead, which is the single most
common way a platformer feels like it caught on something. An upward move that
overlaps a solid by less than `CORNER_CORRECTION` (9px, well under half the
player's width) is nudged past the corner instead of stopped. It forgives a
clipped corner; it never lets anybody through a wall they were squarely under.
It lives in the shared step, so the server, the client's prediction and the bots
all agree about it.

**A frame is not a step.** The simulation advances 60 times a second in whole
steps; the display draws whenever it likes, and the two are not in phase — on a
90Hz or 144Hz screen they never are. Drawing the player at the last completed
step means one frame repeats the previous position and the next jumps two steps'
worth, which reads as a stutter, most visibly in a jump where the vertical speed
is large and changing. The renderer now keeps the position each step *started*
from and interpolates by whatever is left in the accumulator:

```
render = previous + (current - previous) * (accumulator / stepLength)
```

A server correction moves both ends by the same amount, so the interpolation
stays one step long instead of stretching across the correction, and the existing
error smoothing still hides the difference. Remote players were already
interpolated from their snapshot buffer; this is the local one catching up.

---

## What a player looks like

The figure carries three pieces of information for anybody who can see it, and
each of them was worth a fix.

**The health bar is always there.** It used to hide itself at full health to keep
the screen calm, which meant the one thing you most want to know about somebody
across the arena — whether they are hurt — was only legible once they were. An
empty space above a head reads as "no information", not as "unhurt". The empty
part of the bar is drawn too, so a short bar reads as short rather than as small.

**The weapon is held out in front of everything, including the face.** It draws
in front of the visor -- a dark bar cut across a rifle reads as a hole in the
rifle -- and nothing is hidden by that because the two are kept apart by the
*hold* rather than by layering. `holdDistance` pushes the weapon further out
along the aim on exactly the angles where it would otherwise cross the face,
which is every steep upward aim. Layer them the other way and the eyes cut the
gun; hold them together and the gun blanks the eyes.

**The weapon is held out in front, at chest height.** With the grip on the body's
centre line a rifle's stock lay across the face, and the visor is the only part of
the figure that says which way somebody is looking. Moving the grip forward alone
was not enough: a bulky weapon's stock reaches back past the grip, so at the
shoulder the rocket launcher still covered 56px² of an 84px² visor. Lowering the
hold fixes that — the grip sits `WEAPON_FORWARD_X` along the aim from a pivot at
`AIM_ORIGIN_Y`, the chest rather than the shoulder, and from there no weapon in
the catalogue touches the face at a level aim. That leaves the weapon free to be
drawn *in front of* the figure, where a held object belongs, instead of hidden
beneath it.

Aiming steeply up is the one case geometry cannot win: a weapon held in front of
the chest and pointed at the sky crosses the head at any offset, and lowering the
hold only changes the angle at which it starts. So the draw order finishes the
job — the visor is the last thing drawn over the body, and a weapon swung across
the face passes behind the eyes instead of blanking them. Three tests hold the
line: the barrel must reach past the body, no weapon may touch the visor at a
level aim, and the visor must draw after the weapon. `MUZZLE_OFFSET_X` moved with
the grip, so the drawn barrel, the muzzle flash and the point the server spawns
projectiles from still agree.

**A throw is drawn at the hand, not on the HUD.** A wind-up used to be a power bar
at the bottom of your own screen — which could only tell you something you already
knew. It is now an arrow from the hand along the aim, growing with the charge and
turning from green through amber to red. Because `chargingGrenade` is
synchronised, *everybody* can see somebody winding one up: the arrow is a warning
as much as a gauge. Only the fact of a wind-up is synchronised, not its progress,
so for other players the client times it from when it first saw the flag — an
approximation on purpose, because what decides the throw is the button held on
the server.

---

## The weapon catalogue

Seven weapons, and every one of them is data. A weapon is a row in
`config.weapons`: numbers, a falloff curve, an optional blast, and a silhouette
made of rectangles. Nothing about the list below required a line of code that
knows which weapon it is.

```
                  damage   range   rpm   mag   what it is for
Assault Rifle         18    1400   520    30   the baseline, no falloff
SMG                   11     900   900    40   close work; three times the rifle's cone
Shotgun            13 x9     620    75     6   contact range, brutal, useless beyond it
Sniper Rifle          62    2600    40     5   two hits, across the whole arena
Flamethrower        7 x2     300   720   100   the highest close dps in the game
Rocket Launcher     0(!)    1800    48     2   the round does nothing; the blast is the weapon
Chainsaw              34      62     -     -   if you can reach them
```

**Explosions are one mechanism, not two.** A grenade and a rocket differ in how
they arrive and in their numbers, never in what happens when they go off — the
same `detonate` decides who a blast catches, how much it hurts and how hard it
throws them. Two copies of that would drift, and the day they did a rocket would
quietly stop opening crates or start sparing the person who fired it.

An explosive round never applies its own damage — hence the launcher's `damage:
0`, which is not an oversight. It detonates wherever it stops: a player, a crate,
a wall, or the end of its range, because a rocket that only exploded on people
would be one nobody could use for anything else. It catches the shooter as
readily as anyone, which is what makes both firing it in a corridor and firing it
at your own feet a decision — the recoil and the blast are tuned so the second
one is a rocket jump.

Bots hold fire with an explosive weapon when the target is inside their own blast
radius. The same reasoning the grenade action already applied, moved to the
trigger: a bot with a launcher backs off instead of killing itself.

**A reload costs what is actually missing.** `reloadTime` is configured as the
time for a full reload -- empty magazine to full -- but a reload used to take
that long regardless of how empty the gun actually was, and the HUD swept its
gauge from empty every time even when most of the magazine was still loaded.
Topping off 29 of 30 rounds looked and felt identical to reloading from zero.

`getReloadDurationMs(weapon, currentAmmo)` scales `reloadTime` by the fraction of
the magazine actually gone: a rifle missing 1 of 30 rounds reloads in a
thirtieth of the full time, missing 14 of 30 takes just under half of it. One
function, asked by three places that all used to assume a full reload on their
own: `WeaponSystem` (which enforces the deadline), the client's `LocalFireModel`
(which predicts it, so the trigger gate does not mispredict an early shot after
a short reload), and the HUD (which times the gauge's sweep). Asking one place
means the three cannot drift into disagreeing about how long a reload takes.

The gauge itself starts its sweep from wherever the ammunition actually sits --
`ammoRatio`, the same number the ordinary ammo bar is drawn at -- rather than
from empty. A bar that already read 97% full no longer has to fall to nothing
and climb back up to say "resupplying"; it visibly tops off the last sliver
instead.

**One bar, one animation.** The sweep used to be a second element -- an amber
overlay drawn on top of the ammo fill, growing on its own timer while the white
bar underneath sat frozen at the ammo count the reload started with. The moment
the reload actually finished, the overlay vanished and the *white* bar's own
CSS width transition fired for the first time in the whole reload, animating
from that frozen starting width up to 100% -- a second, redundant fill playing
immediately after the first, because the bar reporting the real ammunition
count had never been allowed to move. It is the one element now: reloading
adds `.is-reloading`, which turns it amber, and starting a reload sets the
bar's own `width` transition to the exact `getReloadDurationMs` for that
reload and its target to 100% in the same tick -- the browser interpolates
from whatever width the bar already had, and there is nothing left to fire a
second time when the reload ends, only the class coming back off to fade the
colour back to white. Confirmed in a live client with the built bundle
instrumented to sample the bar every 80ms through a full reload: its rendered
width climbed smoothly and monotonically for the whole 1800ms transition, then
sat exactly flat for the three seconds sampled afterward -- one animation, not
two. A partial reload is timed the same way: missing 1 of 30 rounds swept from
96.7% to full in 60ms (exactly `1800ms * 1/30`), missing 14 of 30 swept from
53.3% in an 840ms reload (`1800ms * 14/30`).

---

## Knockback and recoil

Getting shot moves you, and shooting moves you back.

Both are **impulses**, never position changes: a teleport out of a hit would put
somebody through geometry and would arrive on every other client as a jump rather
than as a shove. The impulse is added to whatever the player was already doing,
so a knockback compounds with a jump the way it should.

Each weapon carries two separate numbers, because a weapon that throws people
across the room need not also throw its owner:

| | Knockback | Recoil |
| --- | --- | --- |
| Assault Rifle | 0.75 | 0.3 |
| Shotgun | 0.3 *per pellet* | 1.1 |
| Chainsaw | 1.3 | 0 |
| Grenade blast | 1.8 at the centre | — |

One unit is 260 px/s along the direction of travel, so the numbers read as
multiples of each other rather than as raw speeds. Knockback is applied **per
hit** — nine shotgun pellets landing at contact range deliver nine of them —
while recoil is applied **per shot**, so a shotgun kicks once however many pellets
leave the barrel. A grenade throws outwards from the blast and falls off with it,
so a near miss shoves and a direct hit launches.

`player.maxKnockbackSpeed` caps what any single hit may add. Physics that a
configuration value can break is not really configurable, and it is the only
thing standing between a mistyped weapon and somebody crossing the arena.

Two interactions are worth knowing about, because either of them silently cancels
the whole feature.

**The run-speed cap must not clip a velocity that is already above it.** Clamping
outright means a knocked-back player erases the shove by holding a movement key.
The limit never clips below the speed already carried — holding a key still cannot
push you *past* the cap.

**Friction must not be what bleeds a shove off.** Ground friction is 3200px/s²,
which erases a rifle's shove within two frames and about half a pixel of travel:
landing a hit then looks like nothing happened at all. A shove therefore opens a
window (`player.knockbackRecoveryMs`) during which horizontal speed decays by
`player.knockbackDamping` of itself per second instead, which makes the distance
travelled proportional to the impulse — roughly `speed ÷ damping` pixels, so a
rifle round moves somebody about 30px and a point-blank shotgun the better part of
170. The window is part of the movement state and is synchronised, because
prediction has to replay a knocked-back player exactly as the server did.

A hit landing on somebody standing also takes them off their feet, in proportion
to the impulse (`player.knockbackLift`): a purely horizontal push against the
floor is fought by the victim's own footing, and lifting them is what makes a hit
read as one. Recoil deliberately passes no lift — an automatic weapon would
otherwise bounce its owner off the floor several times a second.

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

### Standing still once it is over

A decided match used to leave the arena twitching. Two separate faults, both
visible as a player who "stops" and then flickers between two poses:

- **`FINALE.celebrateMs` was written down and never consulted.** The winner's
  hop was started and then ticked for as long as anybody was watching, so it
  bounced 34px up and down through the entire twelve-second results screen with
  no resting frame.
- **The walk cycle ran off the last velocity the server sent.** Whatever a
  player happened to be doing when the match ended, they kept doing on the
  spot -- a match decided mid-sprint left everyone jogging in place.

Both are fixed by the same rule: **when the match is decided, animations
conclude and then stop.** `PlayerViewState` carries `matchLive`, and a view that
is not live settles its pose to neutral (`settleStep`) rather than animating it.
The settle is eased rather than snapped, because the requirement is that an
animation in progress *finishes* -- a runner settles out of their stride instead
of jumping to attention -- and it latches: once neutral, nothing writes to the
body again until play resumes.

The celebration ends itself rather than waiting to be told. It keeps two clocks,
and they are not interchangeable: the hop *animates* on the scene's slowed
clock, so it stays in slow motion with the rest of the finale, while the
*deadline* runs on real time. An attempt at measuring the deadline in scaled
time too made `celebrateMs` mean whatever the time scale happened to be --
measured at 8.07s of wall time for a 2200ms constant, most of it spent bouncing
behind the results screen.

Two further things only came out of measuring, and neither would have been
guessed:

- **The finale stops ticking on its own schedule.** Handing it the job of ending
  the celebration left the winner frozen 4.5px off the ground at a 0.009rad
  tilt, held for the rest of the results screen -- stable, but not a resting
  pose. A celebration that has gone untouched for `CELEBRATION_STALE_MS` is now
  finished by the view itself, so the pose never depends on somebody else
  remembering.
- **Prediction kept running with nothing left to predict.** No input is
  accepted after the match and the authoritative position has stopped moving,
  but re-simulating it every frame still produced 3.47px of permanent wobble
  under the winner. The local view reads the server's position directly once
  the match is over, and the prediction is not stepped at all.

Measured over two full matches after the fix: the hop runs for a second or two
and then the drawn position holds an exact 0.000px spread for the six to seven
seconds sampled afterwards, with the winner's view ending on
`celebratingFor=-1, lift=0, bodyY=0, rotation=0` -- one stable frame, and
nothing still running behind it.

### Where the health and ammo bars live

Both bars are drawn over every player's head by default, and the corner panel's
copy of them is off (`gauges.overPlayer`, `gauges.inHud`). Two ordinary
switches, so a room can have either, both, or neither.

Over the player they sit where you are already looking -- at your own character,
in the fight -- rather than in a corner you have to glance away to read. And
they are legible for *everybody*, which is the point rather than a side effect:
a bar over somebody's head says whether they are hurt and whether they are out,
and an enemy who has just started a reload is the clearest opening the game
offers. That is the same argument the health bar was already making; the ammo
bar simply finishes it.

The ammo bar is the health bar's shape exactly -- same width, same border, same
visible empty track -- so the pair reads as one block rather than two unrelated
marks. A weapon with no magazine draws nothing at all, because the chainsaw
never runs out and an empty track under it would say it can.

It animates a reload rather than sitting frozen: the server does not refill
`ammo` until the reload completes, so a bar drawn straight from the round count
would stall and then jump. It sweeps from where the magazine was to full over
exactly `getReloadDurationMs` -- the same function the weapon system enforces
and the HUD gauge uses -- and turns amber while it does. Measured live with the
built bundle instrumented to record every draw: the ratio climbed 0.000 to
0.768 without once going backwards while the round count sat at 0.

Redrawing a `Graphics` object re-tessellates it, so the bar is skipped whenever
nothing changed, keyed on the *drawn ratio* rather than the round count --
during a reload that is what moves while `ammo` does not.

### The arena notice, top and centre

"ARENA IN 1:57" used to sit in the bottom-right stack beside the speed buff. It
is not a buff: it is a deadline for everybody in the arena at once, and the
bottom-right corner is the last place a player looks during a fight. It now sits
top and centre, in its own notice strip (`.hud__notice`), a little larger and
with a heavier backdrop than a corner pill so it reads from further away.
Centred on the viewport rather than laid out with the corners, so it stays put
whatever the corners hold.

### Trails, and why they are one mechanism

A running player leaves a short streak; a grenade leaves its whole arc, so a
throw can be read while it is still in the air rather than guessed at. Both are
the same class over the same `TrailSpec` -- length in segments, fade time,
alpha, width, taper, colour, and the speed and distance gates below which
nothing is recorded -- so giving something a trail is a row in `TRAILS` beside
the bursts, not a new class. A projectile or a drifting power-up would need
nothing else.

The two differ only in those numbers, and the numbers say what each is *for*.
The player's is short, cool and gated just under a flat-out run: movement here
is binary -- standing still, or running at `moveSpeed` -- so that is the only
line that separates travelling from not. A gate above it and you would only
ever trail while falling; a gate at zero and a streak would follow everyone
permanently. Speed then lengthens the trail on its own, because a fall or a
boosted run covers more ground inside the same fade window. The grenade's is
longer, brighter and ungated, because a lob nearly stops at the top of its arc
-- exactly where the trail is most worth seeing.

**It follows the path actually drawn, not the path the server sent.** Both
emitters feed it the position on screen, extrapolation and prediction included,
so a grenade's arc is a curve rather than a 20Hz dotted line through one.

**Nothing is created per frame.** `TrailPath` keeps its points in preallocated
typed arrays used as a ring buffer, and hands back segments by index out of
objects it rewrites in place -- returning a `slice` would be the nicer shape and
would allocate an array per trail per frame, which for every player and grenade
on screen is how a smooth game acquires a stutter. `TrailRenderer` maps those
onto a sprite pool allocated once at construction, each one either repositioned
or hidden. Phaser's `Graphics` was the obvious alternative and the wrong one: it
re-tessellates on `clear()`, and a trail changes every frame by definition --
the mirror image of `drawHealthBar`, where geometry is cheaper precisely because
a health bar rarely changes.

A trail that stops being fed is not cut off; it ages out where it is. That is
what makes stopping, dying and exploding all fade rather than blink -- a body
being thrown by the death animation is moving but no longer *travelling*, so
`tickDeath` keeps ageing the trail without adding to it. A respawn clears it
outright, because the line from where somebody died to where they came back is
not a path anything travelled.

Measured in a live client with the built bundle instrumented to record every
segment handed to a sprite: mean alpha rose from 0.22 at the tail to 0.46 at the
head, ran down to 0.029 before disappearing rather than cutting off, and width
tapered from 9.5px to 3.1px against a 2.75px floor -- the fade and the taper on
one curve, as the spec says they are.

### The countdown shows you the arena

While 3-2-1 runs, the camera pulls back to the whole arena -- the level is the
one thing worth reading in those seconds, and a new map was previously something
you discovered mid-firefight. A pulsing ring marks where you will land, and on
the final second the camera dives to it, arriving at normal zoom just as the
match starts.

The dive only works because the server now decides spawns *before* anybody
spawns: the deal used to happen at the moment the match started, so during the
countdown there was nothing to dive to. `beginCountdown` deals every connected
player a spot and publishes it on their state (`spawnX`/`spawnY`), and
`startMatch` honours the promise -- reserved by session rather than by list
position, so a player leaving mid-countdown does not shift everybody else onto
spots the flyover no longer matches. Somebody who slips in after the deal gets
an unreserved spot.

While the flyover runs the ordinary camera follow keeps its hands off, and the
camera's world bounds come off with it -- zoomed out far enough to fit the
arena, Phaser's bounds clamping would pin the level into a corner of the screen
instead of the middle. Both come back the moment the player spawns.

### One cursor, not two

During a match the system arrow used to sit on top of the crosshair, aiming at
slightly different pixels than the thing doing the actual aiming. The OS
pointer is now hidden for the duration (`body.hide-cursor`, toggled every frame
off `network.state.matchState`) and restored the moment something needs a real
cursor to click -- the settings panel or the debug console, both reachable by a
key press mid-match.

Hiding it exposed a real bug in the crosshair itself: its screen position was
only refreshed on the HUD's throttled 80ms tick, meant for a health bar rather
than a pointer, so it visibly stepped behind a fast mouse movement instead of
tracking it. It now updates every rendered frame, unthrottled, alongside the
cursor visibility check -- both cheap enough that there was never a reason to
throttle them, only a shared code path that happened to.

### Every hit is legible, whoever landed it

A damage number used to appear only for hits you landed or took, and the server
only told the attacker and the victim a hit had happened. Watching two other
players fight -- or spectating after your own elimination -- showed muzzle
flashes over a health bar that quietly shortened, which reads as nothing
happening at all.

The server now broadcasts each `DAMAGE` to the room. That is not a new leak:
every player's position and health is already in the synchronised state each
client receives, so a modified client learns nothing it could not read before,
and the cost is a few dozen bytes per hit against a patch that already carries
every player twenty times a second.

The client draws all three cases in different voices (`DamageVoice` in
`EffectsSystem`), because they are not equally your business: a hit you landed
is amber, a hit you took is red, and somebody else's exchange is paler, smaller
and dimmer -- there to be read if you look, not to compete with your own fight.

### A hit you did not land still makes a noise

The impact sound for somebody else's hit was already written; nobody had ever
heard it, because until damage was broadcast the event never arrived. Now that
it does, two things keep the arena readable rather than merely loud: an exchange
you are not part of plays at a little over half volume on top of the distance
falloff that already silences anything far enough away, and it is rate-limited
in its own bucket (`SoundThrottle`).

The bucket matters more than it sounds. Rate limits exist so a shotgun's nine
pellets land as one impact, and they were keyed by sound alone -- so once every
hit in the arena reached every client, a faint exchange between two bots across
the map could arrive a few milliseconds before the shot you just landed and
silence it. First come wins, however little it mattered. Your hits and theirs
are counted separately now.

### Nobody is eliminated in the lobby

"You were eliminated -- spectating nobody" kept appearing over the lobby. The
elimination path was careful about this and checked that a match was actually
running; the banner's other entry point, the one the scene calls when the
spectate target changes, checked only that the local player was not alive. In
the lobby nobody is alive, and removing a player makes the scene pick a new
target -- so kicking a bot re-announced an elimination that had happened in the
previous match, or never.

Both entry points ask `isSpectating` now, which lives on its own precisely
because it is the kind of two-clause rule that gets re-derived slightly
differently in each place that needs it. With nobody left to watch, the banner
also drops the "spectating -- placed" line and the key hint rather than
naming nobody as the person you are following.

### Health is two bytes on the wire

`player.maxHealth` may be set as high as 1000 in the admin, and `health` on the
schema was a `uint8`. An administrator who raised it got players spawning on 232
health -- 1000 wrapped into a byte -- and a red sliver of a health bar, with
nothing anywhere reporting a problem: the server was authoritative, correct, and
truncated on the way out.

It is a `uint16` now. `tests/wire.test.ts` walks the admin's own declared maxima
(`buildConfigFields`) and pushes each through a real `Encoder`/`Decoder` round
trip, so a field that cannot survive its configured maximum fails the suite
rather than reaching a player as a wrong number.

### Dying, and the last kill of a match

A death used to be a body disappearing on the frame its health hit zero, and only
for the local player at that — a kill across the arena looked like a player
quietly vanishing. Now every kill throws the body: it is lifted, spun, drifts away
from whoever shot it and fades as it falls (`DEATH_ANIMATION`). It is owned by
`PlayerView` and ticked from the scene rather than from the state-apply path,
because a dead player's state stops changing and there would be nothing to drive
it.

The kill that ends a match gets more than that. The server flags it: `endsMatch`
rides on the kill message, decided in `MatchManager.eliminate` from the number of
survivors, because the client cannot work it out for itself — the kill arrives
immediately and the finished state only with the next patch, so without the flag
the last kill of a match looks like any other for a fifth of a second.

On that flag the whole ending plays out, in two beats, and the shell holds the
results screen back until it has finished — the moment somebody wins is something
you watch rather than something a menu covers.

```
0ms     the kill      slow motion drops in, the camera pushes in on the body
1150ms  the winner    the camera finds whoever is left, they jump for joy,
                      four waves of confetti fall across the screen
3400ms  the menu      the standings, once there is nothing left to watch
```

The winner's celebration is an *offset* on the position the server sent, not a
position of its own — they are still standing exactly where the server says, and
this is only how they are drawn. The confetti is built from the same tweens as
every other particle, which means it slows down with the finale instead of racing
it.

Two details keep the whole thing honest:

- **Simulation time and presentation time are separate.** Prediction, input and
  snapshot interpolation keep running on real time; only what is *drawn* slows
  down. Slowing the network loop would desynchronise the client from the server
  for the sake of an effect.
- **The wait itself runs on real time.** A Phaser timer would be dilated by the
  very effect it is waiting on and the results would arrive late by exactly
  however much time was slowed. The shell also keeps a backstop timer, so a scene
  torn down mid-animation still ends with the standings on screen.

**Play again** ends the results early once everybody has asked for it — everybody
who *can* ask, that is. Bots are always "connected" and never ask for anything,
so counting them meant the button could not do its job in any room with one in
it, which is every room somebody plays alone. The button also says it heard you:
the countdown line is redrawn every frame, so writing "ready" straight to it was
overwritten within milliseconds, and a working button looked like a broken one.

Nothing here can change the outcome: the match is decided on the server before any
of it starts.

### What a player can change

Press **O** (or *Settings* on the menu) for master and per-channel volumes, mute,
particle density, screen shake and damage numbers. All of it is stored in the
player's own browser and none of it reaches the server — volumes and particle
counts are presentation, and presentation is the client's.

Turning particles or shake to zero is a supported setting, not a broken one: the
game still plays every flash and flourish, just without the debris or the camera
movement.

---

## The minimap

A transparent panel in the HUD's top-right corner, off by default in nothing but
its presence -- it ships enabled, drawing the whole arena. Every position it can
show is already in `SyncedGameState`: a player's `x`/`y`, a power-up's, both
already sent to every client for the world itself to render, so the panel
decides what gets *drawn*, never what gets *sent*. Switching it off costs
nothing on the wire, and turning it on reveals nothing a client could not
already compute for itself.

Three settings, all in `minimap.*` and all ordinary configuration -- editable in
the admin interface and the debug console like anything else, applied on the
next update rather than needing a rejoin:

- **`enabled`** -- whether the panel appears at all.
- **`showPlayers`** / **`showPowerUps`** -- either layer can be dropped
  independently. A living player gets a dot in a colour that marks yours out
  from everyone else's; a dead one gets none, the same way a body stops
  appearing on the HUD's other gauges.
- **`radius`** -- how far from the local player something has to be to earn a
  dot, in world px. 0 means no limit, the whole arena regardless of distance.
  The radius is measured from where the player actually *is*, though, which
  only means something while they are still playing: once eliminated, the
  filter drops rather than staying centred on a corpse, because a spectator
  watching a fight that has moved on deserves a minimap that still shows it
  rather than one that went blank the moment the action left wherever they
  died.

Positions are normalised to 0..1 fractions of the arena (`normalisePosition`)
and placed with CSS percentages, so the panel never has to measure its own
on-screen size or recompute anything when it changes. Dots are pooled DOM nodes
keyed by entity id -- reused and repositioned across updates, only ever
created or removed when something actually enters or leaves the picture -- the
same discipline as everything else added to this HUD, and it runs on the same
80ms cadence as the rest of it: a corner dot does not need the per-frame
precision the crosshair's pointer tracking does.

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
  Also knockback and recoil: the direction of the shove, that it scales with the
  weapon, that it is capped however absurd the configuration, that it adds to the
  speed already carried, that it never moves a position directly, that recoil is
  per shot rather than per pellet — and that holding a movement key no longer
  cancels a knockback. Also that a hit is announced to the whole room rather than
  to the two players involved, so a bystander can see a fight they are not in, and
  that a bot's difficulty scales what it takes and what it lands — read off the
  bot rather than its target, applied to a human in neither direction, left at its
  own setting for traps and the closing walls, counted once when a bot blows
  itself up, and picked up on the next hit when the ladder is retuned mid-match.
  Also that the countdown publishes every player's spawn before anybody stands on
  it, and that the match then puts them there. And that a reload costs exactly
  the configured time when it starts from empty, none at all when the magazine
  is already full, and the proportional time for what is actually missing in
  between — `getReloadDurationMs` pinned against the exact numbers in the spec
  it was built to satisfy (5, 6 and 9 of 10 rounds), plus a live server case that
  starts a manual reload with a single round missing and checks it finishes on
  its own, much shorter deadline rather than the full one.
- **`tests/wire.test.ts`** — every configurable maximum survives the wire. The
  schema's field widths are checked against the admin's own declared maxima by
  encoding real state and decoding it again, so a setting the game would silently
  truncate fails here instead of reaching a player as a wrong number.
- **`tests/debug.test.ts`** — debug authorization over a real socket: a refusal leaks
  no catalogue, a hand-crafted command from an unauthorized session changes nothing,
  arguments are clamped, unknown config paths are refused, and a room override never
  reaches the server configuration.
- **`tests/powerups.test.ts`** — the closing arena (timing, symmetry, minimum width,
  crush damage, disabling it) and the crate pipeline end to end: spawn points, weighted
  contents, crate damage and destruction, revealed pickups, collection, and every
  power-up effect including expiry. Also asserts a crate never exposes its contents —
  including while it is only a warning, which lands exactly where it was promised,
  holds its spot for the whole wait, and counts against the crate limit.
- **`tests/grenades.test.ts`** — the loadout, charge-to-speed curve (including an
  absurd hold being clamped), flight under gravity, bouncing off geometry, the fuse,
  and a blast that falls off with distance and catches the thrower too.
- **`tests/presentation.test.ts`** — the sound and effect catalogues: every id has a
  definition, every sound routes to a real channel and renders (no sub-audible tones,
  no zero-length layers), burst-prone sounds are throttled, and no camera shake is
  set hard enough to be unplayable. Also that a rate limit counts your own hits
  separately from other people's, so a distant exchange cannot silence yours,
  and the minimap's own geometry: a world position normalises to the right 0..1
  fraction of the arena (clamped when something sits outside its bounds), and a
  reveal radius of 0 or anything nonsensical is treated as no limit at all. And
  that a pose eases to exactly neutral and latches there rather than approaching
  it forever, that a long frame cannot fling it past upright, and that the
  finale hands the celebration a duration it actually ends on. Also the trail
  catalogue and the path behind it: movement too slow or too small is
  not recorded, the fade and taper follow one curve, points age out one at a
  time rather than all at once, the ring buffer never grows past its configured
  length, a teleport clears it — and it rewrites its segment objects instead of
  allocating a fresh one per frame, which is the whole reason the class exists.
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
  enforced. Also that the minimap's visibility, its two layers and its radius are
  ordinary editable fields, and that a negative radius is refused rather than
  silently accepted as "unlimited". And that the health and ammo bars ship over
  the player with the corner panel's copy switched off, and that both switches
  can be flipped either way.
- **`tests/traps.test.ts`** — traps from the server's side: contact damage that fires
  once and re-arms, continuous damage metered per second, the warning before the hurt,
  the full cycle, proximity triggering, a trap that moves into someone, inheritance and
  overrides, and every way a trap is switched off.
- **`tests/admin.test.ts`** — the administration services: nothing reaches storage
  unvalidated, the last playable arena cannot be deleted, a save publishes to the
  running server, and reset works at every scope while storing only deltas.
- **`tests/npc.test.ts`** — the bots. That perception throws away what a bot could
  not sense (walls, range, a crate's contents), that behaviour comes out of scores
  rather than thresholds, that hysteresis stops the attack/retreat flicker, that
  targeting is genuinely separate from acting, and that the navigation graph
  narrows when the configured jump does. Plus whole matches run end to end:
  bots join a lobby, spawn, move under their own power through the ordinary input
  queue, choose varied actions, and shoot each other. Also the lobby hold: places
  stay open while it runs, fill when it expires, can be skipped by a person and
  not by a bot, and never leave bots playing alone.

---

## Extending it

The seams are already in place for the obvious next features:

- **More weapons** — add an entry to `shared/src/config/defaults.ts`; nothing else
  hard-codes weapon behaviour, and it appears in the administration interface and the
  debug console on its own.
- **More power-ups** — another entry in the same file. A new *weapon* power-up needs
  no code at all; a genuinely new kind of effect needs one applier in `PowerUpSystem`.
- **More NPC behaviour** — `brain.registerAction({ id, label, score, execute })`.
  The brain has no list of its own, so nothing else changes; registering an
  existing id replaces that behaviour. New personalities are entries in
  `npc.profiles`, and appear in the admin interface on their own.
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
