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
| `--bots` | all | `baseline` always runs; bots: `irrigate,dike,weir,drain,vandal` |
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
(population peak), act from `--act-day` and look again each season, once
per village (new villages get theirs later):
- `irrigate`: a trench (2 wide, 1–3 m deep, as deep as gravity feed
  needs) from the nearest shore whose water can reach them to the middle
  of the driest quarter of a village's fields, with a dogleg around the
  houses if needed (round 2: aimed at the driest quarter of the dry fields
  *and fertile open land* within 17 cells, preferring an intake up to 70
  cells away whose water stands near field level, never onto land below
  the intake's water; else as before);
- `dike`: dikes (1.5 m) 3 cells inside the water's edge on rays from the
  village where the land is low (< 2.5 m above the water) or remembers
  floods; looks again when new flood memory appears;
- `weir`: once the weir is unlocked (15 villagers), a weir across the
  river 12–40 cells upstream of the biggest village, crest 1 m above the
  water, banks high enough on both sides;
- `drain`: a ditch (0.8 m) from the wettest patch near a village (soil
  saturation or field moisture ≥ 0.9, or puddles) down to lower water;
- `vandal`: a canal from the shore with the most head straight into the
  first village's store, and a dam across the river just below the intake;
- `undo` (round 2): the vandal's works, and a year later a trench through
  the dam down to the river bed and a dike across the canal by its intake,
  as a player would undo them: does the village recover?

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
