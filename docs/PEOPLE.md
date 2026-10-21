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
`fieldMoisture = max(0.6·own, 0.8·exp(−d/2.5))`, with d the distance in
cells to water (daily distance transform; `CAPILLARY` in `village.ts`). The
own soil counts at 0.6 (GAMEPLAY §4.1: at full weight 60 % of the land was
farmable without any water work), so where the water is decides what grows.
Crops grow fully from moisture 0.46, not at all below 0.22 (`CROP_MOISTURE`;
was 0.4/0.2 before playtest round 2), and villagers claim land only where
crops would grow at least half as well today (`FARMING.minGrowth`). A crop
grows 11 stages a day at full growth (`FARMING.growPerDay`, was 16), so a
field sown early in spring only just ripens by late summer if it never
lacked water: dry spells cost yield. Ripe crops (≥ 230) are harvested any
time; in autumn the farmers bring in whatever stands (≥ 40) at its share of
a full yield (`FARMING.lateHarvest`). A field gives 10 person-days per full
harvest (× fertility; `FARMING.yield`, was 8) and a farmer keeps 28 fields
(was 14): a village is bounded by the watered land around it (§4), not by
its hands. Water in the player's canals and in field ditches wets the land
a little further than a river (`CAPILLARY.canalReach` 4 cells, rivers 2.5).

**Field ditches** (`people/ditches.ts`, playtest round 2): once the
player's canal carries water within a village's field radius, farmers dig
small ditches off it into the dry land beside it, one every couple of days
up to 1 + population/6 (at most 12): a straight line of up to 10 cells, one
cell wide, cut through the canal's bank, its floor 0.12 m below the canal's
water and at most 0.9 m below ground, only where the ground stands above
the canal's water (it would spill otherwise) and only where at least 8 dry
field or fertile cells lie within 2 cells. Farmers spend about a third of
their task choices on it while one is open, 0.35 m per visit, and wait for
the harvest before cutting through a standing crop. The water sim fills the
ditch; the land beside it greens like any canal bank.

**Hardy crops and pegged plots** (`HARDY`, `PEGS` in `people/village.ts`;
the "watch and learn" cue for short of land / land to spare, §7). Daily,
in `manageFields`, a village first claims good land (as above) up to its
farmers' 28 fields each; hardy fields never stand in its way, and bare
hardy fields are given up when good land is claimed beyond the hands.
- **Shortage → hardy crops.** When no good land is left within reach, the
  village has more hands than fields and not food enough to grow (plenty
  below `ECONOMY.enough` + 0.2; round 6), farmers sow
  marginal land too, at most 2 cells a day and at most 2 + ¼ × its
  ordinary fields (gentle): **millet** on dry land (grows from moisture
  0.1, fully from 0.3; 40 % of an ordinary harvest) and small **rice
  paddies** in shallow, still standing water (2–25 cm, slower than
  0.1 m/s, not a canal; grows fully in the water, drowns above 0.4 m; 45 %).
  A paddy is not given up for standing in water at sowing.
- **Improvement → back to the ordinary crop.** A hardy field whose land
  now grows the ordinary crop well (cropGrowth ≥ 0.85, above the claiming
  threshold, so a wet spring alone does not do it: it takes a canal or
  drainage) is sown with it at the next sowing; a young hardy crop (stage
  < 80) is ploughed under and resown while sowing is still possible, so
  the upgrade shows within a season. A paddy that ran dry becomes millet,
  millet land under shallow still water a paddy.
- **Surplus → pegged plots.** While the village has at least as many
  ordinary fields as hands and good land is left over, its best 6
  unclaimed good cells (the next it would claim) are staked out
  (`SettlementState.pegs`): not ploughed, gone when the surplus is. When a
  farmer comes, they are the first new fields.
- Neither: ordinary crops edge to edge, no pegs.
- Saved: `PeopleState.hardy` ([cell, kind] pairs) and
  `SettlementState.pegs`; older saves load with none. Sent as the fourth
  byte of `Snapshot.fields` (`FieldCrop`: Common, Millet, Paddy, Pegged).
