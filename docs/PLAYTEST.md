# Hydro — Automated playtests

A headless harness that plays the game many times over, hands-off and with
simple scripted "player bots", and turns the runs into numbers about
playability: does the village thrive without help, does the player's work
make a difference (and how fast is it visible), how different are the
worlds, and how eventful is the game in real time at 1×.

It is a measuring instrument for tuning, not a test: nothing here asserts
balance. (A smoke test, `tests/tools/playtest.test.ts`, checks that the
bots act on a small world and that the forked control copy is identical.)

## How to run

```sh
npm run playtest -- --seeds 1..8 --years 10 --bot-years 4 --jobs 4
npm run playtest -- --seeds 1,3 --days 96 --bots irrigate,vandal   # quick look
npm run playtest -- --seeds 1..8 --years 10 --bot-years 4 --summary-only
```

| option | default | |
|---|---|---|
| `--seeds` | `1..4` | ranges and lists, `1..8` or `1,3,5` |
| `--years` / `--days` | 5 years | length of the hands-off runs |
| `--bot-years` | = years | length of the bot runs (their effects show within a few years) |
| `--size` | 128 | map size; the game uses 256, but that is ~4–10× slower |
| `--bots` | all | `baseline` always runs; bots: `weircanal,wheel,dike,drain,vandal,undo,good,irrigate` |
| `--budget` | 6000 | earth each bot may move over the run (m³, dug plus raised) |
| `--jobs` | CPU count | child processes at a time |
| `--act-day` / `--check-every` | 16 / 12 | the first day the bots look at the world, and how often they look again |
| `--window` | 36 | days the untouched control copy runs alongside after a bot's first action |
| `--ignore-unlocks` | off | let bots use tools before their population unlock |
| `--out` | `out/playtest` | results dir (gitignored) |
| `--force` / `--summary-only` | | rerun cached jobs / only rebuild the summary |

Each job (one seed × one bot) writes `<out>/<bot>-s<seed>-<size>-<days>d.json`;
results with the same spec are reused, so an interrupted run resumes. The
markdown summary goes to `<out>/summary.md` and stdout.

