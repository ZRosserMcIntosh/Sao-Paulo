# Georgia State Pursuit — vehicle physics demonstrator

A browser police-pursuit physics demonstrator, served at **zrossermcintosh.com/gsp**. It exists
to find out whether the driving, the handling, the contact physics and the pursuit AI are fun
enough to justify a bigger, sillier game. Fictional agency, fictional cars, entertainment only:
not police training. No pedestrians, no injuries. Just paperwork.

It runs on the site's own physics engines:

| Engine | What it does here | Shipped as |
|---|---|---|
| **OpenRoad Dynamics** (Vehicle-Dynamics) | Every car's tyres (Pacejka, combined slip, relaxation length, wet grip, hydroplaning), unsprung wheels and suspension, drivetrain and automatic gearbox, assists (ABS, TCS, ESC, steering, drift assist), aero, and the body hull that carries a rolled car | `engines/gsp.wasm` from `web/gsp_web.cpp` (many-vehicle host ABI) |
| **Rapier 3D** (`@dimforge/rapier3d-compat`) | The host rigid-body world: integrates every chassis from the core's forces, car-to-car / barrier / prop contacts, props and debris | npm |
| **Glass Dynamics** (Glass) | Car windows: tempered side and rear glass dices and flies; the laminated windscreen cracks and stays | `engines/glass.wasm` + `glass_library.json` (the Glass Lab's files), in a worker |
| **Street Dynamics** (Destruction-Dynamics) | Breakaway sign posts: they bend, release at the slip base, shed panels, and push back on the car | `engines/street.wasm` + `street_library.json` (the Street Lab's files) |
| The driving page's **engine synthesizer** | The interceptor's cross-plane V8 voice and tyre noise (AudioWorklet) | `engines/engine-worklet.js` |

Built with Next.js (App Router, static export), TypeScript, React Three Fiber, drei,
@react-three/postprocessing, Zustand and Tailwind. Everything runs locally in the browser: no
accounts, servers, databases or external APIs.

## Run it

```bash
npm install
npm run dev          # http://localhost:3210/gsp/
```

`?scenario=C&seed=7` deep-links into a scenario; `?ui=0` starts in photo mode (U toggles it).

```bash
npm run build        # copies the engines into public/engines, then next build -> out/
npm run deploy       # build, then copy out/ to ../../gsp (the site's /gsp)
npm test             # headless: every scenario, then an AI-driven pursuit
npm run typecheck
```

After a deploy, stale hashed chunks in `gsp/_next/static` show up in `git status`; delete them.

## Controls and menus

W/↑ accelerate · S/↓ brake (hold at a standstill to reverse) · A/D steer · Space handbrake ·
L emergency lights · H siren · G horn · C camera · R restart (same seed) · T slow motion ·
F replay the last notable event · Y tow (back on the road) · U photo mode · Tab engineering lab ·
Esc pause · N single step while paused · F1 or ? the controls sheet. Gamepad: analog stick
steering, RT/LT throttle/brake, X handbrake, Y camera, B lights, LB siren, Start pause, Back restart.

The interface is split by what you are doing, so nothing lives in two places:

| Where | What is in it |
|---|---|
| **Main menu** | *Play* (scenario cards tagged Practice / Pursuit / Conditions / Chaos, details, seed, roll out) · *Settings* · *Controls* · *About* |
| **Pause (Esc)** | Left: resume, restart, replay the last crash, one physics step, the lab, back to the scenario menu. Right: *Settings* and *Controls* tabs |
| **Settings** (`ui/Settings.tsx`, same panel in both menus) | *Graphics*: quality preset, on-screen key hints · *Audio*: master volume and mute, a mix (engine, tyres, impacts, sirens, radio), dispatch voice · *Driving*: assists preset, steering sensitivity, mph or km/h · *Camera*: default camera, camera shake on impacts |
| **Physics lab (Tab)** | Engineering only: telemetry, handling and physics sliders, the vehicle definition, save / load |
| **HUD** | Pursuit status, the damage report, speedo; a short row of key hints (Settings → Graphics turns it off) |

Settings are saved in the browser (`localStorage` `gsp.settings`) and applied when a scenario
starts, including from a deep link.

## Architecture

```
src/
  sim/                      no React, no three.js: runs headless in Node too (tests/)
    Simulation.ts           fixed 120 Hz step, accumulator, slow motion, pause/step, contacts, rules
    engines/gsp.ts          OpenRoad Dynamics bridge (ISO 8855 <-> three.js frames)
    engines/street.ts       Street Dynamics bridge (ENU <-> three.js)
    engines/glass.ts        Glass Dynamics worker client
    physics/world.ts        Rapier world, collision groups, static scenery colliders
    vehicle/Vehicle.ts      one car = core vehicle + Rapier body
    vehicle/params.ts       the vehicle definition (mirrors the C++ parameter block)
    vehicle/catalog.ts      interceptor, sedan, pickup, SUV, hatch, van, coupe
    vehicle/damage.ts       damage zones, stages, detachable parts, glass, bill
    ai/driver.ts            road-following AI: traffic, suspects, troopers
    world/track.ts          the interstate loop: centreline, lanes, banking, queries
    world/terrain.ts        heightfield + surface classes (shared by core, Rapier, renderer)
    world/layout.ts         guardrails, barriers, signs, billboards, cones, trees
    props.ts                cones, drums, barricades, debris (Rapier)
    replay.ts               rolling 24 s transform buffer + events
    game.ts                 counters, achievements, dispatch radio
    audio.ts                Web Audio
    input.ts                keyboard + gamepad
    config.ts               the lab configuration (JSON export / import)
    scenarios.ts            scenarios A-F
  render/                   React Three Fiber: reads the sim every frame, never drives it
  ui/                       HUD, menus, lab panel, toasts (Zustand store in state/)
```

### One physics step (1/120 s)

1. **AI** (60 Hz) turns the road, the traffic and its personality into steering, throttle,
   brake and gear requests — the same inputs a player has.
2. **Player** input (keyboard ramped, pad shaped) goes into the same `controls`.
3. **Vehicle core**, per car: the Rapier body's pose and velocities go in (`gsp_set_body`), the
   core steps its tyres and suspension on 3 vehicle-local substeps (360 Hz) in
   `ChassisMode::External` against the shared heightfield, and hands back the average force and
   torque about the centre of mass over the host step (`gsp_forces`), which are applied to the
   Rapier body. Gravity is Rapier's. The core reports its host-sync error (lab: *Host sync
   error*, typically well under 1 mm).
4. **Arcade assistance** (optional, labelled) adds its own force/torque to the player only.
5. **Street Dynamics** gets the cars near a sign as oriented boxes, steps, and returns impulses.
6. **Rapier** steps: chassis integration and every contact. Car bodies do not collide with the
   terrain (the core's tyres and body hull carry them on the same heightfield); they do collide
   with each other, barriers, guardrails, the overpass, trees and props. Props sit in a lower
   dominance group, so a 20 kg drum can never act as a ramp under a 2-tonne car.
7. **Contacts**: Rapier's contact-force events become impulses (N·s) with a contact point and
   normal → damage, bills, sparks, sound, replay events, and the PIT check.
8. **Rules**, **replay recording** (60 Hz).

Rendering interpolates between the last two steps (`alpha`). Spins, PITs and rollovers are never
scripted: a PIT is a contact impulse on the rear quarter plus tyres that let go.

### Frames

The core works in ISO 8855 (x forward, y left, z up); Street Dynamics in ENU; the game in
three.js (Y up). The mapping is `ISO/ENU (x, y, z) -> three (x, z, -y)`, a proper rotation, so
vectors, axial vectors and quaternion vector parts map the same way. It lives in
`engines/gsp.ts` and `engines/street.ts` only. The body origin is the centre of mass.

## The vehicle definition

Every car — player, suspects, troopers, traffic — is built by the core from this definition
(`src/sim/vehicle/params.ts`, the `GSP_*` block in `gsp_web.cpp`). The lab's **Vehicle** tab edits
it live (each change rebuilds the cars of that kind in place, keeping their motion) and the
configuration JSON carries it.

| Field | Unit | Meaning |
|---|---|---|
| `mass` | kg | total, including unsprung |
| `inertiaRoll`, `inertiaPitch`, `inertiaYaw` | kg·m² | principal moments about the CoM |
| `wheelbase`, `trackFront`, `trackRear` | m | |
| `frontWeight` | 0–1 | static share on the front axle (sets the axle positions) |
| `cgHeight` | m | CoM height at rest (the hardpoints are solved so it rests there): rollover propensity |
| `tireRadiusFront/Rear` | m | |
| `gripLong/LatFront/Rear` | μ | Magic Formula peak friction |
| `corneringStiffness` | Fz₀/rad | |
| `springFront/Rear` | N/m | at the wheel |
| `suspensionTravel` | m | |
| `bump/reboundFront/Rear` | N·s/m | dampers |
| `antiRollFront/Rear` | N/m | |
| `steeringLock` | rad | road wheel at full lock |
| `brakeFront/Rear`, `handbrake` | N·m | per wheel |
| `drive` | 0/1/2 | RWD / FWD / AWD (`awdFrontShare`) |
| `differential` | 0/1/2 | open / locked / clutch LSD (`lsdPreload`, `lsdPower`, `lsdCoast`) |
| `finalDrive`, `gears[]`, `reverseRatio` | | |
| `transmission` | 0/1/2 | automatic / dual clutch / manual; `shiftTime` s |
| `idleRpm`, `redlineRpm`, `engineInertia`, `torqueCurve[[rpm, N·m]]` | | |
| `dragArea` | m² | Cd·A |
| `topSpeed` | m/s | electronic limiter (0 = none) |
| `overhangFront/Rear`, `halfWidth`, `bodyHeight`, `bodyFriction` | m | the body hull (rollovers, landing on the roof) |
| `unsprungMass` | kg | per corner |
| `ackermann` | 0–1 | |
| `clutchTorque` | N·m | |
| `wetGrip`, `looseGrip` | × | tyre grip on a fully wet / loose surface |

The catalog (`catalog.ts`): the **GSP-71 Pursuit Interceptor** (1,950 kg RWD V8, 8-speed auto,
clutch LSD, 150 mph limiter; 0–100 km/h ≈ 5.3 s, 100–0 ≈ 41 m with ABS in the core's own smoke
test), the suspect's tired FWD V6 **sedan**, a 2.8 t **pickup** with a 0.84 m CoM, an AWD **SUV**,
a **hatch**, a **van**, and a yellow V8 **coupe**. All fictional.

## The lab (Tab)

* **Telemetry**: speed, rpm, gear, engine torque, accelerations (g), angular velocity, sideslip,
  inputs, assist activity, body-hull ground contacts; per wheel slip ratio, slip angle, load,
  suspension compression, grip used, surface; the last contact impulses (N·s and Δv); damage
  zones, condition, steering pull, detached parts, repair estimate; physics step time (core /
  Rapier / AI), render fps, host-sync error.
* **Driving**: driving preset (FUN / SPORT / SIM / DRIFT — the core's assist bundles; same
  physics), drift assist, steering sensitivity, arcade assistance (below).
* **Physics**: tyre grip ×, suspension stiffness ×, steering lock ×, collision restitution, core
  substeps, surface friction ×, and grip, wet grip loss and looseness per surface class.
* **Vehicle**: the full definition above, per vehicle kind, with drivetrain selectors.
* **Save / Load**: export / copy / import the whole configuration as JSON (`config.ts`, version 1).
* Pause, single step (1/120 s), slow motion (0.05–0.5×).

### Arcade assistance (separate from the simulation)

All in `cfg.arcade`, all off when `enabled` is false or the slider is 0, all applied as extra
forces or impulses next to the physics, never instead of it:

* **PIT assist**: on a pursuer's contact with a suspect's rear half, adds a fraction of the
  contact's own yaw angular impulse (r × J) to the suspect.
* **Stability**: player-only yaw damping toward the yaw rate the steering asks for.
* **Arcade downforce**: player-only force ∝ v².
* **AI trooper PIT eagerness**: how often and how tightly AI troopers line up a PIT.

## Sound

The engine and the tyres are the driving page's AudioWorklet (`sao-paulo/driving/audio/engine-worklet.js`,
copied into `engines/` at build time); sirens, horn, impacts, glass and the dispatch radio are
Web Audio in `sim/audio.ts`. Five buses (engine, tyres, impacts, sirens, radio) feed the master
and are what Settings → Audio → Mix sets.

**Tyres** (`tyre-squeal` processor). Each wheel is its own voice driven by the vehicle core, 120
times a second (`tyreInputs` in `sim/audio.ts`):

| Input | From the core | Meaning |
|---|---|---|
| `s` squeal | combined slip `max(|κ|, |α|/0.12)` through a bell that peaks just past the grip peak, × sliding speed, × load | how hard the tread is stick-slipping |
| `v` sliding speed | `hypot(ωr − v, v·tan α)` (m/s) | sets the squeal's pitch and how fast it chirps |
| `h` hiss | slip well past the peak (lock-ups, burnouts, big slides) × sliding speed | rubber scrubbing rather than singing |
| `r` roughness | the surface class (concrete smooth, shoulder and county road rough) | grit and pitch jitter |

Puddles and rain kill the squeal and turn it into a wet swish; grass, clay and gravel do not squeal.
Per voice the synth makes a stick-slip tone (≈0.5–1.1 kHz, rising with sliding speed, with mode
hops between a few close resonances, slow pitch wander and fast flutter) with stretched overtones
that thin out as it gets harsher, a chirp gate that stutters near the grip limit and smooths out in
a full slide, band-passed hiss, grit and a low roar for big slides. The four voices are panned and
slightly detuned, then share a tyre-road "horn" boost around 1.7 kHz, a 190 Hz high-pass, an
early ground reflection and, in the hood and driver cameras, a cabin low-pass. The nearest other
car's tyres get their own quieter, panned node. Cost: ≈5 % of one core with four tyres sliding,
≈0.3 % idle. The driving page (`/sao-paulo/driving`) uses the same synth with the same per-wheel
inputs from its own vehicle.

## Surfaces and weather

Surface classes live in the heightfield the core samples (`terrain.ts`): asphalt lanes, concrete
median, shoulders, grass, **red clay** (cut slopes and patches: low grip, loose, slick when wet),
gravel verges, the test pad, the bridge deck, the county road and the median ditch. Rain sets
every surface's wetness, lays a water film on paved classes and fills puddles (deterministic,
18 m cells) whose standing water drives the core's hydroplaning model. In the core's smoke test the
interceptor stops from 100 km/h in 41 m dry with ABS, 64 m in a downpour with ABS, 94 m wet with
locked wheels.

