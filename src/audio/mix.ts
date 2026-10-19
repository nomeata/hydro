/**
 * The sound mix as pure functions of what the camera sees (docs/SOUND.md):
 * a summary of the visible water and land, the ambient layer gains from it
 * and the weather/season, and the candidate spot sounds (people at work,
 * animals, wheels) with their stereo pan and distance gain. No Web Audio
 * here, so all of it is unit-tested in Node (tests/audio/mix.test.ts).
 */
import type { BuildingInfo, ClimateState, EntityFrame, PowerInfo, SimTime, StructureInfo } from '../shared/protocol';
import { EntityAnim, EntityKind, VEL_SCALE } from '../shared/protocol';

/** The camera as the mixer needs it (cells; see render/camera.ts). */
export interface View {
  x: number;
  y: number;
  yaw: number;
  pitch: number;
  /** Visible world height (cells); smaller = closer. */
  viewHeight: number;
  /** Viewport width / height. */
  aspect: number;
}

/** The ambient layers, each a gain 0..1 before the engine's per-layer level. */
export interface Layers {
  /** Murmur of flowing water (streams, rivers, canals). */
  river: number;
  /** Lapping of still open water (lakes, ponds, reservoirs). */
  lake: number;
  /** Rushing fast water: rapids, weir spill, the race below a weir. */
  rapids: number;
  rain: number;
  wind: number;
  /** Density of bird song (spring and summer, over green land). */
  birds: number;
  /** Crickets: warm summer days, a little more towards evening. */
  crickets: number;
  /** Density of frog croaks (marshy shallow water in the warm seasons). */
  frogs: number;
  /** Turbine hum (powerhouses close by). */
  hum: number;
}

export const LAYER_IDS: readonly (keyof Layers)[] = ['river', 'lake', 'rapids', 'rain', 'wind', 'birds', 'crickets', 'frogs', 'hum'];

export function silentLayers(): Layers {
  return { river: 0, lake: 0, rapids: 0, rain: 0, wind: 0, birds: 0, crickets: 0, frogs: 0, hum: 0 };
}

/** What the visible water and land look like (fractions of the sampled view). */
export interface ViewSummary {
  /** Flowing water, weighted by depth and speed. */
  flowing: number;
  /** Still, deep-ish open water. */
  still: number;
  /** Fast water (≥ 1.2 m/s), weighted by how fast. */
  rapids: number;
  /** Shallow still water on wet, green ground (marsh). */
  marsh: number;
  /** Known dry land. */
  land: number;
  /** Mean vegetation (0..1) of the known land. */
  green: number;
  /** Stereo position (−1..1) of the flowing / still / fast water. */
  panFlow: number;
  panStill: number;
  panRapids: number;
}

export function emptySummary(): ViewSummary {
  return { flowing: 0, still: 0, rapids: 0, marsh: 0, land: 0, green: 0, panFlow: 0, panStill: 0, panRapids: 0 };
}

