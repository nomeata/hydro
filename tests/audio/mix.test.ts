import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../../src/render/camera';
import { HeightField } from '../../src/render/heights';
import {
  ambience,
  birdSeason,
  emptySummary,
  entitySources,
  fromScreen,
  precipitationAt,
  spotPlacement,
  SPOT_RULES,
  SPOT_TOTAL_CAP,
  SpotScheduler,
  structureSources,
  summariseView,
  toScreen,
  turbineHum,
  weirSpill,
  zoomOf,
  type SpotSource,
  type View,
  type ViewSummary,
} from '../../src/audio/mix';
import { SoundDirector, planSpots } from '../../src/audio/director';
import { EntityAnim, EntityKind, VEL_SCALE, type ClimateState, type EntityFrame, type SimTime, type Snapshot } from '../../src/shared/protocol';

const view = (o: Partial<View> = {}): View => ({ x: 64, y: 64, yaw: 0.7, pitch: 0.6, viewHeight: 30, aspect: 4 / 3, ...o });

/** Deterministic random numbers for the scheduler. */
function lcg(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const time = (o: Partial<SimTime> = {}): SimTime => ({ step: 1000, day: 10, year: 0, season: 0, dayOfSeason: 10, yearFrac: 0.12, timeOfDay: 0.5, ...o });
const climate = (o: Partial<ClimateState> = {}): ClimateState => ({ temperature: 16, windDir: 0, windSpeed: 1, fronts: [], ...o });

function grids(W: number, fill: (x: number, y: number) => { d: number; vx?: number; vy?: number }) {
  const depth = new Float32Array(W * W);
  const vel = new Int8Array(W * W * 2);
  const look = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = fill(x, y);
      depth[i] = c.d;
      vel[2 * i] = Math.round(((c.vx ?? 0) / VEL_SCALE) * 127);
      vel[2 * i + 1] = Math.round(((c.vy ?? 0) / VEL_SCALE) * 127);
      look[4 * i + 1] = 120;
      look[4 * i + 2] = 200;
    }
  return { width: W, height: W, depth, vel, look };
}

describe('screen mapping', () => {
  it('matches the real camera projection on flat ground', () => {
    const cam = new CameraController(new HeightField(128, 128));
    cam.setViewport(800, 600);
    const v = view();
    cam.setState({ x: v.x, y: v.y, yaw: v.yaw, pitch: v.pitch, viewHeight: v.viewHeight });
    for (const [x, y] of [
      [70, 60],
      [55, 72],
      [64, 50],
    ] as const) {
      const p = new THREE.Vector3(x + 0.5, 0, y + 0.5).project(cam.camera);
      const [sx, sy] = toScreen(v, x, y);
      expect(sx).toBeCloseTo(p.x, 2);
      expect(sy).toBeCloseTo(p.y, 2);
    }
  });

  it('fromScreen inverts toScreen', () => {
    const v = view({ yaw: -1.3 });
    const [x, y] = fromScreen(v, 0.4, -0.7);
    const [sx, sy] = toScreen(v, x, y);
    expect(sx).toBeCloseTo(0.4, 6);
    expect(sy).toBeCloseTo(-0.7, 6);
  });

  it('spots are loud in the middle, soft at the edge, silent off screen and far out', () => {
    const v = view();
    const mid = spotPlacement(v, 64, 64)!;
    const [ex, ey] = fromScreen(v, 0.95, 0);
    const edge = spotPlacement(v, ex, ey)!;
    const [ox, oy] = fromScreen(v, 1.6, 0);
    expect(mid.gain).toBeGreaterThan(edge.gain * 1.5);
    expect(edge.pan).toBeGreaterThan(0.5);
    expect(spotPlacement(v, ox, oy)).toBeNull();
    expect(spotPlacement(view({ viewHeight: 200 }), 64, 64)!.gain).toBeLessThan(mid.gain * 0.3);
    expect(zoomOf(8)).toBe(0);
    expect(zoomOf(300)).toBe(1);
  });
});

