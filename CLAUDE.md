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
- Commit as Claude <noreply@anthropic.com> (the repo's git config); never
  pass another --author. End messages with the Co-Authored-By trailer.
- Agents merge their own finished branch into `main` (after merging `main`
  into it and running all tests locally), push, and report right away —
  don't wait for GitHub CI; the lead keeps an eye on CI and dispatches a fix
  if a run fails.
- Parallel agents: run each in its own git worktree (`isolation: "worktree"`)
  on its own branch from current `main`; it commits there, and the lead
  reviews and merges. In a fresh worktree, symlink `node_modules` from the
  main checkout instead of reinstalling. Agents commit after every
  meaningful step: the container can restart and uncommitted work in a
  worktree may be lost (or need salvaging). Changes to shared contracts
  (`src/shared/protocol.ts`, `src/render/coords.ts`, `src/sim/world.ts`)
  are made by the lead first, then branched from.
- `main` must always build and pass tests: every push deploys to
  https://hydro.nomeata.de/.
