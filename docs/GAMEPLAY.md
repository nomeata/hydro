# Hydro — Gameplay: what the player is for

*Design note, October 2026 (after M3-δ and M4a).* Opinionated answers to
five questions from the owner, with parameter-level proposals and a
prioritised list at the end (§7). Complements DESIGN.md (pillars) and
PEOPLE.md (villagers). Where this note and DESIGN §4 disagree, this note
is the newer intent; DESIGN §4 is updated when the items are built.

The one-sentence thesis: **the land should pose problems the villagers
cannot solve with a spade, and the player's plans should be the only way
to solve them — visibly, within a season or two.** Today it mostly doesn't
(§4.1), so the tools feel decorative.

---

## 1. Wells, pumps, water wheels, mills

Rule of thumb: a *player tool* needs a **spatial decision with
consequences in the water sim** (where exactly, how high, which way).
Something whose right place is obvious from the village's needs is a
*villager creation*: it shows the player that the land they shaped is
being used. Something that is neither is cosmetic.

| Thing | Verdict | Why |
|---|---|---|
| Well | **Villager creation** | The right place is "in the village"; the interesting part is *whether* there is groundwater, which the player influences. |
| Hand / animal pump, shadoof | **Neither** (cosmetic) | Pre-power pumps are just a well or a field's water draw drawn differently. |
| Water wheel (lifting noria) | **Player tool** (unlock 50) | Where to put it, and where the lifted water goes, is a real puzzle: it is the only pre-power way to get water *uphill*. |
| Mill | **Villager creation** | Villagers find a drop with flow near home; the player's weirs and canal drops create such places. |
| Electric pump | **Player tool** (M6) | Spends power to move water anywhere: the endgame lever, leading to pumped storage. |

### 1.1 Well (villagers)
- **Story.** A village founded on a dry terrace sends people with buckets
  down to the river (the planned "water carriers" cue, PEOPLE §7). One day
  its builders dig a well by the store; the carriers stop. If the player
  later builds a reservoir or canal nearby, the water table rises and a
  village that *couldn't* dig a well (too deep) suddenly does: the
  player's work, read back through the villagers.
- **Rule.** Daily per village: if `waterDist[centre] ≥ 8` and no well yet,
  find a yard cell within 4 of the centre whose water table depth
  `soil − ground/porosity` (plus bedrock clearance) is ≤ 4 m; builders
  build it (`BUILD_PER_VISIT` progress, like a house). A village may have
  one well per 20 people. Drop the old `waterDist < 25` cliff:
  `waterAccess = 1` with a well or `waterDist < 8`, else
  `max(0.4, 1 − (waterDist − 8)/40)`.
- **Sim.** Each well draws `0.02 m³/person/day` from `ground` spread over
  the 5×5 cells around it (a gentle drawdown cone; springs nearby can
  weaken in a dry summer). If the water table falls below 6 m the well is
  "dry" (bucket comes up empty, `waterAccess` falls back) until it recovers.
- **Effect.** Wellbeing via `waterAccess` (0.15 weight) only. No economy.

