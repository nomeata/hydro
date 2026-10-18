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
  floods and wet springs don't earn them. When the player plans works on a
  cell (trench, dike, level, weir, gate) the sim remembers its **original
  ground** (saved with the world; villagers building the player's plans
  count as the player's works too).
- Events are reported as they happen (a harvest, a catch, a rebuilt ruin, a
  finished well or mill, villagers opening a gate for their fields, a gate's flood relief, a bank lined by
  villagers). Quick checks run every 60 steps (plans
  finished, villages, population), the waterfall check every 150 steps, the
  grid checks once per game day.
- The checks only observe: they never change the world or draw random
  numbers, so the simulation is the same with or without them.
- Old saves without achievements take their loaded state as the baseline
  and quietly record what is already true. Loading never shows toasts.
  Saves from before the original ground was kept only count works planned
  after loading for Lake Maker.
- Toasts (and the population milestone notes) wait while the welcome
  panels or a tool card are open; a first visit starts paused behind the
  welcome panels, and play begins when they close.

## The list

| Achievement | Condition |
|---|---|
| **Waterworks** | |
| First Spade | An earthwork plan (trench, dike, level) is fully built |
| Long Canal | A trench stroke at least 40 cells (200 m) long is built (at most 30% cancelled) |
| Lake Maker | A reservoir the player made, on three days in a row: one connected body of standing water (≥ 0.1 m, slower than 0.3 m/s) that touches a cell the player raised, with its surface ≥ 0.2 m above that cell's original ground (without the work the water would spill there), and holding, on cells that were dry at the start, ≥ 40 cells and ≥ 2000 m³ of water above their original ground (≥ 0.5 m deep on average). Raising dry land, a dug basin, rain puddles or a natural lake spreading near the works do not count |
| Waterfall | The water surface drops ≥ 3 m within two cells at a cell the player's works changed, with the water flowing (≥ 0.2 m/s) |
| Weir Builder | All cells of a weir are lined |
| Gatekeeper | Villagers open a sluice gate to water their fields (GAMEPLAY §2.2 rule 3; not a gate held by the `toggleGate` command) |
| Miller's Head | Villagers finish a mill whose head (the cell driving its wheel) is within 3 cells of the player's works (a weir's spill, a canal step) |
| Uphill | A water wheel has lifted 100 m³ onto the bank in all |
| Bright Windows | A house is on the power grid and gets power (a turbine within reach, or poles from one) |
| Village Lights | 20 houses on the power grid at once |
| Night and Day | On one day, pumps used ≥ 0.02 kWh of spare power and storage turbines gave back ≥ 0.02 kWh (a game day is 300 hydraulic seconds) |
| Safety Valve | A sluice gate opens as flood relief (rule 1) and its dike is not overtopped that day |
| **The land** | |
| New Ground | A field on land that was too dry to farm at the start, near the works |
| Green Desert | ≥ 150 cells that were too dry at the start are now well watered (field moisture ≥ 0.35), near the works, two days in a row |
| Forest Keeper | ≥ 40 cells of forest (vegetation ≥ 0.6) where there was none at the start, near the works, two days in a row |
| Good Idea | An idea for this valley (sim/ideas.ts) goes away while the player's works are near its spot (a turbine or poles idea: always) |
| Well Trodden | A connected desire path (8-neighbours) of ≥ 30 cells |
| **The people** | |
| Founders | The first village |
| First Harvest | The first field harvested |
| A New Home | A second village |
| Three Villages | A third village |
| Gone Fishing | A fish caught by water the player made, at least 3 cells from the world's own water: a cell they dug (≥ 0.3 m below its original ground) or a lake their works hold back (as for Lake Maker, any size) |
| Golden Year | 250 field harvests in one calendar year |
| Stone by Stone | Villagers line a bank cell with stone (their own works near home) |
| Quayside | Villagers have a quay (lined lake front by the houses) |
| Wellspring | Villagers finish a well within 10 cells of the player's works |
| Fishing Jetty | A village's jetty is finished |
| Footbridge | Villagers finish (or rebuild) a footbridge to land across the water |
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
