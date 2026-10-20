# Hydro — Endless world (M7) proposal

*Status: proposal, October 2026. Step 1 (sparse simulation inside the
fixed map) is built; §12 says how and what it measured.
Numbers marked "(container)" were measured in the dev container, which is
about 5× slower than a desktop (CLAUDE.md). The measuring scripts were
throw-away prototypes; §11 says how to reproduce them.*

## 0. Short answers

**1. Can the map just grow as the fog recedes, with no apparent limit?**
Yes, *apparently* unlimited. Truly unlimited, no: the cost is per
simulated cell, and the whole simulation is local and explicit. The budget
is about **1M active cells on desktop** (≈ 1000², 25 km²) and **≈ 250k on a
phone**. The good news is that the players' pace sets the growth rate.
Villages are founded at most once per game year, and each adds roughly
10–15k newly revealed cells. So 1M cells takes about 70 game years
(≈ 28 h at 1×). A soft cap that steers *where* villages are founded
(§9) keeps the revealed land inside the budget without a visible border:
the cloud sea stays, only the frontier stops moving outward.

**2. Can we simulate only what is revealed (plus a margin)?**
Yes. This is the cheapest and biggest win, and it works inside the current
fixed map with no change to worldgen or rendering. The flow kernel is
83 % of a real game step, and its cost falls linearly with the masked area
(measured: 10 % of the cells → 12 % of the time). The cells outside the
mask are frozen and act as a boundary (§4). Combined with sleeping dry
16² tiles and per-tile sub-stepping (§3), a 512² or even 1024² map
costs early in a game about what 256² costs today.

**Recommended path:**
- **Step 1:** active mask + dry-tile sleeping inside the fixed map.
  Then make 512² the desktop default.
- **Step 2:** a tiled, growable world up to a fixed reachable extent,
  generated consistently, with chunk streaming and the soft cap.
- **Step 3 (only if players hit the cap):** level-of-detail sleeping of far
  revealed land, plus a hierarchical macro network. This makes the world
  unbounded.

## 1. Where we are (facts and measurements)

- `World` is one dense `W×H` structure-of-arrays (FIELD_SPECS):
  **67 B/cell**. The Simulation's scratch arrays add **88 B/cell**, and the
  worker's snapshot pool about 26 B/cell more. The main thread
  (R32F/RGBA8 textures and CPU mirrors) adds roughly 80–100 B/cell.
  All-in that is **≈ 260 B/cell**.
- Real game step (container, seed 7, with a village, after spin-up):

  | | 256² | 512² |
  |---|---|---|
  | full `advance()` | 14.0–14.6 ms | 48 ms |
  | `flowStep` per call (dry/wet mix) | 3.36 ms (51 ns/cell) | 11.9 ms (44 ns/cell) |
  | CFL sub-steps per step | 2–4 | 3–4 |
  | groundwater (amortised per step) | 0.15 ms | 0.44 ms |
  | erosion (amortised) | 0.31 ms | 0.51 ms |
  | talus (amortised) | 0.27 ms | 0.81 ms |
  | vegetation (amortised) | 0.01 ms | 0.04 ms |

  A CPU profile of the 256² game gives **83 % `flowStep`**, 2.5 % soil
  water, 1.8 % talus, about 1 % groundwater and 0.7 % erosion. People are
  negligible at this population. (`npm run bench` uses a synthetic all-wet
  world: flow 5.9 / 14.6 ms, full step 12.4 / 39.9 ms at 256² / 512².)
- **Sub-stepping is global.** One 18 m deep pool forces 4 sub-steps
  everywhere. Yet cells deeper than 2 m are only 0–7 % of the map.
- **Wet area is small, but only at fine granularity.** Tiles with any
  water: 28–48 % at 16² tiles, 46–71 % at 32² tiles, but 75–88 % at 64²
  tiles (three seeds, 512²). Tiles deeper than 1.5 m: 8–15 % at 16² tiles.
  So sleeping must use **16² tiles** (`TILE` already exists). 64² tiles are
  too coarse to sleep.
- **Masked flow kernel prototype.** I wrote a copy of `flowStep` that loops
  over per-row spans, with disc masks:

  | active cells | 100 % | 50 % | 25 % | 10 % |
  |---|---|---|---|---|
  | 256² | 3.31 ms | 1.80 | 0.99 | 0.39 |
  | 512² | 11.5 ms | 5.5 | 3.0 | 1.36 |

  The cost is linear in the active cells. Short spans add +5–15 % per
  active cell.