## Damage

`damage.ts` turns each contact impulse into Δv on the car and assigns it to a zone (front, rear,
left, right, roof): stages 1–3, broken head/tail lights and light bar, loose then detached bumper
covers, mirrors, hubcaps, tailgate, push bar and light bar (they become Rapier debris), dents
pushed into the body mesh where it was hit, scratches (paint roughness), engine smoke, reduced
power and a steering pull. Side and rear windows that break go to Glass Dynamics and dice; a
windscreen that breaks cracks (its crack lines are the glass engine's). Bills are capped at a
total loss. No deformable body: dents are cosmetic, the chassis stays rigid.

## AI

`ai/driver.ts`: pure-pursuit lane following on the interstate, a PI speed loop against the
speed limit × personality, curvature ahead and the car in front (IDM-like gaps), lane changes
when blocked (gap checks), keep-right, moving over for sirens, swerves, wobble by skill, traction
recovery (countersteer into a slide, ease off), spin recovery (stop, reverse on lock, forward on
opposite lock), giving up after repeated spins. Suspects flee with panic that builds with a
trooper behind them (erratic lane changes, the shoulder). Troopers follow, offset, line up PITs
on the rear quarter, pull up behind a stopped suspect, and retarget the nearest suspect still
running. A suspect stopped for 3 s with a trooper within 35 m is detained; the pursuit ends when
all are.

## Scenarios

A Free Drive (pad, slalom, skid pad) · B Highway Pursuit (sedan) · C Uncooperative Suspect
(aggressive, shoulder-running, more traffic) · D Heavy Vehicle (2.8 t pickup) · E Rainy Day in
Georgia (wet, puddles, fog) · F Absolute Mayhem (three suspects, three troopers, heavy traffic,
the work zone). Every scenario is seeded; R restarts with the same seed; the menu picks a seed.

## Cameras and replay

Chase (car-relative, eased heading, speed FOV, impact shake), close chase, hood, driver (simple
cabin), free orbit (drag, wheel), trackside cinematic. The replay buffer keeps 24 s of every
car's and prop's transform and the wheels at 60 Hz plus events; F replays the most notable recent
event at 0.35× with cuts between an orbit, a low trackside shot, an overhead and a chase angle.

## Tests

* `tests/headless.mjs` runs every scenario without rendering (Node, the real engines) and prints
  step cost, speeds, AI state and counters.
* `tests/pursuit.mjs [scenario] [seconds] [seed]` drives the player's car with an AI trooper and
  reports PITs, contacts and the end of the pursuit.
* `tests/tyre-audio.mjs [out.wav]` drives the interceptor through a launch, a locked-wheel stop and a
  handbrake drift with every aid off and renders the tyre synth from the core's own
  slip data to a WAV, for listening to changes.
* The vehicle core's many-vehicle module has its own smoke test in Vehicle-Dynamics
  (`node web/gsp_smoke_test.mjs`: rest height, 0–100, 100–0 dry and wet, cornering, the deck,
  two cars, live rebuild), run in its CI.

Measured on this build (4-core cloud VM, Node 22): ~1.0 ms per 120 Hz step with 8 cars, ~1.7 ms
with 23 (Mayhem), i.e. 2–3.5 ms of CPU per 60 fps frame for the whole simulation. GPU frame time
was not measured (the test machine renders in software).

## Known limits

* Damage is cosmetic plus a few mechanical effects; the core's node/beam crash structure needs
  an internal chassis and is off here.
* The terrain is a single heightfield (1.5 m cells): wheels see the overpass deck as a separate
  flat deck; ramps and jumps are not modelled.
* AI drives the interstate loop; off the loop it only recovers back onto it.
* Graphics presets trade terrain resolution, trees, shadow map size, pixel ratio, rain density and
  post-processing; there is no LOD for cars.
