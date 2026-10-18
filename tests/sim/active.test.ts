import { describe, expect, it } from 'vitest';
import { ActiveSet } from '../../src/sim/active';
import { CELL_AREA, STEPS_PER_DAY, TILE } from '../../src/sim/constants';
import { revealDisc } from '../../src/sim/fog';
import { DEFAULT_FLOW_PARAMS, FlowScratch, flowStep, type FlowStats } from '../../src/sim/hydro/inertial';
import { loadGame, saveGame } from '../../src/sim/persist';
import { Simulation } from '../../src/sim/sim';
import { SoilType, World } from '../../src/sim/world';
import { generateWorld } from '../../src/sim/worldgen';

/** A bumpy basin with a pond in one corner and a dry rest. */
function basin(n = 96): World {
  const w = new World(n, n, 3);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = w.idx(x, y);
      w.bedrock[i] = 0.03 * (x + y) + 0.4 * Math.sin(x * 0.3) * Math.cos(y * 0.23);
      w.soil[i] = 1;
      w.soilType[i] = SoilType.Loam;
      if (x < 30 && y < 30) w.water[i] = Math.max(0, 1.2 - 0.03 * (x + y));
    }
  return w;
}

const stats = (): FlowStats => ({ outflow: 0, maxDepth: 1, maxSpeed: 0 });

function totalStored(w: World): number {
  let s = 0;
  for (let i = 0; i < w.size; i++) s += w.water[i]! + w.ground[i]! + w.snow[i]!;
  return s * CELL_AREA;
}

describe('active set', () => {
  it('is the revealed tiles dilated by two tiles', () => {
    const a = new ActiveSet(160, 160);
    expect(a.all).toBe(true);
    const rev = new Uint8Array(160 * 160);
    rev[80 * 160 + 80] = 1; // tile (5, 5)
    a.setFromRevealed(rev);
    expect(a.count).toBe(25);
    expect(a.at(80 - 2 * TILE, 80)).toBe(true);
    expect(a.at(80 - 3 * TILE, 80)).toBe(false);
    expect(a.cells()).toBe(25 * TILE * TILE);
    // Rows are row-major segments covering exactly the active cells.
    let n = 0;
    for (let k = 0; k < a.rows.length; k += 3) n += a.rows[k + 2]! - a.rows[k + 1]!;
    expect(n).toBe(a.cells());
    const v = a.version;
    a.setFromRevealed(rev);
    expect(a.version).toBe(v); // unchanged: no rebuild
  });
});

describe('sparse flow kernel', () => {
  it('sleeping dry tiles gives bit-identical results', () => {
    const a = basin();
    const b = basin();
    const sa = new FlowScratch(a.size);
    const sb = new FlowScratch(b.size);
    sb.sleep = false;
    const st = stats();
    for (let k = 0; k < 400; k++) {
      // Rain now and then on a dry spot wakes its tile.
      if (k === 150) {
        a.water[a.idx(70, 70)] = 0.3;
        b.water[b.idx(70, 70)] = 0.3;
      }
      flowStep(a, sa, DEFAULT_FLOW_PARAMS, 0.25, st);
      flowStep(b, sb, DEFAULT_FLOW_PARAMS, 0.25, stats());
    }
    expect(sa.awakeTiles).toBeLessThan(36);
    for (const f of ['water', 'sediment', 'qx', 'qy', 'velX', 'velY'] as const) expect(Array.from(a[f])).toEqual(Array.from(b[f]));
  });

  it('keeps the frozen land fixed and books the exchange across the edge', () => {
    const w = basin();
    const act = new ActiveSet(w.width, w.height);
    const mask = new Uint8Array(act.tw * act.th);
    // Active: tiles x 1..3, y 0..3 — the pond's tile column 0 is frozen.
    for (let ty = 0; ty < 4; ty++) for (let tx = 1; tx < 4; tx++) mask[ty * act.tw + tx] = 1;
    act.setTiles(mask);
    const frozen = w.water.slice();
    const sc = new FlowScratch(w.size);
    const st = stats();
    const activeVol = () => {
      let s = 0;
      for (let i = 0; i < w.size; i++) if (act.cell(i)) s += w.water[i]!;
      return s * CELL_AREA;
    };
    const v0 = activeVol();
    let inn = 0;
    let out = 0;
    for (let k = 0; k < 600; k++) {
      flowStep(w, sc, DEFAULT_FLOW_PARAMS, 0.25, st, null, act);
      inn += st.edgeIn!;
      out += st.edgeOut! + st.outflow;
    }
    // The frozen pond keeps feeding the active land across the edge.
    expect(inn).toBeGreaterThan(10);
    expect(Math.abs(activeVol() - (v0 + inn - out))).toBeLessThan(1e-3 * (v0 + inn));
    for (let i = 0; i < w.size; i++) if (!act.cell(i)) expect(w.water[i]).toBe(frozen[i]);
  });
});