- **Worldgen:** 1.4 s for 256², 3.4 s for 512² (≈ 13 µs/cell; base noise
  is 5.7 µs/cell of that). The macro network over a larger domain:
  2048² fine cells take 0.6 s, 4096² take 1.7 s, 8192² take 7.1 s
  (container).
- **Worldgen consistency test.** I generated 512² at origin (0,0), then
  the same 256² quarter as its own window with a 32–128 cell apron (same
  `riverScale`).
  - **The macro river paths agree exactly**: 0 of 438 vertices are off by
    more than 2 cells.
  - **The fine terrain does not agree.** 0.6–3.8 % of the cells differ by
    more than 25 cm, soil type differs in 2–5 % of the cells, and wet/dry
    in 0.6 %.
  - The cause is the window-global conditioning steps: `placeBoundary`,
    `settleBasins` and `depressions` drain to the *window perimeter*, and
    `d8Accumulate` runs over the window.
- **Saves:** 21.5 B/cell gzip (256² ≈ 1.4 MB, 512² ≈ 5.5 MB).
- **Pace of reveal:** each settlement reveals `R = 56 + 5√pop`. Foundings
  happen at most once per game year, worldwide (`FOUNDING.interval`), at
  the soft fog edge. On today's 256² map the frontier reaches the map edge
  within a few game years.

## 2. The active region

Definitions, all on **16² tiles** (`TILE`):
- **Revealed tile:** some cell has `revealed > 0`.
- **Active tiles:** the revealed tiles dilated by a **margin M = 32 cells**
  (2 tiles), plus *pending* tiles (see the next list). Every kernel
  runs here.
- **Halo:** the ring of one tile outside the active set. It is read, never
  written (§4).
- **Awake tiles ⊆ active tiles:** tiles that the surface-flow kernel runs
  on this step (§3). The slow kernels (groundwater, soil water, erosion,
  talus, vegetation) run on *all* active tiles, because they are cheap and
  must keep dry land evolving.

Why the margin:
- Everything at the active edge (the frozen boundary, cut-off backwater)
  is ≥ 32 cells inside the fog, where the cloud sea hides the terrain and
  water is not drawn.
- The margin also gives freshly activated land time to spin up before
  anyone sees it.

**Activation is ahead of revealing:**
- *Reveal growth* (`updateReveal`, daily): `R` grows by a cell or two per
  day at most, so the 32-cell margin stays ahead.
- *Founding* reveals a whole disc at once, mostly over unknown land.
  1. The sim picks the site, as today.
  2. It marks the disc (+M) **pending**, which activates and spins up
     those tiles (§5.4).
  3. The disc's `revealed` then rises over the 1–3 days the migrants need
     to walk in, a nice "the land opens up as they arrive" effect.
- *Adaptive growth:* a halo tile whose neighbouring active cells have
  water ≥ 5 cm above the frozen halo surface for a whole day is activated
  too, up to a small extra allowance. Example: a reservoir the player
  dammed, backing up into the fog. The water gets room where it wants to
  go.

Tiles never deactivate in steps 1–2 (revealed land stays revealed).
Step 3 adds deactivation of *far* land (§10).

## 3. Running the kernels sparsely

**Representation:** an active-tile bitmap plus a derived **span list**
(per tile row: runs `[x0, x1)` of consecutive active tiles). All
row-major kernels become

```ts
for (const s of spans) for (let y = s.y0; y < s.y1; y++)
  for (let x = s.x0, i = y * W + x; x < s.x1; x++, i++) { … }
```

So in a dense array (step 1, and step 2 inside a tile page; §6) the index
arithmetic `i±1`, `i±W` stays unchanged. Rebuild the spans only when
the active set changes (daily at most).

**Surface flow** (`flowStep`), the hot one:
1. **Dry-tile sleeping** (already sketched in ARCHITECTURE §3.2). A 16²
   tile sleeps when all of these hold:
   - max depth < `DRY` in the tile and its 1-cell ring;
   - all face fluxes are 0;
   - no inflow cell, no outlet, no wall in it.

   Rain still lands in the soil bucket (soil water already runs per
   cell). A tile wakes when:
   - ponding exceeds `DRY`;
   - a neighbour's face flux into it is non-zero (checked on the tile
     border in phase 3);
   - or a plan, the crew, or a villager changes its terrain.

   The awake set is rebuilt every step from tile flags set by phase 3, as
   a cheap union over the span list.
   - Expected gain: wet 16² tiles are 28–48 % of the map in dry weather,
     so **≈ 2× on flow**.
   - Worst case: rain over the whole active area wakes it all. The budget
     must still hold then (§7).
