import { describe, expect, it } from 'vitest';
import { alignGates } from '../../src/render/structures/structures';
import type { StructureInfo } from '../../src/shared/protocol';

const weir: StructureInfo = { id: 1, kind: 'weir', x: 10, y: 10, x2: 20, y2: 20, rot: Math.PI / 4, width: Math.hypot(10, 10), top: 5, sill: 3, open: false, progress: 1 };
const gate = (x: number, y: number): StructureInfo => ({ id: 2, kind: 'gate', x, y, rot: 0, width: 1, top: 5, sill: 3, open: false, progress: 1 });

describe('gates in a weir', () => {
  it('lie along a diagonal weir’s line, centred on it', () => {
    const [g] = alignGates([gate(15, 16)], [weir]);
    expect(g!.rot).toBeCloseTo(Math.PI / 4, 6);
    // On the line x = y, nearest to (15, 16).
    expect(g!.x).toBeCloseTo(15.5, 6);
    expect(g!.y).toBeCloseTo(15.5, 6);
  });

  it('a gate away from any weir keeps its own direction', () => {
    const [g] = alignGates([gate(30, 10)], [weir]);
    expect(g!.rot).toBe(0);
    expect([g!.x, g!.y]).toEqual([30, 10]);
  });
});
