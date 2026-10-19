/**
 * Path links (render/village/fields.ts pathLinks): which neighbours a drawn
 * way runs to. Ways along yards do not sprout rungs into them; corners are
 * not cut twice; dead ends run on into one yard.
 */
import { describe, expect, it } from 'vitest';
import { pathLinks } from '../../src/render/village/fields';
import { LandUse } from '../../src/sim/world';

/** A land-use lookup from rows of characters ('#' path, 'y' yard, 'H' house, '=' bridge), row 0 at the top = highest y. */
function grid(rows: string[]): (x: number, y: number) => number {
  const H = rows.length;
  const lu: Record<string, number> = { '#': LandUse.Path, y: LandUse.Yard, H: LandUse.Building, '=': LandUse.Bridge };
  return (x, y) => lu[rows[H - 1 - y]?.[x] ?? '.'] ?? 0;
}
const E = 1 << 0;
const NE = 1 << 1;
const N = 1 << 2;
const W = 1 << 4;
const S = 1 << 6;

describe('path links', () => {
  it('a way along a row of yards has no rungs into them', () => {
    const lu = grid(['yyy', '###', '...']);
    expect(pathLinks(lu, 1, 1)).toEqual([E | W, 0, true]);
  });

  it('a dead end runs on into one yard (an orthogonal one first)', () => {
    const lu = grid(['yyy', '.#.', '.#.']);
    const [links, ends] = pathLinks(lu, 1, 1);
    expect(ends).toBe(N);
    expect(links).toBe(N | S);
  });

  it('a diagonal joins only where no path cell turns the corner', () => {
    expect(pathLinks(grid(['..#', '.#.', '...']), 1, 1)[0]).toBe(NE);
    expect(pathLinks(grid(['.##', '.#.', '...']), 1, 1)[0]).toBe(N);
  });

  it('bridges always join', () => {
    expect(pathLinks(grid(['...', '.#=', '.#.']), 1, 1)).toEqual([E | S, E, false]);
  });
});

describe('path texels', () => {
  it('a way passing a cluster of yards joins it once, from its most trodden cell', async () => {
    const { fieldsToRgba } = await import('../../src/render/village/fields');
    const { FIELD_BYTES } = await import('../../src/shared/protocol');
    const rows = ['.yyy.', '#####', '.....'];
    const Wd = 5;
    const H = rows.length;
    const src = new Uint8Array(Wd * H * FIELD_BYTES);
    const lu: Record<string, number> = { '#': LandUse.Path, y: LandUse.Yard };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < Wd; x++) {
        const i = y * Wd + x;
        src[FIELD_BYTES * i] = lu[rows[H - 1 - y]![x]!] ?? 0;
        src[FIELD_BYTES * i + 1] = x === 3 ? 90 : 40;
      }
    const dst = new Uint8Array(Wd * H * 4);
    fieldsToRgba(src, dst, Wd * H, Wd);
    let spurs = 0;
    for (let x = 0; x < Wd; x++) if (dst[4 * (1 * Wd + x) + 3]) spurs++;
    expect(spurs).toBe(1);
    expect(dst[4 * (1 * Wd + 3) + 3]).toBe(N);
  });
});

describe('village lanes', () => {
  it('join every door and the store in one tree through the yards, without loops', async () => {
    const { villageLanes } = await import('../../src/render/village/lanes');
    const { FIELD_BYTES } = await import('../../src/shared/protocol');
    const { RING_X, RING_Y } = await import('../../src/render/village/fields');
    // Three buildings two cells apart in a row, their yards merged into one cluster.
    const Wd = 12;
    const H = 7;
    const src = new Uint8Array(Wd * H * FIELD_BYTES);
    const bs = [
      { id: 1, kind: 'store' as const, x: 3, y: 3, rot: 0, progress: 1 },
      { id: 2, kind: 'house' as const, x: 5, y: 3, rot: Math.PI / 2, progress: 1 },
      { id: 3, kind: 'house' as const, x: 7, y: 3, rot: -Math.PI / 2, progress: 1 },
    ];
    for (const b of bs)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) src[FIELD_BYTES * ((b.y + dy) * Wd + b.x + dx)] = dx || dy ? LandUse.Yard : LandUse.Building;
    for (const b of bs) src[FIELD_BYTES * (b.y * Wd + b.x)] = LandUse.Building;
    const dst = new Uint8Array(Wd * H * 4);
    for (let i = 0; i < Wd * H; i++) dst[4 * i] = src[FIELD_BYTES * i]!;
    villageLanes(src, dst, Wd * H, Wd, bs);
    // Lane cells and the links between them (each counted from both sides).
    let cells = 0;
    let half = 0;
    const seen = new Set<number>();
    const stack: number[] = [];
    for (let i = 0; i < Wd * H; i++) {
      if (src[FIELD_BYTES * i] !== LandUse.Yard || !dst[4 * i + 2]) continue;
      cells++;
      const m = dst[4 * i + 2]! & ~dst[4 * i + 3]!;
      for (let k = 0; k < 8; k++) if (m & (1 << k)) half++;
      if (!stack.length && !seen.size) {
        seen.add(i);
        stack.push(i);
      }
    }
    while (stack.length) {
      const i = stack.pop()!;
      const m = dst[4 * i + 2]! & ~dst[4 * i + 3]!;
      for (let k = 0; k < 8; k++) {
        if (!(m & (1 << k))) continue;
        const j = i + RING_Y[k]! * Wd + RING_X[k]!;
        if (!seen.has(j)) {
          seen.add(j);
          stack.push(j);
        }
      }
    }
    expect(cells).toBeGreaterThanOrEqual(3);
    expect(seen.size).toBe(cells); // connected
    expect(half / 2).toBe(cells - 1); // a tree
    // Each house's door cell (local +x turned by rot: house 2 faces −y, house 3 faces +y) is on a lane, with an end into the house.
    expect(dst[4 * (2 * Wd + 5) + 3]).toBe(1 << 2);
    expect(dst[4 * (4 * Wd + 7) + 3]).toBe(1 << 6);
  });
});
