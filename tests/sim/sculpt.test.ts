import { describe, expect, it } from 'vitest';
import { CellFlag, LandUse, SoilType, World } from '../../src/sim/world';
import { Simulation } from '../../src/sim/sim';
import { CELL, CELL_AREA, STEPS_PER_DAY } from '../../src/sim/constants';
import { BRUSH, BRUSH_SIZES, brushSample, capHeight, newStamp, passDepth, stampOffset, strokeSamples, type SculptGrid } from '../../src/sim/plans/sculpt';
import { loadGame, saveGame } from '../../src/sim/persist';
import type { BrushTool, Command } from '../../src/shared/protocol';

/** A flat meadow at 10 m, with a pond in one corner. */
function meadow(n = 48): World {
  const w = new World(n, n, 3);
  for (let i = 0; i < w.size; i++) {
    w.bedrock[i] = 8;
    w.soil[i] = 2;
    w.soilType[i] = SoilType.Loam;
    w.ground[i] = 0.3;
  }
  for (let y = 30; y < 44; y++) for (let x = 30; x < 44; x++) w.water[w.idx(x, y)] = 0.8;
  return w;
}

function totalWater(w: World): number {
  let s = 0;
  for (let i = 0; i < w.size; i++) s += w.water[i]! + w.ground[i]!;
  return s * CELL_AREA;
}

const hold = (tool: BrushTool, x: number, y: number, seconds: number, radius = 3, stroke = 1): Command => {
  const samples: number[] = [];
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) samples.push(x, y, 1 / 60);
  return { type: 'sculpt', tool, radius, stroke, samples };
};

/** A grid of `n`² cells with its own heights, to which the kernel's changes are applied. */
function field(n: number, h: (x: number, y: number) => number, fixed: (i: number) => boolean = () => false) {
  const z = Float64Array.from({ length: n * n }, (_, i) => h(i % n, (i / n) | 0));
  const z0 = Float64Array.from(z);
  const grid: SculptGrid = { width: n, height: n, terrain: (i) => z[i]!, fixed, orig: (i) => z0[i]! };
  const stamp = newStamp();
  /** The brush held at (x, y) for `seconds`, one sample per frame. */
  const hold = (tool: BrushTool, x: number, y: number, r: number, seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
      const dz: [number, number][] = [];
      brushSample(grid, tool, x, y, r, 1 / 60, stamp, (i, d) => dz.push([i, d]));
      for (const [i, d] of dz) z[i]! += d;
    }
  };
  const at = (x: number, y: number) => z[y * n + x]!;
  /** Steepest drop to a neighbour (8-connected) over the distance (m per m). */
  const steepest = () => {
    let m = 0;
    for (let y = 1; y < n - 1; y++)
      for (let x = 1; x < n - 1; x++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            m = Math.max(m, Math.abs(at(x, y) - at(x + dx, y + dy)) / (Math.hypot(dx, dy) * CELL));
          }
    return m;
  };
  const volume = () => z.reduce((a, b) => a + b, 0) * CELL_AREA;
  return { z, grid, stamp, hold, at, steepest, volume };
}