const clamp = (v: number, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Soft saturation: about linear for small x, approaching 1. */
const sat = (x: number) => 1 - Math.exp(-Math.max(0, x));

/** Half-extents (cells) of the visible ground: across the screen and up it. */
export function viewExtent(v: View): { hw: number; hh: number } {
  return { hw: (v.viewHeight * v.aspect) / 2, hh: v.viewHeight / (2 * Math.max(0.3, Math.sin(v.pitch))) };
}

/** Screen position of a ground cell: sx right, sy up, both −1..1 at the screen edge. */
export function toScreen(v: View, x: number, y: number): [number, number] {
  const { hw, hh } = viewExtent(v);
  const dx = x - v.x;
  const dy = y - v.y;
  const c = Math.cos(v.yaw);
  const s = Math.sin(v.yaw);
  // render/camera.ts: right = (cos yaw, −sin yaw), forward (up the screen) = (−sin yaw, −cos yaw).
  return [(dx * c - dy * s) / hw, (-dx * s - dy * c) / hh];
}

/** The ground cell at a screen position (inverse of toScreen). */
export function fromScreen(v: View, sx: number, sy: number): [number, number] {
  const { hw, hh } = viewExtent(v);
  const c = Math.cos(v.yaw);
  const s = Math.sin(v.yaw);
  const a = sx * hw;
  const b = sy * hh;
  return [v.x + a * c - b * s, v.y - a * s - b * c];
}

/** 0 when close (viewHeight ≤ 10) … 1 when zoomed far out (≥ 240). */
export function zoomOf(viewHeight: number): number {
  return clamp(Math.log(Math.max(1, viewHeight) / 10) / Math.log(24));
}

/**
 * Distance gain and pan of a sound at cell (x, y): full in the middle of
 * the screen, softer towards the edges, silent beyond them; everything
 * quieter the further out the camera is. Null when inaudible.
 */
export function spotPlacement(v: View, x: number, y: number): { gain: number; pan: number } | null {
  const [sx, sy] = toScreen(v, x, y);
  const r = Math.hypot(sx, sy * 1.1);
  if (r > 1.25) return null;
  const edge = 1 - 0.75 * smooth(0.3, 1.25, r);
  const zoom = Math.pow(14 / Math.max(14, v.viewHeight), 0.8);
  return { gain: edge * zoom, pan: clamp(sx * 0.75, -0.85, 0.85) };
}

/** The grids the view summary samples (snapshot arrays; only read). */
export interface Grids {
  width: number;
  height: number;
  depth: Float32Array;
  /** Snapshot velocity: interleaved signed bytes, 127 ≙ VEL_SCALE m/s. */
  vel: Int8Array;
  /** Ground look RGBA8 (G moisture, B vegetation), if known. */
  look?: Uint8Array | null;
  /** Fog of war (≥ 128 known), if any. */
  revealed?: Uint8Array | null;
}

/**
 * Summarise the visible water and land by sampling an n×n grid over the
 * screen (n² reads, independent of zoom and map size). Fogged cells count
 * as nothing (the cloud sea is quiet).
 */
export function summariseView(v: View, g: Grids, n = 20): ViewSummary {
  const out = emptySummary();
  const vs = VEL_SCALE / 127;
  let total = 0;
  let wf = 0;
  let ws = 0;
  let wr = 0;
  let greenSum = 0;
  for (let j = 0; j < n; j++) {
    const sy = ((j + 0.5) / n) * 2 - 1;
    for (let k = 0; k < n; k++) {
      const sx = ((k + 0.5) / n) * 2 - 1;
      total++;
      const [fx, fy] = fromScreen(v, sx, sy);
      const x = Math.floor(fx + 0.5);
      const y = Math.floor(fy + 0.5);
      if (x < 0 || y < 0 || x >= g.width || y >= g.height) continue;
      const i = y * g.width + x;
      if (g.revealed && g.revealed[i]! < 128) continue;
      // Centre-weighted, so what is in the middle of the screen counts most.
      const w = 1.25 - 0.5 * (sx * sx + sy * sy) * 0.5;
      const d = g.depth[i]!;
      const sp = Math.hypot(g.vel[2 * i]!, g.vel[2 * i + 1]!) * vs;
      const look = g.look;
      const moist = look ? look[4 * i + 1]! / 255 : 0.5;
      const veg = look ? look[4 * i + 2]! / 255 : 0.5;
      if (d < 0.03) {
        out.land += w;
        greenSum += w * veg;
        continue;
      }
      const deep = smooth(0.03, 0.5, d);
      const flow = deep * smooth(0.12, 0.9, sp);
      if (flow > 0) {
        out.flowing += w * flow;
        wf += w * flow * sx;
      }
      const fast = deep * smooth(1.1, 2.6, sp);
      if (fast > 0) {
        out.rapids += w * fast;
        wr += w * fast * sx;
      }
      const calm = 1 - smooth(0.08, 0.35, sp);
      if (d > 0.25) {
        const st = calm * smooth(0.25, 1.2, d);
        out.still += w * st;
        ws += w * st * sx;
      } else if (calm > 0) {
        // Shallow and calm: marsh if the ground around is wet and green.
        out.marsh += w * calm * smooth(0.3, 0.8, (moist + veg) / 2);
      }
    }
  }
  if (out.flowing > 0) out.panFlow = clamp(wf / out.flowing, -1, 1) * 0.6;
  if (out.still > 0) out.panStill = clamp(ws / out.still, -1, 1) * 0.6;
  if (out.rapids > 0) out.panRapids = clamp(wr / out.rapids, -1, 1) * 0.6;
  out.green = out.land > 0 ? greenSum / out.land : 0;
  out.flowing /= total;
  out.still /= total;
  out.rapids /= total;
  out.marsh /= total;
  out.land /= total;
  return out;
}

/** How much the birds sing over the year (yearFrac 0 = start of spring). */
export function birdSeason(yearFrac: number): number {
  const f = ((yearFrac % 1) + 1) % 1;
  // Piecewise linear: dawn chorus in spring, quieter in high summer, a few in early autumn, none in winter.
  const pts: [number, number][] = [
    [0, 0.55],
    [0.12, 1],
    [0.3, 1],
    [0.45, 0.75],
    [0.55, 0.45],
    [0.68, 0.12],
    [0.74, 0],
    [0.97, 0],
    [1, 0.55],
  ];
  for (let k = 1; k < pts.length; k++) {
    const [x1, y1] = pts[k]!;
    const [x0, y0] = pts[k - 1]!;
    if (f <= x1) return y0 + ((y1 - y0) * (f - x0)) / (x1 - x0);
  }
  return 0;
}

/** Rain (0..1) and snow (0..1) falling at the view centre, from the weather fronts. */
export function precipitationAt(c: ClimateState, x: number, y: number): { rain: number; snow: number } {
  let rain = 0;
  let snow = 0;
  for (const f of c.fronts) {
    const dx = x - f.x;
    const dy = y - f.y;
    const ca = Math.cos(f.angle);
    const sa = Math.sin(f.angle);
    const u = (dx * ca + dy * sa) / Math.max(1, f.rx);
    const w = (-dx * sa + dy * ca) / Math.max(1, f.ry);
    const r = Math.hypot(u, w);
    // Full inside, fading out over a third of the radius beyond the edge (distant rain).
    const a = clamp(f.intensity) * (1 - smooth(0.85, 1.35, r));
    if (f.snow) snow = Math.max(snow, a);
    else rain = Math.max(rain, a);
  }
  return { rain, snow };
}

/**
 * Rain and snow heard in the view: the strongest of the centre and four
 * points half-way to the screen corners (those a little softer), so a
 * front passing over part of the screen is heard.
 */
export function precipitationInView(c: ClimateState, v: View): { rain: number; snow: number } {
  const out = precipitationAt(c, v.x, v.y);
  for (const [sx, sy] of [
    [-0.6, -0.6],
    [0.6, -0.6],
    [-0.6, 0.6],
    [0.6, 0.6],
  ] as const) {
    const [x, y] = fromScreen(v, sx, sy);
    const p = precipitationAt(c, x, y);
    out.rain = Math.max(out.rain, p.rain * 0.8);
    out.snow = Math.max(out.snow, p.snow * 0.8);
  }
  return out;
}

export interface AmbienceInput {
  view: View;
  summary: ViewSummary;
  climate: ClimateState;
  time: SimTime;
  /** Requested game speed (0 = paused). */
  speed: number;
  /** Turbine hum level 0..1 from spot analysis (nearby running turbines). */
  hum: number;
  /** Water spilling over weirs and through open gates in view, 0..1 (weirSpill). */
  spill?: number;
}

/**
 * Ambient layer gains. Fractions of the view are soft-saturated, so a
 * stream crossing the screen is clearly there and a screen full of river is
 * not deafening; zoomed out, water detail fades and the wind takes over.
 * Paused: everything keeps breathing, a little quieter.
 */
export function ambience(a: AmbienceInput): Layers {
  const { summary: s, view, climate, time } = a;
  const zoom = zoomOf(view.viewHeight);
  const near = 1 - 0.55 * zoom;
  const paused = a.speed <= 0;
  const calm = paused ? 0.6 : 1;
  const { rain, snow } = precipitationInView(climate, view);
  const wet = Math.max(rain, snow);
  const winter = time.season === 3 ? 1 : 0;
  const warm = smooth(8, 20, climate.temperature);
  const out = silentLayers();
  // Water grows gently with how much of the view it fills and with zooming in.
  const waterNear = 1 - 0.4 * zoom;
  out.river = sat(s.flowing * 5) * waterNear * calm;
  out.lake = sat(s.still * 4) * (0.7 + 0.3 * clamp(climate.windSpeed - 0.6)) * near * calm;
  out.rapids = Math.max(sat(s.rapids * 8), 0.8 * (a.spill ?? 0)) * (1 - 0.25 * zoom) * calm;
  out.rain = rain * (0.55 + 0.45 * near) * calm;
  out.wind = clamp(0.12 + 0.45 * zoom + 0.2 * winter + 0.25 * snow + 0.15 * rain + 0.1 * clamp(climate.windSpeed - 0.8, 0, 1)) * calm;
  const outdoors = (1 - wet * 0.85) * near;
  out.birds = birdSeason(time.yearFrac) * sat(s.land * 2.5) * (0.35 + 0.65 * s.green) * outdoors * (paused ? 0.5 : 1);
  const summer = time.season === 1 ? 1 : time.season === 0 ? smooth(0.6, 1, time.dayOfSeason / 30) * 0.3 : time.season === 2 ? 0.25 : 0;
  const evening = 0.6 + 0.4 * smooth(0.5, 0.8, time.timeOfDay);
  out.crickets = summer * warm * sat(s.land * 2) * (0.3 + 0.7 * s.green) * evening * outdoors * calm;
  out.frogs = sat(s.marsh * 12) * warm * (winter ? 0 : 1) * (1 - rain * 0.5) * near * (paused ? 0.4 : 1);
  out.hum = clamp(a.hum) * calm;
  for (const k of LAYER_IDS) out[k] = clamp(out[k]);
  return out;
}

// ---------------------------------------------------------------------------
// Spot sounds.

export type SpotKind =
  | 'hammer'
  | 'chop'
  | 'dig'
  | 'moo'
  | 'baa'
  | 'peep'
  | 'creak'
  | 'splash'
  | 'bird'
  | 'frog';

/** A sound source on the map that may make a spot sound. */
export interface SpotSource {
  kind: SpotKind;
  x: number;
  y: number;
  /** Relative activity (wheels: how fast they turn), default 1. */
  weight?: number;
}

/** A spot sound to play now (+ delay seconds). */
export interface SpotEvent {
  kind: SpotKind;
  gain: number;
  pan: number;
  delay: number;
  /** Which recording / variant (0..1, the engine picks from it). */
  variant: number;
}

/** What a kind of spot sound may do: per-source rate and a cap for all of them together (events/s). */
export interface SpotRule {
  rate: number;
  cap: number;
  /** Minimum gap between two of this kind (s). */
  gap: number;
  /** Keeps going while paused (scaled by 0.5); default false. */
  ambient?: boolean;
}

export const SPOT_RULES: Record<SpotKind, SpotRule> = {
  hammer: { rate: 0.5, cap: 1.4, gap: 0.25 },
  chop: { rate: 0.35, cap: 0.9, gap: 0.3 },
  dig: { rate: 0.3, cap: 0.9, gap: 0.3 },
  moo: { rate: 1 / 50, cap: 0.08, gap: 6 },
  baa: { rate: 1 / 35, cap: 0.12, gap: 4 },
  peep: { rate: 1 / 10, cap: 0.4, gap: 1 },
  creak: { rate: 1 / 5, cap: 0.4, gap: 1.5 },
  splash: { rate: 1, cap: 1, gap: 0.4 },
  bird: { rate: 0.5, cap: 0.5, gap: 1.2, ambient: true },
  frog: { rate: 0.7, cap: 0.7, gap: 0.5, ambient: true },
};

/** All spot sounds together: at most this many per second (a bustling village is a murmur). */
export const SPOT_TOTAL_CAP = 2.2;

/** Per-entity sound sources (people at work, animals). Positions in cells. */
export function entitySources(e: EntityFrame | undefined | null, out: SpotSource[] = []): SpotSource[] {
  if (!e) return out;
  for (let k = 0; k < e.count; k++) {
    const kind = e.info[4 * k]!;
    const anim = e.info[4 * k + 2]!;
    const x = e.pos[5 * k]!;
    const y = e.pos[5 * k + 1]!;
    let s: SpotKind | null = null;
    if (kind === EntityKind.Person) {
      if (anim === EntityAnim.Build) s = 'hammer';
      else if (anim === EntityAnim.Chop) s = 'chop';
      else if (anim === EntityAnim.Work || anim === EntityAnim.Shovel) s = 'dig';
    } else if (kind === EntityKind.Cow) s = 'moo';
    else if (kind === EntityKind.Sheep) s = 'baa';
    else if (kind === EntityKind.Chick) s = 'peep';
    if (s) out.push({ kind: s, x, y });
  }
  return out;
}

/** Turning water wheels and mills creak. */
export function structureSources(structures: readonly StructureInfo[] | null, buildings: readonly BuildingInfo[] | null, out: SpotSource[] = []): SpotSource[] {
  for (const s of structures ?? []) {
    if (s.kind === 'wheel' && s.progress >= 1 && Math.abs(s.speed ?? 0) > 0.15) out.push({ kind: 'creak', x: s.x, y: s.y, weight: clamp(Math.abs(s.speed!) / 1.2, 0.3, 1.5) });
  }
  for (const b of buildings ?? []) {
    if (b.kind === 'mill' && b.progress >= 1 && (b.spin ?? 0) > 0.15) out.push({ kind: 'creak', x: b.x, y: b.y, weight: clamp(b.spin! / 1.2, 0.3, 1.5) });
  }
  return out;
}

/** Hum of running turbines near the view centre (0..1). */
export function turbineHum(v: View, power: PowerInfo | null): number {
  let hum = 0;
  for (const t of power?.turbines ?? []) {
    if (t.progress < 1 || t.power <= 0) continue;
    const p = spotPlacement(v, t.x, t.y);
    if (!p) continue;
    // ~1 kW is a whisper, 50 kW a steady hum.
    const level = clamp(Math.log10(1 + t.power / 1000) / 1.7);
    hum = Math.max(hum, level * p.gain);
  }
  return hum;
}

/**
 * Water spilling over the weirs (the depth on the crest) and through open
 * gates in view, by distance: 0..1. The spill sheet is often slower than
 * "rapids" in the velocity field, but it is what a weir sounds like.
 */
export function weirSpill(v: View, structures: readonly StructureInfo[] | null, depth: Float32Array, width: number): number {
  let spill = 0;
  const at = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= width || yi * width >= depth.length) return 0;
    return depth[yi * width + xi]!;
  };
  for (const s of structures ?? []) {
    if (s.progress < 1) continue;
    let d = 0;
    let cx = s.x;
    let cy = s.y;
    if (s.kind === 'weir') {
      const x2 = s.x2 ?? s.x;
      const y2 = s.y2 ?? s.y;
      const n = Math.max(1, Math.ceil(Math.hypot(x2 - s.x, y2 - s.y)));
      let sum = 0;
      let wet = 0;
      for (let k = 0; k <= n; k++) {
        const dk = at(s.x + ((x2 - s.x) * k) / n, s.y + ((y2 - s.y) * k) / n);
        if (dk > 0.01) {
          sum += dk;
          wet++;
        }
      }
      // A sheet over part of the crest, weighted by how much of it spills.
      d = wet ? (sum / wet) * Math.min(1, wet / 3) : 0;
      cx = (s.x + x2) / 2;
      cy = (s.y + y2) / 2;
    } else if (s.kind === 'gate' && (s.lift ?? (s.open ? 1 : 0)) > 0.3) {
      d = at(s.x, s.y) * (s.lift ?? 1);
    } else continue;
    const p = spotPlacement(v, cx, cy);
    if (!p) continue;
    spill = Math.max(spill, smooth(0.015, 0.25, d) * Math.min(1, p.gain * 1.4));
  }
  return spill;
}