describe('view summary', () => {
  it('finds a river on the right, a lake on the left, and nothing in the fog', () => {
    const W = 128;
    const v = view({ yaw: 0 }); // screen right = +x
    const g = grids(W, (x) => (x >= 70 && x < 76 ? { d: 0.8, vy: 1.0 } : x >= 50 && x < 58 ? { d: 1.5 } : { d: 0 }));
    const s = summariseView(v, g);
    expect(s.flowing).toBeGreaterThan(0.05);
    expect(s.still).toBeGreaterThan(0.05);
    expect(s.panFlow).toBeGreaterThan(0.1);
    expect(s.panStill).toBeLessThan(-0.1);
    expect(s.rapids).toBe(0);
    expect(s.land).toBeGreaterThan(0.4);
    expect(s.green).toBeCloseTo(200 / 255, 2);
    const fog = summariseView(v, { ...g, revealed: new Uint8Array(W * W) });
    expect(fog.flowing + fog.still + fog.land).toBe(0);
  });

  it('counts fast water as rapids and shallow calm water on green ground as marsh', () => {
    const v = view({ yaw: 0 });
    const fast = summariseView(v, grids(128, () => ({ d: 0.6, vx: 2.5 })));
    expect(fast.rapids).toBeGreaterThan(0.5);
    const marsh = summariseView(v, grids(128, () => ({ d: 0.1 })));
    expect(marsh.marsh).toBeGreaterThan(0.5);
    expect(marsh.flowing).toBe(0);
  });
});

