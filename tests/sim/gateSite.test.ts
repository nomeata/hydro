import { describe, expect, it } from 'vitest';
import { gateSite, gateSites, type GateGrid } from '../../src/sim/structures/gateSite';

/**
 * A 20×20 grid at 10 m with a bank (12 m) along x = 10: `pond` water 1 m
 * deep west of it on a bed at `bed`; the ground east of it at `east`.
 */
function grid(opts: { pond?: boolean; bed?: number; east?: number; wall?: boolean } = {}): GateGrid {
  const W = 20;
  const bed = opts.bed ?? 10;
  const east = opts.east ?? 9.5;
  const t = (i: number) => {
    const x = i % W;
    return x === 10 ? 12 : x < 10 ? bed : east;
  };
  return {
    width: W,
    height: W,
    terrain: t,
    depth: (i) => (opts.pond !== false && i % W < 10 ? 1 : 0),
    wall: (i) => opts.wall !== false && i % W === 10,
  };
}

describe('gate sites', () => {
  it('a bank holding a pond above lower ground: one cell wide, along the bank, its sill at the pond bed', () => {
    const s = gateSite(grid(), [10, 8])!;
    expect(s.ok).toBe(true);
    expect([s.cx, s.cy, s.width]).toEqual([10, 8, 1]);
    // The bank runs along y: the leaf lies along it.
    expect([s.dx, s.dy]).toEqual([0, 1]);
    expect(s.top).toBe(12);
    expect(s.sill).toBe(10);
  });

  it('the sill is the ground below when that stands higher than the pond bed (the pond drains down to it)', () => {
    const s = gateSite(grid({ bed: 9.5, east: 10.2 }), [10, 8])!;
    expect(s.ok).toBe(true);
    expect(s.sill).toBeCloseTo(10.2, 6);
  });

  it('not on flat ground, natural ridges, a dry bank, or where the other side is not lower', () => {
    const g = grid();
    expect(gateSite(g, [4, 8])!.ok).toBe(false);
    expect(gateSite(g, [15, 8])!.ok).toBe(false);
    expect(gateSite(grid({ wall: false }), [10, 8])!.ok).toBe(false);
    expect(gateSite(grid({ pond: false }), [10, 8])!.ok).toBe(false);
    expect(gateSite(grid({ east: 11 }), [10, 8])!.ok).toBe(false);
    expect(gateSite(g, [-3, 8])).toBeNull();
  });

  it('marks every bank cell that parts the water from lower ground, and nothing else', () => {
    const sites = gateSites(grid());
    expect(sites.length).toBe(20);
    expect(sites.every((s) => s.cx === 10)).toBe(true);
    expect(gateSites(grid({ pond: false }))).toEqual([]);
  });
});