*As built (October 2026, `sim/people/wells.ts`).* As specified, with: the
aquifer must be ≥ 0.5 m thick (`ground/porosity`, so thin soil over rock
gives no well); a dry well (table > 6 m or aquifer < 0.15 m) works again
only above 5.5 m / 0.3 m; the first well at 6+ people, then one per 20, at
most 3, within 7 cells of the centre and 6 apart; houses are built first.
The people's draw takes from the 5×5 cone in proportion to what each cell
holds (booked in the ledger). A small garden effect: fields within 2 cells
of a working well get field moisture ≥ 0.42 and draw their 4 mm/day from
the well's cone (a handful of fields, ~1–2 people's food). Water carriers
(P7): an idle adult now and then (20 %) fetches a bucket (from the well,
or from the water's edge when home is 8–32 cells from it) and carries it
to a house. Rendering: stone ring with water (bare earth when dry), posts,
winding beam, shingle roof, buckets; built in four stages.
Measured hands-off (128², 3 years, seeds 1/3/5/7/11): the temperate
terrace starts all have the table 0.6–1.2 m down, so every village of 6+
that lives ≥ 8 cells from water digs its well in the first weeks (seed 7
lives by the water and digs none; seed 5's well runs dry in late summer).
So on today's temperate worlds a well is the norm, not yet a reward; it
becomes one on dry climates (§5.1, steppe) where the table is deep and a
reservoir raises it. Achievement **Wellspring**: a well within 10 cells of
the player's works.

### 1.2 Mill (villagers)
- **Story.** The player builds a weir by the village. Next spring a small
  mill house with a turning wheel appears on the bank beside the spill;
  carts of grain go there after harvest, flour sacks to the store, and the
  village's smoke thickens. On a canal with a step in it, the same happens.
  The player learns that *drop × flow* is worth something — exactly the
  quantity hydro power will use (§1.5).
- **Site rule.** Every 4 days per village with ≥ 20 people and ≥ 20 grain
  fields and no mill: scan cells within 20 of the centre for a **head
  site**: water surface drops ≥ 0.8 m within 2 cells, flow ≥ 0.3 m/s,
  discharge `Q = depth·speed·5 m ≥ 0.5 m³/s`, a dry buildable bank cell
  adjacent. Score by `P = ρ g Q Δh` (W); need `P ≥ 3 kW`. Natural rapids
  qualify too, but rarely near flat village land; a weir spill
  (`Weir.top` − tailwater) or a gate outflow is the typical site.
- **Effect.** One miller (job); grain harvests go to the mill first, then
  the store, booking `YIELD × 1.15`; flour sacks on the store; +0.04
  wellbeing target. The wheel spins at a speed ∝ local flow, so a mill
  stops visibly in a drought and races in a flood. If the head disappears
  (weir removed, river moved) for 20 days the mill becomes a ruin.
- **Sim.** Run-of-river: no water removed. Optionally a small extra
  Manning roughness on the wheel cell (n × 2) — not needed at first.

*As built (October 2026, `sim/people/mills.ts`).* The head at a water cell
is the surface drop along the flow (from 2 cells upstream to 2 downstream,
so a river's sloping banks don't count) and `Q` is the stream's whole
discharge through its cross-section there (a race takes what the wheel
needs; one cell's `depth·speed·5 m` underrated every spill that spreads
over a weir's width). Thresholds as specified (drop ≥ 0.8 m, speed
≥ 0.3 m/s, Q ≥ 0.5 m³/s, P ≥ 3 kW); the mill house stands on a dry bank
cell with the head within 2 cells, its wheel in the wet cell beside it.
A built mill grinds while P and Q are ≥ half the thresholds; the wheel
turns (speed ∝ the water's speed, sent as `BuildingInfo.spin`) above a
fifth. Farmers bring grain sacks to the mill while it grinds, a miller
(one, while grain waits) grinds 24 person-days per visit and carries the
flour to the store, booked ×1.1; with the wheel still he carries the grain
over as it is. +0.04 wellbeing while it turns. Given up after a whole year
(48 days) without a head. Achievement **Miller's Head**: the mill's head
within 3 cells of the player's works.
Measured hands-off (seeds 1/3/5/7/11, 3 years): one natural mill (seed 11,
a steep reach by the start). A scripted weir across the nearest fast river
(1.5 or 2.5 m, probe bot) gave heads of only 0.3–0.7 m on seeds 1/3/5: the
pool spilled round its ends over the flat floodplain, so the villagers
built no mill there; a weir tied into the banks (the scenario in
`tests/sim/wells.test.ts`, a lined 1.5 m step) gives ~1 m and a mill in
days. Village populations at year 3 stayed within the run-to-run noise of
the economy (48/29/27/12/43 vs 41/23/37/15/79 before; the differences come
from founding times), so wells and mills do not make hands-off villages
richer.

### 1.3 Water wheel / noria (player tool)
- **Story.** The good fields are on a terrace 3–5 m above a fast river and
  there is no upstream point high enough for a gravity canal (or it would
  be 400 m long through a hill). The player places a wheel on the river
  and draws a trench from it across the terrace. The wheel turns, buckets
  tip into a wooden trough, a thin stream runs along the trench, and
  fields follow it in a season.
- **Placement.** A short stroke from the river onto the bank: the wheel
  sits in the water cell, its trough runs to the **head cell** inland, up
  to `maxLift = 10 m` above the water surface (see As built). The preview shows the head cell; the crew builds the wheel and
  lines the head cell.
- **Sim.** Each step: `v` = flow speed at the wheel cell, `h` = depth.
  Available power of an undershot wheel `P = 0.25·½ ρ A v³` with
  `A = 5 m × min(h, 1 m)`. Lifted flow
  `Q_lift = min(P / (ρ g H), 0.02 m³/s)` with `H` = head cell ground −
  water surface; moved from the wheel cell to the head cell (conserved;
  ledger entry `lifted`). No flow below `v = 0.3 m/s`: a wheel in a pond
  stands still, which teaches the rule. At v = 1 m/s, h = 0.6 m,
  H = 3 m: Q ≈ 2.5 L/s ≈ 215 m³/day — enough to keep a 150 m trench wet
  and ~40 fields growing (fields draw 0.1 m³/day each).
- **As built** (`sim/structures/wheel.ts`, tool `wheel`). Story: a
  noria lifts river water up to a canal on the terrace above, so fields
  beyond the floodplain can be watered; set it where the current is
  quick — in the main channel, a narrowed reach, or the race below your
  weir. A stroke from the river onto the bank: the wheel stands in the
  quickest water at or beside where it starts (≥ 0.05 m deep, so the thin
  fast spill below a weir counts), its trough (an aqueduct on stilts)
  runs along the stroke to the **head cell**, the last dry cell of the
  stroke within 6 cells (30 m); a tap picks the lowest dry cell within 2
  that is above the water. Lift up to 10 m (historic norias stand
  10–20 m); the wheel is drawn as tall as its lift (and broader, on
  stouter posts), so the size follows the bank, and the lifted flow falls
  as 1/H. Refused: dry start, no dry bank on the stroke, head > 10 m or
  < 0.2 m above the river's surface, a rise under the trough more than
  0.5 m above the head, current < 0.3 m/s, unknown land. The preview has
  no text: while the tool is held, gold rings stand in the river at the
  good sites (`wheelSites`: a tapped wheel would lift ≥ 10 m³/day; the
  best within 4 cells; refreshed every 2 s), each facing its bank; under
  the mouse or while drawing a ghost wheel and trough show the site —
  turning, its trough running, when good; red and still when not. Letting
  go on a bad site places nothing and keeps the tool. The tool hint and
  card tell the story. The spirit crew builds the wheel and
  lines the head cell. Lift `Q = min(gain·P/(ρ g H), 0.2 m³/s)` per
  hydraulic second with `gain = 10` (`PARAMS.wheelGain`, standing for
  the fast hydraulic clock; a hydraulic day is only 300 s), so the
  reference case lifts ≈ 0.13 m³/s ≈ 38 m³ per game day: a thin stream
  that wets a trench and its fields; on a low river the race below a
  1.5 m weir lifts more than twice what the open reach does (up to the
  cap, ≈ 60 m³ per day). The trough stops while 0.5 m of water stands at its
  outlet. Ledger: `lifted`. Achievement **Uphill** (100 m³ lifted).
  Site survey (`tools/wheel-sites.ts`, seeds 1–8 at 256², after spin-up):
  revealed wet cells at the banks are mostly quick enough (slow ones
  240–400 per seed; seed 8 is lake-like, 25 sites only); the first dry
  cell is almost always < 2 m above the water (a floodplain), and 5 cells
  further in the land stands 2–10 m up (seeds 7–8 also > 10 m). So the
  old rule (first dry cell, ≤ 3 cells, ≤ 5 m) only reached the
  floodplain, which a gravity trench waters anyway; the terrace beyond
  needed the longer trough and the higher lift.
- **Why not a pump?** The wheel's lift comes from the river's own
  movement, so it fits "water is the protagonist"; it fails gracefully
  in a dry summer (slow river ⇒ slow wheel), which is the kind of
  setback the design wants.

### 1.4 Electric pump (M6, player tool)
A placed pump with an inlet cell and an outlet cell (any lift), powered
from the grid: `Q = η P / (ρ g H)`, η = 0.7. It is what makes pumped
storage possible (§1.5) and lets late villages live on high plateaus.

### 1.5 The road to hydro power (M6)
Every step teaches the next one's physics without a word of UI:
1. **Weir** (head) → **mill** appears where head and flow meet: "drop ×
   flow is valuable".
2. **Wheel**: the river's speed can lift water: "flow is energy".
3. **Turbine** (M6, player tool): placed in a sluice-gate passage or a
   weir. `P = 0.8·ρ g Q H`, with `Q` the real flow through the passage and
   `H` the real head across it. A village mill within 3 cells of a new
   turbine is rebuilt as a little power house (the miller becomes the
   turbine keeper).
4. **Power poles**: radius 12 cells; houses inside light up in the
   evening (lit windows tint), +0.1 wellbeing target, +1 person per house
   (houseCapacity 5). Demand ~2 kW per house, peaking in winter evenings.
5. **Electric pump** and **pumped storage**: a high basin filled by pumps
   when the turbines make more than the houses use, drained through a
   gated turbine when they make less. The gate rule (§2) gets a third
   mode for turbine gates: release to keep supply ≥ demand.

*As built (M6, `sim/power/`).* The **turbine** is a tap on a weir, dike
or dam crest (also beside a gate); its penstock runs across the wall to
the lowest ground within 4 cells either side and moves
`Q = min(5, 0.6·√(2gH))` m³/s from the higher to the lower side,
`P = 0.8·ρgQH` (mass conserved; it takes water off the spillway and the
gate). A turbine whose pool stands at its spill level (the lower of the
crest and the pool's high-water mark, which sinks 1 cm/day) runs free
(run of the river: with a small river it settles at what the river
brings); a pool drawn below that is storage and runs only to cover the
houses' demand. No mill conversion and no turbine gate mode (yet).
Houses within 8 cells of a turbine (or a pole) are on its network;
demand ~2 kW a house (`houseDemand`: low at night, evening peak, +25%
in winter). Supply short of demand dims and flickers the lights. A
village's daily lit share gives up to +0.05 wellbeing (no capacity
change). Energy is booked per network (J): produced = houses + pumps +
unused. The tools share one palette button, **Power**, with its modes
on the options line.
**Poles**: a stroke places poles every 6 cells (beside a house or a
bridge, never in water), a stroke starting or ending at a turbine or pole
joins it; wires join consecutive poles (a skipped wet spot leaves a longer
span). **Electric pump**: a stroke from water (inlet) to the outlet (≤ 24
cells, ≤ 30 m up); its pump house (the first dry cell along the pipe) must
be within 8 cells of a pole or turbine. Pumps take only the surplus of the
free turbines after the houses (20 kW each, `Q = 0.7 P/(ρgH)`), so a pump
filling a basin whose turbine is on the same network makes **pumped
storage**: that turbine (its intake within 12 cells of the pump's outlet,
at the same level) never runs free, only to cover the evening peak.

---

## 2. The sluice gate: villager-operated

**Pick: villagers operate gates; with no village near, a gate is a
self-acting flood relief.** Remove tap-to-toggle (keep the `toggleGate`
command for tests and debugging). Rationale: it turns a gate into
infrastructure the people *use*, which is the game's whole language; and
a self-acting fallback keeps a gate useful in empty land.

### 2.1 Quantities (per gate, daily, after `floodHouses`)
- **Sides.** The two ends of the passage (cells `PASSAGE_REACH` either
  side of the wall). `up` = the side with the higher mean water surface
  over the 3×3 cells at that end; `down` the other. Surface `hU`, `hD`.
- `crest` = the lower of the dike crest beside the gate (min terrain of
  the dike cells within 3 of the passage) and `top`.
- `sill` = `Gate.sill`.
- **Keeper village** = nearest settlement whose centre is within
  `REACH` (40) of the gate. **Served fields** = that village's field
  cells within 24 cells of the `down` end.
- `dryShare` = fraction of served fields with a dry stress byte (1..127)
  during spring/summer; `0` if there are fewer than 6 served fields.

### 2.2 Rule (first matching line wins)
1. **Flood relief** (always, keeper or not): if `hU ≥ crest − 0.25 m` →
   **open**. Stay open until `hU ≤ crest − 0.7 m`.
2. **Don't drown the neighbours** (keeper only): if any village house
   within 16 cells of `down` had water > 0.1 m today, and rule 1 does not
   apply → **close**.
3. **Irrigation release** (keeper only, spring and summer): open if
   `dryShare ≥ 0.15` and `hU − sill ≥ 0.4 m`; once open, stay open while
   `dryShare ≥ 0.05` and `hU − sill ≥ 0.25 m` (keep a pool for the fish).
4. **Refill**: otherwise → **closed**. In autumn and winter gates close
   after rule 1 releases, so the reservoir fills for next summer.

Hysteresis: at most one change per gate per 2 days, except rule 1, which
may open at once.

### 2.3 What the player sees
A villager (a builder, or any idle adult) walks to the gate, works the
wheel for ~60 steps (Build anim), and the leaf rises over ~4 game hours
(`progress`-style lerp of the wall top, not a jump: no flood wave). With
no keeper the leaf simply rises by itself when the water nears the crest.
The rhythm becomes legible over a year: full reservoir in spring, a
summer release with green fields below, closed again in autumn.

### 2.4 Changes
*Built (October 2026): `src/sim/structures/gatekeeper.ts`, checked every
three game hours; the villager is called with `PeopleSystem.callToGate`
and works the wheel for the leaf's travel (`LIFT_STEPS`, 4 game hours);
if nobody arrives within a quarter day (relief) or a day, the gate moves
by itself. `toggleGate` holds a gate by hand (tests, scenes).*
- `Gate.open` is the target; `lift` (0..1) follows it and lowers the
  wall's crest smoothly to the sill; `lastSwitch`, `operator` (agent id or
  −1), `mode` (relief / irrigation), a pending `want`. Saved; old saves
  get `lift = open`.
- Achievement **Gatekeeper** → "Villagers open a sluice gate to water
  their fields" (rule 3 fired). New **Safety Valve**: rule 1 opened a gate
  and the dike was not overtopped that day.
- Tool hint: "Tap a dike or weir to put a sluice gate in it. Villagers
  open it to water their fields in summer; it opens by itself before the
  water spills over."

---

## 3. Help: self-explanatory, with one card per tool at its unlock

**Recommendation: no help panel.** A help page is a manual; the design
says "watch and learn". Instead, three small things, in order of value:

1. **Hints that say why, not just what** (the hint line under the
   palette, `src/ui/tools.ts`). One sentence each, naming the landscape
   problem:
   - Trench: "Dig from the river down to dry land: water follows the
     trench, fields follow the water. Its floor slopes evenly from start
     to end."
   - Dike: "Raise a level bank to keep a flood off the fields, or to hold
     a pond." *(As built: "…Make it high enough: water pouring over a dike
     cuts through it. Across a river, build a weir.")*
   - Level: "Flatten a slope into a terrace or a basin, at the height
     where you start."
   - Weir: "Draw across a river: it holds a pool through the dry summer
     and spills over its crest. Villagers like a mill by the spill."
     *(As built, after a playtester asked whether a weir was "just a dike
     without erosion": "a stone crest that the water may flow over. It
     holds the pool at the crest's height all summer and spills the rest
     safely, where a mill can use the fall. Tap a weir to change it." The
     weir card says the same, and the sim backs it: overtopped dikes
     breach, weirs don't — DESIGN §4.)*
   - Gate: as §2.4.
   - Wheel: "Place on a fast river, against the bank: it lifts water into
     a trench on higher ground."
2. **An unlock card with a live scene.** When a tool unlocks, the
   milestone sparkle is followed (once, when the player next taps the
   palette) by an intro-style card — the same `Intro`/`introScenes`
   machinery, one panel — showing the tool working in a staged scene
   (`sim/scenes.ts`): the weir filling a pool and a mill appearing; the
   gate opened by a villager and fields greening below; the wheel lifting
   water up a terrace. The trench/dike/level cards are the existing
   "You shape the water" scene. The card is reachable again from a small
   ⓘ at the end of the hint line while that tool is selected. That is the
   whole help system: ≤ 6 scenes, each ≤ 20 s. *(Built for the weir and
   the gate: `ui/toolCards.ts`, scenes 'weir' and 'gate' in
   `sim/scenes.ts`; not shown under `?test=1` unless `&cards=1`.)*
3. **Achievements as ideas.** The Achievements card opens with
   **"Ideas for this valley"**: up to three unearned achievements that
   the sim finds *possible here*, from data it already has:
   a village has ≥ 10 % dry-stressed fields → New Ground / Green Desert;
   village land flooded last spring → Weathered the Storm / Dry Feet;
   ≥ 30 boggy cells by a village → Drained; a village of 20+ without a
   head site → Miller's Head. Phrase descriptions as invitations ("Bring
   water to land too dry to farm"). No toasts, no nagging: the player
   finds them when they look. *(Built as concrete ideas from the world's
   actual problems, each with the tool that would help and a "Show me":
   `sim/ideas.ts`, the top of the Achievements card; ≤ 3 for unlocked
   tools, a small dot on the menu when a new one appears, Good Idea when
   one goes away by the player's works. No village names: places are said
   relative to the village, above/below/beside it, since the camera turns.)*

No contextual pop-ups, no arrows, no "suggested plan" ghosts: they would
turn the sandbox into a tutorial and contradict pillar 4.

---

## 4. Player agency

### 4.1 Diagnosis: what villagers achieve alone

Measured headless with no player plans (a throwaway probe over
`Simulation.run`, 4 game years per seed), and read from the code:

| Seed | Year 1 | Year 2 | Year 3 | Year 4 | Villages (y4) | Flooded cells (4 y) |
|---|---|---|---|---|---|---|
| 3 | 35 | 97 | 196 | **345** | 5 | 5 |
| 11 | 42 | 103 | 170 | **322** | 5 | 3 |
| 7 | 34 | 34 | 40 | **52** | 1 | 160 |

Population with **no player input at all**, 128², the real simulation
(people, vegetation, weather; ~1 s per game day here). On seeds 3 and 11
every tool milestone (15/30/50) falls in the first year and Little Town
(250) in the fourth, all by waiting; villages run at wellbeing ~1.0 with
granaries full. Seed 7 (20 % farmable) is the exception: one village
stuck at 34–52 people, food at zero and wellbeing ~0.45 for three years:
hard, but *grim* rather than cozy (hunger is chronic rather than seasonal).

Why the land is so easy:
- **The start site is the best spot on the map.** `chooseStart`
  (`worldgen/index.ts`) maximises fertility, flatness and nearness
  (~14 cells) to the *biggest* river. The village gets the prime
  meadow by construction.
- **Rivers never change.** Boundary inflows (`world.inflow`) are constant
  all year and all decade: no spring freshet, no summer low water, no dry
  years (the M1c "climate anomaly" item is still open). A river-side
  village therefore never meets a drought or a river flood; only local
  rain makes floods, and those are small (flood cells: a handful in the
  first year on every seed tried).
- **The live climate ignores the worldgen climate.** `TerrainGen.wetness`
  and the macro rain map (rain shadow, orography) shape soils and rivers
  at generation, but the running weather uses one global
  `PARAMS.rainPerDay`. Dry and wet worlds play the same once started.
- **Moisture is generous near any water.** `fieldMoisture = max(own,
  0.8·e^(−d/2.5))` gives full crop growth within ~2 cells of water, and
  on typical soils the own groundwater already exceeds 0.35: 60 % of known
  land is farmable on seeds 3 and 11 at the start.
- **Founding needs nothing from the player.** 36–43 blocks score ≥ 0.55
  (`FOUNDING.minScore`) on seeds 3 and 11 without any works: second and
  third villages come by themselves.
- **Milestones come by waiting.** 15, 30 and 50 villagers within the
  first year on seeds 3 and 11, 250 by year 4.
- **Villagers solve erosion themselves.** They line banks within 3 cells
  of buildings, yards, fields *and* paths, so a meander eating a field is
  handled without the player.
- Seed 7 shows the other failure mode: only 20 % farmable and no block
  ≥ 0.55, so no second village ever, and the first one hovers hungry.
  Growth is limited by *chronic hunger*, which reads as misery; it should
  be limited by *land*, with hardship only seasonal. Fix: families stop
  arriving and births pause while `foodSecurity < 0.5` (today births only
  slow to 0.3× and arrivals are gated only by wellbeing), so a village
  levels off with food in the store.

So the player's real contribution today is optional decoration (lakes,
waterfalls) plus marginal new fields. Nothing the player does is
*needed*, and nothing visibly breaks or blooms because of it.

### 4.2 Target
- **Unaided**, the first village settles at **15–30 people** by year 3
  (weir yes, gate not quite) and stays fed, with visible seasonal hardship
  (dry fields in late summer, a flooded meadow in some springs). At most
  one extra village by year 5, and only on seeds with naturally good
  second sites.
- **With sensible works**, population **doubles within two years of the
  first good plan** and new villages follow the player's canals and dikes.
  The difference must be visible from the default zoom: green strip vs
  straw-yellow fields, dry feet behind a dike vs mud.
- **No failure.** The start site always supports ≥ 8 people unaided in
  the worst year; the recovery floor (PEOPLE §4) stays.

A test pins this (§7, item 2): `tools/agency.ts` runs 5 seeds × 4 years
unaided and with a scripted "obvious" plan (an intake canal onto the
terrace), and asserts the ratios above. This is the regression test for
"the player matters".

### 4.3 Problems the land poses, and the mechanics behind them

**P1 — River seasons and dry years (the big one).**
Multiply every boundary inflow by
`Q(t) = base · season(t) · anomaly(year)`.
- `season`: a smooth (cosine-interpolated between season midpoints)
  profile per climate (§5); temperate `[1.6, 0.45, 0.8, 1.0]` for spring,
  summer, autumn, winter, plus a **freshet**: in the first 8 days of
  spring an extra ×1.0 bump (snowmelt), more after a snowy winter
  (scale by the season's snowfall vs its mean, clamped 0.5–2).
- `anomaly`: AR(1) per year, `a' = 0.6 a + 0.4 ε`, `ε ~ N(0, σ)`,
  `σ = 0.25`, factor `exp(a)` clamped to `[0.55, 1.6]`. The same factor
  scales rain-front frequency (`frontsPerDay × exp(0.8 a)`). Drawn from
  the weather RNG at New Year: deterministic and saved. A "dry year"
  (factor < 0.75) about one year in six.
- Effect: in late summer the river shrinks to half its width, the 2-cell
  capillary strip moves with it, margin fields go straw-yellow; in spring
  the floodplain goes under for a week. Both are the setback kind of
  hardship, never extinction.
- Player answers: **weir** (holds a pool through low water: the strip
  stays put), **reservoir + gate** (§2 releases in summer), **dike**
  (freshet off the fields), **intake canal** from upstream.

**P2 — The terrace start.** Change `chooseStart` to prefer a **dry
terrace above a floodplain**: flat land 2–6 m above the nearest river
surface, 8–20 cells from it, mean own moisture < 0.3, with ≥ 60 cells of
fertile (≥ 0.6) floodplain between it and the river. Score
`1.0·terraceFlatness + 0.8·floodplainFertility − 1.5·ownMoisture +
0.5·(2 ≤ height above river ≤ 6)`, keeping the centre bias. The family
settles on the terrace (dry feet, safe), farms the floodplain strip and
river bank. Unaided: a decent but floodable and summer-dry living. The
obvious first plan — a trench from 200–400 m upstream, graded down onto
the terrace — turns the terrace green. A dike along the floodplain makes
it safe in spring. Both are the starting tools, so the first hour has a
point.

**P3 — Floods that matter, and that dikes visibly cure.**
- Fields are claimed in flood-remembered land (they are today, `buildable`
  allows `floodMemory < 60`), but drown in the freshet: crop −60/day
  already, so P1 makes this real.
- Flood memory forgets *fast once the cause is gone*: at the end of each
  spring, any cell that was not wet (> 0.3 m) during that spring loses
  100 memory. So one dry spring behind a new dike frees the land for
  fields and houses the next year (today it takes ~4 years: 255 → 60 at
  1/day).
- New achievement **Dry Feet**: village land flooded last spring is not
  flooded this spring and the player's dike lies between it and the water.

**P4 — Marsh to meadow.** On marsh-edge starts and lowland climates (§5),
peat basins with groundwater at the surface (`moisture ≥ 0.9`: crops ×0.4,
no houses). A drainage trench from the bog to the river lowers the water
table through lateral groundwater flow: within a season the bog cells
fall below 0.9 and become top fields (peat fertility is high). Worldgen:
the marsh start guarantees ≥ 80 boggy cells within 15 of the centre.
Tune: check that lateral Darcy flow actually drains 3–4 cells either side
of a 1 m trench within ~10 days; if not, add a drain term (cells next to a
lower water surface lose groundwater at `k·Δh`). Achievement **Drained**:
≥ 30 cells that were boggy at the start are fields.

**P5 — The river takes a field.** Villagers line banks only within 3 cells
of **houses and yards** (`WORKS.near` no longer counts fields and paths),
and the player's canals near home as now. So a meander can now eat into
fields (bank erosion exists, `bankK`); the player answers with a weir
upstream (calmer water), a cut-off trench, or a dike set back from the
bank. Setback, not failure: fields are re-claimed elsewhere.

**P6 — Dry plateaus for new villages.** Migrants judge land at its worst:
`surveyLand` runs as now, but founding uses
`min(score now, score at the end of last summer)` (a stored copy of the
day-22 survey). Raise `FOUNDING.minScore` 0.55 → 0.6. With P1 the
natural river margins fall below it in late summer, so a second village
needs land the player keeps wet all year (canal, reservoir, wheel). Keep
the `crowdedPopulation` trigger, but have crowded villages *grow onto*
irrigated land near them before founding far away.

**P7 — Water carriers.** With wells (§1.1), a terrace village far from the
river shows carriers until it gets a well. Visible, gentle, and changed
by the player's reservoirs raising the water table.

### 4.4 Tuning that goes with it
- `FIELD_RADIUS` 22 → 18: villages farm closer, so where water is matters
  more than how much land there is.
- Capillary reach: keep `0.8·e^(−d/2.5)` but use the **water present
  today**: with P1 the strip follows the shrinking river (it already
  does, as `waterDist` is daily; P1 makes it bite).
- `PARAMS.evapPerDay` × (1 + 0.5 × summer anomaly heat) in dry years, so
  open reservoirs lose some water and deep ones (fewer cells per m³) win:
  a reason to dig deep with Level instead of flooding flats.
- Measure with `tools/agency.ts` before touching `YIELD` or the economy;
  P1+P2 alone may hit the §4.2 targets.

### 4.5 Revised unlock progression (lining is no longer a player tool)

Remove the Lining tool from the palette (villagers line banks by their
homes and the player's canals near the village; `Structures.planLining`
stays for weirs, gates and wheels). Digit keys shift accordingly.

| Unlock | Tool | What it newly lets the player solve |
|---|---|---|
| start | Trench | Intake canals onto the terrace (P2), drainage of a bog (P4), cut-offs for an eating meander (P5) |
| start | Dike | Freshet off the floodplain (P3), ponds and small reservoirs |
| start | Level | Terraces on slopes, deep basins (less evaporation), a flat site for a village |
| start | Remove | — |
| 15 | **Weir** | Keep the river's pool through low water (P1); raise the river so a short intake works; calm water for fish; a head for a mill (§1.2) |
| 30 | **Sluice gate** | Seasonal reservoirs: villagers release in summer (§2); flood relief that opens itself |
| 50 | **Water wheel** | Water *uphill* onto terraces and plateaus where no gravity canal reaches (P6); new villages on high land |
| 100 | **Turbine** (M6) | Power from head × flow at a gate or weir; mills become power houses |
| 150 | **Power pole** (M6) | Lit cottages, larger houses (higher cap) |
| 250 | **Electric pump** (M6) | Any lift; pumped storage for evenings and winter |

With §4.2 the 15 milestone comes unaided in the first year; 30 needs the
player's first good works; 50 and beyond need the player to open new land.

---

## 5. Variety: what makes two worlds play differently

**Today**: the seed picks terrain style (mountains / plain / hills /
mixed / highlands), the river network and a wind direction. But the live
climate is the same everywhere, rivers are steady, and the start is
always the prime river meadow, so every game opens the same way: a
village by a big river that grows by itself. Seed 7 vs seed 3 differ
mainly in where the *second* village can go.

**Should**: each world has a **climate**, a **start-site type** and a
**river character**, chosen from the seed (and the terrain style), shown
as one line in the menu's world card ("A dry steppe valley", "A wet
lowland with a marsh") and nowhere else.

### 5.1 Climates (parameter bundles applied over PARAMS)

| Climate | rain × | fronts/day (sp, su, au, wi) | temp mean / amp (°C) | evap × | inflow season (sp, su, au, wi) | anomaly σ | Main problem |
|---|---|---|---|---|---|---|---|
| Temperate | 1.0 | 0.7, 0.35, 0.6, 0.45 | 9 / 12 | 1.0 | 1.6, 0.45, 0.8, 1.0 | 0.25 | late-summer low water, moderate freshet |
| Steppe | 0.55 | 0.5, 0.12, 0.3, 0.3 | 11 / 15 | 1.5 | 2.2, 0.3, 0.5, 0.7 | 0.3 | drought; exotic river from far mountains; wells, wheels |
| Alpine valley | 1.25 | 0.7, 0.55, 0.6, 0.5 | 4 / 11 | 0.8 | 2.8, 1.2, 0.6, 0.35 | 0.2 | violent snowmelt freshet, gravel fans, steep terraces |
| Monsoon | 1.1 | 0.25, 1.3, 0.5, 0.08 | 18 / 6 | 1.3 | 0.6, 2.4, 1.0, 0.4 | 0.25 | summer floods then a long dry; reservoirs + gates |
| Lowland marsh | 0.9 | 0.6, 0.4, 0.6, 0.5 | 10 / 10 | 0.9 | 1.2, 0.8, 1.0, 1.1 | 0.15 | waterlogging; drainage, dikes, polders |

- Choice: `mountains`/`highlands` → alpine 50 %, temperate 50 %;
  `plain` → steppe 35 %, marsh 35 %, monsoon 30 %; `hills`/`mixed` →
  temperate 60 %, steppe 20 %, monsoon 20 %. Bias by `TerrainGen.wetness`
  (dry → steppe, wet → marsh/monsoon). The very first world a player gets
  (and the README seed) is temperate.
- **The live weather uses the generation climate.** Multiply each
  front's rain by the macro rain map (`sampleMacro(grid.rain, …)`,
  normalised to mean 1) so rain shadow and wet slopes persist in play.
- Climate is saved with the world (one byte + the bundle id); the macro
  rain map is recomputed from the seed.

### 5.2 Start-site types
- **Terrace** (temperate, steppe default) — P2.
- **Marsh edge** (lowland) — dry rise beside ≥ 80 boggy cells, P4.
- **Fan** (alpine) — at a valley mouth where a steep stream leaves the
  mountains: gravel, braiding, a freshet that shifts channels; levelled
  terraces and a weir are the game.
- **Oasis** (steppe, 1 in 3) — a spring and small lake, the main river
  > 40 cells away; the wheel and long canals open the world.
- **Delta bank** (monsoon) — a low natural levee between river and back
  swamp; dikes and gates.
Each type is a `chooseStart` scoring function; fall back to terrace if
nothing scores. Guarantee for all: ≥ 12 farmable cells within 10 of the
centre in the driest season of an average year (no failure).

### 5.3 River character
Knobs on the macro network and carving, by climate: `riverScale`
(discharge), sinuosity (meander amplitude in `carve`), bed material
(gravel → braided, wide and shallow, moves in freshets; silt → single
meandering channel), and **no through-river** (1 in 8 steppe/oasis
worlds: springs and a closed lake only). Confluences (two inflows meeting
near the start) as a 25 % variant: two regimes, one of them flashier.

---

## 6. Things to drop or change in the docs as built
- DESIGN §4: remove Lining from the tool table (villager work only);
  Well/pump and Water wheel/mill rows per §1; Sluice gate text per §2.
- ACHIEVEMENTS: "Stone by Stone" → "Villagers line your canal" (a
  villager lines a `CellFlag.Canal` cell); "Gatekeeper" per §2.4; new:
  Dry Feet, Drained, Miller's Head (a mill on the player's head site),
  Uphill (a field watered by a wheel's trench), Safety Valve, Wellspring
  (a village digs a well within 10 cells of the player's works).
- ROADMAP M1c: the "climate anomaly" item is §4.3 P1 and should be done
  first.

---

## 7. Prioritised implementation list

1. **River seasons + dry/wet years** (P1): inflow multiplier, freshet,
   AR(1) anomaly on inflow and front frequency; live rain × macro rain
   map. `sim/climate/weather.ts`, `hydro/soilwater.ts` (inflow), saved
   state. *Small change, biggest effect.* Long-run stationarity test
   still passes (sediment controller follows the inflow).
2. **Agency harness** `tools/agency.ts` + a slow test: unaided vs a
   scripted intake canal on 5 seeds × 4 years; report peak population,
   villages, dry-field days, flood cells. Targets §4.2. Use it for every
   later item.
3. **Terrace start** (P2), fast flood-memory forgetting (P3), lining only
   by houses (P5), founding judged at the end of summer + minScore 0.6
   (P6). Retune with the harness.

   *As built (items 1 and 3, October 2026).* `sim/climate/climate.ts`;
   freshet ×2.0 (×1.0 barely wetted the floodplain: carved channels hold
   a 2.5× flow), AR(1) `a' = 0.6a + 0.24ε` (sd ≈ 0.3). Measured with a
   hands-off probe (128², 3 years, seeds 1/3/5/7/11), P1 + P3 alone barely
   changed growth (seed 3: 49/115/226 people at the ends of years 1–3, vs
   36/83/167 before): the land stays moist (own saturation hardly moves
   over a summer), yields are high and growth is limited by arrivals, not
   food. So the economy was retuned too (PEOPLE §3.1): own soil counts
   0.6 against capillary water, crops need 0.4, land is claimed only where
   crops grow at least half as well, yield 34 → 8 per field, 14 fields per
   farmer, growth pauses below food security 1, new villages from 40 people
   (crowded 30). Result at the end of year 3, unaided: 41, 23, 37, 15, 79
   (three villages) for seeds 1, 3, 5, 7, 11 (before: 206, 167, 181, 27,
   185). A crude scripted intake canal (straight trench from the nearest
   higher bank) gave 30, 70, 42, 9, 38: a clear gain on seed 3, noise or
   damage elsewhere; the agency harness (item 2) has to judge this
   properly. Spring brings a hungry month on several seeds (food security
   dips before the first harvest).
4. **Unlocks**: remove the Lining tool; weir 15, gate 30, wheel 50
   (`shared/unlocks.ts`, `ui/tools.ts`, hotkeys, e2e).
5. **Villager-operated gates** (§2), achievements Gatekeeper/Safety Valve.
6. **Help**: hint rewrite (§3.1) — an hour's work, do it with item 4;
   then "Ideas for this valley" in the Achievements card; then unlock
   cards with staged scenes (weir, gate, wheel).
7. ☑ **Wells** (§1.1) with the water-carrier cue.
8. ☑ **Mills** (§1.2) at head sites.
9. **Water wheel** tool (§1.3).
10. **Climates and start-site types** (§5): temperate first as today's
    default, then steppe and lowland marsh (they exercise P1 and P4
    hardest), then alpine and monsoon.
11. **M6**: turbine in gate/weir passages, poles, lit houses, electric
    pump, pumped storage, turbine gate mode (§1.5).