Cost: on this container a 128² game day takes 1.5–8 s per process (much
more with other agents' tests running), so a ten-year 128² run is about
half an hour to an hour; the full matrix above (8 hands-off runs × 10
years, 40 bot runs × 4 years) took several hours with 4 jobs.

## Method

**New game exactly as in the browser.** `src/sim/newgame.ts` (also used by
the worker) generates the world, spins it up for a day, resets the clock
and history. Everything is deterministic: the same seed and bot give the
same result; the harness only reads sim state and issues ordinary
`Command`s through `Simulation.command`. Real time is nominal 1×
(20 steps/s: a game day is 30 s, a year 24 min).

**What is recorded** (`tools/playtest/observe.ts`):
- daily: population, prosperity (population-weighted wellbeing, as in the
  stats bar), villages, houses, field cells, food security
  (`Settlement.foodSecurity`, each village capped at 2), share of fields
  under dry stress in the growing seasons;
- per season (mid-season): the above plus revealed area, food per head,
  dry/waterlogged field shares, mean field moisture, forest cover and
  cumulative counters (land cells newly flooded, houses ruined, people
  fleeing, families' arrivals/departures, births/deaths);
- milestones: the day the peak population first reached each progression
  milestone (`src/shared/unlocks.ts`: weir 15, gate 30, then 50, 100, 150,
  250 reserved for later tools) and 200/400; the day of every founding;
- notable events for pacing: house finished, village founded, flood
  episode (≥ 5 land cells newly flooded or a house ruined), people
  fleeing, unlock, milestone, family arrived / left, a village's visible
  mood changed, fields grew by ≥ 4 cells beyond their largest extent, the
  river channel moved (≥ 15 cells of channel more than 2 cells from where it
  ran in the same season a year before), achievement earned. "Major"
  events leave out the routine ones (house, field, arrival, mood).
- world descriptors: relief, mean slope, river sources at the edge and
  their inflow, river/water share, distance from the start point and from
  the first village to the nearest river, soil saturation and fertility
  around the start; from the run: precipitation and evaporation (mm/yr),
  flood episodes per year, channel change per year.

Arrivals and departures are computed by `Settlement.day` but not kept; the
harness wraps that method to count them (observer only).

**Player bots** (`tools/playtest/bots.ts`) look at the world like a
player: villages, their fields and field moisture, water and flow
direction, flood memory, known land. They respect the tool unlocks
(population peak), act from `--act-day` and look again every
`--check-every` days. Since round 3 every bot has the **same earth
budget** (`--budget`, default 6000 m³ dug plus raised over the run;
`canal.ts earthOf` prices a plan before it is issued, the run records
what `Simulation.brush.moved.script` actually counted); weirs (stone,
built by the crew) and wheels do not count against it. Earthworks are
`shapeLine` commands (the brushes' rules, at once); a dig may give
absolute floor heights, so a canal is graded to a water level in one
stroke. Canals are laid out by `canal.ts planCanal`: a Dijkstra over the
land from the water's edge whose water surface falls 6 mm a cell and
never stands above the ground beside it (no spills), that keeps off lower
water (or it becomes the river's bypass), costs cut depth and fields
crossed, and ends where it waters most dry land outside its own
footprint for its cost.
- `weircanal` (a): once the weir is unlocked, a stone weir (1.5–4 m) across
  flowing water 8–45 cells from the village whose pool fills within 12
  days and reaches no house, with a graded canal from the pool's shore onto
  the dry land (fields and fertile open land the river does not keep
  moist); only if the canal waters clearly more than the pool drowns;
- `wheel` (b): a water wheel at one of `wheelSites()`, its trough drawn up
  the bank (≤ 6 cells, the stroke that gives the best canal), and a canal
  from its head, no longer than the wheel's water keeps wet (perDay/2.5
  cells). The wheel unlocks at 50, which few valleys reach in four years,
  so this bot builds it from the start: it measures the mechanic;
- `dike` (c): once the land near a village remembers a flood, a dike
  2.5–3.5 cells back from the river along the stretch in front of the low
  fields and houses, its crest 0.4 m above the highest flooded ground
  (1.5–2.5 m above the river), ends tied into higher ground; again when new
  flood memory appears;
- `drain` (d): up to three drains per village, from the wettest patches
  (soil saturation or field moisture ≥ 0.9, or puddles) down to lower
  water, floor 0.8 m under the patch graded to just under the outlet;
- `vandal` (e): a canal from the shore with the most head straight into the
  first village's store, and a dam across the river just below the intake
  (no budget);
- `undo` (e): the vandal's works, then 48 days later the dam trenched to
  the river bed and the canal filled back to the ground it was dug into
  (in 3-cell pieces), and on the next two looks a drain from what is still
  wet by the village;
- `good`: a sensible player combining (a), (c) and (d): drains and dikes
  where needed from the first look (at most 20 % and 25 % of the budget),
  the weir + canal once unlocked with the rest;
- `irrigate`: round 2's bot (a trench from the nearest usable shore to the
  driest land), kept for comparison.

Dev tools: `tools/playtest/try-bot.ts` (a bot's first look at a cached
game day and the response a few days on), `exp.ts` (jobs in-process with
tunables overridden: `--set FARMING.yield=12`; `--floods` gives every
spring from the third year a big freshet), `diag-start.ts` (how each
seed's start was chosen and the land in its field radius), `diag-map.ts` (ASCII map
of a village after a bot's works), `diag-crops.ts` (fields sown, ripe,
who does what), `table.ts` (the round tables below).

**Agency and response latency.** The day a bot first acts, the game is
forked (save → load; the state hashes are compared) and the untouched copy
runs alongside for `--window` days. The bot's target cells (the dry
fields, the wet patch, the future reservoir, the houses) are probed daily
in both: mean water depth, field moisture, soil saturation, crop stress
and flooded cells. The first visible response is the first day the
difference passes a threshold (5 cm, 0.05, 0.05, 8 stress units, one
cell). Outcome deltas are the bot run minus the hands-off run of the same
seed (which share everything up to the first action).

## Findings (first run)

`npm run playtest -- --seeds 1..8 --years 10 --bot-years 4 --jobs 4` on
main after the agency1 merge (50b3684: river seasons, wet/dry years,
terrace start, economy retuned). It took 2.2 hours with 4 jobs on a
shared container. Main has since gained wells and mills (no bot uses
them) and simulates only the revealed land plus a margin; re-run to
confirm the numbers on a later main.

Caveats: **128² maps**, not the game's 256² (256² is 4–10× slower), so
the start disc already shows most of the map and there is little room
for further villages; revealed area is not representative. Bot runs last
**4 years** and are compared with the hands-off run of the same seed on
the same day. One run per seed and bot: villages are stochastic and a bot
run diverges from the baseline after its first action for reasons
unrelated to it; with villages of 15–80 people, per-seed differences of
±30 % happen by chance (e.g. two bots that change nothing near seed 2's
village end at 57 and 86 people against a baseline of 37). Read the
means over seeds, not single rows.

An earlier run on the main before agency1 (a93081c, same command) is
kept for comparison where it says something about the retune.

### 1. Does the hands-off village thrive?

| seed | relief m | slope | pop y1 | y2 | y4 | y10 | prosp. y10 % | food sec. y10 | villages | min to 15 (weir) / 30 (gate) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 31 | 0.05 | 36 | 41 | 43 | 53 | 63 | 0.35 | 1 | 7 / 13 |
| 2 | 21 | 0.04 | 22 | 23 | 37 | 174 | 67 | 0.54 | 4 | 8 / 73 |
| 3 | 84 | 0.10 | 12 | 17 | 41 | 259 | 81 | 0.88 | 5 | 38 / 84 |
| 4 | 12 | 0.03 | 12 | 14 | 51 | 116 | 62 | 0.37 | 2 | 36 / 81 |
| 5 | 59 | 0.12 | 33 | 37 | 42 | 51 | 60 | 0.26 | 1 | 7 / 14 |
| 6 | 10 | 0.02 | 27 | 33 | 74 | 109 | 63 | 0.45 | 3 | 9 / 40 |
| 7 | 150 | 0.48 | 17 | 12 | 13 | 14 | 59 | 0.23 | 1 | 11 / – |
| 8 | 186 | 0.44 | 21 | 16 | 21 | 21 | 58 | 0.30 | 1 | 13 / – |

- **The start is no longer too habitable, but it is still generous at
  the beginning.** Every seed reaches the weir unlock (15) hands-off, in a
  median of **10 real minutes** (day 19); the gate (30) on 6/8 seeds in a
  median of 56 minutes. Before the retune all of them came within 35
  minutes and on six seeds the villages grew to 360–1080 people at
  95–100 % prosperity; now populations level off at 14–260 after ten years, and
  only half the seeds found a second village (median day 167).
- **Prosperity settles at about 60 %** (median 62 % in year 10, 58–81 %)
  on every seed, and food security below 1 (median 0.36): the villages
  are stationary but chronically short of food. The stats bar therefore
  reads "so-so" for most of a game, whatever happens. Year 1 is the best
  year everywhere (82–95 %; the founders bring 400 days of food).
- 60 % is a floor, not an equilibrium of the land: wellbeing is
  0.55·min(1, food security) + 0.2·housing + 0.15·water + 0.1·safety, so a
  housed, safe village never drops below 0.45 even with an empty store,
  above `ECONOMY.leaveBelow` 0.4. **Nobody ever leaves** (0 departures in
  80 village-years, both runs); a hungry village only stops growing (the
  growth pause below food security 1) and loses people slowly to deaths.
- The steep seeds 7 and 8 (slope > 0.4, relief 150–186 m) stay at 12–21
  people, food security ~0.25, with 45 % of their few fields dry-stressed;
  on seed 7 the village sits 83 cells from the river.

### 2. Agency: immediate feedback, unclear consequence

| bot | acted | built in | first visible change | Δ pop (4 y) | Δ prosperity pts | Δ dry fields pts | Δ flooded cells | Δ houses ruined |
|---|---|---|---|---|---|---|---|---|
| irrigate | 8/8 | 1–2 days | same day (moisture, depth) | −6 | +0.1 | −3.2 | +27 | 0 |
| dike | 8/8 | 1 day | 0–35 days, on 5/8 seeds | −0.4 | 0.0 | +5.6 | +6 | 0 |
| weir (at 15 villagers) | 4/8 | 1 day | same day (+0.1–0.3 m) | +7 | −1.4 | −5.6 | +4 | 0 |
| drain | 7/8 | 1–2 days | same day (depth) | +4 | +0.3 | +3.6 | +11 | 0 |
| vandal | 8/8 | 1–3 days | same day | −28 | −32 | +3.1 | +61 | +3.5 |

(Baseline population at year 4: median 42.)

- **Local feedback is excellent:** the spirit crew finishes every plan
  within one or two days, and the target cells respond the same day: the
  dry fields at the canal end are 0.08–0.30 wetter in field moisture, the
  reservoir behind the weir 0.13–0.33 m deeper, the drained patch lower.
- **But the villages hardly notice.** Averaged over seeds the beneficial
  bots change the population by −6 … +7 (out of ~40) and prosperity by
  about a point: less than the run-to-run noise. One canal to the driest
  quarter of the fields lowers the dry-stressed share by only 3 points;
  the weir by 6. A village has hundreds of field cells (140–2400) spread
  over the land around it, and one canal wets a strip a few cells wide
  (capillary reach 2.5 cells). A player would need many canals before the
  stats bar moves, and nothing shows that more canals would pay.
- Canals that end in the fields flood some of them (+27 flooded land
  cells for irrigate); before the retune that was enough to cut seed 1's
  prosperity from 93 to 68 %.
- Dikes do nothing measurable: floods are rare and mild (0–0.4 episodes
  a year, ≤ 2 houses ruined in ten years on any seed). The dike bot also
  only finds water that is there on its checks; a spring flood over the
  fields (seed 7 before the retune, 90 of 120 field cells under water)
  needs flood-memory-driven placement.
- **Harm is strong and permanent:** the vandal's diversion canal and dam
  ruin 2–7 houses and leave 7 of 8 villages at 5–10 people and ~40 %
  prosperity for the remaining four years, with no recovery: nobody
  leaves, nobody arrives (arrivals need w > 0.6) and a new village needs
  40 people in the valley. PEOPLE.md's "setbacks and recovery in 3–8
  years" does not happen.

### 3. Variety

- Outcomes spread widely (final population 14–259, CV 0.79), but the
  spread is in size, not in kind: prosperity converges to ~60 % on every
  seed (CV 0.11).
- Relief and slope decide most of it (seeds 7, 8 stall); water much less:
  seed 1 with a 0.7 m³/s brook and seed 6 with 66 m³/s end at 53 and 109.
  Rainfall varies 68–135 mm per (48-day) year.
- Floods are rare everywhere (≤ 0.4 a year); the rivers move 0–11
  channel cells a year (more on the steeper seeds; flat seeds 2, 4 are
  static).

### 4. Pacing

| | year 1 | year 2 | year 3 | years 4–10 |
|---|---|---|---|---|
| events per real hour (median of 8 seeds) | 105 | 24 | 23 | 20–110 |

- The first year is busy (houses, fields, arrivals, unlocks:
  65–180 events an hour at 1×). **Then the game goes quiet for about an
  hour of real time:** in years 2–3 hands-off villages stop growing (food
  security below 1 pauses arrivals), and the rate drops to 13–48 events
  an hour on every seed. All four 15+ minute silences of this run fall in
  year 2 (days 67–163). Seeds that later found new villages pick up again
  (seed 3: 100–160/h from year 4); small ones stay at 15–30/h.
- "Major" events (new village, flood, unlock, milestone, river shift,
  people fleeing) come 5–13 times an hour; the longest gap between them
  is 20–85 minutes.
- Hands-off, the progression goals are reached early (weir) or never
  (gate on 2/8 seeds, the later milestones on half); 8–16 achievements per
  world arrive without the player.

### 5. Oddities found on the way

- "Fleeing" fires constantly without floods (hundreds to 12 000 onsets in
  ten years; up to 100 000 before the retune): `PeopleSystem.updateAgent`
  makes anyone standing in water deeper than 0.3 m flee, but people wade
  up to 0.4 m (`MAX_WADE`), so every ford crossing is a flight with the
  Run animation. The flee counts in the tables are therefore not floods.
- Departures are effectively dead code (see §1).

### Tuning suggestions (not applied; for the design review)

1. **Let wellbeing fall, so hunger has a visible consequence and
   recovery a trigger.** In `Settlement.day` (settlement.ts), weigh food
   more (0.55 → 0.7) and housing/water/safety less, or multiply the food
   term in, so that a hungry village can drop below `leaveBelow` 0.4 and
   families leave, then come back when food returns. Pair with a migrant
   trickle to small villages (e.g. `arriveAbove` 0.6 → 0.45 below ~10
   people) so the vandal's village recovers in a few years.
2. **Make one canal matter.** With food security ~0.36 the villages are
   water-limited now, but one canal reaches too few fields. Options:
   capillary reach (`CAPILLARY.reach` 2.5 → 4–5 cells, or `max` 0.8 →
   0.9) so a canal through the fields wets a band of ~10 cells; or let
   villagers dig short field ditches off the player's canals (M4
   "NPCs build their own small works"). Target: the irrigate bot's
   Δ prosperity ≥ +10 points within two years.
