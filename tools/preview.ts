/**
 * Worldgen preview: writes PNGs for one or more seeds.
 *
 *   npx tsx tools/preview.ts [seed...] [--size 256] [--out out/preview] [--seeds N] [--scale 2]
 *
 * Per seed: <seed>-relief.png (hillshaded colour relief with water, inflows
 * in red, outlets in magenta, start point in white), <seed>-soil.png,
 * <seed>-veg.png, <seed>-ground.png, and <seed>-all.png (all four side by
 * side). With several seeds, contact.png shows all relief maps.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { CELL } from '../src/sim/constants';
import { CellFlag, SOIL_PROPS, type World } from '../src/sim/world';
import { generateWorldDebug } from '../src/sim/worldgen/index';

type RGB = [number, number, number];

interface Img {
  w: number;
  h: number;
  data: Uint8Array;
}

function img(w: number, h: number): Img {
  return { w, h, data: new Uint8Array(w * h * 3) };
}

function put(im: Img, x: number, y: number, c: RGB): void {
  if (x < 0 || y < 0 || x >= im.w || y >= im.h) return;
  const o = (y * im.w + x) * 3;
  im.data[o] = c[0];
  im.data[o + 1] = c[1];
  im.data[o + 2] = c[2];
}

function writePng(path: string, im: Img, scale = 1): void {
  const png = new PNG({ width: im.w * scale, height: im.h * scale });
  for (let y = 0; y < im.h * scale; y++)
    for (let x = 0; x < im.w * scale; x++) {
      const s = (Math.floor(y / scale) * im.w + Math.floor(x / scale)) * 3;
      const o = (y * im.w * scale + x) * 4;
      png.data[o] = im.data[s]!;
      png.data[o + 1] = im.data[s + 1]!;
      png.data[o + 2] = im.data[s + 2]!;
      png.data[o + 3] = 255;
    }
  writeFileSync(path, PNG.sync.write(png));
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function ramp(stops: [number, RGB][], v: number): RGB {
  if (v <= stops[0]![0]) return stops[0]![1];
  for (let k = 1; k < stops.length; k++) {
    if (v <= stops[k]![0]) {
      const [a, ca] = stops[k - 1]!;
      const [b, cb] = stops[k]!;
      return mix(ca, cb, (v - a) / (b - a));
    }
  }
  return stops[stops.length - 1]![1];
}

function shade(w: World, x: number, y: number, exag = 1.5): number {
  const W = w.width;
  const H = w.height;
  const z = (xx: number, yy: number): number => {
    const i = Math.min(H - 1, Math.max(0, yy)) * W + Math.min(W - 1, Math.max(0, xx));
    return w.bedrock[i]! + w.soil[i]!;
  };
  const dzdx = ((z(x + 1, y) - z(x - 1, y)) / (2 * CELL)) * exag;
  const dzdy = ((z(x, y + 1) - z(x, y - 1)) / (2 * CELL)) * exag;
  // Light from the north-west, 45° up.
  const nx = -dzdx;
  const ny = -dzdy;
  const nz = 1;
  const l = Math.hypot(nx, ny, nz);
  const lx = -0.5;
  const ly = -0.5;
  const lz = 0.707;
  return Math.max(0, (nx * lx + ny * ly + nz * lz) / l);
}

const HYPSO: [number, RGB][] = [
  [0, [92, 140, 70]],
  [0.15, [130, 165, 85]],
  [0.35, [190, 185, 115]],
  [0.55, [170, 135, 90]],
  [0.75, [140, 120, 105]],
  [0.92, [200, 195, 190]],
  [1, [250, 250, 250]],
];

const SOIL_COLORS: RGB[] = [
  [120, 120, 125], // rock
  [175, 165, 140], // gravel
  [235, 215, 150], // sand
  [140, 105, 60], // loam
  [190, 120, 90], // clay
  [110, 140, 120], // silt
  [60, 45, 40], // peat
];

function render(w: World, startX: number, startY: number) {
  const W = w.width;
  const H = w.height;
  let zmin = Infinity;
  let zmax = -Infinity;
  for (let i = 0; i < w.size; i++) {
    const z = w.terrain(i);
    zmin = Math.min(zmin, z);
    zmax = Math.max(zmax, z);
  }
  const relief = img(W, H);
  const soil = img(W, H);
  const veg = img(W, H);
  const ground = img(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const z = w.terrain(i);
      const hs = shade(w, x, y);
      const t = (z - zmin) / Math.max(1, zmax - zmin);
      let c = ramp(HYPSO, t);
      c = mix(c, [40, 90, 40], w.vegetation[i]! * 0.35);
      c = c.map((v) => v * (0.35 + 0.85 * hs)) as RGB;
      const d = w.water[i]!;
      if (d > 0.01) c = mix(c, mix([110, 170, 220], [25, 60, 150], Math.min(1, d / 3)), Math.min(1, 0.55 + d));
      if (w.flags[i]! & CellFlag.Outlet) c = [255, 0, 255];
      if (w.inflow[i]! > 0) c = [255, 30, 30];
      put(relief, x, y, c.map((v) => Math.max(0, Math.min(255, v))) as RGB);

      let sc = SOIL_COLORS[w.soilType[i]!]!;
      sc = sc.map((v) => v * (0.6 + 0.4 * hs)) as RGB;
      if (d > 0.05) sc = mix(sc, [40, 80, 200], 0.6);
      put(soil, x, y, sc);

      const v = w.vegetation[i]!;
      let vc = ramp(
        [
          [0, [200, 190, 160]],
          [0.3, [170, 200, 110]],
          [0.6, [70, 150, 60]],
          [1, [20, 80, 30]],
        ],
        v,
      );
      vc = vc.map((q) => q * (0.6 + 0.4 * hs)) as RGB;
      if (d > 0.05) vc = [60, 90, 200];
      put(veg, x, y, vc);

      const cap = w.soil[i]! * SOIL_PROPS[w.soilType[i]!]!.porosity;
      const sat = cap > 0 ? w.ground[i]! / cap : 0;
      let gc = ramp(
        [
          [0, [230, 200, 150]],
          [0.4, [150, 190, 200]],
          [0.8, [50, 110, 190]],
          [1, [10, 40, 120]],
        ],
        sat,
      );
      gc = gc.map((q) => q * (0.7 + 0.3 * hs)) as RGB;
      if (d > 0.05) gc = [0, 0, 60];
      put(ground, x, y, gc);
    }
  for (let k = -5; k <= 5; k++) {
    for (const im of [relief, soil, veg, ground]) {
      put(im, startX + k, startY, [255, 255, 255]);
      put(im, startX, startY + k, [255, 255, 255]);
    }
  }
  return { relief, soil, veg, ground };
}

function tile(images: Img[], cols: number, gap = 4): Img {
  const w = images[0]!.w;
  const h = images[0]!.h;
  const rows = Math.ceil(images.length / cols);
  const out = img(cols * w + (cols - 1) * gap, rows * h + (rows - 1) * gap);
  out.data.fill(255);
  images.forEach((im, k) => {
    const ox = (k % cols) * (w + gap);
    const oy = Math.floor(k / cols) * (h + gap);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = (y * w + x) * 3;
        put(out, ox + x, oy + y, [im.data[s]!, im.data[s + 1]!, im.data[s + 2]!]);
      }
  });
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const seeds: number[] = [];
  let size = 256;
  let out = 'out/preview';
  let scale = 1;
  let nSeeds = 0;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === '--size') size = Number(args[++k]);
    else if (a === '--out') out = args[++k]!;
    else if (a === '--scale') scale = Number(args[++k]);
    else if (a === '--seeds') nSeeds = Number(args[++k]);
    else seeds.push(Number(a));
  }
  for (let s = 1; s <= nSeeds; s++) seeds.push(s);
  if (seeds.length === 0) seeds.push(1, 2, 3, 4, 5, 6, 7, 8);
  mkdirSync(out, { recursive: true });
  const reliefs: Img[] = [];
  for (const seed of seeds) {
    const t0 = performance.now();
    const { result, debug } = generateWorldDebug({ seed, size });
    const ms = performance.now() - t0;
    const w = result.world;
    const ims = render(w, result.startX, result.startY);
    reliefs.push(ims.relief);
    writePng(join(out, `${seed}-relief.png`), ims.relief, scale);
    writePng(join(out, `${seed}-soil.png`), ims.soil, scale);
    writePng(join(out, `${seed}-veg.png`), ims.veg, scale);
    writePng(join(out, `${seed}-ground.png`), ims.ground, scale);
    writePng(join(out, `${seed}-all.png`), tile([ims.relief, ims.soil, ims.veg, ims.ground], 2), scale);
    let zmin = Infinity;
    let zmax = -Infinity;
    let inflow = 0;
    let outlets = 0;
    let wet = 0;
    for (let i = 0; i < w.size; i++) {
      zmin = Math.min(zmin, w.terrain(i));
      zmax = Math.max(zmax, w.terrain(i));
      inflow += w.inflow[i]!;
      if (w.flags[i]! & CellFlag.Outlet) outlets++;
      if (w.water[i]! > 0.01) wet++;
    }
    const tm = Object.entries(debug.timings)
      .map(([k, v]) => `${k} ${v.toFixed(0)}`)
      .join(', ');
    const qs = new Map<string, number>();
    for (const c of debug.inflowCells) qs.set(`${c}`, w.inflow[c]!);
    console.log(
      `seed ${seed} [${debug.gen.style}] x${result.riverScale.toFixed(2)} ${ms.toFixed(0)} ms (${tm}); relief ${zmin.toFixed(0)}..${zmax.toFixed(0)} m; ` +
        `inflow ${inflow.toFixed(1)} m³/s in ${debug.inflowCells.length} cells; outlets ${outlets}; wet ${((100 * wet) / w.size).toFixed(1)}%; ` +
        `paths ${debug.macro.paths.length}; start ${result.startX},${result.startY}`,
    );
  }
  if (reliefs.length > 1) writePng(join(out, 'contact.png'), tile(reliefs, Math.min(4, reliefs.length)), 1);
}

main();