- Rendered (`render/village/fields.ts`, `crops.ts`, `plots.ts`, water.ts):
  millet as short, sparse, gappy rows on pale sandy soil, olive green
  ripening to bronze (wheat turns gold), with small sparse ear models;
  paddies as basins between grassy earth bunds (one per 2×2 cells) under
  clear, still water (no shore foam), rice in clumps on a 4×4 grid per
  cell, as shader dots and tuft models, yellowing when ripe; pegged plots
  as a paler meadow with a string along the plot's outline and wooden
  pegs at its corners (one merged mesh, shown below view height 70; the
  shader draws the string and peg spots at any zoom). Review:
  `npx tsx tools/shot-crops.ts make` then `shoot` (all four side by side
  by a real village, four seasons, close/desktop/phone).

Irrigated fields also **draw water**: crop evapotranspiration of about
4 mm/day is taken from the nearest water or groundwater and booked in the
ledger. In a dry spell, rivers below heavily irrigated land visibly shrink.
Too wet is bad too: saturation above 0.9 slows crops to 0.4; standing
water over 5 cm slows them to 0.4 as well (a spilling canal, a wet spring),
and water over 15 cm drowns them (`CROP_MOISTURE.drown`). Fields that stand
in water when they should be sown are given up, and the village claims dry
land elsewhere. The player's earth brushes leave fields alone unless they
make the ground too steep to farm (DESIGN.md §4, `FIELD_MAX_SLOPE`).

**Clearing snow before sowing** (`SNOW_CLEARING` in `people/village.ts`).
A field cell due for sowing under more than 1.5 mm of snow water (thinner
snow is patchy and sown straight into) is first shovelled clear: a work
step a little longer than sowing (`SiteKind.ClearSnow`, the shovel swing
`EntityAnim.Shovel`) that clears a short strip, the cell and the next
unsown field cell on either side, then the cells are sown as usual. Half the
snow (`bank`) is thrown onto the nearest cells beyond the field (open land
or pasture, dry, no structure) within 3 cells, a low bank along the field's
edge: a bank cell holds at most 2.5 cm of water more than the cleared cell
had (`pile`), so the banks melt a day or two after the snow around them
instead of lingering as heaps; the other half, what does not fit, and the
snow deep inside a large field, is trodden in and soaks into the soil (any
excess stays on top). A bank standing in more than 3 cm of water
(`flooded`) melts into it within hours (`floodMelt`, 10 cm water a day).
The people remember the bank cells (`PeopleSystem.snowBanks`, saved); the
renderer (`render/village/snowPiles.ts`, from `Snapshot.snowPiles`, which
leaves flooded banks out) groups adjacent bank cells into one bank and
draws it as a few low, broad, overlapping snow mounds strung along it
(instanced; white with a cool blue shade, a little grey at the foot, sunk
slightly into the ground), sized by the snow held above the snow around,
shrinking as they melt; banks with little snow are not drawn. The ground
under a bank shows only the snow around it. No water is made or lost. Snow falling on a sown field is
left alone. Under snow, fields stay readable at every zoom (terrain
shader, `fieldSnow` in `render/village/fields.ts`): the snow is ribbed by
the furrows, the outline shows as a shaded seam at least a pixel wide,
and clods, stubble or crop rows poke through thin snow; at a distance this
averages to a greyer, ribbed white. Review: `tools/shot-crops.ts` (winter
and thaw scenes, far view).

### 3.2 Vegetation (M3-δ, `sim/vegetation.ts`)
Once a game day every cell's `vegetation` (0..1) moves towards what the
land supports. One number carries both layers:
- **Grass** up to `grassCap` = 0.55·(0.3 + 0.5·moisture)·soil share
  (≈ 0.17–0.44; rock and sand carry little). Bare ground is colonised
  quickly in the growing season (12 % of the gap per day); drought browns
  and thins it (5 %/day of the excess), never quite to bare earth.
- **Forest** above it, up to `cap` = grass + 0.7·suitability·patch:
  moist (saturation 0.18 → 0.45), gentle slopes rather than open flats or
  steep ones, not waterlogged soil, inside
  the world's forest patches (the same low-frequency noise worldgen used
  for the initial forests, so stands keep to their places). Forest grows
  only where a forested cell (≥ 0.55) is at hand, the cell itself or a
  neighbour, at 2.5 % of the gap per growing day: cleared land is won back
  from the edges, about two cells a year. Drought thins it slowly (0.8 %
  of the excess per day).
