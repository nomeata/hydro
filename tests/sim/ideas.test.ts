import { describe, expect, it } from 'vitest';
import { DAYS_PER_SEASON } from '../../src/sim/constants';
import { IDEAS, villageLabel } from '../../src/sim/ideas';
import { Simulation } from '../../src/sim/sim';
import { CellFlag, LandUse, SoilType, World } from '../../src/sim/world';

const N = 64;
/** A summer day late enough to judge dry fields, and an autumn day. */
const SUMMER = DAYS_PER_SEASON + 5;
const AUTUMN = 2 * DAYS_PER_SEASON + 4;

/** A 64² valley: a river along y ≈ 20 (west → east), loamy flats to the south (wells.test.ts style). */
function valley(): World {
  const w = new World(N, N, 11);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = w.idx(x, y);
      const dr = Math.abs(y - 20);
      const h = 30 + (N - x) * 0.01 + Math.min(3, dr * 0.5) - (dr <= 1 ? 1.2 : 0);
      w.bedrock[i] = h - 3;
      w.soil[i] = 3;
      w.soilType[i] = dr <= 2 ? SoilType.Sand : SoilType.Loam;
      w.ground[i] = 0.6;
      w.fertility[i] = 0.7;
      w.revealed[i] = 255;
    }
  return w;
}

/** A village at (30, 31) with fields to the south (x 22..38, y 37..40) and six houses. */
function village(): Simulation {
  const sim = new Simulation(valley(), 5, { people: { startX: 30, startY: 31 } });
  sim.people!.stage({
    x: 30,
    y: 31,
    food: 3000,
    houses: [
      { x: 27, y: 33 },
      { x: 33, y: 33 },
      { x: 30, y: 35 },
      { x: 27, y: 29 },
      { x: 34, y: 29 },
      { x: 36, y: 33 },
    ],
    fields: [{ x0: 22, y0: 37, x1: 38, y1: 40, crop: 40 }],
    people: Array.from({ length: 12 }, (_, k) => ({ x: 30 + (k % 4), y: 31, job: 'farmer' as const })),
  });
  // Well-watered fields to begin with.
  sim.people!.fieldMoisture.fill(0.6);
  return sim;
}

/** Look twice (an idea shows on the second look in a row). */
function look(sim: Simulation, day: number): void {
  sim.ideas.look(sim, day);
  sim.ideas.look(sim, day + 2);
}

const ids = (sim: Simulation) => sim.ideas.list().map((i) => i.id);

