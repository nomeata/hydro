# Credits

## 3D models

All 3D models in `public/assets/` are by **Kenney** (https://kenney.nl) and
released under **CC0 1.0** (public domain). Credit is not required, but we
gladly give it. Thank you, Kenney!

| Pack | Version | Used for |
|---|---|---|
| [Nature Kit](https://kenney.nl/assets/nature-kit) | 2.1 | trees, bushes, rocks, grass, flowers, reeds, lily pads, mushrooms, logs, crops, fences, small props |
| [Fantasy Town Kit](https://kenney.nl/assets/fantasy-town-kit) | 2.0 | house parts (walls, roofs, chimney), water-mill and windmill wheels, cart, stall, lantern |
| [Survival Kit](https://kenney.nl/assets/survival-kit) | 2.0 | resources (wood, planks, stone), tools, bucket, barrel, workbench |
| [Mini Characters](https://kenney.nl/assets/mini-characters) | 1.0 | the little people |
| [Cube Pets](https://kenney.nl/assets/cube-pets) | 2.0 | cows, pigs, chicks, bunnies, deer, dogs, cats, foxes, beavers, fish |

The original license files are copied to `public/assets/LICENSE-kenney-*.txt`.

The models were processed by `tools/assets.ts`: static models are flattened
into a single vertex-coloured mesh (the Nature Kit palette is recoloured to
warmer greens), and animated models have unused animations and vertex
attributes stripped. Run `npx tsx tools/assets.ts [kenneyDir]` with the
downloaded packs to regenerate them.
