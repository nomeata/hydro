import { describe, expect, it } from 'vitest';
import { World } from '../../src/sim/world';
import { PathFinder } from '../../src/sim/people/path';
import { generateWorld } from '../../src/sim/worldgen';

function flat(n: number): World {
  const w = new World(n, n, 1);
  for (let i = 0; i < w.size; i++) w.soil[i] = 1;
  return w;
}

describe('pathfinding', () => {
  it('finds a straight path on flat ground', () => {
    const w = flat(32);
    const p = new PathFinder(w).find(w.idx(2, 2), w.idx(20, 2))!;
    expect(p).not.toBeNull();
    expect(p.length).toBe(19);
  });

  it('goes around deep water and wades through shallow water', () => {
    const w = flat(40);
    for (let y = 0; y < 30; y++) w.water[w.idx(20, y)] = 1.0; // a deep ditch with a gap at y >= 30
    const pf = new PathFinder(w);
    const p = pf.find(w.idx(10, 5), w.idx(30, 5))!;
    expect(p).not.toBeNull();
    expect(Math.max(...p.map((i) => (i / 40) | 0))).toBeGreaterThanOrEqual(30);
    for (let y = 0; y < 30; y++) w.water[w.idx(20, y)] = 0.2; // now shallow
    const q = pf.find(w.idx(10, 5), w.idx(30, 5))!;
    expect(q.length).toBeLessThan(p.length);
  });

  it('returns null when the goal is cut off', () => {
    const w = flat(40);
    for (let y = 0; y < 40; y++) w.water[w.idx(20, y)] = 2;
    expect(new PathFinder(w).find(w.idx(10, 5), w.idx(30, 5))).toBeNull();
  });

  it('crosses water on a bridge', () => {
    const w = flat(40);
    for (let y = 0; y < 40; y++) w.water[w.idx(20, y)] = 2;
    const bridge = (i: number) => i === w.idx(20, 5);
    expect(new PathFinder(w).find(w.idx(10, 5), w.idx(30, 5), { bridge })).not.toBeNull();
  });

  it('is fast enough on a real map', () => {
    const { world, startX, startY } = generateWorld({ seed: 2, size: 256 });
    const pf = new PathFinder(world);
    const s = world.idx(Math.round(startX), Math.round(startY));
    let found = 0;
    const t0 = performance.now();
    for (let k = 0; k < 40; k++) {
      const gx = Math.max(0, Math.min(255, Math.round(startX) + ((k * 37) % 61) - 30));
      const gy = Math.max(0, Math.min(255, Math.round(startY) + ((k * 53) % 61) - 30));
      if (pf.find(s, world.idx(gx, gy))) found++;
    }
    const ms = (performance.now() - t0) / 40;
    expect(found).toBeGreaterThan(10);
    expect(ms).toBeLessThan(25); // slow container; ~5× faster on real hardware
  });
});
