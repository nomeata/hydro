# Hydro — Game Design

> A slow, cozy sandbox about shaping water in a living landscape, and watching
> little people make a home of what you shaped.

## 1. Pillars

1. **Water is the protagonist.** Rain, snow, rivers, groundwater, floods and
   droughts are simulated, not scripted. Everything interesting follows from
   where water goes.
2. **The god hand shapes the land; the crew builds.** The player is a "god
   hand": the ground itself is sculpted directly, with brushes (raise, dig,
   even) that change it at once under the finger, so the interesting wait
   is for the *water* and the *people* to respond, not for construction.
   Stone structures (weirs, gates, wheels, turbines, pumps) are
   still *planned*, and a quick crew builds them. The power lines are the
   villagers' own (§5). (Having villagers do the
   earthworks was tried and felt odd; it is off, see
   `PARAMS.villagersBuildPlans`. Planned trenches, dikes and levels were the
   first design, replaced by the brushes: plans felt indirect for earth.)
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
- Rivers have seasons: high water and a snowmelt freshet in spring, low
  water in late summer. Slow random climate variability (wet years,
  droughts: a yearly factor 0.55–1.6 on rivers and rain fronts, about one
  dry year in six) keeps the landscape never quite in equilibrium. Dry
  years and floods are setbacks, never failure. The live weather keeps the
  generated climate (dry and wet worlds, rain shadows). River courses
  slowly change.

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

## 4. Player tools

The ground is sculpted with three **brushes**; structures are placed as
*plans* that the crew builds (and can be taken down again).

