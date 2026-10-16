# Hydro — People, Settlements & Living Land (design for M2–M3)

*Draft for review.* Complements DESIGN.md §3 and ARCHITECTURE.md.

## 1. Goals

- Little people make visible, legible use of whatever the player shaped:
  fields appear on irrigated flats, fishers line a calm reservoir, herds graze
  wet meadows, houses avoid the floodplain (until people forget).
- No direct control. The only levers are the land and the plans.
- Bustle: at any zoom where people are visible, many are doing something
  recognisable (walking with a load, hoeing, fishing, chopping, building).
- **Stationary:** a settlement grows to the carrying capacity of its land and
  then fluctuates around it. Disturbances (flood, drought) cause setbacks and
  recovery. Population never explodes or silently dies out without cause.
- Cheap: ≤ ~400 simulated people on a 256² map at < 1 ms per sim tick on a
  phone. Rendering ≤ ~150 animated people visible at once.

## 2. Model overview

```
 land (per cell)          settlement (aggregate)            people (agents)
 ───────────────          ──────────────────────            ───────────────
 vegetation, crops   ──▶  food/wood/stone stocks     ◀──▶   jobs & tasks
 fertility, moisture      wellbeing, population             walk, carry, work
 landuse, owner           demand for land/jobs              animation states
 fish stock (water)       migration in/out
```

Two layers of simulation:

1. **Aggregate (hidden economy).** Per settlement: stocks, production rates,
   consumption, wellbeing, births/deaths/migration. This is what keeps the
   system stationary and is cheap and testable.
2. **Agents (what you see).** People carry out the work implied by the
   aggregate: a farmer walks to a field and hoes; the harvest increments the
   stock when the work is done. Agents are the *mechanism* of production, so
   distance, slopes and floods matter. But the agent layer can be thinned
   out (one visible agent stands for one worker; tasks are coarse-grained).

## 3. Land

### 3.1 Vegetation (M2)
Per-cell `vegetation` (0..1 biomass) plus `vegType` (grass, shrub, forest,
reed). Daily update (cheap, once per game day, vectorised):
- Growth ∝ suitability(moisture, fertility, temperature, slope, depth) ×
  (1 − v). Decline when unsuitable (drought, waterlogging, snow, grazing,
  cutting).
- Forest spreads only from forest neighbours (slow, seed-dispersal). Grass
  colonises bare ground quickly. Reeds on shallow wet margins.
- Effects: vegetation raises infiltration, lowers erosion (×(1−0.8v)) and
  raises Manning roughness. Forests transpire (soil moisture sink).
- Stationarity: growth/decline balance; slow natural disturbance (windthrow,
  occasional fire in dry summers) keeps forests from monopolising.

### 3.2 Land use & ownership (M3)
New fields: `landuse` (u8: none, field, pasture, path, building, yard),
`crop` (growth stage 0..1), `owner` (u16 settlement id), `traffic`
(decaying footfall counter, forms desire paths).
- **Fields:** crop grows in the growing season when moisture is in range
  (too dry → stress, waterlogged/flooded → loss). Ploughing compacts the soil
  (lower infiltration, more runoff) and slowly depletes fertility. Flood silt
  restores it. Fallow fields recover.
- **Pasture:** grass consumed by herds. Overgrazing lowers vegetation, which
  increases erosion.
- **Paths:** cells with high traffic become paths (faster walking, slight
  runoff).
- **Fish:** per-cell `fish` density in water: grows in calm, not-too-shallow,
  clean water, spreads with flow, and is depleted by fishing.

## 4. Settlements and the hidden economy

Settlement = cluster of households sharing a centre (store, well/landing).
State per settlement:

| | |
|---|---|
| `population`, households | integer people, grouped 2–5 per house |
| stocks | food, wood, stone (capped by storage) |
| `wellbeing` 0..1 | smoothed from food security, housing, water access, safety, (later) power |
| `floodMemory` | recent flood severity at house sites; decays over ~5 years |
| demand | desired fields, pasture, houses, jobs from population & stocks |

Daily: consumption (food per person), production booked when agents finish
tasks, spoilage (a fraction of stock per day, prevents infinite hoarding).

Yearly (and smoothly in between):
- births ∝ population × f(wellbeing), deaths ∝ population × g(age-free
  constant, raised by hunger/sickness), **immigration** when wellbeing is
  high and land is available, **emigration** when wellbeing is low.
- This is a logistic system whose carrying capacity is set by the land's
  productivity, so it converges to a lively equilibrium.

