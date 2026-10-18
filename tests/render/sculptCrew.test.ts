import { describe, expect, it } from 'vitest';
import { SculptCrew } from '../../src/render/crowd/sculptCrew';

describe('the crew at sculpted ground (cosmetic)', () => {
  it('comes while the player brushes, tamps the earth, and leaves when the brushing stops', () => {
    const crew = new SculptCrew();
    const worked: [number, number][] = [];
    crew.onWork = (x, y) => worked.push([x, y]);
    for (let k = 0; k < 600; k++) {
      crew.note(40 + k * 0.02, 40, 2.5);
      crew.advance(1 / 60);
    }
    expect(crew.count).toBeGreaterThan(0);
    expect(crew.count).toBeLessThanOrEqual(3);
    for (let k = 0; k < 20 * 60; k++) crew.advance(1 / 60);
    expect(worked.length).toBeGreaterThan(0);
    for (const [x, y] of worked) expect(Math.hypot(x - 46, y - 40)).toBeLessThan(12);
    const f = crew.frame();
    expect(f.count).toBe(crew.count);
    for (let k = 0; k < 60 * 60; k++) crew.advance(1 / 60);
    expect(crew.count).toBe(0);
  });
});
