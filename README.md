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

### Difficulty is skill, not a second personality

**A brain profile says what a bot wants. A difficulty level says how well it
manages any of it.** Multiplying one by the other is what gives twelve
personalities × five levels — sixty kinds of opponent — without a single extra
profile being written. An Aggressive bot at level 2 is the same Aggressive bot:
it still walks at you, it is simply worse at it.

Difficulty is emphatically **not** less health or less damage. Every level plays
the same game with the same weapons and the same rules; what changes is the
quality of the decisions and the execution:

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
```

Level 5 is the reference point: every multiplier is 1, so it plays the profiles
exactly as written — which is where the bots were before difficulty existed, and
why the shipped default is 3. And even level 5 aims through the same
imperfect-aim machinery as every other rung: there is no perfect aim at any
difficulty, and no level is given information a bot could not sense.

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

The marker is three things at once, because one alone is missable in a firefight:
a ring that tightens onto the spot, a shadow growing underneath, and a flashing
chevron above it — with the pulse quickening from a slow beat to an urgent one as
the moment approaches.

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

**The weapon is held forward, and drawn behind the body.** With the grip on the
body's centre line a rifle's stock lay across the face, and the visor is the only
part of the figure that says which way somebody is looking. It is now held
`WEAPON_FORWARD_X` in front of the shoulder *and* drawn beneath the body, so no
weapon can cover the head whatever its shape — the barrel still reaches past the
shoulder, which a test checks for every weapon in the catalogue. `MUZZLE_OFFSET_X`
moved with it, so the drawn barrel, the muzzle flash and the point the server
spawns projectiles from still agree.

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
  cancels a knockback.
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
