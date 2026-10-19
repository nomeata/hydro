/**
 * Desire paths grow as connected, thin ways along the routes people walk
 * (docs/PEOPLE.md §3.3), deterministically.
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/shared/rng';
import { walk, type Walker } from '../../src/sim/people/agents';
import { pathDuplicates, pathStats, updateDesirePaths } from '../../src/sim/people/desire';
import { PathFinder } from '../../src/sim/people/path';
import { LandUse, SOIL_PROPS, SoilType, World } from '../../src/sim/world';

function meadow(n: number): World {
  const w = new World(n, n, 7);
  for (let i = 0; i < w.size; i++) {
    w.bedrock[i] = 20;
    w.soil[i] = 2;
    w.soilType[i] = SoilType.Loam;
    w.ground[i] = 0.5 * 2 * SOIL_PROPS[SoilType.Loam]!.porosity;
    w.vegetation[i] = 0.3;
  }
  return w;
}

/**
 * A hamlet: a house (with its yard) and a store, a well, and a field in the
 * meadow around. Every day people walk from near the house to somewhere
 * near one of the destinations and back, by A*.
 */
function hamlet(days: number): World {
  const w = meadow(48);
  const set = (x0: number, y0: number, x1: number, y1: number, lu: LandUse) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) w.landuse[w.idx(x, y)] = lu;
  };
  set(8, 8, 10, 10, LandUse.Yard);
  w.landuse[w.idx(9, 9)] = LandUse.Building;
  set(36, 10, 37, 11, LandUse.Building); // well
  set(10, 36, 11, 37, LandUse.Building); // store
  set(32, 32, 40, 40, LandUse.Field);
  const dests: [number, number][] = [
    [36, 12],
    [12, 36],
    [31, 31],
    [33, 31],
    [31, 34],
  ];
  const rng = new Rng(5);
  const pf = new PathFinder(w);
  const a: Walker = { x: 11, y: 11, heading: 0, path: [], pathPos: 0, vx: 0, vy: 0 };
  for (let day = 0; day < days; day++) {
    for (let k = 0; k < 8; k++) {
      const home = w.idx(11 + rng.int(-1, 2) * (rng.next() < 0.5 ? 1 : 0), 11 + rng.int(0, 2));
      const [dx, dy] = dests[rng.int(0, dests.length)]!;
      const goal = w.idx(dx + rng.int(-1, 2), dy + rng.int(-1, 2));
      for (const [from, to] of [
        [home, goal],
        [goal, home],
      ] as const) {
        const p = pf.find(from, to, { window: 48, maxExpand: 20000 });
        if (!p) continue;
        a.x = from % w.width;
        a.y = (from / w.width) | 0;
        a.path = p;
        a.pathPos = 0;
        while (!walk(w, a, 4));
      }
    }
    updateDesirePaths(w);
  }
  return w;
}

