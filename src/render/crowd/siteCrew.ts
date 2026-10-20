/**
 * The crew at a weir that is being built: a few little workers gather on
 * the banks (`site`), working from the dry ground beside the water, and
 * wander off once it is done. Purely cosmetic: they live
 * on the main thread, are merged into the entity frames like the welcome
 * scenes' animals (render/worldLayers.ts), and change nothing in the sim.
 */
import { CarryKind, EntityAnim, EntityKind, type EntityFrame } from '../../shared/protocol';

/** At most this many workers at once. */
const MAX_CREW = 3;
/** How long a site spot keeps them interested (s), and how long they stay after the last stroke. */
const SPOT_LIFE = 40;
/** Walking speed (cells per second). */
const SPEED = 1.6;
/** Spots closer than this to an existing one are merged (cells). */
const MERGE = 3;

interface Spot {
  x: number;
  y: number;
  t: number;
}

interface Worker {
  id: number;
  variant: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  /** Where it is going (null: working on the spot), how long it works there. */
  goal: { x: number; y: number } | null;
  work: number;
  /** Leaving: walks away and is gone at `goneAt`. */
  leaving: boolean;
  goneAt: number;
}

export class SiteCrew {
  private spots: Spot[] = [];
  private crew: Worker[] = [];
  private now = 0;
  private nextId = 1;
  private seed = 0x5c1b7;
  /** Called when a worker starts working at (x, y) (sound). */
  onWork: ((x: number, y: number) => void) | null = null;

  constructor(
    private readonly known: (x: number, y: number) => boolean = () => true,
    /** Dry ground (workers do not stand in the water); everywhere by default. */
    private readonly dry: (x: number, y: number) => boolean = () => true,
  ) {}

  private rand(): number {
    // xorshift32: cosmetic only.
    let s = this.seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed = s >>> 0;
    return this.seed / 4294967296;
  }

  /** Work going on around (x, y) (cells), within radius r. */
  private note(x: number, y: number, r: number): void {
    const near = this.spots.find((s) => Math.hypot(s.x - x, s.y - y) < MERGE);
    if (near) near.t = this.now;
    else this.spots.push({ x, y, t: this.now });
    if (this.spots.length > 40) this.spots.shift();
    // A worker comes along now and then, up to a few.
    const active = this.crew.filter((w) => !w.leaving).length;
    if (active < MAX_CREW && this.rand() < 0.02) {
      const a = this.rand() * Math.PI * 2;
      const d = r + 5 + this.rand() * 4;
      const sx = x + Math.cos(a) * d;
      const sy = y + Math.sin(a) * d;
      if (!this.known(sx, sy) || !this.dry(sx, sy)) return;
      this.crew.push({ id: this.nextId++, variant: Math.floor(this.rand() * 10), x: sx, y: sy, vx: 0, vy: 0, heading: 0, goal: this.pick(x, y), work: 0, leaving: false, goneAt: 0 });
    }
  }

  /**
   * A building site at (x, y) (a weir's end on the bank): keeps workers
   * coming while it is called.
   */
  site(x: number, y: number): void {
    this.note(x, y, 1.5);
  }

  /** A site spot near (x, y) to go to, a little off its centre (on dry ground when there is some). */
  private pick(x: number, y: number): { x: number; y: number } {
    const fresh = this.spots.filter((s) => this.now - s.t < SPOT_LIFE);
    let s = fresh[Math.floor(this.rand() * fresh.length)] ?? { x, y };
    // Prefer one near where the worker already is.
    for (let k = 0; k < 3; k++) {
      const o = fresh[Math.floor(this.rand() * fresh.length)];
      if (o && Math.hypot(o.x - x, o.y - y) < Math.hypot(s.x - x, s.y - y)) s = o;
    }
    let g = { x: s.x, y: s.y };
    for (let k = 0; k < 6; k++) {
      const a = this.rand() * Math.PI * 2;
      const d = 1 + this.rand() * 1.5;
      g = { x: s.x + Math.cos(a) * d, y: s.y + Math.sin(a) * d };
      if (this.dry(g.x, g.y)) break;
    }
    return g;
  }

  /** Advance by dt real seconds. */
  advance(dt: number): void {
    this.now += dt;
    this.spots = this.spots.filter((s) => this.now - s.t < SPOT_LIFE);
    const lastStroke = this.spots.reduce((m, s) => Math.max(m, s.t), -Infinity);
    for (const w of this.crew) {
      if (!w.leaving && this.now - lastStroke > SPOT_LIFE * 0.6) {
        // Nothing left to work on: off they go.
        w.leaving = true;
        const a = this.rand() * Math.PI * 2;
        w.goal = { x: w.x + Math.cos(a) * 8, y: w.y + Math.sin(a) * 8 };
        w.goneAt = this.now + 8 / SPEED;
      }
      const g = w.goal;
      if (g) {
        const dx = g.x - w.x;
        const dy = g.y - w.y;
        const d = Math.hypot(dx, dy);
        if (d < 0.1) {
          w.goal = null;
          w.vx = w.vy = 0;
          w.work = 3 + this.rand() * 4;
          if (!w.leaving) this.onWork?.(w.x, w.y);
        } else {
          const step = Math.min(d, SPEED * dt);
          w.vx = (dx / d) * SPEED;
          w.vy = (dy / d) * SPEED;
          w.x += (dx / d) * step;
          w.y += (dy / d) * step;
          w.heading = Math.atan2(dy, dx);
        }
      } else {
        w.work -= dt;
        if (w.work <= 0 && !w.leaving) w.goal = this.pick(w.x, w.y);
      }
    }
    this.crew = this.crew.filter((w) => !w.leaving || this.now < w.goneAt);
  }

  /** How many workers are about. */
  get count(): number {
    return this.crew.length;
  }

  frame(): EntityFrame {
    const n = this.crew.length;
    const f: EntityFrame = { count: n, id: new Uint16Array(n), info: new Uint8Array(n * 4), pos: new Float32Array(n * 5) };
    this.crew.forEach((w, k) => {
      f.id[k] = (50000 + w.id) & 0xffff;
      f.info[k * 4] = EntityKind.Person;
      f.info[k * 4 + 1] = w.variant;
      f.info[k * 4 + 2] = w.goal ? EntityAnim.Walk : EntityAnim.Work;
      f.info[k * 4 + 3] = CarryKind.None;
      f.pos[k * 5] = w.x;
      f.pos[k * 5 + 1] = w.y;
      f.pos[k * 5 + 2] = w.goal ? w.vx : 0;
      f.pos[k * 5 + 3] = w.goal ? w.vy : 0;
      f.pos[k * 5 + 4] = w.heading;
    });
    return f;
  }
}
