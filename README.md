# Hydro

A slow, cozy water-management sandbox in the browser.

Rain falls, rivers wander, groundwater rises and sinks. You shape the land
with your own hand — raise, dig and even the ground with a brush — and plan
weirs, gates, wheels and (eventually) pumps and turbines that a little crew
builds. The people then decide for themselves where to farm, fish, graze and
settle.

**Play:** https://hydro.nomeata.de/ (desktop and phone)

| | |
|---|---|
| ![Overview](https://hydro.nomeata.de/screenshots/overview.png) | ![Close-up](https://hydro.nomeata.de/screenshots/closeup.png) |

<sub>Screenshots are rendered by CI from the deployed build.</sub>

## Status

Early development. See [the roadmap](docs/ROADMAP.md).

## Controls

| | Mouse | Touch |
|---|---|---|
| Pan | drag | one finger (Look tool) / two fingers |
| Zoom | wheel | pinch |
| Rotate | right-drag | two-finger twist |
| Draw plan | left-drag with a tool | one finger with a tool |
| Pick a tool | keys 1…9, 0 in palette order (Esc: Look) | tap |
| Open/close a sluice gate | click it (Look tool) | tap it |

URL options: `?seed=123` picks a world, `?size=512` a bigger map,
`?stats=1` shows performance numbers, `?cheat=1` makes every tool
available from the start (for testing).

## Development

```sh
npm install
npm run dev        # http://localhost:5173
npm run check      # typecheck + unit tests
npm run e2e        # Playwright browser tests
npm run bench      # simulation kernel benchmark
npm run preview-world -- 1 2 3   # worldgen preview PNGs in out/preview
```

Design and architecture: [docs/DESIGN.md](docs/DESIGN.md),
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/TESTING.md](docs/TESTING.md).

## Credits & license

Code: Apache-2.0. 3D models: [Kenney](https://kenney.nl) (CC0), see
[CREDITS.md](CREDITS.md).
