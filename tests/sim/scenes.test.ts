import { describe, expect, it } from 'vitest';
import { SCENE_LAYOUT, SCENE_SIZE, buildScene, buildSceneWorld, cloneScene } from '../../src/sim/scenes';
import { CellFlag, FIELD_SPECS, LandUse } from '../../src/sim/world';
import { Job, SiteKind } from '../../src/sim/people/agents';

function worldHash(w: ReturnType<typeof buildSceneWorld>): number {
  let h = 0x811c9dc5;
  for (const spec of FIELD_SPECS) {
    const a = w.field(spec.name);
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  }
  return h >>> 0;
}

describe('welcome scenes', () => {
  it('builds the same land every time, all of it known', () => {
    const a = buildSceneWorld();
    const b = buildSceneWorld();
    expect(a.width).toBe(SCENE_SIZE);
    expect(worldHash(a)).toBe(worldHash(b));
    expect(a.revealed.every((v) => v === 255)).toBe(true);
  });

  it('is deterministic, and a clone runs exactly like the original', () => {
    const a = buildScene('water');
    const b = buildScene('water');
    expect(a.stateHash()).toBe(b.stateHash());
    const c = cloneScene(a);
    expect(c.stateHash()).toBe(a.stateHash());
    a.run(200);
    c.run(200);
    expect(c.stateHash()).toBe(a.stateHash());
    expect(a.fog).toBe(false);
  });

  it('has a river from the inflow to the outlet, and rain in the water scene', () => {
    const sim = buildScene('water');
    const w = sim.world;
    const out0 = sim.ledger.outflow;
    const in0 = sim.ledger.inflow;
    sim.run(600);
    const inflow = sim.ledger.inflow - in0;
    const outflow = sim.ledger.outflow - out0;
    expect(inflow).toBeGreaterThan(0);
    // In steady state most of what comes in leaves at the outlet.
    expect(outflow).toBeGreaterThan(0.6 * inflow);
    let wetOutlets = 0;
    for (let i = 0; i < w.size; i++) if (w.flags[i]! & CellFlag.Outlet && w.water[i]! > 0.2) wetOutlets++;
    expect(wetOutlets).toBeGreaterThan(0);
    expect(sim.ledger.rain).toBeGreaterThan(0);
    // The pond holds water; the hollow is dry.
    expect(w.water[w.idx(SCENE_LAYOUT.pond.x, SCENE_LAYOUT.pond.y)]).toBeGreaterThan(0.6);
    expect(w.water[w.idx(SCENE_LAYOUT.hollow.x, SCENE_LAYOUT.hollow.y)]).toBeLessThan(0.05);
  });

  it('fills the hollow once the scripted trench is dug', () => {
    const sim = buildScene('shape');
    const w = sim.world;
    const h = w.idx(SCENE_LAYOUT.hollow.x, SCENE_LAYOUT.hollow.y);
    expect(w.water[h]).toBeLessThan(0.05);
    sim.command({ type: 'planTrench', points: SCENE_LAYOUT.trench, width: 3, depth: 1.5 });
    sim.run(900);
    expect(w.water[h]).toBeGreaterThan(0.4);
  });

  it('stages a living village without fast-forwarding', () => {
    const sim = buildScene('village');
    const p = sim.people!;
    expect(p.settlements.length).toBe(1);
    const s = p.settlements[0]!.state;
    const houses = p.buildings.filter((b) => b.kind === 'house');
    expect(p.buildings.filter((b) => b.kind === 'store').length).toBe(1);
    expect(houses.length).toBe(6);
    expect(houses.filter((b) => b.progress < 1).length).toBe(1);
    expect(s.houses).toBe(5);
    expect(s.population).toBe(p.agents.length);
    expect(p.agents.length).toBeGreaterThanOrEqual(10);
    expect(p.agents.filter((a) => a.job === Job.Fisher && a.siteKind === SiteKind.Fish).length).toBe(2);
    let fields = 0;
    let ripe = 0;
    for (let i = 0; i < sim.world.size; i++)
      if (sim.world.landuse[i] === LandUse.Field) {
        fields++;
        if (sim.world.crop[i]! >= 230) ripe++;
      }
    expect(fields).toBeGreaterThan(60);
    expect(ripe).toBeGreaterThan(20);
    // A few seconds later people are at work: someone fishes, someone harvests.
    sim.run(200);
    expect(p.agents.some((a) => a.siteKind === SiteKind.Fish)).toBe(true);
    expect(p.agents.some((a) => a.siteKind === SiteKind.Harvest || a.carry === 2)).toBe(true);
  });
});
