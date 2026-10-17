# Hydro — People, Settlements & Living Land (design for M2–M3)

*Revised after internal review #2.* Complements DESIGN.md §3 and
ARCHITECTURE.md.

## 1. Goals

- Little people make visible, legible use of whatever the player shaped:
  fields appear on irrigated flats, fishers line a calm reservoir, herds graze
  wet meadows, houses avoid the floodplain (until people forget).
- No direct control. The only levers are the land and the plans.
- **Watch and learn:** the hidden economy is shown through props and
  behaviour, never through text (see §7).
- Bustle: wherever people are visible, many are doing something
  recognisable (walking with a load, hoeing, fishing, building).
- **Stationary:** a settlement grows to what its land supports and then
  fluctuates around it. Disturbances cause setbacks and recovery, never
  extinction without cause.
- Cheap: ≤ 400 people on a 256² map, agent tick < 1 ms; one draw call per
  character model.

## 2. The contract: "land grows it, people collect it"

Each quantity has exactly one owner, so the visible agents and the hidden
economy cannot diverge:

| Owner | Owns |
|---|---|
| **Cells** (land) | standing crop biomass, pasture grass, fish stock (per 8×8 block of calm water). These grow from moisture, fertility and season only. |
| **Agents** | realisation: food enters the store only when an agent completes a task, `harvested = min(standing, work capacity)`. Uncollected crop rots. Walking distance, wading, floods and slopes therefore cut income for real. |
| **Settlement** (aggregate) | decisions and demography only: job quotas, wellbeing, migration, house siting. It never books production itself. |

- **One person = one agent** (no "one agent stands for k").
- Every task has a timeout. A failed task (unreachable, flooded path) marks
  the site `blockedUntil = day + 3`, so the settlement re-plans.
- Invariant test: over a year in a fixed scenario, booked food is within
  ±15% of Σ(yield × labour share) over farmed cells.

## 3. Land

### 3.1 Moisture for fields (prerequisite)
Today a cell's moisture is its own soil bucket, so a canal would not wet the
fields beside it. Before villages, **lateral groundwater (M1c)** must exist,
or at least a daily capillary proxy:
`fieldMoisture = max(own, 0.8·exp(−d/2))`, with d the distance in cells to
water (daily distance transform).

Irrigated fields also **draw water**: crop evapotranspiration of about
4 mm/day is taken from the nearest water or groundwater and booked in the
ledger. In a dry spell, rivers below heavily irrigated land visibly shrink.
Too wet is bad too: saturation above 0.9, or standing water over 5 cm for
more than 2 days, drowns crops.

### 3.2 Vegetation (M2, kept simple at first)
First version: grass greenness follows moisture and season; forests are
static apart from being cut. Later: per-cell growth/decline from moisture,
fertility and temperature, slow forest spread, vegetation slowing erosion
and raising infiltration. Fire and windthrow come last, if at all.

### 3.3 Land use (M3)
New world fields:
- `landuse` u8: none, field, garden, pasture, path, building, yard, bridge
- `crop` u8: growth stage plus a health flag
- `floodMemory` u8: set to 255 when depth exceeds 0.3 m; drops by 1 per day
  (≈ 5 years)
- `traffic` u8: decaying footfall; high values become desire paths (late)

Ownership is not stored per cell. It is derived from the nearest settlement
(per 8×8 block).

Effects:
- **Fields:** ploughing compacts soil (more runoff) and slowly depletes
  fertility; flood silt restores it.
- **Roofs and paths:** seal the soil (infiltration ×0.2 and ×0.6).
- **Pasture:** grazing lowers vegetation; overgrazing raises erosion.

## 4. Settlements and the hidden economy

**State per settlement:**
- **Population:** households of 2–5 people.
- **Food:** in person-days. No wood or stone, since building is free.
- **Storage cap:** 1.5 × annual need, shown as a granary that fills up.
- **Wellbeing** `w`, 0..1.

**Food security is measured against the season, not the raw stock:**
`S = F / (P · (daysToNextHarvest + 6))`. Wellbeing reads `min(1, S)` together
with housing, water access and safety, smoothed with τ ≈ 6 days. Several food
sources on different schedules (fish all year except winter, dairy, a quick
garden crop in summer and autumn) flatten the yearly sawtooth.