/** A spun-up 192² game whose known land is a small disc on the main river. */
function riverGame(): { sim: Simulation; cx: number; cy: number } {
  const gen = generateWorld({ seed: 7, size: 192 });
  const sim = new Simulation(gen.world, 7, { people: { startX: gen.startX, startY: gen.startY }, rain: gen.rain });
  sim.vegetationOn = false;
  sim.spinUp(200);
  const w = sim.world;
  // The deepest flowing cell away from the map edge.
  let best = -1;
  let bq = 0;
  for (let y = 40; y < w.height - 40; y++)
    for (let x = 40; x < w.width - 40; x++) {
      const i = w.idx(x, y);
      const q = Math.abs(w.qx[i]!) + Math.abs(w.qy[i]!);
      if (q > bq) {
        bq = q;
        best = i;
      }
    }
  const cx = best % w.width;
  const cy = (best - cx) / w.width;
  w.revealed.fill(0);
  revealDisc(w, cx, cy, 8);
  sim.updateActive();
  return { sim, cx, cy };
}

describe('simulation on the active land', () => {
  it('balances the ledger, keeps the river flowing in, and resumes exactly', async () => {
    const { sim } = riverGame();
    const w = sim.world;
    const act = sim.active;
    expect(act.all).toBe(false);
    expect(act.count).toBeLessThan(act.tw * act.th / 2);
    // Water in the active river cells now.
    const wet: number[] = [];
    for (let i = 0; i < w.size; i++) if (act.cell(i) && w.water[i]! > 0.3) wet.push(i);
    expect(wet.length).toBeGreaterThan(20);
    const depth = () => wet.reduce((s, i) => s + w.water[i]!, 0) / wet.length;
    const d0 = depth();

    const before = totalStored(w);
    const L0 = { ...sim.ledger };
    sim.run(STEPS_PER_DAY + 200);
    const L = sim.ledger;
    const d = (k: keyof typeof L) => L[k] - L0[k];
    const expected = before + d('rain') + d('snowfall') + d('inflow') - d('outflow') - d('evaporation') - d('seepage') + d('earthworks');
    expect(Math.abs(totalStored(w) - expected) / Math.max(1, d('inflow'))).toBeLessThan(1e-3);
    // The river still comes in from the fog: it has not drained away.
    expect(d('inflow')).toBeGreaterThan(1000);
    expect(depth()).toBeGreaterThan(0.6 * d0);

    // Save, load, continue == continue.
    const bytes = await saveGame(sim, {});
    const { sim: b } = await loadGame(bytes);
    b.vegetationOn = false;
    expect(Array.from(b.active.tile)).toEqual(Array.from(act.tile));
    expect(b.stateHash()).toBe(sim.stateHash());
    sim.run(300);
    b.run(300);
    expect(b.stateHash()).toBe(sim.stateHash());
  }, 120_000);

  it('is deterministic', () => {
    const a = riverGame().sim;
    const b = riverGame().sim;
    a.run(400);
    b.run(400);
    expect(a.stateHash()).toBe(b.stateHash());
  }, 120_000);

  it('activates tiles as the fog recedes', () => {
    const { sim, cx, cy } = riverGame();
    const w = sim.world;
    const act = sim.active;
    const n0 = act.count;
    // New land becomes known 60 cells away, mid-day: it activates at the day boundary.
    const nx = cx + 60 < w.width ? cx + 60 : cx - 60;
    sim.run(STEPS_PER_DAY - (sim.step % STEPS_PER_DAY) - 1);
    const t = ((cy / TILE) | 0) * act.tw + ((nx / TILE) | 0);
    expect(act.tile[t]).toBe(0);
    revealDisc(w, nx, cy, 8);
    const i = w.idx(nx, cy);
    const frozen = w.water[i]!;
    expect(w.water[i]).toBe(frozen);
    sim.run(1);
    expect(sim.step % STEPS_PER_DAY).toBe(0);
    expect(act.tile[t]).toBe(1);
    expect(act.count).toBeGreaterThan(n0);
    // It starts from the frozen (spun-up) state, then evolves.
    expect(w.water[i]).toBe(frozen);
  }, 120_000);
});
