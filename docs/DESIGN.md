# Hydro — Game Design

> A slow, cozy sandbox about shaping water in a living landscape, and watching
> little people make a home of what you shaped.

## 1. Pillars

1. **Water is the protagonist.** Rain, snow, rivers, groundwater, floods and
   droughts are simulated, not scripted. Everything interesting follows from
   where water goes.
2. **The player plans, the land responds.** The player is a "god hand" that
   marks plans (trenches, dikes, reservoirs, gates, …). They are realised
   quickly and on their own, so that the interesting wait is for the *water*
   and the *people* to respond, not for construction. (Having villagers do
   the earthworks was tried and felt odd; it is off, see
   `PARAMS.villagersBuildPlans`.)
3. **No control over people.** NPCs settle, farm, fish, graze, build houses and
   occasionally a little dam of their own, entirely on their own initiative.
   The player only shapes circumstances.
4. **Watch and learn.** Very little UI explanation. No event log, no thought
   bubbles. Consequences (soil exhaustion, runoff, erosion) are
   slow and subtle; an attentive player learns to read the colours of the land.
5. **Slow and cozy.** Make a change, then lean back. No failure state, but
   setbacks: floods wash away fields, droughts empty villages, and they recover.
6. **Stationary, not static.** Left alone, the world should neither freeze
   nor drift into a dull or broken state. It should settle into a lively
   dynamic equilibrium: rivers that erode at the sea also bring sediment in,
   meandering rivers keep meandering, forests grow and burn back, settlements
   and their economy level off (perhaps at a different level after a
   disturbance). This is a design guideline for every subsystem and its
   tuning, checked by long-horizon tests, not a formal requirement.
7. **Cute and bustling.** Low-poly, flat-shaded, toy-like look (Kenney CC0
   assets), lots of tiny moving things, day/night, seasons.

## 2. The world

### 2.1 Landscape
- Procedurally generated from a seed: mountains, rolling hills, plains, basins
  with bogs, dry areas, river valleys. Climate varies across the map
  (prevailing wind ⇒ wet windward slopes, rain shadow on the lee side).
- Conceptually infinite and deterministic (terrain is a pure function of seed
  and coordinates). Only a finite **active region** is simulated; it starts
  large-ish with most of it hidden by fog and can be extended later
  (see ARCHITECTURE §World growth).
- Terrain layers: **bedrock** (very hard to erode), **soil** on top (type,
  thickness), **surface water**, **groundwater**, **snow**.
- Soil types: rock, gravel/sand, loam, clay, silt (alluvial), peat. They differ
  in infiltration, water capacity, erodibility and base fertility.

### 2.2 Water
- **Surface water** flows downhill (shallow-water "virtual pipes" model). Rivers
  enter from the boundary of the active region (fed by a coarse, larger-scale
  catchment model) and leave at low boundary points.
- **Erosion & sediment:** fast water picks up soil, slow water drops it. Rivers
  carve valleys, shift course, build deltas and floodplains. Floods deposit
  fertile silt (+fertility). Steep slopes slump (talus), so a deep unlined
  trench slowly fills in.
- **Groundwater:** rain and standing water infiltrate according to soil type;
  groundwater flows slowly; where the water table reaches the surface, springs
  and bogs appear. Wells and pumps lower it.
- **Evaporation** from open water and soil, temperature dependent; later
  transpiration by plants.

### 2.3 Climate, weather, seasons
- A year has four seasons. Default pacing: ~25 real minutes per year at 1×
  (configurable), speeds pause / 1× / 3× / 10×.
- Always daytime. A day/night cycle turned out to be distracting; the
  seasons alone shift light, hue and colours.
- Weather: rain fronts drift across the map with the wind; orographic
  enhancement makes mountains wetter. Winter precipitation falls as snow above
  the snow line and melts in spring ⇒ spring floods.
- Slow random climate variability (wet years, droughts) so the landscape is
  never quite in equilibrium. River courses slowly change.

### 2.4 Soil & vegetation
- Per cell: moisture (from groundwater/surface), fertility (nutrients),
  compaction, salinity, pollution, vegetation biomass and type (grass, shrub,
  forest, reeds, crops).
- Vegetation grows where moisture and fertility allow; holds soil (less
  erosion), increases infiltration. Overgrazing and deforestation reverse that.
- Rendering of the ground colour reflects these values subtly (lush, dry,
  salty-white tint, muddy, boggy, etc.). No explicit overlays in normal play
  (a debug overlay mode exists for development).

## 3. The people

- Cute small individuals (Kenney mini-characters) with simple needs: food,
  water, shelter, company, (later) light and power.
- Groups arrive at the edge of the known world when there is attractive land.
  They found **households** and **settlements**.
- Professions emerge from circumstances, not from player choice:
  farmer (fertile, moist, flat land not flooded at the wrong time),
  fisher (healthy water with fish), herder (grassland), woodcutter/forester,
  builder (carries out the player's plans, and builds houses, paths, small
  dams of their own), miller (water mill), later engineer/turbine keeper.
- A hidden settlement economy (food stock, materials, wellbeing) drives
  growth, migration, and building speed. Building is "free" for the player;
  the only cost is time, and time depends on how prosperous people are.
