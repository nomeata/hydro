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
- milestones: the day the peak population first reached 15/30/50 (tool
  unlocks) and 100/200/400; the day of every village founding;
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
  houses if needed;
- `dike`: dikes (1.5 m) 3 cells inside the water's edge on rays from the
  village where the land is low (< 2.5 m above the water) or remembers
  floods; looks again when new flood memory appears;
- `weir`: once the weir is unlocked (30 villagers), a weir across the
  river 12–40 cells upstream of the biggest village, crest 1 m above the
  water, banks high enough on both sides;
- `drain`: a ditch (0.8 m) from the wettest patch near a village (soil
  saturation or field moisture ≥ 0.9, or puddles) down to lower water;
- `vandal`: a canal from the shore with the most head straight into the
  first village's store, and a dam across the river just below the intake.

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

`npm run playtest -- --seeds 1..8 --years 10 --bot-years 4 --jobs 4`
(commit of this doc; 128² maps, not the game's 256²: the full matrix took
2.9 hours with 4 jobs on a shared container, 256² would be 4–10× slower).
On 128² the start disc (56 cells) already shows most of the map, so
revealed area and the room for new villages are not representative.
Bot runs last 4 years and are compared with the hands-off run of the same
seed on the same day. One run per seed and bot: the villages are
stochastic, so a bot run diverges from the baseline after its first
action for reasons unrelated to it; differences of ±10 % in population
are within that noise.

### 1. The start is far too habitable

| seed | relief m | slope | pop y1 | y2 | y4 | y10 | prosp. % | villages | min to 15 / 30 / 50 / 100 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 31 | 0.05 | 45 | 113 | 318 | 663 | 95 | 5 | 4 / 13 / 27 / 44 |
| 2 | 21 | 0.04 | 16 | 71 | 255 | 972 | 97 | 9 | 24 / 35 / 41 / 61 |
| 3 | 84 | 0.10 | 36 | 83 | 348 | 1014 | 98 | 8 | 11 / 19 / 37 / 54 |
| 4 | 12 | 0.03 | 32 | 93 | 306 | 1035 | 96 | 9 | 14 / 24 / 35 / 49 |
| 5 | 59 | 0.12 | 43 | 108 | 246 | 363 | 100 | 2 | 7 / 14 / 34 / 44 |
| 6 | 10 | 0.02 | 39 | 101 | 345 | 1078 | 98 | 10 | 8 / 19 / 29 / 48 |
| 7 | 150 | 0.48 | 24 | 35 | 25 | 4 | 38 | 1 | 11 / 37 / – / – |
| 8 | 186 | 0.44 | 35 | 53 | 55 | 58 | 96 | 1 | 7 / 14 / 46 / – |

- Hands-off, every seed reaches the lining unlock (15) and the weir (30),
  in a median of **9 and 19 real minutes**; the gate (50) in 35 min on 7/8
  seeds. All tools are unlocked before the player has had a reason to use
  them.
- Prosperity sits at 95–100 % (median 97 %) for ten years on 7/8 seeds:
  the headline stat has no tension. Food security stays at its cap.
- On flat seeds the population grows by ×2–2.5 in year two and then by
  100–150 people a year, until 23–38 % of the map is fields and 5–10
  villages; only seeds 1 and 5 level off (at 660 and 360) within ten
  years. That is far above PEOPLE.md's growth limit (r ≤ 0.5 per year).
- Why: food is never short. A farmer works 6 field cells
  (`FIELDS_PER_FARMER`), each harvest gives `YIELD` 34 × fertility
  person-days, while a person eats 48 a year, so one farmer feeds 2–4
  people; migration is limited only by houses (`ECONOMY.arrivalRate` 0.6
  families a day per free house above w = 0.6) and houses are built
  whenever the village is full and w > 0.5.
