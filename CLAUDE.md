# Notes for Claude working on Hydro

- Read docs/DESIGN.md, docs/ARCHITECTURE.md, docs/TESTING.md and
  docs/ROADMAP.md first. Keep ROADMAP.md status markers current.
- Layout: `src/sim` (no DOM/three; runs in worker and Node), `src/shared`
  (protocol, rng, noise), `src/client` (worker wrapper), `src/render`
  (three.js), `src/ui` (HTML HUD/tools), `e2e` (Playwright), `tests` (vitest).
- The sim must stay deterministic: no `Math.random`/`Date` in `src/sim`.
- Units in the sim are SI metres/seconds; see `src/sim/constants.ts` for the
  two clocks (hydraulic vs calendar) and `src/sim/params.ts` for tunables.
- Commands: `npm run check`, `npx playwright test`, `npm run bench`,
  `npm run preview-world`.
- Playwright uses the pre-installed Chromium at /opt/pw-browsers/chromium
  with SwiftShader when present (see playwright.config.ts).
- Visual review: take screenshots (tools/shot.ts or e2e) and look at them.
- This container's CPU is ~5× slower than a typical desktop; judge perf with
  that in mind (bench results are relative).
- Commit with the user as author; end messages with the Co-Authored-By trailer.
