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
- **Active land** (`tests/sim/active.test.ts`, ENDLESS.md §12): dry-tile
  sleeping is bit-identical to running every tile; frozen land stays
  fixed and the exchange across the active edge is booked; on a game
  whose known land is a small disc on the main river the ledger balances,
  the river keeps flowing in from the fog, save/load/continue and two runs
  give the same hash, and newly revealed land activates at the next day
  boundary from its frozen state.
- **Welcome scenes** (`tests/sim/scenes.test.ts`): the scene world is
  deterministic and fully known, clones run exactly like the original, the
  river runs from inflow to outlet, the scripted trench fills the hollow,
  and the staged village has its houses, fields, people and fishers.

## 2. Scenario tests (vitest, Node) — `tests/scenarios/*.test.ts`
Gameplay-level checks run against the real sim with small worlds (64–128²).
Each scenario sets up a handcrafted or seeded world, issues *player commands*
through the same command API the UI uses, fast-forwards game days and asserts
outcomes. For example:
- dig a trench from a river into a dry basin ⇒ the basin holds water after N days;
- sculpting (`tests/sim/sculpt.test.ts`): the brush kernel (rate × hold
  time, falloff, fixed cells masked smoothly, Even levels), immediate
  changes with no time passing, water conservation under the brush,
  houses/bridges/structures untouched and fields cleared, undo, determinism
  and save/resume, old saves' earthwork plans finished on load;
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

## 3b. Playability harness — `tools/playtest.ts`
`npm run playtest -- --seeds 1..8 --years 10 --bot-years 4` plays new
games headless, hands-off and with scripted player bots (irrigation, dikes,
weir, drainage, a vandal), and summarises outcomes, their spread across
seeds, the bots' effect and response latency, and pacing (events per real
hour at 1×). Method and first findings: docs/PLAYTEST.md. A smoke test
(`tests/tools/playtest.test.ts`) runs the bots on a 64² world.

## 4. Browser tests (Playwright + pre-installed Chromium) — `e2e/*.spec.ts`
The game exposes a **test hook** when loaded with `?test=1`:
`window.__hydro` gives access to the sim client (`runDays(n)`, `stateHash()`,
`getCell(x,y)`, `setCamera(...)`, `pause()`), a deterministic seed, a fixed
time of day, and disabled random visual effects (no particle jitter).
`?cheat=1` makes every tool available from the start (no population
unlocks), for trying late tools by hand or in a test.
- **Smoke:** page loads, WebGL context exists, worker reports ready, no
  console errors, frames are rendered (canvas not blank).
- **Interaction tests:** drive real input events:
  - mouse: select the Dig brush, hold and drag on the canvas (paused) ⇒
    the mirror's and the sim's terrain drop along the path at once, the
    tool stays selected; Undo (button and Ctrl+Z) brings the ground back
    (`e2e/sculpt.spec.ts`); a structure tool's stroke places a plan;
  - touch (phone profile): one finger brushes, a second finger turns the
    stroke into a pan/zoom (the brush bites only after 90 ms);
  - camera: wheel zooms, drag pans, right-drag rotates (assert camera state);
  - touch (emulated Pixel device profile): one-finger pan, pinch zoom,
    two-finger rotate, tap to use tools. Multi-touch is dispatched via CDP
    `Input.dispatchTouchEvent`;
  - UI: speed buttons change sim speed; tool palette is reachable and usable
    at phone viewport sizes (no overlap, tap targets ≥ 44 px).
- **Persistence:** play a bit, reload ⇒ state restored (hash equal), export ⇒
  import round-trips.
- **Welcome panels** (`e2e/intro.spec.ts`): `__hydro.showIntro()` opens
  them; a second scene worker starts, the live canvas fades in and is not
  blank, Next switches scenes (the scripted hand's Dig brush reaches the
  scene's sim), Skip closes the dialog, and the worker and canvas are gone
  again (`SimClient.live`); no console errors. For visual review,
  `npx tsx tools/shot-intro.ts [--phone] [--times 2,6]` screenshots each
  panel at given scene times (needs a preview server, default port 4233);
  `npx tsx tools/shot-card.ts --tool wheel` does the same for a tool card.
  `HYDRO_PW_PORT=<port> npx playwright test` runs the e2e suite on a
  preview port of one's own (parallel agents).
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

The same spec renders the social link preview (`og:image` in `index.html`,
1200×630): `tools/og-image.ts` grows a fixed scene headless (seed, days, a
weir and a wheel by the village), loads it as the autosave, hides the HUD
and adds the wordmark; CI writes it to `dist/og.png`, served at
`https://hydro.nomeata.de/og.png`. `public/og.png` is the committed fallback
for local builds; refresh it with `npx tsx tools/og-image.ts make` then
`npx tsx tools/og-image.ts shoot --out public/og.png` (against `vite preview`).
`e2e/meta.spec.ts` checks the tags and that the image is served.

## 5b. Sound review — `tools/sound-review.ts`
The ears' analogue of the screenshots (docs/SOUND.md). `npm run
sound-review -- [--seconds 20] [--only river,village]` (needs a preview
server; `HYDRO_PW_PORT` or `--url`) opens the game in headless Chromium
with `?test=1&sound=1` for each scenario — quiet meadow, river close-up,
paused, zoomed out (main game, seed 1) and the staged village, rain,
weir and water-wheel scenes — records the mixer's ticks in real time,
then renders them offline through the game's own Web Audio graph
(`SoundSystem.renderOffline`, an `OfflineAudioContext`). It writes
`out/sound/<scenario>.wav` and analyses each: integrated and momentary
loudness (BS.1770 K-weighting, approx. LUFS), peak (headroom ≥ 3 dB),
spectral balance in five bands, sustained tones (drones), click
candidates, spot events per minute and the mean layer gains; warnings
for peaks, loud scenarios and scenarios far from the median loudness go
to `out/sound/report.json`. With ffmpeg installed it also renders a
spectrogram (`<scenario>.png`) and waveform (`<scenario>-wave.png`):
look at them for clicks (vertical lines), harsh highs, drones (long
horizontal lines) and repetition, and listen to the WAVs. Unit tests of
the mixing logic: `tests/audio/mix.test.ts`; e2e: `e2e/sound.spec.ts`.

## 6. Performance
- `npm run bench`: hydro steps/sec for 256² and 512² worlds in Node; tracked
  over time (bench results are printed in CI logs). Besides the all-wet
  kernel and full step it times the flow kernel on 25 % of the tiles (per
  active cell) and on a half-dry world (tile sleeping).
- `npx tsx tools/benchgame.ts [size] [seed]`: a real game step (generated
  world, village, after the worker's spin-up), with the active share.
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
`.github/workflows/ci.yml`, parallel jobs on every push and PR:
- **check** (2 runners): typecheck, and vitest split with `--shard=k/2`;
- **build**: `vite build` (plus `dist/version.json` with the commit), shared
  with the next jobs as the `dist` artifact;
- **e2e** (8 runners): Playwright on the built site, `--shard=k/8`
  (`fullyParallel`, so single tests are spread; the `list` reporter prints
  each test's duration, to find slow ones);
- **screenshots**: the `@readme` spec (README screenshots and `og.png`);
- **deploy** (main only): needs check, build and e2e to pass; takes the
  fresh screenshots, or keeps the published ones if that job failed.

A push to a branch or PR cancels its older run; runs on `main` are never
cancelled, so a busy stretch of pushes still deploys. Their deploys queue
one at a time (`pages` group), and a run whose commit is no longer newer
than the deployed one (`/version.json`) skips its deploy. A push deploys in
about 10 minutes.
