# Hydro — Architecture

*(Revised after internal review #1.)*

## 1. Overview

```
 ┌──────────────── main thread ────────────────┐      ┌────────── sim worker ──────────┐
 │ ui/      HUD, tool palette, input gestures  │      │ sim/  authoritative world state│
 │ render/  three.js scene: terrain, water,    │ ◀─── │   worldgen, climate, hydro,    │
 │          objects, NPC puppets, fog, camera  │ snap │   groundwater, erosion, soil,  │
 │ client/  SimClient: protocol, interpolation │ ───▶ │   plans, (later) NPCs, power   │
 │ persist/ IndexedDB save slots               │ cmds │                                │
 └─────────────────────────────────────────────┘      └────────────────────────────────┘
                     shared/: types, protocol, rng, noise
```

- **TypeScript + Vite**, **three.js** (WebGL2), **vitest**, **Playwright**.
- `sim/` has **no DOM and no three.js dependency**. It runs in a Web Worker in
  the browser and directly in Node for tests, benchmarks and tools
  (worldgen preview PNGs).
- Static deploy to GitHub Pages via GitHub Actions.

### Why TypeScript and not Rust/WASM?
The kernels are allocation-free loops over typed arrays, written as plain
functions (arrays in, arrays out). Measured: ~3 ms/step for a 256² flux
kernel in Node on desktop. Porting a hot kernel to WASM SIMD (~2–3×) or to a
WebGL2 GPU pass (>10×) stays a local change if the phone bench demands it.

## 2. World model

### 2.1 Units and grid
- The sim works in **SI units**: metres, seconds, g = 9.81. Cell size
  `CELL = 5 m`. Vertical exaggeration is a renderer setting only.
- Grid `W × H`: **256² default** on all devices, 512² as a desktop quality
  tier once benchmarks allow.
- Structure-of-arrays fields in `sim/world.ts`, declared in one field table
  that drives serialisation and snapshots.

| Field | Type | Meaning |
|---|---|---|
| `bedrock` | f32 | bedrock elevation (m) |
| `soil` | f32 | soil thickness (m); terrain = bedrock + soil |
| `soilType` | u8 | rock / gravel / sand / loam / clay / silt / peat |
| `water` | f32 | surface water depth (m) |
| `sediment` | f32 | suspended sediment volume (m³) |
| `qx`, `qy` | f32 | face discharges (m³/s) to the +x / +y neighbour |
| `velX`, `velY` | f32 | cell velocity (m/s, derived) |
| `ground` | f32 | groundwater stored in soil (m water column) |
| `snow` | f32 | snow water equivalent (m) |
| `fertility`, `vegetation` | f32 | 0..1 |
| `flags` | u8 | lined / outlet / structure / inflow |
| `plan` | f32 | target terrain height for pending earthworks (NaN = none) |
| `inflow` | f32 | prescribed inflow (m³/s), boundary rivers and springs |
| `flowAvg` | f32 | slow moving average of discharge (river detection) |
| `revealed` | u8 | fog of war (used from M3) |

### 2.2 Bounded active window and the endless world
Simulating an ever-growing grid is not affordable. The design is:
- **Global integer cell coordinates.** `World.originX/Y` places the grid in
  the infinite world. Terrain generation is a pure function of seed + global
  coordinates.
- A **macro river network** is computed at coarse resolution (1/16) over an
  area much larger than the active window: flow accumulation over the
  macro heightfield gives river paths and discharges. Worldgen **carves those
  rivers** into the fine terrain (3–8 cells wide, banks, graded profile).
  Rivers crossing the window boundary become **inflow cells** carrying their
  macro discharge (and sediment at capacity) or **outlets** with a pinned
  base level.
- The **active window** is simulated in full. Its size is capped (≤ 512²).
  Outside it, the land is dormant: terrain is frozen and hydrology is the
  steady macro routing.
- Expanding or shifting the window generates new margins from the same
  functions, blends them into the edited edge over ~16 cells, and runs a
  short local spin-up. Because rivers come from the global macro network, a
  former boundary inflow continues seamlessly as an interior river.
- Saves store fields per 64×64 chunk (from M7 on; M1 saves the whole window).

## 3. Simulation

### 3.1 Two clocks
- **Hydraulic time:** `DT = 0.5 s` per step, with a CFL check and sub-stepping
  for deep water (dt ≤ 0.7·dx/(√(g·h_max)+|u|max)).
- **Calendar time:** `STEPS_PER_DAY = 600`, so a game day is 300 hydraulic
  seconds. Compression factor `K = 86400/300 ≈ 290`.
- **Every slow rate** (rain, evaporation, infiltration, melt, groundwater,
  growth) is expressed per game day in `sim/params.ts` and converted per
  step. Because of K, a small catchment yields visible rivers, so K is in
  effect the "how wet is the game" knob.
- At 1× the target is 20 steps/s, so a day is 30 s and a year 24 min. Water
  moves at ~3 cells per real second, which reads as flowing.
- The game slows down rather than going unstable when the CPU can't keep up.
  The HUD shows the achieved speed.
- **Geomorphology speed (MORFAC)** is a separate multiplier on
  erosion/deposition/talus. Target: an unlined trench visibly slumps within
  about 1 game year, and a river channel migrates noticeably over about 10
  game years.

### 3.2 Surface water: local inertial model (Bates et al. 2010)
For each face between cells i and j (x-faces and y-faces):
```
h_f   = max(η_i, η_j) − max(z_i, z_j)            (flow depth at face)
q    ← (q − g·h_f·dt·(η_j − η_i)/dx) / (1 + g·dt·n²·|q| / h_f^(7/3))
```
`q` is discharge per unit width. Manning `n` comes from the surface type
(water ≈ 0.03, vegetation higher). Then:
1. Outflow limiting: for each cell, the total outgoing volume this step is
   capped at the stored volume, and the outgoing faces are scaled.
2. Depth update from the flux divergence.
3. Sediment moves with the same face fluxes (upwind concentration), so it is
   conserved exactly.
4. Cell velocity = average face discharge / depth (used for erosion,
   rendering foam, NPCs).
5. Outlets drain at critical flow `q = h·√(g·h)`, with their bed height pinned.

**Tile sleeping.** Only enabled once the bench shows it is needed. A tile
sleeps when max depth < 2 mm, its fluxes are ~0 and its neighbours sleep.
Rain on sleeping tiles goes into a soil bucket and wakes the tile when
ponding exceeds the threshold. Thin films below ε are removed into
ground/evaporation with exact accounting. The worst case (rain over the
whole window) must still fit the budget.

### 3.3 Erosion, deposition, talus (M1b)
Code: `sim/hydro/erosion.ts`, `sim/hydro/talus.ts`; tunables in
`sim/params.ts` (copied into `Simulation.geo`, which tools and tests may
change). Erosion runs every 8 steps, talus every 16, weathering 4× a day.
- **Two capacities.** Suspended sediment is a volume per cell carried by the
  flow kernel. The water can keep `C = MORFAC·Kc·(|v| − v_c)^1.5·min(h, h_cap)`
  in suspension (v_c ≈ 0.4 m/s, nothing below h = 3 cm); any excess settles
  at the settling velocity. Picking up from the bed uses the bed's own
  critical speed (`bedCriticalFactor` per soil type: gravel 4×, clay
  1.6×, …) and ramps in with depth (no sheet-flow scour on hillsides).
  Between the two the water neither erodes nor deposits.
- **Per-pass limits:** at most 10% of the local soil, never below half-way
  to the lowest neighbour, deposits never above the highest neighbour;
  bare bedrock erodes 1000× slower. Lined cells and outlets never change.
- **Bed texture:** sustained scour (0.3 m net) armours a loose bed to gravel,
  so steep reaches stop incising; deposits turn the topsoil into silt
  (slow water, + fertility) or sand (bars on gravel).
- **Lateral migration:** flow running up a bank (velocity against the
  bank's smoothed uphill direction, so diagonal channels do not widen)
  wears it down above `bankCriticalVelocity`; the material is laid down on
  the far margin of the channel as a point bar. Channels shift but keep
  their width. A weak bed-slope diffusion keeps cross-sections smooth.
- **Boundaries:** outlets have a pinned base level. Each inflow carries the
  sediment its river can transport: a slow controller adjusts the inflow
  concentration so the reach within 8 cells below it neither degrades nor
  aggrades (the upstream analogue of the pinned base level).
- **Weathering** turns bedrock into soil at 3 cm/year under bare rock,
  decaying with soil depth (e-folding 0.5 m, cap 5 m).
- **Talus:** soil steeper than its repose slope (SOIL_PROPS) slumps to lower
  8-neighbours; the slope is lower when wet (saturated, or the toe under
  water) and for **loose soil**: earthworks loosen the cells they change,
  which settle over about a game year. So a fresh unlined trench slumps and
  narrows once water flows in, a lined one does not. Only soil moves.
- **Ledgers:** f64 sediment ledger (inflow, outflow, eroded, bank,
  deposited, weathered, talus); bedrock + soil + suspended sediment is
  conserved apart from inflow and outflow. Save games keep the ledger and
  the sparse per-cell erosion state (`SimState.geo`).
- **Stationarity** (`tests/sim/erosion.test.ts`, `tools/longrun.ts`): on
  generated 128² worlds over 10–20 game years the mean terrain change stays
  at centimetres and grows ever more slowly, rivers persist and migrate,
  sediment in ≈ sediment out. The default test runs one year at MORFAC ×6;
  `HYDRO_LONG=1` runs ten years at the normal MORFAC.

### 3.4 Groundwater (M1a: bucket; M1c: lateral flow)
- M1a: each cell's soil is a bucket of capacity `soil × porosity`.
  Infiltration from surface water at a soil-dependent rate; excess emerges.
- M1c: lateral Darcy flow on a half-resolution grid, once per game hour,
  with the conductivity contrast clamped to ≤ 100×. Springs and bogs form
  where the table meets the surface.
- Evaporation from open water and topsoil, depending on temperature.

### 3.5 Climate & weather
- Calendar, seasonal temperature, lapse rate. Rain fronts are drifting
  ellipses with orographic enhancement. Snow below 0 °C with degree-day
  melt (M1c). AR(1) climate anomaly for wet and dry years (M1c).
- Rain is evaluated per tile. The renderer receives the fronts (for clouds
  and rain particles) and the sun/season state.

### 3.6 Plans and builders
- Plans are target terrain heights per cell, written by tool commands
  (polyline trench with a graded floor, polyline dike with a level crest,
  level area, cancel).
- Builders move terrain towards the target at a bounded rate. M1 uses a
  "spirit crew" stand-in. In M3, NPC builders replace it, using the same
  `applyEarthwork` API.
- The main thread renders plans **optimistically** for immediate feedback.

### 3.7 Determinism & accounting
- Seeded `sfc32` RNG owned by the sim. No `Math.random` or wall clock in `sim/`.
- Determinism is promised within one engine (Node/Chromium). Saves and the
  command log are the source of truth across engines.
- Mass ledgers (rain, inflow, outflow, evaporation, infiltration, thin-film
  removal) are accumulated in f64 and checked in tests.

### 3.8 Performance budget (estimated, verify with `?bench=1`)
| | 256² | 512² |
|---|---|---|
| desktop Node, flux kernel only | 3 ms/step | 14 ms/step |
| Pixel 9a full step (est.) | ~4–6 ms | ~10–13 ms |
| steps/s at ≤ 50% of one core, phone | ~100–150 | ~40–50 |

1× (20 steps/s) and 3× (60) fit at 256² on the phone. 10× is desktop only.
The worker caps its CPU share on mobile and pauses when the tab is hidden.

## 4. Worker protocol (`shared/protocol.ts`)
Main → worker: `init`, `load`, `scene` (welcome scenes, §5.1), `setSpeed`,
`command`, `ack` (returns buffers), `requestSave`. Worker → main: `ready`,
`snapshot`, `saved`, `log`.

**Snapshots** (~10 Hz), using transferable buffers from a 3-set ping-pong
pool. When no set is free, the worker **skips** the snapshot and never
queues or allocates.
- `time`, climate, fronts, stats (achieved speed, ledger).
- `depth`: f32 water depth (256² → 256 KB).
- `vel`: RG8 signed velocity (±4 m/s).
- `terrain`: f32 terrain height, **only dirty row bands**.
- `look`: RGBA8 ground look (soil type, moisture, fertility, snow), at ~1 Hz or
  dirty bands.
- `plan`: changed plan cells.

The worker loop runs work slices of ≤ 4 ms and yields through a
MessageChannel, so commands and acks are handled promptly. It paces
itself with its own clock.

## 5. Rendering (`render/`)
- `OrthographicCamera` at ~35° pitch with free yaw. Mouse: drag pans, wheel
  zooms, right-drag rotates. Touch: one-finger pan, pinch, twist. **Tool
  mode:** one finger draws, two fingers pan/zoom, explicit exit button.
- **Terrain:** one shared indexed grid geometry (64×64 cells) drawn per
  chunk with an offset uniform. Heights come from a terrain height texture
  (R32F, `texelFetch`, NEAREST, so no float-linear extension is needed).
  Edits are `texSubImage2D` row uploads. Flat shading from `dFdx/dFdy`
  normals. Colour from the per-cell ground-look RGBA8 texture.
- **Water:** the same grid approach with the depth texture. Two depth
  textures (previous/current snapshot) are mixed for smooth interpolation.
  At dry vertices next to wet ones, the water height is set to the highest
  wet neighbour's surface so the depth test cuts a smooth waterline. Shore
  fade by depth, foam by |v|, animated normals.
- **Plans** are drawn by shared GLSL (`planOverlay.ts`) on the terrain *and*
  on the water surface (stripes + outline), so they stay visible under water.
- **Flow particles** (`flow.ts`): up to 2600 comet-shaped foam flecks and
  leaves, advected on the CPU through a decoded copy of the snapshot
  velocity (visual speed ≈ 2.2·v^0.7 cells/s at 1×, frozen when paused),
  spawned in flowing cells inside the view; one instanced draw.
- **Weather** (`weather.ts`): rain fronts become flat-bottomed low-poly
  puff clusters (one InstancedMesh, depth pre-pass + colour pass) that
  dissolve when zoomed in, soft ground/water shadows via front uniforms,
  and GPU-only rain/snow (one instanced draw tiled around the camera).
- **Seasons** (`seasons.ts`): one palette blended over the year drives sun,
  sky, grass, water and leaf colours.
- **Objects:** each Kenney model merged into one geometry with the shared
  colormap, one `InstancedMesh` per model, bucketed per chunk. Small props
  are hidden when zoomed out. Target < 150 draw calls on the phone.
- **Characters:** cloned `SkinnedMesh` + `AnimationMixer` up to ~60. From M3
  on, baked animation textures. Cube pets are animated procedurally (hop and
  squash in the vertex shader).
- **Picking:** ray-march against the CPU copy of the heightfield.
- **Mobile:** pixel ratio ≤ 1.5, a 1024² shadow map fitted to the view
  frustum (off on the low tier), LOD by chunk stride when zoomed out,
  `webglcontextlost`/`restored` handling. Feature checks are logged at
  startup.
- **Fog of war (M3-γ, `fog.ts`):** a revealed R8 texture turns the
  terrain over unknown land into a billowing cloud sea (see PEOPLE.md §6);
  water chunks entirely in the fog are not drawn, objects there are not
  placed, and the camera pans only over known land.

### 5.1 Welcome scenes (`sim/scenes.ts`, `ui/introScenes.ts`)
The welcome panels are illustrated by the real engine, not by drawings:
- **Scene world:** `buildSceneWorld()` hand-builds a 96² world in code,
  independent of worldgen tuning: rolling meadow, two wooded hills, a river
  from an inflow on the left edge to an outlet on the bottom edge, a pond,
  and a dry hollow lower than the river. Landmarks live in
  `sim/sceneLayout.ts` (pure data, so the UI can aim cameras without
  bundling the sim). `buildScene(id)` makes a Simulation of it (fog off,
  no random rain fronts, early summer) and spins it up so the river flows:
  `water` adds one scripted rain front (`Weather.addFront`), `shape` is the
  bare land, `village` stages a ready-made village with
  `PeopleSystem.stage(…)` (store, five houses and one being built, fields
  at several crop stages, farmers, builders, two fishers already fishing).
  Everything is deterministic and runs as in the game from then on.
- **Runtime:** the dialog starts a second `SimClient` with
  `{type: 'scene', scene, run}`. The worker builds each scene once and keeps
  it as a template; a (re)start is a cheap `cloneScene`. Switching scenes
  keeps the buffers (same grid) and resends the whole state; every
  snapshot carries `sceneRun`, so stale states of a scene already left are
  dropped. One `GameRenderer` (pixel ratio ≤ 1.5, no shadows) with the
  game's own `WorldLayers` (vegetation, crowd, fish jumps;
  `render/worldLayers.ts`, shared with `main.ts`) draws on the dialog's
  canvas from a fixed camera per scene, with no camera input. Closing the
  dialog terminates the worker and disposes the renderer
  (`forceContextLoss`); the main canvas is not rendered while the dialog is
  open.
- **Timelines:** each scene loops (11–14 s, then a short fade and a fresh
  clone). `shape` animates an HTML hand over a piece of the tool palette and
  the canvas: it picks Trench, draws (showing the real plan preview from
  `planTrench` on a `WorldMirror` grid), releases (a real `planTrench`
  command), and the spirit crew digs while the hollow fills.
- **Fallback:** the SVG drawings show while the scene loads and stay when
  WebGL or the worker fails.

## 6. Persistence (M1b)
Header JSON + binary fields, gzip via `CompressionStream`, stored in
IndexedDB. Autosave every few game days and on `visibilitychange`. Versioned
with migrations and golden save files per version. Export/import comes later.

## 7. Code layout
```
src/
  main.ts                bootstrap
  shared/                protocol.ts, rng.ts, noise.ts
  sim/                   world.ts, constants.ts, params.ts, sim.ts, worker.ts,
                         scenes.ts + sceneLayout.ts (welcome scenes)
    worldgen/            terrain.ts, macro.ts (river network), carve.ts, soils.ts
    hydro/               inertial.ts, erosion.ts, groundwater.ts, talus.ts
    climate/             calendar.ts, weather.ts
    plans/               plans.ts, builders.ts
  client/                simClient.ts
  render/                renderer.ts, camera.ts, terrain.ts, water.ts, sky.ts,
                         objects.ts, characters.ts, picking.ts,
                         worldLayers.ts (vegetation/crowd/fish wiring)
  ui/                    hud.ts, tools.ts, input.ts, styles.css,
                         intro.ts + introScenes.ts (welcome panels)
  persist/               idb.ts
tools/                   bench.ts, preview.ts
tests/                   vitest (sim/, scenarios/)
e2e/                     Playwright specs
public/assets/           curated Kenney GLBs + CREDITS
```