describe('brush kernel: the stamp', () => {
  it('a held Dig at one spot converges to a round bowl, whatever the ground was like', () => {
    const f = field(40, (x, y) => 5 + 0.3 * Math.sin(x * 1.7) * Math.cos(y * 2.3));
    f.hold('dig', 20, 20, 3, 2);
    // Round: cells at the same distance from the centre stand at the same height.
    const byD = new Map<number, number[]>();
    for (let y = 10; y <= 30; y++)
      for (let x = 10; x <= 30; x++) {
        const d = Math.round(Math.hypot(x - 20, y - 20) * 1000);
        // (Inside where the ellipsoid is gentler than loose earth: outside it, the slumped earth follows the old bumps.)
        if (d >= 2000) continue;
        byD.set(d, [...(byD.get(d) ?? []), f.at(x, y)]);
      }
    const rings = [...byD.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, hs] of rings) expect(Math.max(...hs) - Math.min(...hs)).toBeLessThan(1e-3);
    // A bowl: rising from the centre, the ellipsoid's shape, pressed in rate × time below the highest contact.
    for (let k = 1; k < rings.length; k++) expect(rings[k]![1][0]!).toBeGreaterThanOrEqual(rings[k - 1]![1][0]! - 1e-6);
    const bottom = f.at(20, 20);
    expect(bottom).toBeLessThan(5 - BRUSH.rate * 2 + 0.3 + 1e-6);
    expect(f.at(21, 20) - bottom).toBeCloseTo(stampOffset(1, 3), 1);
    expect(f.at(22, 21) - bottom).toBeCloseTo(stampOffset(Math.sqrt(5), 3), 1);
    // Smooth: nowhere steeper than loose earth stands.
    expect(f.steepest()).toBeLessThan(BRUSH.repose * 1.05);
  });

  it('pressed deeper than its cap, the bowl widens into a funnel instead of steepening', () => {
    const f = field(48, () => 10);
    const r = 3;
    f.hold('dig', 24, 24, r, 1.5);
    const shallow = [...f.z].filter((h) => h < 10 - 0.05).length;
    f.hold('dig', 24, 24, r, 6);
    expect(10 - f.at(24, 24)).toBeGreaterThan(capHeight(r) * 1.5);
    expect(f.steepest()).toBeLessThan(BRUSH.repose * 1.05);
    // Wider than the stamp: dug ground reaches well beyond its rim.
    const deep = [...f.z].filter((h) => h < 10 - 0.05).length;
    expect(deep).toBeGreaterThan(shallow * 2);
    expect(f.at(24 + r + 2, 24)).toBeLessThan(10 - 0.5);
    // The slumped earth stays in the hole: what is gone is no more than the stamp pressed out.
    expect(Math.abs(f.at(24 + r + 2, 24) - f.at(24, 24 + r + 2))).toBeLessThan(1e-6);
  });

  it('a held Raise heaps a round mound that broadens like a sand pile', () => {
    const f = field(48, () => 10);
    f.hold('raise', 24, 24, 3, 6);
    expect(f.at(24, 24) - 10).toBeGreaterThan(capHeight(3));
    expect(f.steepest()).toBeLessThan(BRUSH.repose * 1.05);
    expect(f.at(28, 24)).toBeCloseTo(f.at(24, 28), 6);
    expect(f.at(24 + 5, 24)).toBeGreaterThan(10.5);
  });

  it('the small brush makes a rounded bowl over its cells, never a single-cell spike', () => {
    for (const tool of ['dig', 'raise'] as const)
      for (const seconds of [0.1, 0.4, 1, 3]) {
        const f = field(30, () => 5);
        const r = BRUSH_SIZES[0]!;
        // Off the cell centres too.
        f.hold(tool, 15.3, 14.8, r, seconds);
        expect(f.steepest()).toBeLessThan(BRUSH.repose * 1.05);
        // The cell at the centre is no more than a gentle step from its neighbours.
        const c = f.at(15, 15);
        const ring = [f.at(14, 15), f.at(16, 15), f.at(15, 14), f.at(15, 16)];
        const depth = Math.abs(c - 5);
        expect(depth).toBeGreaterThan(0.05);
        // A tap is a shallow dimple; held, a bowl over many cells whose centre is a gentle step below its neighbours.
        if (seconds < 0.2) expect(depth).toBeLessThan(0.15);
        if (seconds < 0.2) expect([...f.z].filter((h) => Math.abs(h - 5) > 0.2 * depth).length).toBeGreaterThanOrEqual(2);
        else if (seconds < 1) expect([...f.z].filter((h) => Math.abs(h - 5) > 0.1 * depth).length).toBeGreaterThanOrEqual(4);
        else {
          for (const h of ring) expect(Math.abs(h - c)).toBeLessThan(0.6 * depth);
          expect([...f.z].filter((h) => Math.abs(h - 5) > 0.3 * depth).length).toBeGreaterThanOrEqual(8);
        }
      }
  });

  it('dragged along a line it cuts a round-bottomed channel of steady depth', () => {
    const f = field(60, () => 10);
    const s = strokeSamples([[10, 30], [50, 30]], 2, 1 / 60);
    for (let k = 0; k < s.length; k += 3) {
      const dz: [number, number][] = [];
      brushSample(f.grid, 'dig', s[k]!, s[k + 1]!, 3, s[k + 2]!, f.stamp, (i, d) => dz.push([i, d]));
      for (const [i, d] of dz) f.z[i]! += d;
    }
    const d20 = 10 - f.at(20, 30);
    const d40 = 10 - f.at(40, 30);
    expect(d20).toBeGreaterThan(0.5);
    expect(Math.abs(d40 - d20)).toBeLessThan(0.1 * d20);
    expect(d20).toBeLessThan(passDepth(3, 2) * 1.3);
    // Round bottomed and symmetric across.
    expect(f.at(30, 29)).toBeCloseTo(f.at(30, 31), 3);
    expect(f.at(30, 29)).toBeGreaterThan(f.at(30, 30));
    expect(f.at(30, 28)).toBeGreaterThan(f.at(30, 29));
    expect(f.steepest()).toBeLessThan(BRUSH.repose * 1.05);
  });

  it('a quick swipe does little; holding does a lot', () => {
    expect(passDepth(3, 30)).toBeLessThan(0.15);
    expect(BRUSH.rate * 2).toBeGreaterThan(2);
    const s = strokeSamples([[0, 0], [10, 0]], 5);
    let t = 0;
    for (let k = 2; k < s.length; k += 3) t += s[k]!;
    expect(t).toBeCloseTo(2, 1);
  });

  it('leaves fixed cells alone and fades out beside them', () => {
    const f = field(30, () => 5, (i) => i === 15 * 30 + 15);
    f.hold('dig', 15, 15, 4, 1.5);
    expect(f.at(15, 15)).toBe(5);
    const next = 5 - f.at(16, 15);
    const far = 5 - f.at(17, 15);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(0.5 * far);
  });

  it('keeps a natural steep bank as it was, beyond what the stroke dug', () => {
    // A 3 m step at x = 30 (steeper than loose earth), dug at well away from it.
    const f = field(40, (x) => (x >= 30 ? 8 : 5));
    f.hold('dig', 15, 20, 3, 2);
    expect(f.at(30, 20) - f.at(29, 20)).toBeCloseTo(3, 6);
  });

  it('even pulls the ground towards its mean', () => {
    const flat: SculptGrid = { width: 20, height: 20, terrain: () => 5, fixed: () => false };
    const bumpy: SculptGrid = { ...flat, terrain: (i) => ((i % 20) + ((i / 20) | 0)) % 2 ? 6 : 4 };
    let before = 0;
    let after = 0;
    brushSample(bumpy, 'even', 10, 10, 3, 0.2, newStamp(), (i, d) => {
      before += Math.abs(bumpy.terrain(i) - 5);
      after += Math.abs(bumpy.terrain(i) + d - 5);
    });
    expect(after).toBeLessThan(before * 0.9);
  });
});