describe('ideas for this valley', () => {
  it('has no ideas without villages, or when all is well', () => {
    const bare = new Simulation(valley(), 5);
    look(bare, SUMMER);
    expect(bare.ideas.list()).toEqual([]);
    const sim = village();
    look(sim, SUMMER);
    expect(sim.ideas.list()).toEqual([]);
  });

  it('finds fields that dry out in summer, keeps the idea until the next summer, and drops it once watered', () => {
    const sim = village();
    const p = sim.people!;
    const w = sim.world;
    // The east half of the fields is too dry.
    for (let y = 37; y <= 40; y++) for (let x = 31; x <= 38; x++) p.fieldMoisture[w.idx(x, y)] = 0.1;
    // Not judged outside summer.
    look(sim, AUTUMN);
    expect(ids(sim)).toEqual([]);
    // One look is not enough (no flicker).
    sim.ideas.look(sim, SUMMER);
    expect(ids(sim)).toEqual([]);
    sim.ideas.look(sim, SUMMER + 2);
    const [idea] = sim.ideas.list();
    expect(idea).toMatchObject({ id: 'dry:0', kind: 'dry', tool: 'dig' });
    expect(idea!.text).toContain('the village');
    expect(idea!.text).toContain('dry out in summer');
    // Where: among the dry cells.
    expect(idea!.x).toBeGreaterThanOrEqual(31);
    expect(idea!.x).toBeLessThanOrEqual(38);
    expect(idea!.y).toBeGreaterThanOrEqual(37);
    expect(idea!.y).toBeLessThanOrEqual(40);
    // Watered in autumn: the idea waits for the summer to judge.
    p.fieldMoisture.fill(0.6);
    look(sim, AUTUMN);
    expect(ids(sim)).toEqual(['dry:0']);
    // The player dug there: two summer looks without the problem and it goes, earning Good Idea.
    sim.achievements.touch(w.idx(34, 38));
    expect(sim.achievements.hasEarned('goodIdea')).toBe(false);
    sim.ideas.look(sim, SUMMER + 48);
    expect(ids(sim)).toEqual(['dry:0']);
    sim.ideas.look(sim, SUMMER + 50);
    expect(ids(sim)).toEqual([]);
    expect(sim.achievements.hasEarned('goodIdea')).toBe(true);
  });

  it('suggests a dike for land flooded last spring, and forgets it when the flood memory fades', () => {
    const sim = village();
    const w = sim.world;
    for (let x = 22; x <= 33; x++) w.floodMemory[w.idx(x, 40)] = 250;
    look(sim, AUTUMN);
    const [idea] = sim.ideas.list();
    expect(idea).toMatchObject({ id: 'flood:0', kind: 'flood', tool: 'raise', achievement: 'weathered' });
    expect(idea!.text).toContain('flooded last spring');
    // A dry spring behind a dike: the memory drops.
    for (let x = 22; x <= 33; x++) w.floodMemory[w.idx(x, 40)] = 100;
    look(sim, AUTUMN + 4);
    expect(ids(sim)).toEqual([]);
    // Not by the player's works: no Good Idea.
    expect(sim.achievements.hasEarned('goodIdea')).toBe(false);
  });

  it('finds a marsh by the village, but not a lake shore', () => {
    const sim = village();
    const w = sim.world;
    for (let y = 26; y <= 32; y++) for (let x = 38; x <= 43; x++) w.water[w.idx(x, y)] = 0.1;
    look(sim, AUTUMN);
    expect(sim.ideas.list()[0]).toMatchObject({ id: 'marsh:0', kind: 'marsh', tool: 'dig' });
    // Next to deep water it is a shore, not a marsh.
    const lake = village();
    const lw = lake.world;
    for (let y = 26; y <= 32; y++) for (let x = 38; x <= 43; x++) lw.water[lw.idx(x, y)] = x % 2 ? 0.1 : 1.2;
    look(lake, AUTUMN);
    expect(ids(lake)).toEqual([]);
  });

  it('points a big village without a mill to a strong stream, until it has one', () => {
    const sim = village();
    const w = sim.world;
    const p = sim.people!;
    for (let x = 20; x <= 40; x++)
      for (let y = 19; y <= 21; y++) {
        const i = w.idx(x, y);
        w.water[i] = 0.8;
        w.velX[i] = y === 20 && x === 31 ? 1.4 : 1;
      }
    // Too small for a mill.
    p.settlements[0]!.state.population = 12;
    look(sim, AUTUMN);
    expect(ids(sim)).toEqual([]);
    p.settlements[0]!.state.population = 30;
    look(sim, AUTUMN + 4);
    const [idea] = sim.ideas.list();
    expect(idea).toMatchObject({ id: 'mill:0', kind: 'mill', tool: 'weir', x: 31, y: 20, achievement: 'millersHead' });
    expect(idea!.text).toContain('a weir there could turn a mill');
    p.buildings.push({ id: 999, kind: 'mill', settlement: p.settlements[0]!.state.id, x: 31, y: 22, rot: 0, progress: 0.5 });
    look(sim, AUTUMN + 8);
    expect(ids(sim)).toEqual([]);
  });

  it('suggests a turbine for a finished weir near houses', () => {
    const sim = village();
    const w = sim.world;
    const cells = [w.idx(30, 19), w.idx(30, 20), w.idx(30, 21)];
    sim.structures.weirs.push({ id: 77, x: 30, y: 19, x2: 30, y2: 21, top: 31, width: 1, cells });
    // Not yet lined: no idea.
    look(sim, AUTUMN);
    expect(ids(sim)).toEqual([]);
    for (const c of cells) w.flags[c]! |= CellFlag.Lined;
    look(sim, AUTUMN + 4);
    expect(sim.ideas.list()[0]).toMatchObject({ id: 'turbine', kind: 'turbine', tool: 'turbine', x: 30, y: 20 });
  });

  it('orders the most pressing first, and is saved with the world', () => {
    const sim = village();
    const w = sim.world;
    for (let y = 26; y <= 32; y++) for (let x = 38; x <= 43; x++) w.water[w.idx(x, y)] = 0.1;
    for (let x = 22; x <= 33; x++) w.floodMemory[w.idx(x, 40)] = 250;
    expect(w.landuse[w.idx(22, 40)]).toBe(LandUse.Field);
    look(sim, AUTUMN);
    expect(ids(sim)).toEqual(['flood:0', 'marsh:0']);
    const again = village();
    again.setState(sim.getState());
    expect(again.ideas.list()).toEqual(sim.ideas.list());
    expect(again.ideas.dirty).toBe(true);
  });

  it('calls villages without names', () => {
    expect(villageLabel(0, 1)).toBe('the village');
    expect(villageLabel(0, 2)).toBe('the old village');
    expect(villageLabel(1, 2)).toBe('the new village');
    expect(villageLabel(2, 4)).toBe('the third village');
    expect(IDEAS.dryShare).toBeGreaterThan(0);
  });
});