| Tool | Effect | Unlock |
|---|---|---|
| Raise | Brush: heaps up earth under the brush while held (bank, dam, pond wall). Loose earth: water pouring over it scours it, and an overtopped bank notches and breaches | start |
| Dig | Brush: digs the ground under the brush while held (canal, ditch, basin). A rough channel grades itself once water runs in it | start |
| Even | Brush: pulls the ground under the brush towards its mean height (terraces, flat sites, rounding off); repeated strokes level | start |
| Weir | Drawn as a line across a river: a stone wall on the ground as it is (no earthworks), its crest at most 4 m above the ground on its lower side, with a stone apron at its foot. Built to be overtopped: holds the pool at the crest and spills the surplus safely; the place for mills and turbines | 15 villagers |
| Sluice gate | Tap a weir or a bank (or draw across a channel for a stone wall with a gate): a lined passage with a gate leaf; closed it holds the reservoir, open it drains to the sill. Worked by the villagers (GAMEPLAY.md §2): released in summer to water their fields, opened before the water spills over; with no village near it opens by itself as flood relief | 30 villagers |
| Water wheel | Draw from fast river water onto the bank: the current turns a noria that lifts water up to 5 m into the head cell, and on along the player's canal (GAMEPLAY.md §1.3; wells and mills are villager creations) | 50 villagers |
| Turbine | Tap the crest of a weir or dam: power from the real head × flow through it (the Power tool's first mode). Once it turns, the villagers put up the power lines themselves (no tool) | 100 |
| Electric pump, pumped storage | Draw from water to an outlet: lifts water on spare power; a turbine below a pumped basin generates when the houses want more | 250 |

**The brushes** (decision; `sim/plans/sculpt.ts`, `brushwork.ts`,
`ui/tools.ts`, `client/sculptor.ts`). While the pointer is held, the
ground under the brush changes continuously and at once: rate × hold time
(Raise and Dig 1.2 m/s at the centre, `BRUSH.rate`; Even closes
1 − e^(−3 t) of the gap to the brush's weighted mean), with a soft round
falloff ((1 − (d/r)²)²). Three sizes (radius 1.5, 2.5, 4 cells: about 15,
25, 40 m across). Holding still digs a pit; a quick accidental swipe does
little (a pass at 30 cells/s moves ~0.1 m). The brushes stay selected; on
touch the brush bites only after 90 ms, so a second finger still pans and
zooms. They work while paused too: the sim applies every stroke sample at
once. The client applies the same kernel to its mirror for instant feel,
and the sim's terrain is the final word (`Snapshot.sculptSeq`). A ring on
the ground shows the brush. **Undo** (the button by the sizes, Ctrl/Cmd+Z)
takes back the last strokes (the last 12, not across reloads).

- *Water is conserved:* the brush never touches the water depth, so ground
  raised under water lifts its water (which then runs off), digging lowers
  it (water flows in); groundwater above the soil's new capacity comes out.
- *Sculpted earth is loose* (the erosion's `loose`, fading over weeks): it
  slumps and erodes readily. Ground above its original height is
  `CellFlag.Fill`, so overtopped heaped earth breaches (`overtopStep`);
  ground dug 0.3 m below it is `CellFlag.Canal` (villagers line such
  canals near home). Plants are buried or dug out.
- *What is in the way:* houses (and mills, wells, stores, ruins) and
  jetties are never changed, nor structures (weir, gate, wheel,
  turbine, pump) or the crew's work on them: the brush fades out
  over two cells around them (`Snapshot.fixed`). Footbridges and power
  poles are not in the way: ground moved under one knocks it down, and
  the villagers put it up again. Fields, gardens,
  pastures, paths and yards under the brush go back to plain land, and
  the villagers' stone lining comes off.
- *The crew is cosmetic for earth:* a few workers walk up to freshly
  sculpted ground and tamp it with their spades for a while, then leave
  (`render/crowd/sculptCrew.ts`; no effect on the sim).
- Bots, scenes and tests shape whole lines at once with the `shapeLine`
  command (the old trench / dike / level profiles, with the same rules);
  the earth moved by brushes and by scripts is counted
  (`Simulation.brush.moved`, saved). Saves from before the brushes have
  their pending trench, dike and level plans finished on load.

**Selecting and editing.** In Look mode a tap on a weir, gate, water
wheel, turbine, power pole or pump selects it (with the weir tool, a tap on a
weir too): a ring or, for a weir, a dashed line with a handle at each end;
a tap elsewhere or Escape lets go. Everything is edited in place, with no
panel: a small bubble over it names it and holds a **×** to take it down
(tap twice: it asks "Remove?" first; not a pole: the poles are the
villagers'). A weir's end handles slide along its
own line (lengthen or shorten, never turn it), and a handle on its crest
is dragged up or down to raise or lower it (0.25 m steps, 0.5 m above the
ground under it up to 4 m above the ground on its lower side); a ghost of
the wall as it will stand follows live. A pump's outlet and a water
wheel's trough end can be dragged to a new spot (within the pump's reach
and lift, the wheel tool's rules; the ghost turns red where it would not
work): the old one is taken down and the crew builds it anew. A turbine,
pole or pump shows what it does now: a gauge, the houses it lights, a
turbine's head and kW, or why it idles. Edits are plans: the crew takes
the stone off what no longer belongs to the weir, lowers it back to the
ground it was built on (saved per cell with the weir), builds the rest of
the wall to its new crest and lines it again. A removed weir goes back to its ground (gates and
turbines in it go with it); a removed gate's opening is filled back up to
the dam's crest. The Remove (erase) tool is a brush for structures:
plans under it are cancelled, and every structure it touches, built or
not (weir, gate, wheel, turbine, pump; not the villagers' poles), is taken down the same way
(the crew's plans for lowering a weir or plugging a gate are kept even if
the brush passes over them again). Mouse and touch alike
(`ui/selection.ts`).

**Villagers keep off the works.** They never claim fields, pasture,
yards or house plots on a structure's footprint (`CellFlag.Structure`,
kept in sync with the structures), on lined cells, on cells with a
pending plan, or on the crest and slopes of an earthen bank (fill more
than 0.5 m above ground within two cells; a levelled terrace's inside
stays farmable): `plans.ts takenGround`. Fields already on such ground
go back to plain land at the next day.

**Weir vs heaped earth in the sim.** Earth heaped by the brushes is
marked `CellFlag.Fill`. Where water flows off the edge of an unlined fill cell
into a lower neighbour with a clearly lower water surface, the bank is
scoured (`overtopStep`, rate ∝ unit discharge × drop; `PARAMS.overtopK`);
the soil goes into the water as sediment. The cut deepens where most
water goes, so an overtopped bank notches and breaches within days, back
from its downstream face, while a bank that only holds water stands.
Weirs are stone walls (lined), so they do not scour.

Unlocks are driven by population milestones, not by purchase: one
progression table in `src/shared/unlocks.ts` (`PROGRESSION`; the power tools
share one palette button whose modes unlock at 100/150/250; `?cheat=1` unlocks everything for testing). Each tool's hint line names the
problem of the land it solves (GAMEPLAY.md §3).
Stone work (weirs, gates) is done by the quick spirit crew; villagers never
carry out the player's plans, but do their own works (PEOPLE.md §5.4).

There is no player lining tool (decision): stone lining (no erosion or
slumping) is the villagers' job. They line the banks by their homes and the
player's canals near the village on their own; lined banks by the houses
facing open water become quays (lake fronts). Elsewhere the player's works
live with natural erosion. (The sim keeps a `planLining` command for scenes
and tests.)
On a keyboard, the digit keys 1…9, 0 pick the tools in palette order
(1 Look, 2 Raise, 3 Dig, 4 Even, 5 Weir, …), Escape goes back to Look and
Ctrl/Cmd+Z undoes the last stroke.
On phones the hint is one line (tap it for the rest, ⓘ for the tool's
card) and the options a slim strip (brush sizes as dots), so a held tool
covers little of the view; the top bar is a fixed grid, so a longer date
never moves the speed controls or the menu button.

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
    The bar itself is just villagers (no tool icon: one read as "the icon
    for a large population"); the next tool's progress shows on the tool
    palette instead: the next locked tool's button gets a ring round its
    edge filling (log scale from the previous unlock) towards its threshold,
    padlock kept, and a short golden pulse at unlock. Progress follows the
    highest population reached (unlocks are kept).
  - **Prosperity**: the population-weighted mean of the settlements'
    wellbeing, in % ("waiting for settlers" before the first village).
- **History chart**: tapping the stats bar opens the whole game's story:
  villagers (log scale) and prosperity (%) over time on season-coloured
  bands, rain drops, dry spells, floods, and stars at the tool-unlock
  milestones (filled with the day they were reached, outlined for the ones
  ahead). The sim records one sample per game day and saves it with the
  world (thinned for long games). When the valley has an idea (the
  Achievements card's "Ideas for this valley"), the first one shows above
  the chart with its "Show me": a player who taps a falling prosperity bar
  to see why finds what might help.
- **Achievements, per world**: 30 little goals (docs/ACHIEVEMENTS.md),
  from "First Spade" and "Lake Maker" to "Weathered the Storm", none
  secret, all reachable in normal play. Earning one slides in a toast with
  a sparkle (tap it for the list); the menu's Achievements card lists all,
  earned ones with their day, the rest dimmed with what it takes; medals
  mark them on the history chart. Water and land ones only count near the
  player's own works, compared with a snapshot of the world at its start.
  Loading a save shows no toasts.

## 5. Power (M6; as built in GAMEPLAY.md §1.5)
- Purely hydro-powered society. Power = efficiency × ρ g × head × flow, with
  head and flow taken from the actual simulated water.
- Poles carry power; every building within a radius of a pole is supplied.
  The villagers put up the lines themselves once a turbine turns
  (GAMEPLAY.md §1.5): the player builds the power, the people bring it home.
- Benefits: lit houses (more evening activity), electric pumps, more efficient
  farming and crafts, higher population cap, happier people.
- Demand varies over day and season; pumped storage balances it.

## 6. Presentation
- Structure tools apply once and then return to the Look tool, so stray
  touches never place unintended plans. The brushes stay selected: their
  effect grows with hold time, so a stray swipe does little, and Undo
  takes it back.
- Flow direction of water must be readable at a glance (drifting foam,
  flow-aligned ripples). Plans stay visible under water.
- 3D, WebGL, orthographic camera at an isometric-like angle; freely rotatable
  and zoomable; works with mouse and touch (Pixel 9a is a target device).
- Flat-shaded low-poly terrain matching the Kenney style; water as a
  translucent animated surface with foam on fast flow.
- Fog of war: unexplored land is hidden behind soft clouds/darkness.
- Sound (decision reversed: no longer deferred): a gentle, living
  soundscape that reflects what is on screen — water murmur, lapping and
  rapids by what flows in view, rain and wind from the weather and zoom,
  birds by season, crickets and frogs, and rate-limited spot sounds of the
  work nearby (hammering, axes, spades, animals, creaking wheels, fish
  splashes), plus soft UI clicks and a chime for achievements. Quiet by
  default, on after the first tap, mute and volume in the menu. Mostly
  synthesised; a few CC0 samples. docs/SOUND.md.

## 7. Non-goals (for now)
- Combat, money, trade UI, direct NPC control, scripted scenarios, quests.