**Founding:** migrants arrive at the edge of the revealed land when some
reachable site's *attractiveness* is high: flat, fertile, moist but not
flooded, near clean water, near existing settlements (but not crowded).
Attractiveness is a coarse map (per 8×8 block) recomputed every few days.

**Building speed** (player plans and NPC buildings) = builders × wellbeing
factor. Builders take plan cells nearest to their settlement first. Without
people nearby, plans wait (the M1 spirit crew is retired once the first
settlement exists. Before that, the spirit crew remains so the toy still
works).

## 5. Agents

### 5.1 State
Struct-of-arrays in the sim worker: position (f32 x,y), target, path
handle, job, task, task timer, carrying (type, amount), home, settlement,
animation state, rng seed. ≤ 512 agents. Deterministic.

### 5.2 Jobs and tasks
Jobs assigned by the settlement from demand (utility scores, with
hysteresis so people don't flip-flop). Each job is a small state machine of
tasks: `walkTo → work(duration, anim) → carry → deliver`.

| Job | Work site | Visible activity | Effect |
|---|---|---|---|
| farmer | field cells | hoe, sow (spring), tend, harvest (late summer) | crop stage, food |
| herder | pasture | walks with 2–4 cows, cows graze | grazing, food |
| fisher | shore/jetty cell near fish | sits/casts | fish↓, food |
| woodcutter | forest edge | chops (interact anim), carries log | vegetation↓, wood |
| builder | plan cells / construction sites | digs, carries earth, hammers | applyEarthwork, buildings |
| carrier | store ↔ sites | carries goods | logistics flavour |
| (idle) | village | sit, chat, kids play | — |

Seasons drive routines (sowing, harvest, winter woodcutting). There is no
night, but the work rhythm has short breaks so the scene breathes.

### 5.3 Movement
- Grid A* on cells with costs: slope, wading depth (≤ 0.4 m allowed, slow),
  deep water impassable, paths cheaper. Bridges later (M4).
- Shared **flow fields** towards each settlement centre (recomputed when
  terrain/water changes significantly) make the most common trips O(1).
- Paths are cached and invalidated when water floods them; agents re-plan.
- Agents move continuously between cell centres. The renderer interpolates.

### 5.4 Flood behaviour
Rising water near houses → people flee to higher ground (visible!), crops
lost, `floodMemory` rises → no new houses there for a while; maybe a
self-built little dike (M4: NPCs build their own small works).

## 6. Fog of war & progression (M3)
- `revealed` per cell. Initially a radius (~40 cells) around the start;
  every settlement reveals a radius growing with its population; reveal is
  permanent. Unrevealed land is not drawn (soft cloud edge).
- Tool unlocks by total population milestones (weir, lining, sluice → M4).

## 7. Protocol & rendering
- Snapshot adds an **entity list** for agents and herd animals in (or near)
  the camera view: `id, kind, x, y, heading, anim, carry`, packed in typed
  arrays (≈ 16 bytes/agent). The camera's view rectangle is sent to the
  worker so it only sends visible agents (plus a margin).
- Buildings: a separate, rarely changing list (`id, kind, x, y, rot,
  stage`). The renderer instantiates Kenney houses/mill/fences as
  InstancedMeshes. Construction stages show scaffolding/partial.
- Fields: rendered by the terrain shader from a `landuse/crop` texture
  (furrows, crop colour by stage) plus instanced crop models when zoomed in.
- Characters: skinned meshes up to ~60 near the camera, rigid "bobbing"
  instanced versions beyond (LOD). The existing WandererLayer becomes the
  renderer for sim agents.

## 8. Testing
- Economy unit tests: logistic convergence; recovery after an imposed
  disaster; no negative stocks.
- Scenario tests: irrigate a dry plain ⇒ fields appear within N years; a
  flood ⇒ houses not rebuilt in the floodplain for M years; overgrazing ⇒
  erosion increases.
- Long-run stationarity: 30 game years on 3 seeds ⇒ population settles
  (coefficient of variation in the last 10 years below a bound), no
  extinction without a cause.
- Perf: agent tick ≤ 1 ms for 400 agents (Node bench).

## 9. Implementation phases
1. **M2a Vegetation dynamics** (sim) + vegetation feedback into hydrology
   and erosion; renderer already follows `look`.
2. **M3a Settlement aggregate + land use** (sim, no agents): fields and
   pastures appear and disappear as coloured cells, population curve in
   ?stats. This tunes the economy for stationarity first.
3. **M3b Agents + movement + tasks** (sim) with entity snapshots.
4. **M3c Rendering of buildings, fields, people**; retire the spirit crew;
   fog of war.
5. **M3d Founding/migration, flood memory, unlocks.**