**Stability rules:**
- Diminishing returns are built in: people farm the best cells first, so
  food per worker *rises* as population falls.
- **Wellbeing never multiplies production or work speed.** That would create
  a hunger → slow work → hunger death spiral. Wellbeing only sets build
  speed, migration and props.
- **Spoilage:** 0.4 %/day.
- **Growth rate:** effective net growth r ≤ 0.5 per game year, counting
  migration. A discrete yearly map converges for r < 1.
- **Migration is the main lever, rate-limited by housing:**
  - families arrive with probability ∝ `max(0, w − 0.6) × freeHouses`;
  - families leave with probability ∝ `max(0, 0.4 − w)`;
  - births and deaths are small, about ±5 %/yr, and children are cosmetic.
- **Recovery floor:** if land is attractive, a trickle of migrants keeps
  arriving, even to an empty site.

**Job quotas:** once a day the settlement computes target worker counts per
job from marginal returns (value of the best unworked site minus travel
cost). It moves at most one person per job per day, and only for a gain
above 15 %.

**Builders** build the village's own houses. The player's plans are realised
by the anonymous crew, quickly and independently of villages (villagers doing
earthworks was tried and felt odd while playing; `PARAMS.villagersBuildPlans`
switches it back on for experiments).

**Founding:** attractiveness per 8×8 block, recomputed every 4 days, from:
- flat, fertile, moist but not flooded land (low floodMemory), not already
  used, little forest;
- nearby water;
- at least 26 cells (`FOUNDING.minSpacing`) from other settlements;
- on known land or at its soft edge (revealed ≥ 64).

The first family arrives within 1–2 game days of a new game. Further
villages (code: `FOUNDING` in `village.ts`): once all villages together
have ≥ 25 people, or one village has ≥ 18 people and no free house, and at
most once per game year, the best block scoring ≥ 0.55 (0..~1.15:
fertility × wetness × flatness, averaged, plus 0.15 near water) gets a
migrant family of 3–5. They walk in with their bundles from the nearest
edge of the fog and found a village there (store + houses, as the first).
Typical natural land scores 0.4–0.55, good river meadows 0.7–0.85, so on
many maps the player attracts new villages by irrigating a dry plain.

Each village runs on its own: land (fields) belongs to the nearest village,
jobs, houses, fishing and migration are per village. Snapshot stats carry
an aggregate (`stats.village`, with `count` and `peak`) and a per-village
list (`stats.villages`).

## 5. Agents

### 5.1 State and tasks
- Struct-of-arrays in the worker: position, path, job, task, timer, carry,
  home, animation and an RNG stream. Agents are updated in id order (10 Hz,
  every 2 steps).
- Agent state is persisted in saves and included in `stateHash()`.
- Jobs are small state machines, `walkTo → work(anim, duration) → carry →
  deliver`:

| Job | Site | Activity | Effect |
|---|---|---|---|
| builder | plan cells, houses | dig, carry earth, hammer | `applyEarthwork`, buildings |
| farmer | field/garden | plough, sow, tend, harvest | crop → food |
| fisher | shore near fish | sit and cast | fish → food |
| herder (later) | pasture | walks with cows | grass → food |
| woodcutter (later) | forest edge | chop, carry | vegetation ↓ |
| idle | village | sit, chat; children play when w > 0.6 | — |

Fields are claimed and ploughed in any season but winter. Grain follows the
year; gardens give green within about one season.

### 5.2 Movement
- Walking speed is about 1.5 cells per real second at 1× (0.075 cells per
  step). People can wade up to 0.4 m deep, slowly; deeper water is
  impassable.
- Pathfinding is bounded A* (a 64×64 window around the settlement, octile
  heuristic), time-sliced to at most 4 searches per tick. Paths are cached
  per (settlement, site).
- Cached paths are invalidated by a per-16×16-tile "water version" that is
  bumped whenever a tile's wet/dry state changes.
- **Footbridges:** when pathfinding repeatedly fails across water at most 3
  cells wide, NPCs build a plank bridge there. It is a `bridge` landuse that
  makes the cell passable, rendered with Kenney planks. Without bridges, a
  player's canal would cut a village off from its fields.

### 5.3 Floods
Rising water near people makes them run uphill. Crops drown,
`floodMemory` marks the area, and nobody builds houses there for years.