2. **Per-tile sub-stepping** (local time stepping). Today one deep cell
   forces 2–4 sub-steps on every cell. Instead:
   - each awake tile gets its level `n_t = ceil(DT / stableDt(tile max))`,
     rounded up to a power of two;
   - a tile at level `n` runs `n` sub-steps; face fluxes on a border
     between levels use the finer side's sub-steps, and the coarse side
     takes the accumulated volume (standard conservative LTS).

   Deep tiles are 8–15 %, so this is **≈ 1.5–2×** on top of sleeping.
   Riskier than sleeping (checkerboarding at level borders), so do it
   second and test it with the dam-break and conservation tests.
3. Phase 2 (outflow limiting) and phase 3 (continuity) already loop
   cell-wise; they take the same spans.

**Groundwater** (`groundwaterStep`, hourly) and **talus/erosion** use the
same spans over all active tiles. Erosion and talus can also skip sleeping
tiles *with* no loose soil: dry and stable land changes only by talus,
and that only after a change. **Soil water and weather** already work per
16² tile: they skip inactive tiles. **Vegetation** (daily) loops over
active tiles. **People** stay as they are: they live on revealed land,
which is inside the active set by construction.

**Weather fronts** drift over the whole world as today. Rain over
inactive land feeds the boundary inflow model (§4.2) instead of the grid.

## 4. Boundary conditions at the active edge

### 4.1 Frozen halo (step 1, and the base for all steps)
Halo cells keep their state (terrain, water depth, `ground`, sediment
concentration) from when they stopped being simulated. In step 1 that is
the full-map spin-up state. In steps 2–3 it is the worldgen state after
spin-up (§5.4). The halo is a **Dirichlet stage boundary**:

- Faces between an active and a halo cell are computed with the normal
  formula (halo `η`, `qOld` and so on). The flux is applied **only to the
  active cell**. The difference is booked in the ledger as `inflow` or
  `outflow`, with sediment at the upwind concentration.
- **Water in from the fog:** a river crossing into the active area is
  frozen in its spun-up, flowing state in the halo. The face discharge
  therefore continues the steady discharge, as a stage-discharge
  boundary.
- **Water out into the fog:** the frozen halo does not fill up, so it acts
  as an open outlet. Floods that run off the edge simply leave (and are
  booked).
- **Groundwater:** the same rule — a frozen table and a booked exchange.
  The exchange is small (hourly, conductivity-limited).
- The existing map-edge `Outlet` and `inflow` cells keep working where
  the active area reaches the map edge.