- **Nobody ever leaves** (0 departures in all 80 village-years): the
  wellbeing target is 0.55·food + 0.2·housing + 0.15·water + 0.1·safety,
  so with houses, water and safety it never drops below 0.45, above
  `leaveBelow` 0.4, even at zero food. Starving villages shrink only by
  the starvation death rate.
- The two steep seeds (7, 8: slope > 0.4) are the exception. Seed 7's
  village (84 cells from the river) put its fields on a valley floor
  that floods every spring (90 of 120 field cells under water); crops
  drown, food is 0 from year 1, and the village dies out slowly over nine
  years (37 → 4) at prosperity 38 %, "struggling" all the time. Seed 8
  is stuck at ~55 people with one village (no site scores ≥ 0.55).

### 2. Agency: immediate feedback, little consequence

| bot | acted | built in | first visible change | Δ pop (4 y) | Δ prosperity pts | Δ flooded cells | Δ houses ruined |
|---|---|---|---|---|---|---|---|
| irrigate | 8/8 | 1 day | same day (moisture) | −20 | −3.4 | +12 | +0.8 |
| dike | 7/8 | 1 day | 20 days, on 2/7 seeds | −3 | +0.3 | +14 | +0.6 |
| weir (from 30 villagers) | 5/8 | 1 day | same day (+0.1–0.3 m depth) | +19 | +0.9 | +1 | 0 |
| drain | 8/8 | 1 day | same day (depth/moisture) | +7 | +0.1 | +4 | 0 |
| vandal | 8/8 | 1–6 days | same day (depth) | −172 | −37 | +23 | +3.6 |

- The spirit crew finishes every plan within a day or two and the water
  responds at once: the targeted fields are 0.02–0.36 wetter, the weir's
  reservoir 0.1–0.3 m deeper, the drained patch drier, on the next day.
  The *local* feedback is excellent.
- But the beneficial bots change the villages by −20 … +19 people out of
  ~300 (within the noise) and prosperity by a few points. The villages are
  not limited by water or food, so there is nothing for the player to
  fix: crops grow at full rate above field moisture 0.35, and the
  moisture proxy (own soil, or 0.8·e^(−d/2) near water) already gives
  0.5–0.7 on most fields.
- Irrigation even hurts: a canal that ends in the fields floods them
  (seed 1: 13 and 30 field cells flooded, prosperity 68 % vs 93 %; seed
  7: four houses ruined and the village collapses). A careful player ends
  the canal short of the fields, but nothing in the game rewards the
  canal either way.
- Dikes rarely matter: floods are rare (0–0.3 flood episodes a year, a
  few houses in ten years on most seeds). On the one seed where floods
  ruin a village (7) the dike bot found no water near the village on its
  checks (the flood comes in spring over the fields); a flood-memory-
  driven dike placement would be the next bot improvement.
- Harm is strong and lasting: the vandal's diversion canal (and dam)
  ruins 1–7 houses and leaves 6 of 8 villages at 4–9 people and 40 %
  prosperity for the remaining four years, with no recovery: nobody
  leaves, nobody arrives (arrivals need w > 0.6), and a new village needs
  25 people in all. PEOPLE.md's "setbacks and recovery in 3–8 years"
  does not happen.

### 3. Variety

- Outcomes are bimodal rather than varied: six seeds boom to 360–1080
  people and fill the map, two steep ones stall (58) or die out (4).
  Final population CV 0.65, prosperity CV 0.22 (driven by seed 7 alone).
- The spread comes from relief and slope (and the flat land they leave),
  not from water: rainfall varies only 84–119 mm per (48-day) year, river
  inflow 0.7–66 m³/s without visible effect on the outcome (seed 1 with a
  0.7 m³/s brook does as well as seed 6 with 66 m³/s).
- Rivers barely move on flat seeds (0–2 new channel cells a year); only
  the steep seeds 5, 7 and 8 shift by 6–18 cells a year.
- The start site is always 7–16 cells from a river, except on seed 7
  (84): `chooseStart` found no flat fertile land near water there.

### 4. Pacing