/** How activity sounds follow the game speed: none when paused, a little busier when fast. */
export function speedFactor(speed: number): number {
  if (speed <= 0) return 0;
  return Math.min(2, Math.sqrt(speed));
}

/**
 * Decides which spot sounds play, rate-limited per kind and in total.
 * State is only the last time of each kind; randomness is injected, so
 * tests are exact.
 */
export class SpotScheduler {
  private readonly last = new Map<SpotKind, number>();
  private t = 0;
  private tokens = 1;

  constructor(private readonly rand: () => number = Math.random) {}

  /**
   * Advance by dt seconds and return the events to play. `sources` are the
   * positional ones; `ambient` gives the densities of the non-positional
   * birds and frogs (their pans: random, or near the marsh).
   */
  tick(dt: number, view: View, sources: readonly SpotSource[], speed: number, ambient: { birds: number; frogs: number; frogPan: number } = { birds: 0, frogs: 0, frogPan: 0 }): SpotEvent[] {
    const t0 = this.t;
    this.t += dt;
    if (dt <= 0) return [];
    const sf = speedFactor(speed);
    // Group the audible sources by kind.
    const groups = new Map<SpotKind, { gain: number; pan: number; w: number }[]>();
    for (const s of sources) {
      const p = spotPlacement(view, s.x, s.y);
      if (!p || p.gain < 0.02) continue;
      let g = groups.get(s.kind);
      if (!g) groups.set(s.kind, (g = []));
      g.push({ gain: p.gain, pan: p.pan, w: s.weight ?? 1 });
    }
    const events: SpotEvent[] = [];
    const tryKind = (kind: SpotKind, lambda: number, pick: () => { gain: number; pan: number }) => {
      const rule = SPOT_RULES[kind];
      lambda = Math.min(lambda, rule.cap * dt);
      // At most one per kind per tick (ticks are short); Bernoulli with p = 1 − e^−λ.
      if (lambda <= 0 || this.rand() >= 1 - Math.exp(-lambda)) return;
      const delay = this.rand() * dt;
      const when = t0 + delay;
      const last = this.last.get(kind);
      if (last !== undefined && when - last < rule.gap) return;
      const p = pick();
      this.last.set(kind, when);
      events.push({ kind, gain: p.gain, pan: p.pan, delay, variant: this.rand() });
    };
    for (const [kind, g] of groups) {
      const rule = SPOT_RULES[kind];
      const f = rule.ambient ? (speed > 0 ? 1 : 0.5) : sf;
      if (f <= 0) continue;
      // Louder (closer) sources are more likely to be the one heard.
      let sum = 0;
      for (const s of g) sum += s.w * s.gain;
      const lambda = rule.rate * f * dt * g.reduce((a, s) => a + s.w, 0);
      tryKind(kind, lambda, () => {
        let r = this.rand() * sum;
        for (const s of g) {
          r -= s.w * s.gain;
          if (r <= 0) return s;
        }
        return g[g.length - 1]!;
      });
    }
    const amb = speed > 0 ? 1 : 0.5;
    if (ambient.birds > 0.01) {
      tryKind('bird', SPOT_RULES.bird.rate * ambient.birds * amb * dt, () => ({ gain: 0.5 + 0.5 * ambient.birds, pan: (this.rand() * 2 - 1) * 0.7 }));
    }
    if (ambient.frogs > 0.01) {
      tryKind('frog', SPOT_RULES.frog.rate * ambient.frogs * amb * dt, () => ({ gain: 0.5 + 0.5 * ambient.frogs, pan: clamp(ambient.frogPan + (this.rand() - 0.5) * 0.6, -0.8, 0.8) }));
    }
    // The total cap (a token bucket): keep the loudest when too many came up at once.
    this.tokens = Math.min(2, this.tokens + SPOT_TOTAL_CAP * dt);
    const maxN = Math.floor(this.tokens);
    if (events.length > maxN) {
      events.sort((a, b) => b.gain - a.gain);
      events.length = maxN;
    }
    this.tokens -= events.length;
    return events;
  }

  /** Pass on an event that happened (a fish jumped), unless too soon after the last of its kind. */
  external(kind: SpotKind, view: View, x: number, y: number): SpotEvent | null {
    const p = spotPlacement(view, x, y);
    if (!p || p.gain < 0.02) return null;
    const last = this.last.get(kind);
    if (last !== undefined && this.t - last < SPOT_RULES[kind].gap) return null;
    this.last.set(kind, this.t);
    return { kind, gain: p.gain, pan: p.pan, delay: 0, variant: this.rand() };
  }
}