## 6. Fog of war & progression (M3-γ)
- `world.revealed` (u8, persisted): a disc of 40 cells around the start
  point, then `R = 56 + 5·√pop` cells around each settlement, updated
  daily, with a 6-cell soft edge and a little noise wobble. Revealed land
  stays revealed. Old saves without it get the start + village discs.
- Plans can only be placed on revealed land (≥ 128): the sim drops plan
  cells elsewhere, the tool preview masks them too. The fog is only on in
  worlds with villages (pure physics tests are unaffected).
- Rendering (`render/fog.ts`): the terrain mesh itself becomes a sea of
  soft, slowly billowing low-poly cloud over unknown land (vertices move to
  the terrain blurred over ~40 cells plus a lift; white/blue haze colour,
  a little self-lit). Water, flow flecks, fish jumps, vegetation, buildings
  and people are not drawn there; water chunks entirely in the fog are
  skipped. Weather clouds still drift over it. The camera pans only over
  known land plus a margin.
- Tools unlock at population milestones (highest total population so far,
  so unlocks are never lost): one table in `src/shared/unlocks.ts`
  (line 15, weir 30, gate 50; others from the start). Locked tools are
  greyed with a lock and say "Unlocks at N villagers".

## 7. Making the hidden economy visible ("watch and learn")
- **Food:** haystacks, sacks in the granary, fish-drying racks. Their number
  (0–6) follows the stock, quantised.
- **Crops:** green → yellow-brown when dry; brown and patchy with puddles
  when drowned; stubble after harvest; weedy when fallow.
- **Prosperity:** above w ≈ 0.6, chimney smoke, laundry lines, flower boxes
  and children playing appear. Below w ≈ 0.3, people idle at the store and
  walk slowly without bounce.
- **Migration:** families walk in from the fog edge with bundles and walk out
  again. Abandoned houses become ruins that stay for years: the visible
  memory of a setback.
- **Building:** the crowd at a plan grows with wellbeing.
- **Water:** carriers walking to the river mean there is no well nearby.
- **Fish:** jumps follow fish density.

## 8. Protocol & rendering
- **Snapshot entities:** every agent and animal, each `id u16, kind/anim u8,
  carry u8, x f32, y f32, vx/vy i8, heading u8`, about 16 B. 400 agents
  come to about 6 KB at 10 Hz. There is no camera culling in the worker.
  The renderer interpolates and extrapolates.
- **Buildings and props:** a rarely changing list (id, kind, x, y, rotation,
  stage).
- **Fields:** drawn by the terrain shader from a landuse/crop texture
  (furrows, crop colour), plus instanced crop models when zoomed in.
- **Characters:** one `InstancedMesh` per model with **baked animation
  textures** (walk, walk-carry, work-swing, sit, run) from the start, plus
  procedural bobbing. Cows go the same way. The current per-character
  SkinnedMesh wanderers do not scale beyond about 60.

## 9. Testing
- Economy: convergence; no limit cycle of period ≥ 2 years with amplitude
  above 15 %; after a flood that removes 50 % of people, recovery to within
  10 % in 3–8 years; no flip-flopping between sites over 30 years on 3
  seeds; no negative stocks.
- Contract invariant (§2).
- Scenarios: irrigate a dry plain → fields within a season or two; canal
  between village and fields → bridge; flood → no houses rebuilt there for
  years.
- Perf: 400 agents < 1 ms per tick (Node bench).

## 10. Phases
- **Prerequisite:** lateral groundwater (M1c), or the capillary proxy plus
  field water draw (§3.1).
- **M3-α "First village":**
  - a founding family arrives;
  - builders replace the spirit crew;
  - houses, farmers, fields and gardens, granary stockpile props;
  - footbridges;
  - baked-animation characters.
  - The economy is tuned in headless tests along the way.
- **M3-β:** fishers (reservoirs reward the player), flood flight and flood
  memory, ruins.
- **M3-γ:** fog of war, more settlements founded, tool unlocks.
- **M3-δ:** herders with cows, woodcutters, desire paths, vegetation
  dynamics (M2).
- **Later:** the pollution tracer (sewage) rides on the same upwind fluxes as
  sediment (reserve a slot in the flow kernel); NPCs dig their own furrows
  and check dams (M4); power (M6).