- Plenty of small events: 110–250 an hour at 1× on growing seeds (houses
  60/h, new fields 80–100/h, families arriving 50–75/h), so a booming
  village is never visually idle.
- "Major" events (new village, flood, unlock, milestone, river shift,
  people fleeing) come about 8–9 an hour, every ~7 minutes; the longest
  gap between them is 23–91 minutes.
- Boring stretches: once growth stops (the map is full: seed 1 year 9–10,
  seed 5 from year 6) the event rate drops from ~250 to ~30 an hour; the
  steep seeds 7 and 8 drop to 5–15 an hour after year two with 20–41
  minute silences (7 stretches of 15+ minutes, all on seeds 7 and 8).
  Nothing happens to an established village: floods and droughts are too
  rare and too mild to give the equilibrium life.
- Unlocks all come in the first 35 minutes; after that there is no
  progression goal but the doubling milestones (100, 200, 400).

### 5. Oddities found on the way

- "Fleeing" fires constantly without any flood (up to 100 000 onsets in
  ten years on seed 3): `PeopleSystem.updateAgent` makes anyone standing
  in water deeper than 0.3 m flee, but people wade up to 0.4 m, so every
  ford crossing is a flight (Run animation). The flee-episode counts in
  the pacing tables are therefore not floods.
- Departures are effectively dead code (see §1).
- Achievements in a hands-off game: 9–16 per world (founders, first
  harvest, pop 10/50/100/250, golden year, three villages, quayside,
  decade, …) — most of the "endorphin hits" arrive without the player.

### Tuning suggestions (not applied; for the design review)

1. **Make food the limit, so water matters.** In `people/village.ts`:
   `YIELD` 34 → ~15, or `FIELDS_PER_FARMER` 6 → 3–4; and widen the
   growth response to moisture (`growCrops`: full growth only from
   moisture ~0.55 instead of 0.35, or yield ∝ moisture), so that natural
   fields away from water give half a harvest and irrigation doubles it.
   Check with the `irrigate` bot: Δ pop should become clearly positive.
2. **Slow growth to the design rate.** `ECONOMY.arrivalRate` 0.6 → ~0.1,
   and scale arrivals by surplus food security (e.g. ∝ max(0, S − 1))
   rather than wellbeing alone; build houses only with a food surplus.
   Target: r ≤ 0.5/yr, hands-off population levelling off at what the
   land supports (tens to ~150 per village), not filling the map.
3. **Let wellbeing fall.** Food weight 0.55 → 0.7 and housing/water/safety
   0.3 together, or multiply the food term in, so that hunger can push w
   below `leaveBelow` 0.4 and families actually leave (then come back:
   PEOPLE.md's recovery). Keep a migrant trickle to small or collapsed
   villages (`arriveAbove` lower for villages under ~10 people).
4. **Later unlocks, or unlocks earned by the player.** At 15/30/50 all
   tools come within 35 minutes hands-off. After (1)+(2) re-measure; if
   growth is still easy, raise to e.g. 15/40/80, or tie the weir/gate
   unlocks to the player's works (e.g. a first canal that feeds fields).
5. **Fields and start site avoid flood-prone ground.** `manageFields`
   should not claim cells with high `floodMemory` (or rate them by it);
   `chooseStart` (worldgen) could penalise steep surroundings and
   spring-flooded valley floors (seed 7) — or keep such starts on purpose
   as the "hard" seeds where dikes are needed, and make the dike bot find
   them (flood memory driven).
6. **More life in the equilibrium.** Floods are rare (≤ 0.3/yr) and
   rivers on flat maps static; climate anomalies (M1c "wet/dry years"),
   a stronger spring melt or occasional droughts would give established
   villages setbacks to recover from and the player a reason to build.
7. **Fix flight while wading**: flee only above the wading limit (0.4 m)
   or when the water is rising.

Re-run after a change: `npm run playtest -- --seeds 1..8 --years 10
--bot-years 4` and compare `out/playtest/summary.md`.
