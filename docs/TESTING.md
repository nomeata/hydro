# Hydro — Testing Strategy

Testing happens in layers, from fast and exact to slow and visual. All of it
runs headless in CI (GitHub Actions) and locally in the dev container.

## 1. Sim unit tests (vitest, Node) — `tests/sim/*.test.ts`
Fast, exact, run on every change.
- **Kernel invariants:** water mass conservation (inputs − outputs = Δstorage
  within float tolerance), no negative depths/soil, no NaN/Inf, sediment and
  soil volume conservation for erosion and talus.
- **Stability:** long runs (thousands of steps) on adversarial terrain
  (cliffs, single-cell spikes, a dam break) stay bounded.
- **Determinism:** same seed + same command log ⇒ bit-identical state hashes.
  Save → load → continue gives the same hash as running straight through.
- **Analytic checks:** a lake on flat ground reaches a level surface; a tilted
  channel conducts water downhill; groundwater on a slope drains to a spring.

- **Ledgers:** f64 mass ledgers covering every source and sink (rain, inflow,
  outflow, evaporation, infiltration, thin-film removal) balance to < 1e-5 of
  throughput.
- **Long-horizon geomorphology (M1b):** a generated 128² world for one game
  year at MORFAC ×6 (`HYDRO_LONG=1`: ten years at the normal MORFAC):
  hypsometry drift bounded, no single-cell spikes/pits, rivers and outlet
  discharge persist, sediment in ≈ sediment out. Longer and larger runs
  with yearly statistics and before/after/diff images: `npx tsx
  tools/longrun.ts --seed 3 --years 20 --snap-every 5` (writes
  `out/longrun/`); look at the images when tuning.
- **Fuzzing:** random command sequences never produce NaN or negatives.

## 2. Scenario tests (vitest, Node) — `tests/scenarios/*.test.ts`
Gameplay-level checks run against the real sim with small worlds (64–128²).
Each scenario sets up a handcrafted or seeded world, issues *player commands*
through the same command API the UI uses, fast-forwards game days and asserts
outcomes. For example:
- dig a trench from a river into a dry basin ⇒ the basin holds water after N days;
- build a dike across a valley ⇒ a reservoir forms upstream, outflow drops;
- an unlined trench in sand slumps over time; a lined one doesn't;
- a spring flood deposits silt ⇒ floodplain fertility increases;
- (M3+) fertile irrigated land attracts farmers; a flooded village relocates.

These double as **balance regression tests**: when a tuning change breaks a
scenario, we notice.

## 3. Worldgen review tools — `tools/preview.ts`
Node script that generates a world for a seed (plus N days of spin-up) and
writes PNGs: hillshaded height, rivers, soils, groundwater, fertility. Used to
review worldgen quality across many seeds at a glance (contact sheet). Cheap
enough to run for 20 seeds when tuning.

## 4. Browser tests (Playwright + pre-installed Chromium) — `e2e/*.spec.ts`
The game exposes a **test hook** when loaded with `?test=1`:
`window.__hydro` gives access to the sim client (`runDays(n)`, `stateHash()`,
`getCell(x,y)`, `setCamera(...)`, `pause()`), a deterministic seed, a fixed
time of day, and disabled random visual effects (no particle jitter).
- **Smoke:** page loads, WebGL context exists, worker reports ready, no
  console errors, frames are rendered (canvas not blank).
- **Interaction tests:** drive real input events:
  - mouse: select the trench tool, drag on the canvas, release ⇒ assert via
    `__hydro` that plan cells exist along the path; cancel ⇒ they are gone;
  - camera: wheel zooms, drag pans, right-drag rotates (assert camera state);
  - touch (emulated Pixel device profile): one-finger pan, pinch zoom,
    two-finger rotate, tap to use tools. Multi-touch is dispatched via CDP
    `Input.dispatchTouchEvent`;
  - UI: speed buttons change sim speed; tool palette is reachable and usable
    at phone viewport sizes (no overlap, tap targets ≥ 44 px).
- **Persistence:** play a bit, reload ⇒ state restored (hash equal), export ⇒
  import round-trips.
- **Picking correctness:** clicking a known screen position hits the expected
  world cell for several camera angles.

- **Robustness:** WebGL context loss/restore (`WEBGL_lose_context`);
  backpressure (main thread stalls for 2 s; the worker skips snapshots and
  does not queue).

## 5. Visual regression (Playwright screenshots)
- Fixed scenes (seed, camera, time of day, season, with water/snow/fog
  present) are rendered with `?test=1` and compared to stored golden images
  using a perceptual tolerance (pixelmatch threshold plus an allowed
  differing-pixel ratio). Software GL (SwiftShader) in CI is deterministic
  enough for this. Goldens are updated deliberately (`npm run e2e:update`).
  Visual diffs are **non-blocking** (report + artifact) until the art style
  settles; the Chromium version is pinned.
- Screenshots of every e2e run are uploaded as CI artifacts. During
  development, the agent inspects screenshots directly for visual review
  (does it look cute, readable, bustling?).

### README screenshots
A Playwright script (`e2e/screenshots.spec.ts`, tagged `@readme`) renders a
few showcase views (overview, river close-up, winter, night) at a fixed seed
after a fixed number of simulated days. CI copies them into
`dist/screenshots/` before deploying, so they are published with the game at
`https://hydro.nomeata.de/screenshots/*.png`, and `README.md` embeds
those URLs. They are therefore always the screenshots of the deployed build,
and CI never has to commit to the repository.

## 6. Performance
- `npm run bench`: hydro steps/sec for 256² and 512² worlds in Node; tracked
  over time (bench results are printed in CI logs).
- In-browser: `?stats=1` shows FPS, sim steps/sec, snapshot latency. A
  Playwright perf test asserts the frame time stays within budget on the
  default scene (desktop software GL is slow, so this guards relative
  regressions only).
- **Phone bench page** `?bench=1`: runs the kernels and reports ns/cell and
  steps/s, plus a 10-minute thermal soak. The player runs it on the Pixel 9a
  and the results are recorded in `docs/PERF.md`. SwiftShader numbers are
  meaningless for this.
- Startup logs GPU feature checks (`OES_texture_float_linear`,
  `EXT_color_buffer_float`, vertex texture units), visible with `?stats=1`.

## 7. CI pipeline
`push` → `npm ci` → typecheck + lint → unit + scenario tests → build →
Playwright e2e (smoke, interaction, visual) → deploy to GitHub Pages (main
only). The deploy is blocked if any step fails.