describe('desire paths', () => {
  it('grow into connected, one-cell-wide ways along the routes people take', () => {
    const w = hamlet(60);
    const s = pathStats(w);
    // Ways to the well, the store and the field: long, joined, no specks or patches.
    expect(s.cells).toBeGreaterThan(40);
    expect(s.largest).toBeGreaterThanOrEqual(0.8 * s.cells);
    expect(s.small).toBe(0);
    expect(s.thick).toBe(0);
    // One way per direction: no parallel tracks, no short loops.
    expect(pathDuplicates(w)).toEqual({ parallel: 0, loop: 0 });
    // The way to the well reaches it from the house's yard.
    const nearPath = (x: number, y: number) => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (w.landuse[w.idx(x + dx, y + dy)] === LandUse.Path) return true;
      return false;
    };
    let wellEnd = false;
    for (let y = 9; y <= 12; y++) for (let x = 35; x <= 38; x++) wellEnd ||= nearPath(x, y);
    expect(wellEnd).toBe(true);
  });

  it('are deterministic', () => {
    const a = hamlet(30);
    const b = hamlet(30);
    expect(Buffer.from(a.landuse).equals(Buffer.from(b.landuse))).toBe(true);
    expect(Buffer.from(a.traffic).equals(Buffer.from(b.traffic))).toBe(true);
  });

  it('thin out thick paths of old saves, keeping them connected, and drop stubs into nowhere', () => {
    const w = meadow(24);
    // A three-cell-wide band, most trodden in the middle row, and a lone dead-end spur.
    for (let x = 3; x <= 20; x++)
      for (let y = 10; y <= 12; y++) {
        w.landuse[w.idx(x, y)] = LandUse.Path;
        w.traffic[w.idx(x, y)] = y === 11 ? 240 : 120;
      }
    w.landuse[w.idx(10, 5)] = LandUse.Path;
    w.traffic[w.idx(10, 5)] = 60;
    for (let d = 0; d < 3; d++) updateDesirePaths(w);
    const s = pathStats(w);
    expect(s.thick).toBe(0);
    expect(s.groups).toBe(1);
    for (let x = 3; x <= 20; x++) expect(w.landuse[w.idx(x, 11)]).toBe(LandUse.Path);
    expect(w.landuse[w.idx(10, 5)]).toBe(LandUse.None);
  });

  it('merge parallel tracks: the less trodden one gives way', () => {
    const w = meadow(32);
    for (let x = 4; x <= 26; x++) {
      w.landuse[w.idx(x, 10)] = LandUse.Path;
      w.traffic[w.idx(x, 10)] = 230;
      w.landuse[w.idx(x, 12)] = LandUse.Path;
      w.traffic[w.idx(x, 12)] = 140;
    }
    expect(pathDuplicates(w).parallel).toBeGreaterThan(30);
    for (let d = 0; d < 6; d++) updateDesirePaths(w);
    expect(pathDuplicates(w).parallel).toBe(0);
    for (let x = 4; x <= 26; x++) expect(w.landuse[w.idx(x, 10)]).toBe(LandUse.Path);
    let weak = 0;
    for (let x = 4; x <= 26; x++) if (w.landuse[w.idx(x, 12)] === LandUse.Path) weak++;
    expect(weak).toBeLessThan(6);
  });

  it('break short loops (a ladder loses its rungs) but stay connected', () => {
    const w = meadow(32);
    for (let x = 4; x <= 26; x++) {
      w.landuse[w.idx(x, 10)] = LandUse.Path;
      w.traffic[w.idx(x, 10)] = 230;
    }
    // A loop beside the way: up, along and back down, 3 cells out.
    for (let y = 11; y <= 13; y++) {
      for (const x of [10, 16]) {
        w.landuse[w.idx(x, y)] = LandUse.Path;
        w.traffic[w.idx(x, y)] = 120;
      }
    }
    for (let x = 11; x <= 15; x++) {
      w.landuse[w.idx(x, 13)] = LandUse.Path;
      w.traffic[w.idx(x, 13)] = 120;
    }
    expect(pathDuplicates(w).loop).toBeGreaterThan(0);
    for (let d = 0; d < 4; d++) updateDesirePaths(w);
    expect(pathDuplicates(w).loop).toBe(0);
    expect(pathStats(w).groups).toBe(1);
    for (let x = 4; x <= 26; x++) expect(w.landuse[w.idx(x, 10)]).toBe(LandUse.Path);
  });

  it('straighten staircases and zigzags', () => {
    const w = meadow(32);
    // A staircase (right, up, right, up, …) and a zigzag along y = 20/21.
    let x = 4;
    let y = 4;
    for (let k = 0; k < 8; k++) {
      w.landuse[w.idx(x, y)] = LandUse.Path;
      if (k & 1) y++;
      else x++;
    }
    for (let k = 4; k <= 26; k++) w.landuse[w.idx(k, 20 + (k & 1))] = LandUse.Path;
    for (let i = 0; i < w.size; i++) if (w.landuse[i] === LandUse.Path) w.traffic[i] = 200;
    for (let d = 0; d < 3; d++) updateDesirePaths(w);
    const s = pathStats(w);
    expect(s.groups).toBe(2);
    // The zigzag became (mostly) a straight row.
    const row = (y: number) => {
      let n = 0;
      for (let k = 4; k <= 26; k++) if (w.landuse[w.idx(k, y)] === LandUse.Path) n++;
      return n;
    };
    expect(Math.max(row(20), row(21))).toBeGreaterThan(18);
    // The staircase lost its corners: a diagonal, no cell with two orthogonal path neighbours a corner apart.
    expect(pathStats(w).cells).toBeLessThan(8 + 23);
  });
});