- Their impacts on the land: ploughing and sealing (roofs, paths) increase
  runoff; overgrazing and logging cause erosion; wells lower groundwater.
  All gentle and
  slow.
- Houses are not built in places that flooded recently (people remember
  floods for a while — then forget).
- As settlements grow, their **territory** expands and the fog of war recedes,
  giving the player more land to shape. That is the progression.

## 4. Player tools (plans)

All tools place *plans*; NPC builders realise them over time. Plans can be
cancelled.

| Tool | Effect when built | Unlock |
|---|---|---|
| Trench / canal | Lowers ground along a path to a floor that grades evenly from start to end | start |
| Dike / wall | Raises ground along a path to a level crest | start |
| Level | Flattens an area to a target height (basins, terraces) | start |
| Weir | Fixed, lined overflow crest drawn across a river: holds water to the crest, spills evenly above it | 15 villagers |
| Sluice gate | Tap a dike or weir (or draw across a channel for a dam with a gate): a lined passage with a gate leaf; closed it holds the reservoir, open it drains to the sill. Worked by the villagers (GAMEPLAY.md §2): released in summer to water their fields, opened before the water spills over; with no village near it opens by itself as flood relief | 30 villagers |
| Water wheel | Draw from fast river water onto the bank: the current turns a noria that lifts water up to 5 m into the head cell, and on along the player's trench (GAMEPLAY.md §1.3; wells and mills are villager creations) | 50 villagers |
| Turbine | Generates power from head × flow in a gate or weir | 100 (planned) |
| Power line / pole | Distributes power within a radius of poles | 150 (planned) |
| Electric pump, pumped storage | Pump uphill when surplus, generate when deficit | 250 (planned) |

Unlocks are driven by population milestones, not by purchase: one
progression table in `src/shared/unlocks.ts` (`PROGRESSION`; the planned
steps 100/150/250 are already milestones, waiting for their tools;
`?cheat=1` unlocks everything for testing). Each tool's hint line names the
problem of the land it solves (GAMEPLAY.md §3).
Stone work (weirs, gates) is done by the quick spirit crew; villagers never
carry out the player's plans, but do their own works (PEOPLE.md §5.4).

There is no player lining tool (decision): stone lining (no erosion or
slumping) is the villagers' job. They line the banks by their homes and the
player's canals near the village on their own; lined banks by the houses
facing open water become quays (lake fronts). Elsewhere the player's works
live with natural erosion. (The sim keeps a `planLining` command for scenes
and tests.)
On a keyboard, the digit keys 1…9, 0 pick the tools in palette order.

## 4a. Progress you can feel

The player asked for "more direct endorphin hits". Decisions:

- **Keep it all positive.** Sewage/pollution and irrigation salinisation are
  shelved: they would only punish. Mild *natural* setbacks stay (runoff from
  sealed and ploughed land, erosion from overgrazing and logging, floods and
  droughts), because they are part of the landscape's life, not blame.
- **Two headline stats** in a small **stats bar** next to the speed controls
  (on phones a second row below them):
  - **Population**: the total number of villagers. Its bar fills on a log
    scale from the last milestone to the next (the progression in
    `src/shared/unlocks.ts`: 15, 30, 50, 100, 150, 250; beyond, doublings).
    Reaching a milestone gives a small sparkle and a note of what unlocked.
  - **Prosperity**: the population-weighted mean of the settlements'
    wellbeing, in % ("waiting for settlers" before the first village).
- **History chart**: tapping the stats bar opens the whole game's story:
  villagers (log scale) and prosperity (%) over time on season-coloured
  bands, rain drops, dry spells, floods, and stars at the tool-unlock
  milestones (filled with the day they were reached, outlined for the ones
  ahead). The sim records one sample per game day and saves it with the
  world (thinned for long games).
- **Achievements, per world**: 30 little goals (docs/ACHIEVEMENTS.md),
  from "First Spade" and "Lake Maker" to "Weathered the Storm", none
  secret, all reachable in normal play. Earning one slides in a toast with
  a sparkle (tap it for the list); the menu's Achievements card lists all,
  earned ones with their day, the rest dimmed with what it takes; medals
  mark them on the history chart. Water and land ones only count near the
  player's own works, compared with a snapshot of the world at its start.
  Loading a save shows no toasts.

## 5. Power (later milestones)
- Purely hydro-powered society. Power = efficiency × ρ g × head × flow, with
  head and flow taken from the actual simulated water.
- Poles carry power; every building within a radius of a pole is supplied.
- Benefits: lit houses (more evening activity), electric pumps, more efficient
  farming and crafts, higher population cap, happier people.
- Demand varies over day and season; pumped storage balances it.

## 6. Presentation
- Tools apply once and then return to the Look tool, so stray touches never
  place unintended plans.
- Flow direction of water must be readable at a glance (drifting foam,
  flow-aligned ripples). Plans stay visible under water.
- 3D, WebGL, orthographic camera at an isometric-like angle; freely rotatable
  and zoomable; works with mouse and touch (Pixel 9a is a target device).
- Flat-shaded low-poly terrain matching the Kenney style; water as a
  translucent animated surface with foam on fast flow.
- Fog of war: unexplored land is hidden behind soft clouds/darkness.
- Sound: deferred.

## 7. Non-goals (for now)
- Combat, money, trade UI, direct NPC control, scripted scenarios, quests.