- **Snow:** the halo's snowpack is not frozen. Every cell outside the
  active set still gets snowfall below freezing and degree-day melt by its
  own height (the same rules as active land), so a winter has no edge at
  the active set and newly activated land is already white. The meltwater
  leaves; the net is booked apart as `frozenSnow` (not as precipitation,
  so the climate's winter total is unchanged). Tiles without snow that
  are too warm or dry are skipped.

Why not mark the active edge as `Outlet` cells? Critical-flow drains
would empty rivers that should pass through, and they would pin the bed.
The frozen halo is simpler and keeps the rivers' stage.

### 4.2 Catchment inflow (step 1b, needed from step 2)
A frozen halo gives steady discharge only. With a growing world it is
wrong in two ways:
- floods from rain over the unknown upstream never arrive;
- for fresh land there is no spun-up halo to freeze.

So I propose a **coarse routing model of everything outside the active
set**, on the macro grid (`MACRO_F = 8`, receivers and topological order
already computed by `buildMacro`):

- Per coarse cell, a linear reservoir `S`. Per hour it gets:
  - rain from the weather fronts (`tileRain` evaluated at coarse
    resolution);
  - water leaving the active set through halo faces, booked to the coarse
    cell it lands in;
  - minus evaporation and deep loss (one tuned factor).

  It releases `S/τ` to its macro receiver, with τ from the coarse cell
  size over a typical velocity (≈ 1–3 game hours per coarse cell at our
  K).
- Where a macro `RiverPath` enters the active set (`findCrossings`
  generalised from the window rectangle to the active-tile boundary),
  the routed flow of the path's coarse cell becomes the prescribed
  `inflow` of the first active cell on the path. Sediment uses the
  existing `inflowConc` controller.
- **Baseflow calibration:** the steady part must match today's macro
  discharge for the *inactive* part of the catchment. Recompute the macro
  `acc` with active coarse cells' rain set to 0 whenever the active set
  changes (one pass over the coarse grid, a few ms). Scale it by
  `riverScale` as today, and feed it as a constant base into the
  reservoirs. Storm water is added on top. This avoids double counting:
  rain on active land is simulated explicitly and leaves through the
  halo into the routing.
- **Water that leaves and re-enters** (a meander out and back, a river
  looping round a village) is routed through the coarse cells it crosses
  and comes back at the downstream crossing. The model is conservative
  apart from the explicit sinks.
- **Water leaving for good:** it reaches the macro domain border (step 2)
  or a coarse "sea/sink" cell. It is booked as outflow.

The cost is negligible: about 100k coarse cells hourly.

## 5. Worldgen that stays consistent when tiles are added later

What is already right:
- the base terrain is a pure function of (seed, global cell);
- macro paths are identical between overlapping windows (measured, §1);
- `riverScale` is returned and can be pinned.

What must change:

1. **One macro network per world, not per window.** The macro domain is
   currently `window + 768` per side, priority-flooded from its border.
   The paths agree today only because both windows' domains are large.
   From step 2 on, the world has a **fixed reachable extent**
   (e.g. 4096² cells, 20 km, centred on the start).
   - Build the macro once, over extent + margin, at world creation:
     ≈ 1.7–3 s (container), ≈ 0.5 s desktop. Do this in the worker
     before spin-up, or lazily while the player reads the welcome
     panels.
   - Pin `riverScale` from the start window, as now.
   - The macro is a pure function of the seed, so it is **not saved**.
     A load recomputes it.
2. **Make fine conditioning window-independent.** Today's 0.6–3.8 %
   mismatch comes from the steps that treat the window perimeter as the
   drainage boundary.
   - Replace the perimeter outlets by the macro-filled surface. A fine
     cell drains if its macro coarse cell drains along the macro
     receivers: lake levels for large basins come from the macro
     `filled` field.
   - Run `settleBasins`, `depressions` and `d8Accumulate` only on a
     **generation block** of 128² core + 64-cell apron. They see local
     pits only; anything bigger than the apron is already a macro
     feature.
   - `soils` uses `acc` = macro accumulation (bilinear) + local D8
     accumulation within the block.

   Each block then depends only on (seed, block coordinates, macro),
   never on which neighbours were generated first. That makes generation
   order-independent and deterministic. The acceptance test is the one
   from §1: a block generated alone equals the same block cut from a big
   window (terrain within 1 cm, soil type ≥ 99.5 % equal).
3. **Generated land meets edited land.** Neighbouring blocks are
   generated before anyone touches them: activation runs ahead of
   revealing, and the player can only edit revealed land. So the only
   seam is between a block and its neighbours' *evolved* state
   (erosion, vegetation, water).
   - Never modify existing active cells.
   - New tiles take the evolved neighbour's terrain over a 4-cell blend
     on the new side only.
   - Water equilibrates during spin-up.
4. **Spin-up of fresh tiles.** Activated tiles (and their halo, filled
   from the catchment inflow) run a local spin-up while still inside the
   fog margin.
   - On a 64² region with its own halo, 300 steps take ≈ 0.3 s
     (container, at ≈ 220 ns per cell and step), so they are spread over a few frames in the worker's
     4 ms slices.
   - Determinism: the spin-up result is a pure function of (generated
     state, the step at which it is committed). Generation and spin-up
     may run early (ahead, speculatively), but **commit at a
     deterministic step**: activation is decided in `advance()` at a day
     boundary and committed N steps later. If the work is not ready then,
     the sim waits instead of diverging.

**Truly infinite (step 3):** a fixed macro domain is not infinite. Make
the network hierarchical:
- a continental level (e.g. 1/128 resolution) over a very large domain,
  e.g. 512² coarse = 330 km;
- refine level by level inside each coarse cell, with the inflow and
  outflow points on the cell's edges fixed by the parent level (in the
  style of hierarchical river generation, e.g. Génevaux et al. 2013).