describe('ambience', () => {
  const summary: ViewSummary = { ...emptySummary(), flowing: 0.15, land: 0.7, green: 0.7 };
  const base = { view: view(), summary, climate: climate(), time: time(), speed: 1, hum: 0 };

  it('a river in view in spring: murmur and birds, no rain', () => {
    const l = ambience(base);
    expect(l.river).toBeGreaterThan(0.35);
    expect(l.birds).toBeGreaterThan(0.3);
    expect(l.rain).toBe(0);
    expect(l.wind).toBeLessThan(0.4);
  });

  it('winter has no birds and more wind; summer has crickets', () => {
    const w = ambience({ ...base, time: time({ season: 3, yearFrac: 0.85 }), climate: climate({ temperature: -2 }) });
    expect(w.birds).toBe(0);
    expect(w.crickets).toBe(0);
    expect(w.wind).toBeGreaterThan(ambience(base).wind);
    const s = ambience({ ...base, time: time({ season: 1, yearFrac: 0.35, timeOfDay: 0.7 }), climate: climate({ temperature: 24 }) });
    expect(s.crickets).toBeGreaterThan(0.3);
    expect(birdSeason(0.85)).toBe(0);
    expect(birdSeason(0.2)).toBe(1);
  });

  it('rain under a front, fading at its edge; snow is quiet', () => {
    const front = { x: 64, y: 64, rx: 30, ry: 20, angle: 0, intensity: 0.9, snow: false };
    expect(precipitationAt(climate({ fronts: [front] }), 64, 64).rain).toBeCloseTo(0.9);
    expect(precipitationAt(climate({ fronts: [front] }), 64 + 36, 64).rain).toBeLessThan(0.5);
    expect(precipitationAt(climate({ fronts: [front] }), 64 + 60, 64).rain).toBe(0);
    const l = ambience({ ...base, climate: climate({ fronts: [front] }) });
    expect(l.rain).toBeGreaterThan(0.6);
    expect(l.birds).toBeLessThan(ambience(base).birds * 0.4);
    const snow = ambience({ ...base, climate: climate({ fronts: [{ ...front, snow: true }] }) });
    expect(snow.rain).toBe(0);
    expect(snow.wind).toBeGreaterThan(ambience(base).wind);
  });

  it('zoomed out: water detail fades, wind rises', () => {
    const near = ambience(base);
    const far = ambience({ ...base, view: view({ viewHeight: 250 }) });
    expect(far.river).toBeLessThan(near.river * 0.7);
    expect(far.wind).toBeGreaterThan(near.wind + 0.25);
  });

  it('paused: ambience continues, quieter', () => {
    const p = ambience({ ...base, speed: 0 });
    const r = ambience(base);
    expect(p.river).toBeGreaterThan(0.2);
    expect(p.river).toBeLessThan(r.river);
  });

  it('all layers stay within 0..1, even for a screen full of everything', () => {
    const all: ViewSummary = { flowing: 1, still: 1, rapids: 1, marsh: 1, land: 1, green: 1, panFlow: 0, panStill: 0, panRapids: 0 };
    const l = ambience({ ...base, summary: all, hum: 3, time: time({ season: 1, yearFrac: 0.3 }), climate: climate({ temperature: 30, windSpeed: 3 }) });
    for (const v of Object.values(l)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

function entities(list: { kind: EntityKind; anim: EntityAnim; x: number; y: number }[]): EntityFrame {
  const n = list.length;
  const e: EntityFrame = { count: n, id: new Uint16Array(n), info: new Uint8Array(4 * n), pos: new Float32Array(5 * n) };
  list.forEach((p, k) => {
    e.info[4 * k] = p.kind;
    e.info[4 * k + 2] = p.anim;
    e.pos[5 * k] = p.x;
    e.pos[5 * k + 1] = p.y;
  });
  return e;
}

describe('spot sources', () => {
  it('maps people at work and animals to sounds', () => {
    const s = entitySources(
      entities([
        { kind: EntityKind.Person, anim: EntityAnim.Build, x: 1, y: 1 },
        { kind: EntityKind.Person, anim: EntityAnim.Chop, x: 1, y: 1 },
        { kind: EntityKind.Person, anim: EntityAnim.Work, x: 1, y: 1 },
        { kind: EntityKind.Person, anim: EntityAnim.Walk, x: 1, y: 1 },
        { kind: EntityKind.Cow, anim: EntityAnim.Eat, x: 1, y: 1 },
        { kind: EntityKind.Sheep, anim: EntityAnim.Walk, x: 1, y: 1 },
        { kind: EntityKind.Chick, anim: EntityAnim.Eat, x: 1, y: 1 },
        { kind: EntityKind.Dog, anim: EntityAnim.Run, x: 1, y: 1 },
      ]),
    );
    expect(s.map((x) => x.kind)).toEqual(['hammer', 'chop', 'dig', 'moo', 'baa', 'peep']);
  });

  it('turning wheels and mills creak, still ones do not; turbines hum when close', () => {
    const wheel = { id: 1, kind: 'wheel' as const, x: 64, y: 64, rot: 0, width: 1, top: 0, sill: 0, open: true, progress: 1, speed: 1 };
    expect(structureSources([wheel], null)).toHaveLength(1);
    expect(structureSources([{ ...wheel, speed: 0 }], null)).toHaveLength(0);
    expect(structureSources(null, [{ id: 2, kind: 'mill', x: 3, y: 3, rot: 0, progress: 1, spin: 0.9 }])).toHaveLength(1);
    const t = { id: 1, x: 64, y: 64, rot: 0, ax: 0, ay: 0, bx: 0, by: 0, progress: 1, flow: 1, power: 30000 };
    const power = { turbines: [t], poles: [], wires: [], pumps: [], lit: [] };
    expect(turbineHum(view({ viewHeight: 14 }), power)).toBeGreaterThan(0.5);
    expect(turbineHum(view({ x: 200 }), power)).toBe(0);
  });
});

describe('weir spill', () => {
  it('a weir with water over its crest rushes; a dry one and one off screen do not', () => {
    const W = 128;
    const weir = { id: 1, kind: 'weir' as const, x: 60, y: 64, x2: 68, y2: 64, rot: 0, width: 8, top: 0, sill: 0, open: false, progress: 1 };
    const wet = new Float32Array(W * W);
    for (let x = 60; x <= 68; x++) wet[64 * W + x] = 0.2;
    expect(weirSpill(view({ viewHeight: 16 }), [weir], wet, W)).toBeGreaterThan(0.6);
    expect(weirSpill(view({ viewHeight: 16 }), [weir], new Float32Array(W * W), W)).toBe(0);
    expect(weirSpill(view({ x: 200, viewHeight: 16 }), [weir], wet, W)).toBe(0);
    const s = { ...emptySummary(), land: 0.5 };
    const quiet = ambience({ view: view(), summary: s, climate: climate(), time: time(), speed: 1, hum: 0 });
    const loud = ambience({ view: view(), summary: s, climate: climate(), time: time(), speed: 1, hum: 0, spill: 0.8 });
    expect(loud.rapids).toBeGreaterThan(quiet.rapids + 0.5);
  });
});

describe('spot scheduler', () => {
  const builders = (n: number): SpotSource[] => Array.from({ length: n }, (_, k) => ({ kind: 'hammer' as const, x: 60 + (k % 8), y: 60 + Math.floor(k / 8) }));
  const run = (sources: SpotSource[], speed: number, seconds: number, v = view()) => {
    const s = new SpotScheduler(lcg(3));
    const ev = [];
    for (let t = 0; t < seconds; t += 0.25) ev.push(...s.tick(0.25, v, sources, speed));
    return ev;
  };

  it('a lone builder hammers now and then', () => {
    const ev = run(builders(1), 1, 120);
    expect(ev.length).toBeGreaterThan(120 * SPOT_RULES.hammer.rate * 0.5);
    expect(ev.length).toBeLessThan(120 * SPOT_RULES.hammer.rate * 1.5);
    for (const e of ev) {
      expect(e.delay).toBeGreaterThanOrEqual(0);
      expect(e.delay).toBeLessThan(0.25);
    }
  });

  it('a bustling village is capped: per kind and in total', () => {
    const many = [...builders(40), ...Array.from({ length: 30 }, (_, k) => ({ kind: 'chop' as const, x: 64 + (k % 5), y: 66 })), ...Array.from({ length: 30 }, () => ({ kind: 'peep' as const, x: 63, y: 63 }))];
    const ev = run(many, 10, 120);
    const hammers = ev.filter((e) => e.kind === 'hammer').length;
    expect(hammers).toBeLessThanOrEqual(120 * SPOT_RULES.hammer.cap * 1.15);
    expect(ev.length).toBeLessThanOrEqual(120 * SPOT_TOTAL_CAP + 2);
    // Minimum gaps between two of a kind.
    const t = ev.filter((e) => e.kind === 'hammer');
    expect(t.length).toBeGreaterThan(20);
  });

  it('paused: no activity sounds; birds still sing, fewer', () => {
    expect(run(builders(10), 0, 60)).toHaveLength(0);
    const s = new SpotScheduler(lcg(5));
    let playing = 0;
    let paused = 0;
    for (let t = 0; t < 400; t += 0.25) {
      playing += s.tick(0.25, view(), [], 1, { birds: 1, frogs: 0, frogPan: 0 }).length;
      paused += s.tick(0.25, view(), [], 0, { birds: 1, frogs: 0, frogPan: 0 }).length;
    }
    expect(paused).toBeGreaterThan(5);
    expect(paused).toBeLessThan(playing);
  });

  it('nothing off screen', () => {
    expect(run([{ kind: 'moo', x: 400, y: 400 }, ...builders(0)], 1, 300)).toHaveLength(0);
  });

  it('external splashes are rate limited', () => {
    const s = new SpotScheduler(lcg(1));
    expect(s.external('splash', view(), 64, 64)).not.toBeNull();
    expect(s.external('splash', view(), 64, 64)).toBeNull();
    s.tick(1, view(), [], 1);
    expect(s.external('splash', view(), 64, 64)).not.toBeNull();
  });
});

describe('director', () => {
  const W = 64;
  function snapshot(o: Partial<Snapshot> = {}): Snapshot {
    const g = grids(W, (x) => (x >= 30 && x < 36 ? { d: 0.8, vy: 1.2 } : { d: 0 }));
    return {
      time: time(),
      climate: climate(),
      stats: { speedRequested: 1, speedAchieved: 1, msPerStep: 1, surfaceWater: 0, outflowPerDay: 0 },
      poolId: 0,
      depth: g.depth,
      vel: g.vel,
      look: g.look,
      ...o,
    };
  }

  it('turns snapshots into ticks: river murmur, builders hammering, a splash', () => {
    const d = new SoundDirector({ width: W }, lcg(2));
    const v = view({ x: 32, y: 32, viewHeight: 20 });
    d.onSnapshot(snapshot({ entities: entities([{ kind: EntityKind.Person, anim: EntityAnim.Build, x: 32, y: 30 }]) }), v, 0);
    let hammers = 0;
    let frame = d.tick(0.25, v, 0.25);
    for (let k = 0; k < 200; k++) {
      frame = d.tick(0.25, v, 0.25 * k);
      hammers += frame.spots.filter((s) => s.kind === 'hammer').length;
    }
    expect(frame.layers.river).toBeGreaterThan(0.4);
    expect(hammers).toBeGreaterThan(5);
    d.splash(v, 33, 33);
    expect(d.tick(0.25, v, 60).spots.some((s) => s.kind === 'splash')).toBe(true);
  });

  it('is silent before the first snapshot', () => {
    const d = new SoundDirector({ width: W });
    const f = d.tick(0.25, view(), 0);
    expect(Object.values(f.layers).every((x) => x === 0)).toBe(true);
  });

  it('hears the crew dig where plans are in view', () => {
    const plan = new Float32Array(W * W).fill(NaN);
    for (let x = 20; x < 44; x++) for (let y = 31; y < 34; y++) plan[y * W + x] = 1; // a trench
    expect(planSpots(view({ x: 32, y: 32, viewHeight: 10 }), plan, W).length).toBeGreaterThan(0);
    expect(planSpots(view({ x: 10, y: 10, viewHeight: 10 }), plan, W)).toHaveLength(0);
  });
});