- Growth follows the daily mean temperature (none below 3 °C, full from
  14 °C) and stops under snow; standing water deeper than 10 cm drowns
  plants. Now and then wind throws an old tree (0.4 % of forest cells a
  year, a hash per cell and day): small clearings that grow back, so the
  woods stay alive rather than frozen.
- Used land caps it: paths 0.12, yards 0.25, buildings 0.1, lining 0.05;
  fields and gardens belong to the crops.
- **Feedbacks** (moderate): infiltration ×(1 + 0.4·v)
  (`PARAMS.vegetationInfiltration`), erosion pickup ×(1 − 0.6·v)
  (`vegetationHold`). Grazing and woodcutting lower it, so overgrazed or
  cut land erodes more.
- **Stationary:** on seed 3 (128², full simulation) forest cover goes
  from 13.5 % to about 11.5 % in the first dry year, then fills the patches
  the land supports and levels off around 16 % after ten years (more with
  wetter soils); the test runs 20 years of the daily step on spun-up land
  (`tests/sim/life.test.ts`, `HYDRO_LONG=1` for the full simulation;
  `npx tsx tools/vegetation-run.ts --seed 3 --years 20` prints yearly cover
  and writes maps). Fire is not modelled.

### 3.3 Land use (M3)
New world fields:
- `landuse` u8: none, field, garden, pasture, path, building, yard, bridge
- `crop` u8: growth stage plus a health flag
- `floodMemory` u8: set to 255 when depth exceeds 0.3 m on used land; drops
  by 1 per day (≈ 4 years), and by `FLOOD_FORGET` (120) more on the last day
  of a spring in which the cell stayed dry: one dry spring behind a new dike
  frees the land for the next year (docs/GAMEPLAY.md §4.3 P3)