Every level is then a pure function of its parent cell and its
neighbours. I recommend not building this before players actually reach
a 20 km extent. At the measured founding pace that takes hundreds of game
years.

## 6. Storage (memory) for a growing world

- **Step 1:** dense arrays as today. Only the work is sparse.
- **Step 2: tile pages.**
  - Keep the dense layout per **page of 256² cells** (16×16 sim tiles),
    allocated on first activation. A page table maps global page
    coordinates to pages.
  - Kernels run per page with a 1-cell ghost ring copied from neighbour
    pages before each phase that reads across cells. That is about 2 %
    extra work for 256² pages, and the kernel bodies stay as they are.
  - Scratch arrays are per worker thread and page-sized, not
    world-sized. That cuts the 88 B/cell scratch to almost nothing for
    big worlds.
  - Alternative (simpler, more memory): one dense *bounding rectangle*
    that is reallocated and copied when it grows. Fine while the revealed
    land stays compact, wasteful when villages spread along a valley.
    Pages are the better long-term choice. The rectangle is an
    acceptable shortcut while the cap is ≤ 1024².
- **Per-cell budget**, all-in (sim + snapshot + main thread + GPU):
  ≈ 260 B/cell today.

  | active cells | ≈ memory | what |
  |---|---|---|
  | 65k (256²) | 17 MB | today |
  | 262k (512²) | 68 MB | phone cap |
  | 1M (1024²) | 260 MB | desktop cap |

  Cheap reductions if needed:
  - `plan` and `inflow` become sparse maps (they are almost all NaN or 0):
    −8 B;
  - `velX`/`velY` are derived, so they can be per-page scratch: −8 B;
  - f16 for `snow`, `fertility`, `vegetation` and `flowAvg`: −8 B.

## 7. CPU budget

Per active cell and step: ≈ 220 ns all-in today (container: 14.6 ms /
65k cells). That is ≈ 45 ns on desktop.

| | without sleeping/LTS | with sleeping + LTS (≈ 3×) |
|---|---|---|
| desktop, 1M cells | ≈ 45 ms/step → 22 steps/s (just 1×) | ≈ 15 ms → 3× speed |
| desktop, 256k cells | ≈ 11 ms → 4× | ≈ 4 ms → 10× |
| phone, 256k cells (assume ≈ 2× desktop cost, 45 % duty) | ≈ 50 ms → < 1× | ≈ 17 ms → 1× |

So the caps are **1M active cells on desktop** and **256k on a phone**
(128k on a low tier). Two conditions:
- rain over everything wakes all tiles, and the game then slows to
  ≈ 1× rather than below;
- people must stay cheap: the agent count grows with population, by
  estimate roughly 1 villager per 300–500 revealed cells, so ≈ 2–3k villagers at 1M
  cells.

Agent cost needs its own bench before step 2: path searches on a large
grid (`people/path.ts`) are per-cell arrays sized to the world and must
become windowed around the village.

The **snapshot/render** budget becomes the limit before the sim does:
- a full f32 depth array at 1M cells is 4 MB per snapshot. At 10 Hz that
  is 40 MB/s of texture upload, fine on desktop, not on a phone;
- so send only **awake 16² tiles** (≈ 40 %), quantised to u16
  (1 mm steps up to 65 m);
- send velocity only for awake tiles;
- render water chunks only where the camera is.

## 8. Rendering: chunk streaming

What exists: 64² chunk meshes drawn from global R32F/RGBA8 textures
(`render/grid.ts`, `terrain.ts`, `water.ts`), and fog rendering by the
revealed texture.

- **Step 1:** nothing changes (same textures and map size). Optional:
  skip uploading depth rows that are entirely asleep.
- **Step 2:**
  - Replace the single full-map textures by **texture pages** of 256²:
    a `TEXTURE_2D_ARRAY` per field (terrain R32F, depth R16/R32F ×2,
    vel RG8, look RGBA8, fields RGBA8, lining/revealed R8).
  - Use a small page-table texture (global page → layer). The chunk
    vertex shader already recovers the chunk origin from `modelMatrix`;
    it adds a layer lookup.
  - Edge vertices read the neighbour page through the page table
    (`texelFetch` with integer coordinates, no filtering needed).
  - Chunk meshes exist only for revealed pages plus a ring of cloud-sea
    pages around them (which can use a coarser stride).
  - Snapshots carry `{page, rows}` updates instead of full arrays.
  - `HeightSampler`/picking and flow particles read through the same
    page table on the CPU.
  - Camera bounds: the revealed bounding box, as today.
  - Float precision: global coordinates up to ±10⁴ cells are fine in
    f32. Beyond that (step 3), rebase the three.js origin to the camera's
    page.