3. **Fill the year-2 lull.** Hands-off villages stall exactly when the
   player has the weir and nothing to aim for. Either keep the start a
   little hungrier (founders' food 400 → ~250, so the first shortage and
   the stats bar's dip come in year 1 while the player is still
   watching, with a clear water-related cause), or give year 2 a nudge:
   a dry summer from the climate anomaly early in the game, so the
   first canal has an obvious job.
4. **Prosperity as a readable stat.** With a floor at ~45 % and a
   typical 60 %, the bar barely moves. Show it relative to the village's
   own best (or food security directly), or move the floor down (1.).
5. **Unlocks.** Weir at 15 comes in ~10 minutes hands-off, before most
   players have dug a canal; gate at 30 comes late or never on small
   valleys (2/8 seeds never). Consider tying the gate to the player's
   works (e.g. a weir built) rather than to population alone.
6. **Floods as events.** ≤ 0.4 floods a year and ≤ 2 ruined houses in ten
   years: dikes have nothing to do. A stronger or more variable freshet
   (agency1's river seasons) or rare big floods would give flood
   protection a purpose and the equilibrium some drama.
7. **Start site and steep seeds.** `chooseStart` (worldgen) sometimes
   lands far from the river on steep land (seed 7: 83 cells, slope
   0.48); such villages stay at ~15 people all game. Either penalise
   steepness and distance, or keep them deliberately as "hard" valleys
   where the player's canals are the only way up.
8. **Fix flight while wading** (§5): flee only above `MAX_WADE`, or when
   the water is rising.

Re-run after a change and compare `out/playtest/summary.md` (keep the
old results dir to compare against).

## Round 2 (tune2, October 2026)

The findings above, addressed on branch `tune2` (lead's decisions 1–8),
measured with the same command (`--seeds 1..8 --years 10 --bot-years 4`,
128²). "Before" is main at 336195b (wells and mills, revealed-land
simulation); "after" is tune2 at 89a0300, before main's footbridges and
fields-by-walking-distance (b70fa7f) were merged in: the runs on top of
those were cut short by container restarts and a heavily loaded machine
(load 25–30), so they still need a re-run. Bot runs after: `irrigate` and
`dike`; `vandal`/`undo` only as a short check (below).

### What changed
1. **Hunger has consequences.** Wellbeing multiplies food in:
   `(0.1 + 0.9·min(1, S)) · (0.6 + 0.4·comfort)`; departures 0.05 per
   household and day per unit below 0.4 (was 0.02), never the last four
   people. Growth needs food for `max(daysToHarvest, 40) + 6` days (without
   the horizon, arrivals poured in just before the harvest day and starved
   through the spring: a yearly boom and bust). Villages under 12 take
   migrants from wellbeing 0.45 and build for them from 0.4.
2. **Player canals.** Farmers dig field ditches off the player's canals
   (`people/ditches.ts`); canal and ditch water wets 4 cells (rivers 2.5).
   To make water the limit at all, the economy was retuned so that land,
   not hands, bounds a village: crops need moisture 0.22/0.46 (was
   0.2/0.4) and grow 11 a day (was 16; late harvest of what stands in
   autumn), 28 fields a farmer at yield 10 (was 14 at 8). Shallow standing
   water (≤ 0.15 m) only slows crops; fields standing in water at sowing
   are given up; a starving village that lost its land farms poorer land.
   The irrigate bot aims at dry land, not just dry fields.
3. **Big freshets** from the third year, about one year in four (likelier
   when wet), 3–4.5× the usual freshet for 12 days.
4. **The second year is dry** (anomaly ≤ −0.35).
5. **Start**: the meadow fallback penalises steep land, water farther than
   14 cells or > 5 m below, and wants a river with water in it (a lake
   shore start on seed 7 drowned in the first big freshet).
6. **Flight** only from water deeper than `MAX_WADE`.
7./8. Measured below; an `undo` bot was added.

### Hands-off (baseline), before → after

| seed | pop y2 | pop y4 | pop y10 | prosp. y10 % | left | fled | flooded cells | ruined | day to 15 / 30 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 48 → 30 | 55 → 37 | 60 → 33 | 61 → 84 | 0 → 0 | 11928 → 274 | 32 → 24 | 0 → 0 | 10/27 → 32/86 |
| 2 | 30 → 25 | 87 → 64 | 234 → 163 | 76 → 85 | 0 → 5 | 4243 → 114 | 169 → 1213 | 7 → 13 | 11/82 → 36/122 |
| 3 | 33 → 26 | 78 → 52 | 277 → 179 | 65 → 84 | 0 → 16 | 6598 → 155 | 99 → 63 | 2 → 0 | 20/72 → 36/132 |
| 4 | 36 → 28 | 78 → 49 | 112 → 63 | 57 → 86 | 0 → 0 | 514 → 159 | 20 → 240 | 0 → 3 | 15/70 → 33/133 |
| 5 | 21 → 23 | 32 → 29 | 42 → 19 | 58 → 56 | 0 → 8 | 131 → 6 | 14 → 7 | 0 → 0 | 66/172 → 39/316 |
| 6 | 24 → 24 | 47 → 33 | 104 → 35 | 62 → 92 | 0 → 0 | 267 → 57 | 28 → 9 | 0 → 0 | 25/118 → 78/178 |
| 7 | 16 → 6 | 14 → 5 | 13 → 6 | 57 → 72 | 0 → 4 | 1420 → 1191 | 3 → 3 | 0 → 0 | 16/– → –/– |
| 8 | 18 → 10 | 17 → 9 | 25 → 11 | 61 → 61 | 0 → 0 | 748 → 6 | 50 → 1 | 1 → 0 | 22/– → –/– |

- Villages are smaller and better fed: year-10 prosperity 56–92 % (was
  57–76 %, always "so-so"), and it now swings with the years (a dry year
  or a flood takes a village to 20–40 % for a season, then back). Families
  leave in hard times (0–16 per run; before never). Year 2–3 populations
  (23–30) sit in GAMEPLAY §4.2's unaided target of 15–30.
- "Fled" counts are now floods (6–274 on most seeds; seed 7's village
  stands by a ford it crosses often, still to be checked).
- Big freshets make floods events: seeds 2 and 4 lose 240–1213 flooded
  cells and 3–13 houses in ten years (rebuilt), the others little.
- **Regressions:** the unlocks come later (weir 15 at day 32–39 on most
  seeds, 16–20 real minutes, was 5–33 min; gate 30 at day 86–316); the
  steep seeds 7 and 8 hold only 5–11 people (seed 7 below the "≥ 8
  unaided" floor of §4.2).

### Agency

| bot | Δ pop at 4 y (mean of per-seed %, before → after) | Δ prosperity | Δ flooded cells | Δ houses ruined |
|---|---|---|---|---|
| irrigate | −10 % → −7 % (after: seeds 1–5; −12 % over 8 seeds in a run of nearly the same code) | +2 … +41 pts (seeds 1–5) | fewer | 0 → 0 |
| dike (after: a run of the code before the last start/field fixes) | −5 % → −23 % | ±15 pts | −80 % (e.g. seed 2: 1247 → 351, seed 4: 492 → 34) | after: 24 in the hands-off runs vs 1 with dikes (8 seeds, 4 years) |

- **Irrigation does not reach the +30 % target.** It raises prosperity
  (seed 5: 97 vs 56 %, seed 4: 99 vs 86 %) and, on the dry seeds 6 and 8,
  population (+15 %, +11 %), but not elsewhere. Why: (a) terrace starts lie
  2–6 m above the river, so no intake within 70 cells feeds the dry
  terrace by gravity; the bot falls back to a 1–3 m deep canal whose water
  stands far below the fields (no ditch can leave it, maxCut 0.9 m) and
  which takes more land than it waters; (b) for the first years growth is
  limited by how fast families come and houses are built, not food, so
  more food shows as prosperity, not people; (c) the second village is
  founded by chance a year earlier or later, ±20 people. What should work:
  a weir to raise the river so a short intake reaches the terrace (the
  intended weir + canal play), or a wheel; a bot that does this is the
  next step, as is founding new villages on irrigated land.
- **Dikes now have a job:** with big freshets, ruined houses fall from 24
  to 1 over 8 seeds and flooded land by ~80 %; population is lower in the
  dike runs (land behind/under the dikes, divergence), which needs a look.
- Ditches are dug as designed (3–4 per village within a season of the
  canal, 3–10 cells each).

### Unlocks and vandal (findings 7, 8)
- Gate (30): reached hands-off on 6/8 seeds after year 2 (days 86–316);
  the irrigate runs reached it on the same seeds, not earlier.
- Vandal: before, −78 % population after 4 years (every seed 4–34 people
  against 14–87). On the final code (with footbridges, `--years 4`, seeds
  1, 3, 4; population at the ends of years 1–4):

  | seed | hands-off | vandal | undo (works cut through on day 64) |
  |---|---|---|---|
  | 1 | 13, 21, 25, 25 | 11, 4, 4, 4 | 11, 8, 4, 4 |
  | 3 | 19, 27, 35, 46 | 12, 18, 17, 22 | 12, 21, 25, 30 |
  | 4 | 16, 31, 47, 62 | 10, 8, 4, 3 | 10, 8, 7, 3 |

  **Undoing does not yet bring recovery** on seeds 1 and 4: the village
  sits at the four stayers with prosperity 10–19 % for three years. The
  recovery rules are in (departures stop at four, small villages take
  migrants from 0.45 and build from 0.4, fields standing in water are
  given up and dry land claimed), so the remaining block is the land: the
  dead-end diversion canal leaves a pond over the village centre after the
  intake is closed (nothing drains it), and the store and the near fields
  stay wet. Next: let the undo bot also drain or fill the canal, and check
  whether a village whose store stands in water should move its store.

### Open
Re-run on main with footbridges and walking-distance fields; a weir +
canal bot; the dike runs' lower population; seed 7/8 floor; unlock pacing
(weir 15 now comes at ~16–20 min).

## Round 3 (tune3, October 2026)

Bots redesigned on the direct terrain API with one earth budget (see
"Player bots" above: `weircanal`, `wheel`, `dike`, `drain`, `vandal`,
`undo`, `good`, plus `canal` and round 2's `irrigate`). Building and
watching them uncovered several things that were not balance at all:

### Bugs found by the bots
- **Farmers fled from the footbridge over a player's canal** all day (the
  flee check ignored bridges; also fixed independently on main by
  `bridgefix`), and from **canal corners cut on diagonal steps** (A* let
  people step diagonally past deep water; they rounded into it and ran).
  Fields across the canal went unsown and the village starved: seed 3's
  weir + canal village sowed 56 of 313 fields by mid-spring (baseline: all).
  Now: no diagonal step past water deeper than wading depth, and people run
  only from water clearly deeper than that (`FLEE_DEPTH` = 0.65 m). Seed 1's
  hands-off village had 3542 flights in four years at a ford; now none.
- **A canal from a weir's pool became the river's bypass** when it started
  by the weir's end (the pool drained round the weir through it). The
  planner keeps canals off water lower than their own.
- **A mill at the weir's drop held the harvest.** Every sack went to the
  mill and waited for the one miller, so the store looked empty for weeks
  after the harvest and growth (which needs food for 40 days ahead) never
  started: the good player's seed 3 village stood at 20 people for three
  years. Farmers now take their sacks to the store while grain backs up
  at the mill (`MILL.backlog` 72).
- Canals dug through fields and the houses' ring cost more than they
  watered: the planner counts the fields its footprint takes, values
  the village's dry fields over open land, and keeps out of the ring the
  houses grow into.

### Seed 1 crash (review item 13: 96 % → 12 % in years 5–6, 256²)
Re-run hands-off at 256² for seven years (main + the people fixes): the
big freshets of years 3 and 4 flooded 151 and 288 land cells and took most
floodplain fields (501 → 114 in the spring of year 4); the village could
claim back only 10 cells a day, and land claimed after the sowing window
stayed bare, so two weak harvests (with summer dry stress ~0.9) emptied
the store: prosperity 24 % in the spring of year 5, recovered to 96 % by
its end. Not a bug: drought and flood together. Made gentler: while a
village has fewer than half the fields its farmers can work it claims 30
cells a day (`FARMING.reclaimPerDay`). With that (and the other changes)
the same run never fell below 75 %. The ideas for it are the flood idea
(dike, top priority after a big freshet) and the dry-fields idea (dig a
channel), both raised by the sim; surfacing them in the HUD is fixhud's.

### Changes
- **Recovery floor 8** (`ECONOMY.stayers`, was 4): families leave only
  above it, and at or below it hunger kills nobody and births do not wait
  for a full store. Seeds 7 and 8 (steep, dry) fell to 5 in their dry
  second year; now 8–11 (hungry: prosperity 40–70 %). A better start site
  was looked for (a farmland term in the meadow start): on seed 7 every
  site near water is as steep, so it was dropped.
- **Hungry villages sow more hardy crops** (`HARDY.hungryShare` 1 below
  food security 0.5, else ¼ of the ordinary fields).
- **Canal and ditch water wets 8 cells** (`CAPILLARY.canalReach`, was 4;
  rivers 2.5): full growth within ~4.4 cells of a canal's water. With 4
  a canal's own footprint (5 cells wide) took about as much land as it
  watered.
- **Founders bring 500 days of food** (`FOUNDING.startFood`, was 400): the
  weir unlock (15) comes at day 27–35 (13–17 min at 1×).

### Hands-off, main (acb8a53, with the growth limiter and camping) → round 3

`--seeds 1..8 --years 4`, 128²; population at the end of years 1–4,
prosperity over year 4, lowest prosperity after year 1, days to 15 / 30.

| seed | population | prosp. % | lowest % | day 15 / 30 |
|---|---|---|---|---|
| 1 | 15/29/36/35 → 17/28/37/37 | 91 → 92 | 81 → 55 | 32/122 → 28/127 |
| 2 | 13/34/60/77 → 19/40/60/81 | 90 → 97 | 71 → 92 | 71/84 → 32/87 |
| 3 | 18/28/44/63 → 17/39/58/98 | 88 → 91 | 77 → 80 | 35/124 → 35/83 |
| 4 | 20/39/62/78 → 25/46/57/72 | 95 → 96 | 71 → 90 | 29/88 → 28/81 |
| 5 | 19/27/30/27 → 19/24/32/30 | 90 → 87 | 71 → 77 | 31/123 → 28/126 |
| 6 | 14/24/31/33 → 21/32/32/30 | 96 → 96 | 70 → 86 | 79/135 → 30/82 |
| 7 | 8/8/5/5 → 11/11/9/9 | 89 → 42 | 17 → 11 | –/– → –/– |
| 8 | 9/9/9/4 → 10/9/11/8 | 47 → 57 | 12 → 20 | –/– → –/– |

- **Weir unlock** at day 28–35 on every seed with a river (13–17 min at 1×;
  main 29–79), the gate at day 81–127 (40–64 min) hands-off.
- **Steep seeds 7 and 8 stay at 8–11** (main: 4–5), hungry
  (prosperity 42–57 %): the floor, not the land, holds them.
- **Year 3 is above 15–40 on the fertile river seeds 2–4** (57–60), as on
  main (44–62): main's founding rule (land-limited villages of 30 count as
  crowded) founds the second village in year 2. Not changed here (it is
  the growth branch's rule); lowering yields to pull it down delayed the
  weir unlock to day 77 (yield 8.5) and left prosperity at 99 %.

### Agency (`--bots good,weircanal,wheel,dike,drain,undo`, 4 years, budget 6000 m³)

Population at the end of years 1–4 (prosperity over year 4); last column
the mean of the per-seed differences at year 4.

| bot | s1 | s2 | s3 | s4 | s5 | s6 | s7 | s8 | mean Δ |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 17/28/37/37 (92%) | 19/40/60/81 (97%) | 17/39/58/98 (91%) | 25/46/57/72 (96%) | 19/24/32/30 (87%) | 21/32/32/30 (96%) | 11/11/9/9 (42%) | 10/9/11/8 (57%) | |
| good | 14/24/34/32 (92%) | 19/35/57/80 (95%) | 15/37/59/91 (95%) | 21/38/53/67 (96%) | 16/26/31/31 (89%) | 22/29/49/54 (100%) | 11/11/8/9 (61%) | 9/12/11/13 (85%) | +15 % |
| weircanal | 17/28/37/37 (92%) | 19/24/45/62 (92%) | 17/43/58/94 (91%) | 25/37/63/85 (94%) | 19/31/30/29 (87%) | 21/38/52/61 (100%) | = | = | +11 % |
| wheel | 17/26/37/34 (95%) | 17/42/71/86 (89%) | 15/37/58/98 (93%) | 20/45/64/89 (94%) | 19/26/31/31 (84%) | 21/29/42/52 (100%) | 11/10/8/7 (59%) | 9/13/17/17 (79%) | +24 % |
| drain | = | 19/51/73/88 (86%) | 20/37/61/95 (91%) | 21/38/62/78 (96%) | 19/26/30/28 (88%) | 22/32/46/44 (90%) | 11/10/8/8 (51%) | 9/9/9/9 (74%) | +7 % |
| dike | 17/28/37/36 (79%) | 19/40/60/72 (97%) | 17/39/50/76 (90%) | = | = | = | = | = | −5 % |
| undo | 6/7/15/20 (77%) | 9/8/17/24 (82%) | 11/8/13/25 (99%) | 11/8/14/41 (98%) | 9/8/13/18 (78%) | 9/8/12/24 (84%) | 11/11/11/8 (35%) | 10/10/11/13 (87%) | −30 % |

(= : the bot found nothing to do; the run equals the baseline.)

- **The dry seeds respond:** seed 6 (64 mm/yr) +73–80 % with the wheel or
  the good player's contour canal + drain + weir, seed 8 +62–112 % (13–17
  against 8) and its prosperity 57 → 79–85 %, seed 4 +18–24 % with the
  weir or wheel canal. Seed 1 (a brook, a floodplain so flat that any weir
  drowns 70+ fields) has no good site: the bots do nothing or little.
- **The wheel is the strongest single tool** (+24 % mean; built from the
  start here, it unlocks at 50): its short canal starts at the head, high
  on the bank, so its water stands at field level and the villagers dig
  ditches off it. The weir + canal (+11 %) needs a weir far upstream for
  head and its canal crosses more land.
- **The good player is best on the dry seeds (6, 8) and on prosperity**
  (7 of 8 seeds ≥ baseline), but not best on average (+15 %) and below the
  baseline on the wet fertile seeds 1–4 (−5 to −14 %): there the
  baseline founds a second village in year 2 because the first one is
  land-limited, and watering more land delays exactly that founding. The
  +30 % target is met on the dry seeds 6 and 8, not across the board.
- **Dike runs no longer lose people where nothing floods** (they act only
  after flood memory; 5 of 8 seeds identical). Round 2's loss (−23 %) came
  from dikes built on day 16 on every seed, 3 cells inside the water's
  edge, on the best-watered floodplain fields, before anything flooded (and
  from a run of older field rules); round 2's dike bot re-run on main at
  the start of round 3 gave 68 / 52 against 64 / 55 (seeds 2, 4). Where
  the new bot builds (5500–5900 m³ of bank on seeds 1–3) prosperity or
  population is still 10–22 % lower in year 4: the banks take fields.
- **Undo recovers:** the vandal's canal and dam leave 7–9 people in
  year 2; filled back and drained, the villages grow again to 18–41 by
  year 4 (round 2: stuck at 3–4 for three years), with prosperity
  77–99 %.

**256² check** (seeds 4 and 6, 3 years, population at year 3): seed 4
baseline 66, good 70, wheel 59; seed 6 baseline 47, good 23, wheel 43 (the
baseline founded a second village; the good player's did not). The 128²
gains on the dry seeds do not carry over to the game's map size: with
more land the baseline's second village comes sooner, and the founding
effect above dominates.

### Open
Founding after irrigation (the good player loses the land-limited
founding on fertile seeds: founding could also count a village of 30
that has stopped growing for food); dikes on fields; hands-off year 3
above 40 on fertile river seeds (main's founding rule).

## Round 4 (tune4, October 2026)

Lead's decisions: (1) a village of 30 that has stopped growing for any
reason counts as crowded; (2) dry terraces as the usual start, fertile
floodplains rarer; (3) dikes on unfarmed ground, judged with floods that
reach the fields. Measured with `--seeds 1..8 --years 4 --bots
good,weircanal,wheel,dike,undo` (128², budget 6000 m³), plus hands-off
`exp.ts` runs on seeds 1–16.

### Changes
- **Founding** (`FOUNDING.stalledDays`, village.ts `judgeGrowth`): a
  village of ≥ 30 whose growth limit has been `land`, `food`,
  `wellbeing` or `room` for 12 days sends people out (was: no free house,
  or `land`/`room` that day). A block 16–26 cells from a village may be
  settled if ≥ 30 % of it lies within a player canal's reach
  (`FOUNDING.canalSpacing`, `canalShare`: new villages follow the canals).
- **Start** (worldgen `terracePass`, `fieldLand`): a dry terrace scores the
  land within the field radius (18) on its own side of the river: land
  crops grow on now ("good", wanted 120–180 cells: 15–30 people) and
  fertile land too dry but at most 2.5 m above the water (what a weir or
  wheel canal can water; full score from 200). The relaxed pass (a lower
  or farther bench, from 1.5 m) competes on score. One world in four
  (`fertileStart(seed)`, a hash) keeps the floodplain-rich terrace. Seeds
  1–16: 10 dry terraces, 3 fertile terraces (4, 9, 15), 3 meadow fallbacks
  (2, 7, 8: no terrace qualifies).
- **The founders' food was thrown away**: `bookFood` capped the store at a
  hamlet's capacity (1.5 years for 4 people) on the first delivery of fish,
  so the 500 days the founders brought were ~290. Now a delivery never
  shrinks the stock, and the founders bring 400 days.
- **Hamlets grow on their store** (`ECONOMY.hamlet` 15): under 15 people,
  growth asks for food until the next harvest, not 40 days ahead. Dry
  starts otherwise stood at 6–10 people until a good harvest (seeds 10, 14:
  weir unlock at day 126–135).
- **Arrivals by pull**: the daily arrival chance adds up and a family comes
  when the sum passes a threshold drawn from 0.6–1.4 (same mean rate).
  Two runs of one village differed by 17 arrivals in a season by luck
  alone (seed 2: 1 arrival in 18 days at 0.24 a day), which swamped every
  bot comparison.
- **Bots**: the weir's pool is judged at crest + the head of water pouring
  over it (Q = 1.7 L h^1.5; on seed 2 the "2 fields" pool took ~50 bank
  fields), fields on its wet margin count, drowned fields weigh 3×. The
  dike bot tries four bands (2.5–6.5 cells from the river) and takes the
  one whose banks take fewest fields for the low land behind them, with a
  1-cell crest.

### Hands-off (seeds 1–16, 128²)

| | round 3 (seeds 1–8) | round 4 |
|---|---|---|
| weir unlock (15) | day 28–35 (7/8 seeds; 7, 8 never) | day 13–26 on 16/16 seeds (6–13 min) |
| year 3 in 15–40 | 4/8 (1, 5, 6; 2–4 above, 7–8 below) | 10/16 (1, 3, 6, 9–12, 14–16); above: 2, 4, 5, 13; 7, 8 at 12 |
| year 4, seeds 1–8 | 37/81/98/72/30/30/9/8 | 34/70/53/84/60/17/12/12 |

- The dry terraces are hungrier: seed 6 holds 15–18 people at 52–82 %
  prosperity for four years, seeds 9 and 10 17–23 at 59–77 %.
- Steep seeds 7 and 8 now reach 16–17 in year 1 (weir unlocked) and fall
  back to the floor of 8–12 (prosperity 35–54 %).
- Above 40 by year 3: the fertile starts (2, 4) and two dry terraces that
  find a second site once the first village stalls at 30 (5, 13).

### Agency (128², 4 years; population at the end of years 1–4, prosperity in year 4)

| bot | s1 | s2 | s3 | s4 | s5 | s6 | s7 | s8 | mean Δ |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 17/26/36/34 (91%) | 19/29/57/70 (91%) | 18/26/33/53 (97%) | 20/43/70/84 (88%) | 18/30/50/60 (90%) | 18/15/15/17 (82%) | 16/12/12/12 (35%) | 13/12/12/12 (54%) | |
| good | 16/21/38/34 | 17/36/66/81 | 19/28/45/68 | 18/31/52/69 | 18/29/43/55 | 18/21/32/31 (95%) | 16/14/13/9 | 15/14/12/17 | +15 % |
| weircanal | = | 19/29/57/70 | 16/31/50/82 | 21/34/60/71 | 18/29/43/56 | 18/20/32/32 (94%) | = | 13/11/12/14 | +17 % |
| wheel | 17/23/36/38 | 19/35/64/77 | 18/30/56/90 | 20/33/60/73 | 19/32/51/66 | 18/23/26/29 (94%) | 16/12/10/12 | 16/14/15/15 | +23 % |
| dike | = | 19/29/57/73 | = | = | = | = | = | = | +1 % |
| undo | 17/8/19/25 | 15/8/21/29 | 17/10/15/24 | 18/8/15/26 | 8/8/21/31 | 16/8/8/8 | 12/8/8/8 | 16/14/14/16 | −39 % |

(=: nothing to do, same as the baseline.) Seeds ≥ +30 %: good 2/8 (6, 8),
weircanal 2/8 (3, 6), wheel 2/8 (3, 6; seed 8 +25 %). Steps on the way (same
seeds): founding rule alone (run A) good +17 %, weircanal +8 %, wheel
+29 %; with the dry starts (run E, before the store fix and the pull)
+15 / +13 / +22 %.

- **The target (+30 % on most seeds) is not met.** Where the bots bring
  water to a dry terrace the village grows by half to nine-tenths (seed 6
  +71–88 %, seed 3 +28–70 %, seed 8 +17–42 %). Elsewhere: seed 1 (a 0.7
  m³/s brook on a flat plain) offers no weir site and a wheel lifts little;
  seed 5's weirs water little; on the fertile starts (2, 4) works change
  little or take fields (seed 4: the weir canal crosses the floodplain
  fields; −13 to −18 %).
- **Why gains are capped**: a village grows only while its store holds 46
  days of need, and the store holds 1.5 years; so after each harvest
  there is a window of ~3–4 weeks, at most ~0.24 families a day per free
  house. Food beyond that does not speed growth (1.5 → 2.5 years of
  storage: no change in the bot deltas, seeds 1–4). Total population
  grows mainly by more villages, one a year at most (`FOUNDING.interval`);
  the fertile hands-off seeds already found at that rate.
- **Founding**: the stalled-village rule fires as intended (hands-off
  seed 5 founds at day 99; the good player's on seed 5 at day 143 because
  its village hovered at 29–30). The canal-side founding never fired in
  these runs: the canals water the first village's own fields, which do
  not count as open land for a new village.
- **Dikes**: floods rarely reach the fields of the new starts. With a big
  freshet every spring from year 3 (`--floods`), land flooded in four years
  was 0–43 cells except seed 2 (261); the dike bot built on seeds 2–4
  (once flood memory near the village appeared, years 3–4) and changed
  population by −7 … +5 %. With freshets 6–7.5× (`CLIMATE.bigFactor=6`)
  the dikes (crest capped at 2.5 m above the river) did not lower the
  flooded area (seed 2: 526 → 503, seed 4: 361 → 405) and still took
  19–64 fields under their banks. In the normal climate the dike bot builds
  only on seed 2 (+4 %) and equals the baseline elsewhere.
- **Undo recovers**: the vandal leaves 8 people in year 2; after the works
  are undone seeds 1–5 grow back to 24–31 by year 4 (prosperity 84–99 %).
  Seeds 6 and 7 stay at the floor of 8 (dry, hungry starts).

**256² check** (seeds 3 and 6, 3 years; population at the end of years
1–3): seed 3 baseline 17/29/39, weircanal 16/30/52 (+33 %, a second
village), wheel 17/28/50 (+28 %), good 17/20/36 (−8 %); seed 6 baseline
15/10/15 (81 %), good and weircanal 15/15/23 (+53 %, 94 %), wheel 15/14/22
(+47 %). The direction holds at the game's size (round 3: seed 6's good
player had half the baseline's people, 23 against 47).

### Open
Agency on brook and fertile seeds (bots find no site, or works take
fields); growth window (store vs growth horizon) bounds what more food can
do; canal-side founding needs open watered land beyond the first
village's fields; dikes that hold big freshets (crest, closing the
floodplain at both ends).