describe('sculpting in the sim', () => {
  it('changes the ground at once, also while no time passes, and marks it loose earth', () => {
    const w = meadow();
    const sim = new Simulation(w, 1);
    const i = w.idx(12, 12);
    const z = w.terrain(i);
    sim.command(hold('raise', 12, 12, 1));
    expect(w.terrain(i)).toBeGreaterThan(z + 1);
    expect(w.flags[i]! & CellFlag.Fill).toBeTruthy();
    sim.command(hold('dig', 22, 12, 1, 3, 2));
    const j = w.idx(22, 12);
    expect(w.terrain(j)).toBeLessThan(z - 1);
    expect(w.flags[j]! & CellFlag.Canal).toBeTruthy();
    expect(w.flags[j]! & CellFlag.Fill).toBeFalsy();
    expect(sim.step).toBe(0);
    expect(sim.brush.moved.brush).toBeGreaterThan(40);
    expect(sim.achievements.hasEarned('firstSpade')).toBe(true);
  });

  it('conserves water: raising under water lifts it, digging makes room', () => {
    const w = meadow();
    const sim = new Simulation(w, 1);
    const before = totalWater(w);
    sim.command(hold('raise', 36, 36, 1.5, 4));
    sim.command(hold('dig', 32, 40, 1.5, 4, 2));
    sim.command(hold('even', 34, 38, 1, 4, 3));
    expect(totalWater(w)).toBeCloseTo(before, 3);
    // The raised water runs off: still conserved while it flows (closed meadow, no rain).
    sim.vegetationOn = false;
    sim.run(200);
    const L = sim.ledger;
    expect(totalWater(w)).toBeCloseTo(before + L.rain + L.inflow - L.outflow - L.evaporation - L.seepage, 0);
  });

  it('goes round houses, jetties and structures; fields under it survive gentle work', () => {
    const w = meadow();
    const sim = new Simulation(w, 1);
    const house = w.idx(12, 12);
    const bridge = w.idx(14, 12); // a jetty's deck (no footbridge there)
    const struct = w.idx(12, 14);
    const field = w.idx(10, 12);
    w.landuse[house] = LandUse.Building;
    w.landuse[bridge] = LandUse.Bridge;
    w.flags[struct]! |= CellFlag.Structure;
    w.landuse[field] = LandUse.Field;
    w.crop[field] = 100;
    const z = [house, bridge, struct].map((i) => w.terrain(i));
    // (A structure flag is derived from the structures: keep it for this test.)
    sim.syncStructureFlags = () => {};
    sim.command(hold('dig', 12, 12, 1.5, 4));
    expect([house, bridge, struct].map((i) => w.terrain(i))).toEqual(z);
    expect(w.terrain(field)).toBeLessThan(z[0]! - 0.2);
    expect(w.landuse[field]).toBe(LandUse.Field);
    expect(w.crop[field]).toBe(100);
    expect(w.terrain(w.idx(12, 9))).toBeLessThan(z[0]! - 0.1);
  });

  it('loses a field only where the ground gets too steep to farm, by brush or scripted line', () => {
    const w = meadow();
    const sim = new Simulation(w, 1);
    const gentle = [w.idx(6, 6), w.idx(7, 6)];
    const steep = [w.idx(20, 8), w.idx(20, 7)];
    for (const i of [...gentle, ...steep]) {
      w.landuse[i] = LandUse.Field;
      w.crop[i] = 50;
    }
    // A gentle raise over two fields: they keep growing.
    sim.command(hold('raise', 6.5, 6, 0.6, 4));
    expect(w.terrain(gentle[0]!)).toBeGreaterThan(10.05);
    for (const i of gentle) expect(w.landuse[i]).toBe(LandUse.Field);
    // A deep trench (3 m) dug along y = 10: the field on its lip (2 m above the next cell) is too steep, the one behind it stays.
    sim.command({ type: 'shapeLine', tool: 'dig', points: [[14, 10], [26, 10]], width: 1, amount: 3 });
    expect(w.terrain(w.idx(20, 9))).toBeLessThan(8.5);
    expect(w.landuse[steep[0]!]).toBe(LandUse.None);
    expect(w.landuse[steep[1]!]).toBe(LandUse.Field);
  });

  it('is deterministic and survives save and resume', async () => {
    const make = () => {
      const sim = new Simulation(meadow(), 4);
      sim.command(hold('dig', 10, 20, 1));
      sim.command(hold('raise', 25, 20, 1, 2.5, 2));
      sim.run(50);
      return sim;
    };
    const a = make();
    const b = make();
    expect(a.stateHash()).toBe(b.stateHash());
    const { sim: c } = await loadGame(await saveGame(a, {}));
    expect(c.stateHash()).toBe(a.stateHash());
    expect(c.brush.moved).toEqual(a.brush.moved);
    a.run(300);
    c.run(300);
    expect(c.stateHash()).toBe(a.stateHash());
  });

  it('a channel dug from the pond fills with its water', () => {
    const w = meadow();
    const sim = new Simulation(w, 1);
    sim.command({ type: 'shapeLine', tool: 'dig', points: [[36, 30], [36, 20]], width: 2, amount: 1 });
    sim.run(STEPS_PER_DAY / 4);
    expect(w.water[w.idx(36, 24)]!).toBeGreaterThan(0.05);
  });

  it('finishes the earthwork plans of old saves on load', async () => {
    const sim = new Simulation(meadow(), 1);
    const w = sim.world;
    const i = w.idx(5, 5);
    const z = w.terrain(i);
    w.plan[i] = z - 1;
    const { sim: b } = await loadGame(await saveGame(sim, {}));
    expect(b.world.terrain(i)).toBeCloseTo(z - 1, 4);
    expect(Number.isNaN(b.world.plan[i]!)).toBe(true);
  });
});