- The fog look stays exactly as it is. The cloud sea is drawn over
  unrevealed pages near the frontier. Beyond those there is nothing to
  draw: the cloud sea just continues as a flat haze plane to the horizon
  (a single large quad), so there is **no visible map edge**. The
  current diorama skirt (`uSkirtY`) goes away in fog games.

## 9. Limiting growth without a visible border

Two natural limits already exist:
- **the founding pace** (≤ 1 village per game year, worldwide);
- **reveal saturation** (`R = 56 + 5√pop`, sub-linear in population).

Area therefore grows roughly linearly in game time, not exponentially. On
top of that, an **active-cell budget** `B` (by device tier: 1M desktop,
256k phone):

1. **Founding steering.** Multiply the founding score by a factor that
   falls off with how much of the remaining budget the new disc would
   use:
   - score × `clamp((B − A − a_new) / (0.2·B), 0, 1)`, where `A` is the
     active cells now and `a_new` the disc's new cells;
   - plus a mild preference for sites near the existing land:
     × `exp(−d/(4R))` with `d` the distance to the nearest village.

   Near the cap, villages are founded only in gaps inside the known land.
   At the cap, migrants **join existing villages** (densification) or
   don't come. This uses existing mechanics: free houses, arrival rate.
2. **Reveal saturation near the cap.** When `A > 0.9·B`, `revealRadius`
   stops growing. Settlements keep growing in population, not in area.
   Players can still extend the land locally with their own works (a
   small budget for "land you build on is land you know").
3. **No border, only clouds.** The frontier is the same soft cloud edge
   as today, and it just stops moving. Nothing in the UI says "map edge".
   The achievement and stat pacing (DESIGN §4a) should reward density
   (prosperity, irrigated plains) more than area as the game matures.

The budget should count *active* cells (revealed + margin + pending),
because that is what costs. Step 3 relaxes it by making far revealed land
dormant (§10).

## 10. Staged plan

### Step 1 — sparse simulation in the fixed map (≈ 1 agent-week)
- Active-tile bitmap and span list; revealed + 32-cell margin; worlds
  without fog have every tile active.
- Frozen-halo boundary (§4.1) with ledger booking. The conservation
  tests keep passing with the new ledger terms.
- Spans in `flowStep`, `groundwaterStep`, `erosionStep`, `talusStep`,
  `weatherStep`, soil water and vegetation.
- Dry 16² tile sleeping in `flowStep`.
- Founding pre-activation and the gradual reveal of a founded disc.
- Adaptive halo activation (backwater).
- Bench a 512² default: early game ≈ 10–20 % active. Make 512² the
  desktop default once the tier logic exists. The phone stays at 256².
- Tests:
  - masked and unmasked runs agree inside the revealed area for a day
    (within tolerance);
  - conservation with the halo terms;
  - determinism;
  - a dam backing up into the fog activates tiles.
- **Risks:**
  - The halo's frozen state is from the spin-up. After decades it differs
    from the evolved interior (erosion lowers a bed and creates a step at
    the halo). Mitigation: the margin hides it, and adaptive activation
    catches large ones.
  - Global quantities (`History` area for precipitation, achievement
    baselines, `waterDist` and the fish blocks) must count active cells
    only.

### Step 1b — catchment inflow (≈ 3–4 days)
- The coarse routing model (§4.2) replaces the halo's frozen discharge
  for macro rivers. Storm waves arrive from beyond the fog.
- **Risk:** calibration of τ and of the baseflow against today's look;
  rivers must not visibly pulse at the fog edge.

### Step 2 — growable world up to a fixed extent (≈ 3–4 agent-weeks)
Changes to shared contracts (`world.ts`, `protocol.ts`, `coords.ts`) are
done by the lead first, per CLAUDE.md.
- One macro network per world over a fixed reachable extent
  (e.g. 4096² = 20 km).
- Order-independent generation blocks (§5.2) with the seam test.
- Tile pages in the sim (§6), ghost rings, per-page scratch.
- Activation and spin-up of fresh tiles with deterministic commit (§5.4).
- Chunked saves (below), page-based snapshots, texture pages and chunk
  streaming in the renderer (§8), the haze plane to the horizon.