- `traffic` u8: decaying footfall; high values become desire paths (☑ M3-δ,
  `people/desire.ts`): every walker (people and animals) adds 4 per cell it
  enters, a day takes 1/16 of it away. Paths grow as connected lines, not
  patches: open land becomes `LandUse.Path` where traffic reaches 150 (a
  seed), where it continues a path end at ≥ 72, or where it closes a gap
  between two *separate* pieces of path (or a path and a yard, building or
  bridge) at ≥ 40 — never into a loop with itself, and never into a 2×2
  block, so paths stay about one cell wide (thick spots in old saves are
  thinned, keeping the most trodden cells and the connections). Dead ends
  into open meadow and lone specks fade below 72, any path below 24 (a
  month or two unused). No duplicates: a way never grows beside another
  track (a path cell one or two cells away, running the same way, not
  joined within 8 cells of path), and of two such tracks the less trodden
  gives way cell by cell; a loop of ≤ 14 cells through path, yards and
  houses (a ladder's rung, a lane round a cluster of yards) loses its least
  trodden cell; corners of staircases are cut and zigzag teeth move into
  the line (straighter ways). A* converges routes onto the ways others walk:
  paths and yards cost ×0.6 (people cut across the yards between houses
  instead of wearing a ring road round them), trodden grass up to ×0.75
  (`path.ts`), so a few walks in the same direction pull later routes onto
  one track. `pathDuplicates` counts parallel and short-loop cells.
  `npx tsx tools/paths-run.ts --seed 1 --days 140 --map` reports the
  network's shape (groups, specks, thick spots) with an ASCII map of the
  village; `--save out/p1 --save-at 114,140` then
  `npx tsx tools/shot-paths.ts out/p1-d114 --tag after` screenshots it
  (desktop and phone; needs `vite preview`).
  Drawing (`pathMask`/`pathColour` in `render/village/fields.ts`): the
  renderer computes each path cell's links (`pathLinks`, into the fields
  texture's B and A bytes): its path neighbours (a diagonal only where no
  path cell already turns the corner), bridges, and one yard or house only
  where the way ends — a way passing along yards draws no rungs into them,
  but each piece of path joins each cluster of yards it touches once, from
  its most trodden cell. The shader draws, per cell, a quadratic Bézier
  from the middle of one link to the other through the cell centre
  (neighbours' curves meet with the same tangent: no grid corners), spokes
  blended by a smooth minimum at junctions and dead ends; only the 2 × 2
  cells around a point are looked at. The lookup point is displaced by
  low-frequency noise so ways wind a little; noisy soft edges, width from
  the footfall (the fields texture's crop byte carries `traffic` on path
  cells, raised beside houses), blended bilinearly across cells; warm trodden earth, darker and rutted
  where worn, a margin of flattened grass, tufts on little-used ways, mud
  and puddles in the ruts when the soil is wet. In winter a path is trodden
  grey-brown slush with two wet tracks (terrain shader), the snow thinning
  gradually towards it through a noisy fringe of greyish trodden snow, free of hoar frost,
  and its snow melts faster (as if 1.5 °C warmer, twice
  as fast: `PARAMS.pathMelt*`); off the paths every walker leaves
  footprints in the snow (`render/footprints.ts`: a client-side ring of
  ≤ 3000 instanced prints, fading over ~1.6 game days on the game clock,
  faster under falling snow, gone where the snow melts). Paths are 1.2×
  quicker to walk and seal the soil a little (infiltration ×0.6).

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

**Prosperity is plenty now (playtest round 6).** People judge a village by
how good it looks *now*, not by forecasts: the granary and the fields.
`plenty = (store + crops) / (P · days · spoil)` (`Settlement.plenty`), where
`crops` is what the sown fields hold at their current stage (each field
yield × fertility × stage/255; village.ts `manageFields`), `days` the days
to the next harvest plus, for the share of next year's food already standing
(the crops' mean stage in spring, the calendar from summer on, so a stunted
crop shows at once), a year; `spoil` counts what spoils while it waits.
1 = just enough. Prosperity (`wellbeing`) follows
`foodPart · (0.85 + 0.15·comfort)` (+ warm hearth, mill, lit houses) with
τ = 3 days, where `foodPart` rises from 0 at plenty 0.6 to 1 at 1.4 ("plenty
for everyone and then some"; 0 while starving above the floor) and comfort =
0.4·housing + 0.35·water access + 0.25·safety is a small term.
**Reputation** is prosperity smoothed over a few weeks (τ = 5 days; a game
day is about a calendar week), less 0.04 per ruin by the village (at most
0.2). Several food sources on different schedules (fish all year except
winter, dairy, a quick garden crop) flatten the yearly sawtooth.

**Stability rules:**
- Diminishing returns are built in: people farm the best cells first, so
  food per worker *rises* as population falls.
- **Wellbeing never multiplies production or work speed.** That would create
  a hunger → slow work → hunger death spiral. Wellbeing only sets build
  speed, migration and props.
- **Spoilage:** 0.4 %/day.
- **Arrivals follow reputation** (word of a good village spreads, the
  further the bigger it is): families a day =
  `0.25 · (1 + P/20) · (rep − 0.6)/(1 − 0.6)` while the village is fed
  (plenty ≥ 1; a village under 12 from reputation 0.45). They come as the
  daily rate adds up (`pull`, a threshold drawn around 1); with no free
  house the family **camps** at the edge until one is built (houses go up
  promptly, several at once in a bigger village, on a field next to the
  village if no open ground is left). In hard times the campers move on.
- **Births follow prosperity:** 2 %/yr plus up to 16 %/yr as prosperity
  rises from 0.5 to 1, none while food is short (except at the floor);
  deaths 3.5 %/yr (more while starving above the floor).
- **Departures follow the shortfall:** families leave at
  `0.3 · households · (1 − plenty)` a day while plenty is below 1 (all of it
  while starving), summed like arrivals (`push`). So a bad harvest or a
  flood empties houses within days and the village tracks what its land
  feeds, with a visible overshoot after good years and a correction after
  bad ones ("stationary, not static").
- **Recovery floor:** families leave only while more than eight people live
  there (`ECONOMY.stayers`), and at or below it hunger kills nobody.
- **What holds growth back** is named daily per village (`limit`:
  land, food, wellbeing, room, building, open; GAMEPLAY §4.6).
- **Leaving families settle the valley** (round 6): families leaving a
  village of 20 or more in hard times (and a family whose house a flood
  ruined in a crowded village) join a small village nearby that is
  doing well, or found a new one at the best site (at most one new village
  a year), instead of leaving the valley; a crowded (30+), prosperous
  (reputation ≥ 0.65) village now and then sends a young family out to seek
  its luck. They take food from the store to last them to the next harvest and a
  season (at most twice their share, half the store) and
  walk there with an ox and a loaded handcart (`carts`, EntityKind.Cart),
  which stands unloaded by the new store for a season.
- **Ruins** of flooded houses that are not rebuilt grow over, become a
  grassy mound after a year and a half and are gone after two years (the
  cell is free again); until then each costs its village reputation and a
  founding site attractiveness.

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

The first family arrives within 1–2 game days of a new game, at the start
point: on most worlds a dry terrace 2–6 m above the river with a fertile,
flood-prone floodplain below it (worldgen `chooseStart`, GAMEPLAY §4.3 P2;
the old river meadow is the fallback). Further villages (code: `FOUNDING`
in `village.ts`) are founded mostly by the valley's own people (above:
leaving families, adventurers from crowded villages), at most one a year,
at the best block scoring ≥ 0.6 (0..~1.15: fertility × wetness ×
flatness, averaged, plus 0.15 near water, less 0.08 per ruin) both now and
at the end of last summer (a survey kept from day 22: migrants judge land
at its worst, so river margins that dry out in the low water of late
summer don't qualify). Strangers from beyond the known land come too, but
rarely: once all villages together have ≥ 40 people, at most every year and
a half, a family of 3–5 walks in from the nearest edge of the fog with its
cart. Typical natural land scores 0.4–0.55, good river meadows 0.7–0.85, so on
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
| builder | houses, the well and the mill, jetty, own lining | hammer, carry stones | buildings, `CellFlag.Lined` |
| farmer | field/garden | plough, sow, tend, harvest | crop → food |
| fisher | shore near fish | sit and cast | fish → food |
| herder | pasture | leads the herd out, watches it graze, brings the milk | grass → dairy food |
| woodcutter | forest edge | chop (axe), carry a log | vegetation ↓, woodpile |
| idle | village | sit, chat; children play when w > 0.6 | — |
| miller (while grain waits at the mill) | the village mill | grinds (Build) at the mill, carries the flour to the store | milled grain books ×1.1 while the wheel turns (GAMEPLAY §1.2, `people/mills.ts`) |
| water carrier (any idle adult, now and then) | the village well, or the water's edge if home is ≥ 8 cells from it | winds up / dips a bucket, carries it to a house | cosmetic (GAMEPLAY §4.3 P7) |
| gatekeeper (a builder or idle adult, when called) | a sluice gate near the village | walks to the gate, turns its wheel while the leaf moves | gate opened or closed (GAMEPLAY.md §2, `structures/gatekeeper.ts`) |

Fields are claimed and ploughed in any season but winter (never on the
player's works: structures, lining, planned cells, bank crests and slopes;
DESIGN §4). Grain follows the
year; gardens give green within about one season.

### 5.2 Movement
- Walking speed is about 1.5 cells per real second at 1× (0.075 cells per
  step). People can wade up to 0.4 m deep, slowly; deeper water is
  impassable. They run from water only when it is deeper than that
  (`MAX_WADE`; before, anyone in a ford deeper than 0.3 m "fled").
- Pathfinding is bounded A* (a 64×64 window around the settlement, octile
  heuristic), time-sliced to at most 4 searches per tick. Paths are cached
  per (settlement, site).
- Cached paths are invalidated by a per-16×16-tile "water version" that is
  bumped whenever a tile's wet/dry state changes.
- ☑ **Fields by the way there** (`people/reach.ts`): once a day each
  village computes a walking map from its store (bounded Dijkstra, radius
  30, the A* step costs: slope, wading, trodden paths, bridges). A cell at
  straight distance d is claimed as a field only if walking there costs at
  most 1.45·d + 6 (and nearer by path ranks higher); a field costing more
  than 1.8·d + 10 (a river shifted, a bridge was swept away) is given up
  once harvested, at once if cut off, unless a footbridge is on its way.
  Good land turned down for the walk is the village's wish for a bridge.
- ☑ **Footbridges** (`people/bridges.ts`): daily, a village of 4+ people
  with far fields or such wishes looks for a crossing: from a dry bank it
  can reach, straight (8 directions) over 1–4 wet cells (at least one
  ≥ 0.24 m deep; no structures, outlets or plans) to a dry bank opposite.
  The score is the walking it saves on the way to that land, less 6 per
  deck cell, plus a little for well-trodden banks (traffic). The saving is
  measured with every existing bridge (any village's, finished, being
  built or waiting to be rebuilt) already in the walking network, and the
  best few candidates are checked with a real walking map from the far
  bank; it must reach 120 cells summed. So a second bridge beside one that
  already joins the same shores saves next to nothing and is not built,
  while one over the other arm of a fork still is. A bridge whose end the
  river has reached (water too deep to wade) is "stranded": no crossing
  within 4 cells of it is started for 24 days (it may dry out); after that
  such a crossing replaces it. One bridge at a time, at most one per 25
  people (started) and three per village, and 24 days between choosing
  one and the next. A builder
  hammers it together from the village bank (10 visits; a stack of planks
  waits there); finished, its deck cells become `LandUse.Bridge`, walkable
  for people and herds (path.ts), its deck 0.35 m above the water. A
  flood that rises over the deck sweeps the planks away (the piles stay,
  `broken`); after 4 days, with the water below the deck again, the
  villagers rebuild it, higher (above the flood, at most 1.2 m above the
  banks). The player's brushes do not go round a footbridge: ground
  moved more than 0.1 m (strokes summed) at either bank
  or under the deck breaks it the same way (`Bridges.disturbed`), to be
  rebuilt on the new ground. Nobody flees the deep water under a deck or
  fills a bucket from it (else walkers turned back a cell or two onto the
  bridge). A crossing that can't be worked for 60 days is given up. Saved
  in `PeopleState.bridges` (absent in older saves). Rendered by the
  structures layer as an arched plank deck on piles with handrails (piles
  first, then the planks out from the village bank, rails last); the
  wreck shows snapped piles, deck stubs and a plank hanging into the
  water. People on a deck (bridge or jetty) are drawn on the planks
  (`render/structures/decks.ts`). Achievement Footbridge. Ferries over
  wide calm rivers: not yet.

### 5.3 Floods
Rising water near people makes them run uphill. Crops drown,
`floodMemory` marks the area, and nobody builds houses there for years.

### 5.4 The villagers' own works (M4a, `people/works.ts`)
Villagers never carry out the player's plans (the spirit crew does), but
they look after the water by their homes on their own:
- **Lining.** Daily, each village lists the cells it would like to line
  (`lineSites`, best 24): banks (dry or shallow cells next to water) within
  3 cells of its houses and yards (not by fields: a meander may take a
  field, and that is for the player to answer), and the beds and banks
  of the player's canals (cells flagged `CellFlag.Canal` when the player dug
  them 0.3 m below their original ground) within 22 cells of the centre that carry water. Faster
  water, flood memory, canals and banks right by a house rank higher. A
  stone budget grows by 1.5 cells/day at full wellbeing (a fifth of that
  when poor, capped at 4). Builders, or a small mason share of the
  population (4–12 %, more when prosperous), fetch a stone at the store
  (`CarryKind.Stone`) and lay it (Build animation): one cell per visit. So
  banks get lined slowly over seasons, never far from home.
- **Quays.** Lined, dry cells next to water deeper than 0.5 m within 3
  cells of a house read as a quay / lake front: dressed-stone slabs with a
  pale coping, a stone edge down to the water, and now and then a few
  steps, a bollard, a bench or a lantern (derived daily; rendering only).
- **Jetty.** A village with fishers picks its best fishing shore (calm
  water ≥ 0.5 m deep for 2–3 cells straight out, fish, open water beyond)
  and its builders build one wooden jetty there. Its deck cells become
  `bridge` land use (walkable); a fisher then prefers its end.
- **Power lines** (`sim/power/lines.ts`, GAMEPLAY.md §1.5). Once the
  player's first turbine makes power, the villages plan the grid
  themselves: lines from the grid to each village and pump, to the houses
  no pole reaches, and between separate grids, routed beside the paths and
  along field edges, poles evenly spaced and straightened. A builder of
  the nearest village carries a pole out (a log) and puts it up (two
  visits; after houses, the jetty and footbridges); poles out of every
  village's reach (56 cells) the spirit crew puts up. Floods and ground
  moved under a pole knock it down; the builders put it up again, and
  move poles out of the way of new houses and fields.
- Later: harbours, boats and shipping between villages on lakes and
  canals (ports & shipping), village irrigation ditches and check dams.

### 5.5 Woodcutters and herds (M3-δ)
- **Woodcutters** (`WOOD` in `people/village.ts`): villages of 10+ people
  send a small share (5 %, at most 3) while the woodpile holds fewer than 8
  logs. Daily, each village lists its forest edge cells (vegetation ≥ 0.6,
  dense around, an open dry neighbour to stand on), nearest first, never
  within 5 cells of water: no clear-cutting by rivers and lakes. A
  woodcutter walks there, chops (Build swing with an axe, `EntityAnim.Chop`),
  the cell drops to stump and grass (0.18), and carries the log home to the
  woodpile by the store (`SettlementState.wood`, at most 10). Logs are
  burnt (0.15 a day, 0.6 in winter); in winter a warm hearth (wood on the
  pile) adds 0.05 to the wellbeing target. No other economy. The forest
  grows back from the stand around it within a year or two.
- **Herds** (`people/herds.ts`): a village of 6+ people with grassy meadow
  (vegetation 0.12–0.62) in the ring 7–24 cells around it keeps cows: at
  most one per 4 people, per 60 pasture cells and 10 in all, scaled by
  wellbeing (0.4 + 0.6·w); sheep (half the cows, 3+ cows), a pig or two
  (10+ people) and chicks (2 + houses/2, 2+ houses). The first pair comes at
  once, then the herd grows (or is sold off) one animal at a time. Animals
  are sim entities (`Animal` in `agents.ts`: deterministic, saved, sent in
  the entity frame like people). Cows and sheep stay at the fold (open
  ground 5 cells from the store, towards the pasture) and go out when the
  herder leads them; they graze (Eat), each mouthful crops the grass a
  little (−0.012 down to 0.08). Pigs root about the store, chicks peck
  around the houses.
- **Herders** (one for a herd, two for 8+): the first leads the herd to the
  best meadow of the day at its pace, sits and watches it graze for 420
  steps, then the herd heads home and the herder carries a bucket of milk
  to the store: 0.5 person-days per cow (sheep half) at pasture, booked on
  delivery ("land grows it, people collect it"). In winter the herd stays
  in the fold and gives half. Then he rests a while before the next
  outing. Dairy is a small year-round food source.
- The renderer's ambient "fake crowd" of animals is gone from the game;
  the welcome scenes still use it (their staged village keeps no animals,
  `PeopleSystem.noAnimals`).

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
  (weir 15, gate 30; others from the start; `?cheat=1` unlocks all). Locked tools are
  greyed with a lock and say "Unlocks at N villagers".

## 7. Making the hidden economy visible ("watch and learn")
Implemented (☑) and planned cues. No text: the economy shows through props
and behaviour.
- ☑ **Food:** each store shows its own village's stock: 0–6 sacks (one per
  20 days of food per head), one or two round hay bales beside it when it
  is (nearly) full. A village with fishers has a fish-drying rack, hung
  with fish unless the store is empty (`render/village/houses.ts`).
