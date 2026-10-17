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

## Findings

See below (first run).