- The soft cap (§9) with device tiers.
- Windowed per-village path and attractiveness arrays (`people/*`,
  `surveyLand` over the active pages only).
- Optional: per-tile local time stepping (§3) if the bench needs it.
- **Risks:**
  - big surface area for the protocol and renderer;
  - save migration from dense saves;
  - spin-up hitching on phones;
  - founding that "stalls" when the budget is near;
  - memory spikes when many pages activate at once (cap activations per
    day).

### Step 3 — unbounded (only when needed)
- Hierarchical macro drainage (§5).
- Level-of-detail sleeping of revealed land far from the player's
  activity:
  - its hydrology freezes to its current state; frozen water still looks
    like flowing water, because flow particles read the frozen velocity;
  - its villages switch to the hidden economy without agents (food from
    the cells' last yields);
  - it wakes when the camera or a plan comes near.

  Then the active budget stays at 1M while the revealed land can exceed
  it.
- Origin rebasing for float precision.
- **Risks:**
  - dormant land visibly not reacting to weather (a front over a frozen
    region);
  - correctness of the frozen ↔ live hand-over over years.

### Persistence of a growing world (step 2)
- Save per **256² page**, only for pages that were ever activated. Page
  header: its global coordinates. Fields as today, matched by name.
- **Delta against regeneration:**
  - `bedrock`, `soil`, `soilType`, `fertility`: XOR the f32 bits with the
    regenerated worldgen value. Unchanged cells become 0, so gzip shrinks
    them to almost nothing.
  - `water`, `ground` and `sediment` as u16 or f16 quantised. They
    re-equilibrate within a minute of play anyway.
  - Derived fields are not saved: `velX`/`velY`, `flowAvg` (it rebuilds),
    the scratch arrays.
  - Expected ≈ 8–12 B/cell instead of 21.5, so 1M active cells ≈
    10 MB.
- Regenerating the baseline on load costs worldgen time: ≈ 3 s per 1M
  cells on desktop. To avoid that, also store the raw pages and skip the
  delta. That is a size/speed choice, decided by measuring.
- IndexedDB: one record per page, so autosave writes only dirty pages.
- Dense step-1 saves load as one page grid (migration).

## 11. Reproducing the measurements

I ran these as throw-away `tsx` scripts importing `src/sim/*` directly
(seeds 7, 11, 42):
- Generate with `generateWorld({seed, size})`, make a `Simulation` with
  people at the start point, `run(600)`.
- Time `advance()`, and separately `flowStep`, `groundwaterStep`,
  `erosionStep`, `talusStep` and `vegetation.daily` on that world. Also
  profile with `node --cpu-prof --import tsx`.
- Masked kernel: a copy of `flowStep` whose three phases loop over
  per-row spans `[sx0[y], sx1[y])` of a centred disc.
- Sub-steps: `ceil(DT / stableDt(maxDepth, maxSpeed))` after the
  spin-up. Wet/deep tile counts at 16/32/64.
- Memory: `process.memoryUsage().arrayBuffers` around `new World` and
  `new Simulation` (`--expose-gc`).
- Seams: `generateWorldDebug` for 512² at the origin vs a 256² core at
  (256, 0) with a 32/64/128 apron and a pinned `riverScale`. Compare
  terrain, soil type, wet/dry and macro path vertices.
- Macro cost: `buildMacro` with domains of 2048², 4096² and 8192².

Once step 1 starts, the masked-kernel case belongs in `src/sim/bench.ts`
(a "flow kernel, 25 % active" line). That keeps the per-active-cell cost
visible on the phone bench page too.

## 12. Step 1 as built

**What runs where.** `sim/active.ts` holds the `ActiveSet`: a tile mask,
its runs per tile row (`spans`), the same dilated by one tile (`haloSpans`,
active + halo) and row segments of active cells (`rows`, row-major).
- With the fog, `Simulation.active` is the tiles with any `revealed > 0`,
  dilated by 2 tiles (32 cells, a square). Without fog (scenes, tests
  without villages) every tile is active.
- It is **derived state**: recomputed from `revealed` and `fog` at every day
  boundary (right after `updateReveal`, the only place `revealed` grows),
  on construction and on load. A load mid-day therefore gets the same
  mask, and nothing is saved.
- Every per-cell kernel takes the set: `flowStep`, `groundwaterStep`,
  `erosionStep` (+ bed slope, bank erosion, point bars), `talusStep`,
  `weatherStep` (+ loose-soil settling), `soilWaterStep` (per tile) and
  `Vegetation.daily`. Called without a set they run on every tile, exactly
  as before. People, structures and the weather fronts are unchanged.
- The worker's spin-up runs **unmasked** (`Simulation.spinUp`), so the
  frozen land holds flowing rivers and settled water.

**Frozen halo (§4.1).** Cells outside the set keep their state. In
`flowStep` the faces between an active and a frozen cell are computed with
the normal formula; the frozen side has no outflow limit (it is a
reservoir) and its sediment concentration is taken once when the set
changes. The flux changes only the active cell. The volume and sediment
are returned as `edgeIn/edgeOut/edgeSedIn/edgeSedOut` and booked in the
ledgers' `inflow`/`outflow` (`outflowToday` includes the edge outflow).
Groundwater does the same with a fixed water table (`edgeIn/edgeOut` on the
scratch). Erosion, bank erosion, bars, bed slope and talus never write a
frozen cell. Rain on frozen land is not simulated (not booked either), and
the history's precipitation area is the active area.

**Dry-tile sleeping (§3.1), exact.** At the start of each `flowStep` call
the kernel scans which active and halo tiles hold any water (`> 0`) and in
which edge rows/columns. An active tile is awake if it holds water or a
face-neighbouring cell in an adjacent tile does. A sleeping tile's faces
are dry on both sides, so the full kernel would set them to 0 and change
nothing else. Its faces and velocities are cleared once when it falls
asleep. The result is therefore **bit-identical** to running every tile
(tested), so it is always on, also without fog, and needs no wake-up
rules for rain, inflows or works: any water wakes the tile on the next
call. I chose "any water" over the proposed `DRY` threshold because the
threshold changes the physics (films would have to be removed with
booking): exact zero sleeps 38 % of tiles in a 256² game against 49 % for
`DRY`, so the exact rule gives up little.

**Not done in step 1:**
- Per-tile sub-stepping (§3.2): not simple with the θ-weighted faces and
  the halo; the gain is smaller now that most time is in the awake wet
  tiles. Left for later.
- Founding pre-activation and adaptive halo activation (§2): the active
  set grows at the day boundary when a new village's disc is revealed. A
  dam backing up past the margin just spills into the frozen land (booked
  as outflow).
- Newly activated land starts from its frozen state, which is the
  spun-up state of the game's start (or of when it was last active). That
  is plausible: rivers flow, ponds are settled, groundwater is moist. It
  lacks the seasons since (snow, dry summer soil), which the 32-cell
  margin hides while it catches up within a few game days. So there is no
  local spin-up.

**Measurements** (container, loaded by other agents, interleaved runs;
`tools/benchgame.ts`: seed 7, worker spin-up, then 600 game steps):

| | before | after | active tiles | awake (of all) |
|---|---|---|---|---|
| 256², start of a game | 12.2–12.6 ms | 2.6–2.7 ms | 32 % | — |
| 512², start of a game | 47.5–49.1 ms | 4.8–4.9 ms | 16 % | — |
| 512², known land r = 154 cells (≈ 4 villages) | 48.0 ms | 13.8 ms | 51 % | 25 % |
| 256², no fog (sleeping only) | 12.6 ms | 11.3 ms | 100 % | 72 % |

`npm run bench` (synthetic all-wet world, all tiles awake) is unchanged
within noise; its new lines time the kernel on 25 % of the tiles and on a
half-dry world.

**512² proposal.** A 512² game now costs about 5 ms/step at the start and
≈ 14 ms with four villages' worth of known land (container), ≈ 1–3 ms on a
desktop. That is well within budget for 1–3× speed. Rain over all the known
land wakes every active tile, which at 51 % active is still ≈ 25 ms
(container). So I propose 512² as the desktop default. Before switching:
- The worker's spin-up runs on the whole map: 600 steps × 48 ms ≈ 29 s in
  the container (≈ 6 s desktop) at 512². Spin up only the active set plus a
  wider ring (say 128 cells), and spin up further land in the background
  or accept its worldgen state.
- Measure the main thread (4× the texture uploads and chunk meshes) and the
  snapshot size; ENDLESS §7 expects that to limit first.
- Add the device tier logic (phones stay at 256²).
