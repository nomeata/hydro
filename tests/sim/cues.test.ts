import { describe, expect, it } from 'vitest';
import { FIELD_BYTES, STRESS_WET } from '../../src/shared/protocol';
import { STEPS_PER_DAY } from '../../src/sim/constants';
import { loadGame, saveGame } from '../../src/sim/persist';
import { Task } from '../../src/sim/people/agents';
import { MOOD, nextMood, type Mood } from '../../src/sim/people/settlement';
import { CROP_MOISTURE, MAX_CHILDREN, cropGrowth, cropStress } from '../../src/sim/people/village';
import { buildScene } from '../../src/sim/scenes';
import { LandUse } from '../../src/sim/world';

describe('visible mood', () => {
  it('has hysteresis: no flicker around the thresholds', () => {
    expect(nextMood(0, 0.5)).toBe(0);
    expect(nextMood(0, MOOD.prosperousEnter + 0.01)).toBe(1);
    // Dipping a little below the entry threshold keeps it.
    expect(nextMood(1, MOOD.prosperousEnter - 0.03)).toBe(1);
    expect(nextMood(1, MOOD.prosperousLeave - 0.01)).toBe(0);
    expect(nextMood(0, MOOD.strugglingEnter - 0.01)).toBe(-1);
    expect(nextMood(-1, MOOD.strugglingEnter + 0.03)).toBe(-1);
    expect(nextMood(-1, MOOD.strugglingLeave + 0.01)).toBe(0);
    // A crash goes straight through.
    expect(nextMood(1, 0.1)).toBe(-1);
    // A noisy wellbeing around 0.6 changes the mood rarely.
    let m: Mood = 0;
    let changes = 0;
    for (let k = 0; k < 200; k++) {
      const n = nextMood(m, 0.6 + 0.04 * Math.sin(k * 1.7));
      if (n !== m) changes++;
      m = n;
    }
    expect(changes).toBeLessThanOrEqual(1);
  });
});

describe('crop stress', () => {
  it('mirrors the growth factor: dry below CROP_MOISTURE.moist, waterlogged from .soggy, drowned under water', () => {
    const c = CROP_MOISTURE;
    expect(cropStress(100, 0.6, 0, true)).toBe(0);
    expect(cropStress(0, 0.05, 0, true)).toBe(0); // nothing sown
    expect(cropStress(100, 0.05, 0, false)).toBe(0); // not growing
    expect(cropStress(100, c.dry, 0, true)).toBe(127);
    // A quarter of the way from bone dry to moist: clearly but not fully dry.
    const mild = cropStress(100, c.dry + 0.75 * (c.moist - c.dry), 0, true);
    expect(mild).toBeGreaterThan(0);
    expect(mild).toBeLessThan(STRESS_WET / 2);
    expect(cropStress(100, c.moist, 0, true)).toBe(0);
    // The stress mirrors the growth factor.
    expect(cropGrowth(c.dry)).toBe(0);
    expect(cropGrowth(c.moist)).toBe(1);
    expect(cropStress(100, 0.95, 0, true)).toBeGreaterThanOrEqual(STRESS_WET);
    expect(cropStress(100, 0.6, 0.2, false)).toBe(255);
  });

  it('is packed as the third byte of each field cell', () => {
    const sim = buildScene('village');
    const w = sim.world;
    const field = w.landuse.findIndex((l, i) => l === LandUse.Field && w.crop[i]! > 0 && w.crop[i]! < 255);
    expect(field).toBeGreaterThanOrEqual(0);
    w.water[field] = 0.3;
    const out = new Uint8Array(w.size * FIELD_BYTES);
    sim.packFields(out);
    expect(out[field * FIELD_BYTES]).toBe(LandUse.Field);
    expect(out[field * FIELD_BYTES + 1]).toBe(w.crop[field]);
    expect(out[field * FIELD_BYTES + 2]).toBe(255);
    for (let i = 0; i < w.size; i++) if (w.landuse[i] !== LandUse.Field) expect(out[i * FIELD_BYTES + 2]).toBe(0);
  });
});

describe('children', () => {
  it('play in a prosperous village, are not counted, go home in hard times, and are saved exactly', async () => {
    const sim = buildScene('village');
    const p = sim.people!;
    const s = p.settlements[0]!.state;
    s.wellbeing = 0.9;
    sim.run(STEPS_PER_DAY * 2);
    expect(s.mood).toBe(1);
    const kids = p.agents.filter((a) => a.child);
    expect(kids.length).toBeGreaterThan(0);
    expect(kids.length).toBeLessThanOrEqual(MAX_CHILDREN);
    const adults = p.agents.filter((a) => !a.child && a.task !== Task.Leave);
    expect(adults.length).toBe(s.population);
    expect(p.entities(1).info[p.agents.indexOf(kids[0]!) * 4]).toBe(1); // EntityKind.Child

    // Save/load with children: identical state, identical future.
    const b = (await loadGame(await saveGame(sim))).sim;
    expect(b.stateHash()).toBe(sim.stateHash());
    sim.run(STEPS_PER_DAY);
    b.run(STEPS_PER_DAY);
    expect(b.stateHash()).toBe(sim.stateHash());

    // Hard times: the children go in.
    sim.command({ type: 'debugVillage', index: 0, wellbeing: 0.1, food: 0 });
    sim.run(STEPS_PER_DAY * 2);
    expect(s.mood).toBe(-1);
    expect(p.agents.filter((a) => a.child && a.task !== Task.Leave).length).toBe(0);
  }, 120_000);
});