- ☑ **Crops:** the sim sends a stress byte per field cell (third byte of
  `Snapshot.fields`, `cropStress` in `people/village.ts`, mirroring the
  growth factor of `growCrops`): 1..127 dry (moisture < 0.46 while
  growing), 128..255 waterlogged (moisture ≥ 0.9) or drowned (255, under
  water). The terrain shader paints dry fields pale with thin, patchy,
  straw-yellow crop rows, waterlogged ones as dark mud with brown crops and
  puddles with a sky sheen in the furrows; crop models thin out, shrink and
  turn yellow-brown / dull brown. Healthy fields stay lush. Stubble after
  harvest (autumn) as before. ☐ weedy when fallow.
- ☑ **Land short or to spare** (§3.1): millet on sandy soil and rice
  paddies mean the village has used up its good land and is hungry for
  more; pegs and string on the meadow mean good land waits for hands;
  ordinary crops edge to edge mean the two match.
- ☑ **Mood:** each settlement has a visible `mood` from wellbeing with
  hysteresis (`nextMood`, settlement.ts: prosperous above 0.62 until below
  0.55; struggling below 0.28 until above 0.35), saved, sent per village
  in `VillageStats.mood`. Render side (`render/village/cues.ts`):
  - prosperous: every finished house smokes (soft instanced puffs rising
    and drifting with the climate's wind), laundry lines across the gap
    between neighbouring houses, flower patches by most doors;
  - ordinary: about a third of the houses smoke a little;
  - struggling: no smoke, no decor; idle villagers hang about the store
    (resting longer, often sitting) and dawdle (0.6× speed) on idle walks.
    Work trips keep full speed, so the mood never feeds back into
    production (§4).
- ☑ **Children:** a prosperous village has up to `MAX_CHILDREN` (4, at
  most one per four people and one per finished house) child agents
  (`Agent.child`, `EntityKind.Child`, drawn as small villagers). They come
  out of a house, run between the houses (1.7× walking speed), pause, run
  on, and go back in (vanish) when the mood drops. They are deterministic
  sim agents, saved with the others, but cosmetic: no job, no food, not
  counted in the population (`syncPopulation` and job quotas skip them).
- **Migration:** families walk in from the fog edge with bundles and walk out
  again. ☑ A founding party (round 6) travels as a little caravan: the
  family with bundles, an ox (a crowd cow) and a loaded handcart behind it
  (`render/crowd/carts.ts`: bed, sacks under a red cloth, two spoked
  wheels turning with the ground it covers on the game clock); unloaded,
  the cart stands by the new store for a season. Ruins stay for up to two
  years: the visible memory of a setback.
- ☑ **Flood ruins** (`ruinDesign` in `render/village/houses.ts`): a
  house's own walls, wrecked: leaning out, broken off, one fallen flat; the
  roof caved in and lying askew inside; broken rafters, boards, roof shards
  and stones strewn about, the barrel on its side; a mud stain around the
  plinth, everything drained of colour and stained brown below the flood
  line. No scaffolding or stacked planks, so it never reads as a building
  site. Weeds grow over it: tufts after a season, shrubs and flowers after
  a year, a low grassy mound with a few stones after a year and a half,
  gone after two (`BuildingInfo.weeds` 0–3, from `Building.ruinedDay`).
- **Building:** the crowd at a plan grows with wellbeing.
- ☑ **Wood:** a woodpile behind the store grows with the logs (three
  sizes); cows, sheep, pigs and chicks show a village's herd.
- ☑ **Water:** carriers walking to the river with buckets mean there is no
  well nearby (home ≥ 8 cells from water); once the village has a well they
  wind up their buckets there. A dry well shows bare earth in its ring and
  its bucket comes up empty (GAMEPLAY §1.1).
- ☑ **Mill:** the wheel turns with the water at the mill (stands still when
  the canal runs dry, races in a flood); sacks of grain wait by its door
  until the miller has ground them (GAMEPLAY §1.2).
- ☑ **Fish:** jumps follow fish density.
- Cost: the cues add at most 2 draw calls (one InstancedMesh of smoke
  puffs, one merged mesh for all laundry and flowers, rebuilt only when
  houses or moods change); hay and fish racks are part of the store's
  merged geometry; children share the people's instanced meshes.
- Debugging: `Command` `debugVillage` forces a village's wellbeing/mood
  and food or dries its fields' soil (screenshots, tests).

## 8. Protocol & rendering
- **Snapshot entities:** every agent and animal, each `id u16, kind/anim u8,
  carry u8, x f32, y f32, vx/vy i8, heading u8`, about 16 B. 400 agents
  come to about 6 KB at 10 Hz. There is no camera culling in the worker.
  The renderer interpolates and extrapolates.
- **Buildings and props:** a rarely changing list (id, kind, x, y, rotation,
  stage).
- **Fields:** drawn by the terrain shader from a landuse/crop/stress
  texture (furrows, crop colour, stress; §7), plus instanced crop models
  when zoomed in.
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
- ☑ **M3-δ:** herders with cows (and sheep, pigs, chicks), woodcutters,
  desire paths, vegetation dynamics (M2) — §3.2, §3.3, §5.5.
- **Later:** the pollution tracer (sewage) rides on the same upwind fluxes as
  sediment (reserve a slot in the flow kernel); NPCs dig their own furrows
  and check dams (M4); power (M6).
