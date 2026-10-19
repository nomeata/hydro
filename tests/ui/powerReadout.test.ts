import { describe, expect, it } from 'vitest';
import { powerReadout } from '../../src/ui/powerReadout';
import type { PowerInfo } from '../../src/shared/protocol';

/** A turbine at (10, 10) with its intake (9, 10) and tailrace (12, 10), a pole line to houses near (30, 10), and a pump. */
function grid(power: number, flow: number): PowerInfo {
  return {
    turbines: [{ id: 1, x: 10, y: 10, rot: 0, ax: 9, ay: 10, bx: 12, by: 10, progress: 1, flow, power }],
    poles: [
      { id: 2, x: 16, y: 10, progress: 1 },
      { id: 3, x: 22, y: 10, progress: 1 },
      { id: 4, x: 50, y: 50, progress: 1 },
    ],
    wires: [10, 10, 16, 10, 16, 10, 22, 10],
    pumps: [{ id: 5, x: 20, y: 14, hx: 21, hy: 14, ox: 21, oy: 20, progress: 1, flow: power > 0 ? 0.3 : 0, power: power > 0 ? 5000 : 0 }],
    lit: power > 0 ? [100, 1, 101, 1] : [],
  };
}

const houses = [
  { id: 100, kind: 'house', x: 25, y: 11, progress: 1 },
  { id: 101, kind: 'house', x: 26, y: 9, progress: 1 },
  { id: 102, kind: 'house', x: 80, y: 80, progress: 1 },
];

describe('power readout', () => {
  it('a running turbine: head, power of what the head could give, houses lit on its line', () => {
    const surface = (x: number) => (x === 9 ? 12 : 10);
    const r = powerReadout(grid(30000, 3), houses, surface, 'turbine', 1)!;
    expect(r.running).toBe(true);
    expect(r.head).toBeCloseTo(2, 6);
    expect(r.gauge!).toBeGreaterThan(0);
    expect(r.gauge!).toBeLessThanOrEqual(1);
    expect(r.houses).toBe(2);
    expect(r.lit).toBe(2);
    expect(r.text).toContain('2 houses lit');
  });

  it('an idle turbine says why: no head (a drained pool)', () => {
    const r = powerReadout(grid(0, 0), houses, () => 10, 'turbine', 1)!;
    expect(r.running).toBe(false);
    expect(r.gauge).toBe(0);
    expect(r.text).toMatch(/^Idle: only 0\.0 m of head/);
    expect(r.lit).toBe(0);
  });

  it('a pole shows its line; a pole off the grid says so; a pump its lift or why it idles', () => {
    const on = powerReadout(grid(30000, 3), houses, () => 10, 'pole', 3)!;
    expect(on.power).toBe(30000);
    expect(on.text).toContain('from 1 turbine');
    const off = powerReadout(grid(30000, 3), houses, () => 10, 'pole', 4)!;
    expect(off.text).toContain('Not joined');
    expect(powerReadout(grid(30000, 3), houses, () => 10, 'pump', 5)!.text).toContain('Lifting');
    expect(powerReadout(grid(0, 0), houses, () => 10, 'pump', 5)!.text).toContain('no power');
  });
});
