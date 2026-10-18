# Achievements

Little goals per world (DESIGN §4a): all positive, none secret, recorded
with the day they were earned and saved with the world. The table lives in
`src/shared/achievements.ts` (titles, descriptions, icons, thresholds); the
checks in `src/sim/achievements.ts`; the toasts, the Achievements card (menu)
and the medals on the history chart in `src/ui/achievements.ts`,
`src/ui/achievementIcons.ts` and `src/ui/historyChart.ts`.

## How they are checked

- When the world is created (after the worker's spin-up) the sim takes a
  compact **baseline**: where the world's own water was (≥ 0.1 m) and which
  land was too dry to farm (field moisture < 0.15). Both are saved as
  run-length encoded bitsets; so is where the forest stood (Forest Keeper;
  older saves take the forest when loaded).
- **The player's works**: every cell the spirit crew digs, heaps or lines is
  marked; "near the works" means in or next to an 8×8 block with a marked
  cell. Land and water achievements only count near the works, so natural
  floods and wet springs don't earn them.
- Events are reported as they happen (a harvest, a catch, a rebuilt ruin, villagers
  opening a gate for their fields, a gate's flood relief, a bank lined by
  villagers). Quick checks run every 60 steps (plans
  finished, villages, population), the waterfall check every 150 steps, the
  grid checks once per game day.
- The checks only observe: they never change the world or draw random
  numbers, so the simulation is the same with or without them.
- Old saves without achievements take their loaded state as the baseline
  and quietly record what is already true. Loading never shows toasts.

## The list

| Achievement | Condition |
|---|---|
| **Waterworks** | |
| First Spade | An earthwork plan (trench, dike, level) is fully built |
| Long Canal | A trench stroke at least 40 cells (200 m) long is built (at most 30% cancelled) |
| Lake Maker | ≥ 30 cells of standing water (≥ 0.5 m, slower than 0.3 m/s) where there was no water at the start, near the works, on two days in a row |
| Waterfall | The water surface drops ≥ 3 m within two cells at a cell the player's works changed, with the water flowing (≥ 0.2 m/s) |
| Weir Builder | All cells of a weir are lined |
| Gatekeeper | Villagers open a sluice gate to water their fields (GAMEPLAY §2.2 rule 3; not a gate held by the `toggleGate` command) |
| Safety Valve | A sluice gate opens as flood relief (rule 1) and its dike is not overtopped that day |
| **The land** | |
| New Ground | A field on land that was too dry to farm at the start, near the works |
| Green Desert | ≥ 150 cells that were too dry at the start are now well watered (field moisture ≥ 0.35), near the works, two days in a row |
| Forest Keeper | ≥ 40 cells of forest (vegetation ≥ 0.6) where there was none at the start, near the works, two days in a row |
| Well Trodden | A connected desire path (8-neighbours) of ≥ 30 cells |
| **The people** | |
| Founders | The first village |
| First Harvest | The first field harvested |
| A New Home | A second village |
| Three Villages | A third village |
| Gone Fishing | A fish caught in water at least 3 cells from the world's own water, near the works |
| Golden Year | 250 field harvests in one calendar year |
| Stone by Stone | Villagers line a bank cell with stone (their own works near home) |
| Quayside | Villagers have a quay (lined lake front by the houses) |
| Fishing Jetty | A village's jetty is finished |
| Cattle Country | A village keeps a herd of ≥ 5 cows |
| Hamlet, Village Life, Bustling Valley, Little Town | 10, 50, 100, 250 villagers (highest population so far) |
| **Seasons** | |
| Weathered the Storm | In a spring, ≥ 10 cells of village land were flooded on one day, and no house was ruined that spring |
| Rebuilt | A flood ruin is rebuilt |
| Years Go By, A Decade | The first year, ten years |

In a typical game (seed 3, 128²) Founders, First Harvest and Hamlet come in
the first weeks; A New Home, Fishing Jetty, Quayside, Village Life and
Golden Year in the second year; the waterworks come with the player's
first plans and the stone tools.
