/**
 * Turns the stream of snapshots plus the camera into mixing ticks: keeps
 * what the snapshots send only when it changes (buildings, structures,
 * power, look, fog, plans), summarises the visible water at most 5× a
 * second while the snapshot's buffers are at hand, and on each tick
 * (a few times per second) computes the layer gains and picks the spot
 * sounds. No Web Audio here (tests/audio/director.test.ts).
 */
import type { BuildingInfo, ClimateState, EntityFrame, PowerInfo, SimTime, Snapshot, StructureInfo } from '../shared/protocol';
import type { MixFrame } from './engine';
import {
  ambience,
  emptySummary,
  entitySources,
  fromScreen,
  silentLayers,
  structureSources,
  summariseView,
  SpotScheduler,
  turbineHum,
  weirSpill,
  type SpotEvent,
  type SpotSource,
  type View,
  type ViewSummary,
} from './mix';

/** Summaries of the view are refreshed at most this often (s). */
const SUMMARY_EVERY = 0.2;
/** The crew counts as digging for this long after a terrain change under a plan (s). */
const CREW_HOLD = 1.5;

export class SoundDirector {
  private summary: ViewSummary = emptySummary();
  private summaryAt = -Infinity;
  private entities: EntityFrame | null = null;
  private buildings: readonly BuildingInfo[] | null = null;
  private structures: readonly StructureInfo[] | null = null;
  private power: PowerInfo | null = null;
  private look: Uint8Array | null;
  private revealed: Uint8Array | null;
  private plan: Float32Array | null = null;
  private climate: ClimateState | null = null;
  private time: SimTime | null = null;
  private speed = 1;
  private spill = 0;
  private crew: SpotSource[] = [];
  private crewUntil = -Infinity;
  private brush: SpotSource[] = [];
  private brushUntil = -Infinity;
  private readonly sched: SpotScheduler;
  private readonly pending: SpotEvent[] = [];
  private readonly width: number;

  constructor(init: { width: number; look?: Uint8Array | null; revealed?: Uint8Array | null; plan?: Float32Array | null }, rand: () => number = Math.random) {
    this.width = init.width;
    this.look = init.look ?? null;
    this.revealed = init.revealed ?? null;
    this.plan = init.plan ?? null;
    this.sched = new SpotScheduler(rand);
  }

  /** Has any snapshot arrived yet? */
  get ready(): boolean {
    return this.time !== null;
  }

  /**
   * Take a snapshot (synchronously: its depth/velocity buffers go back to
   * the worker afterwards). `now` in seconds.
   */
  onSnapshot(s: Snapshot, view: View, now: number): void {
    this.time = s.time;
    this.climate = s.climate;
    this.speed = s.stats.speedRequested;
    if (s.entities) this.entities = s.entities;
    if (s.buildings) this.buildings = s.buildings;
    if (s.structures) this.structures = s.structures;
    if (s.power) this.power = s.power;
    if (s.look) this.look = s.look;
    if (s.revealed) this.revealed = s.revealed;
    if (s.plan) this.plan = s.plan;
    const width = this.width;
    if (now - this.summaryAt >= SUMMARY_EVERY) {
      this.summaryAt = now;
      this.spill = weirSpill(view, this.structures, s.depth, width);
      this.summary = summariseView(view, { width, height: s.depth.length / width, depth: s.depth, vel: s.vel, look: this.look, revealed: this.revealed });
    }
    // The crew at work: terrain changed while plans are in view.
    if (s.terrain && this.plan && s.time.step > 0) {
      const spots = planSpots(view, this.plan, width);
      if (spots.length) {
        this.crew = spots;
        this.crewUntil = now + CREW_HOLD;
      }
    }
  }

  /** The cosmetic crew works at a weir site at (x, y) (render/crowd/siteCrew.ts): spade sounds there for a while. */
  crewAt(x: number, y: number, now: number): void {
    this.crew = [{ kind: 'dig', x: Math.round(x), y: Math.round(y), weight: 0.5 }];
    this.crewUntil = now + 5;
  }

  /** The earth brush is applied at (x, y): an occasional soft spade crunch while it is (about one every 1.5–2 s at speed 1). */
  brushAt(x: number, y: number, now: number): void {
    this.brush = [{ kind: 'dig', x: Math.round(x), y: Math.round(y), weight: 2 }];
    this.brushUntil = now + 0.5;
  }

  /** A fish jumped (renderer): splash if near enough. */
  splash(view: View, x: number, y: number): void {
    const e = this.sched.external('splash', view, x, y);
    if (e) this.pending.push(e);
  }

  /** One mixing tick of dt seconds at time `now` (s). */
  tick(dt: number, view: View, now: number): MixFrame {
    if (!this.time || !this.climate) {
      const frame: MixFrame = { layers: silentLayers(), pans: { river: 0, lake: 0, rapids: 0 }, spots: this.pending.splice(0) };
      return frame;
    }
    const hum = turbineHum(view, this.power);
    const layers = ambience({ view, summary: this.summary, climate: this.climate, time: this.time, speed: this.speed, hum, spill: this.spill });
    const sources = entitySources(this.entities);
    structureSources(this.structures, this.buildings, sources);
    if (now < this.crewUntil) sources.push(...this.crew);
    if (now < this.brushUntil) sources.push(...this.brush);
    const s = this.summary;
    const spots = this.sched.tick(dt, view, sources, this.speed, { birds: layers.birds, frogs: layers.frogs, frogPan: s.panStill });
    spots.push(...this.pending.splice(0));
    return {
      layers,
      pans: { river: s.panFlow, lake: s.panStill, rapids: s.panRapids },
      spots,
    };
  }
}



/** Up to 3 planned cells on screen (sampled on a coarse grid), as dig sources for the crew. */
export function planSpots(view: View, plan: Float32Array, width: number, n = 12): SpotSource[] {
  const out: SpotSource[] = [];
  if (width <= 0) return out;
  const height = plan.length / width;
  for (let j = 0; j < n && out.length < 3; j++) {
    for (let k = 0; k < n && out.length < 3; k++) {
      const [fx, fy] = fromScreen(view, ((k + 0.5) / n) * 1.6 - 0.8, ((j + 0.5) / n) * 1.6 - 0.8);
      const x = Math.round(fx);
      const y = Math.round(fy);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      if (!Number.isNaN(plan[y * width + x]!)) out.push({ kind: 'dig', x, y, weight: 0.4 });
    }
  }
  return out;
}
