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
