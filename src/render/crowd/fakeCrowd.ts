/**
 * A tiny deterministic stand-in for the M3 agent simulation, run on the main
 * thread, producing EntityFrames at 10 Hz so that the crowd renderer has
 * something lively to show until real agents exist.
 *
 * Around a centre point it lays out a store, dig sites, a field, a woodpile,
 * a building site, a pasture and (if water is near) shore spots, and runs
 * small role state machines: strollers, carriers (site → store with a load,
 * back empty), diggers, builders, sitters, fishers, running children, and
 * grazing cows, pecking chicks, a pig and dogs.
 *
 * Time: it advances with real time at 1× regardless of the simulation speed
 * (pure ambience, like the earlier wanderers), so the land looks alive even
 * while the simulation is paused. It never moves into water deeper than a
 * wading depth or up steep slopes. All randomness comes from `Rng`.
 */
import { CarryKind, EntityAnim, EntityKind, type EntityFrame } from '../../shared/protocol';
import { Rng } from '../../shared/rng';
import type { HeightSampler } from '../coords';

export interface FakeCrowdOptions {
  seed: number;
  centerX: number;
  centerY: number;
  /** Number of people including children (default 40). */
  people?: number;
  /** Animals (defaults: 5 cows, 4 chicks, 1 pig, 2 dogs). */
  cows?: number;
  chicks?: number;
  pigs?: number;
  dogs?: number;
  /** Layout radius in cells (default 14). */
  radius?: number;
  /**
   * Ground look (RGBA per cell, B = vegetation). When given, the village
   * centre moves to the most open, flat, dry spot within `searchRadius` of
   * the centre (so the crowd is not hidden in a forest), preferring water nearby.
   */
  look?: Uint8Array;
  searchRadius?: number;
}

export const FAKE_TICK_S = 0.1;
const MAX_WADE = 0.25;
const MAX_SLOPE = 0.5;

type Role = 'stroller' | 'carrier' | 'digger' | 'builder' | 'sitter' | 'fisher' | 'child' | 'cow' | 'chick' | 'pig' | 'dog';

interface Site {
  x: number;
  y: number;
  load: CarryKind;
  work: EntityAnim;
  /** Facing direction when working here (fishers face the water). */
  face?: number;
}

interface Agent {
  id: number;
  kind: EntityKind;
  variant: number;
  role: Role;
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  tx: number;
  ty: number;
  speed: number;
  walking: boolean;
  /** Animation while walking / staying. */
  anim: EntityAnim;
  carry: CarryKind;
  timer: number;
  label: string;
  homeX: number;
  homeY: number;
  site: Site | null;
  rng: Rng;
}

export class FakeCrowd {
  readonly agents: Agent[] = [];
  /** Village centre (cells). */
  readonly centerX: number;
  readonly centerY: number;
  private acc = 0;
  private readonly rng: Rng;
  private readonly store: Site;
  private readonly sites: { dig: Site[]; field: Site; wood: Site; build: Site; pasture: Site; shore: Site[] };
  private readonly frameBuf: EntityFrame;

  constructor(
    private readonly heights: HeightSampler,
    opts: FakeCrowdOptions,
  ) {
    const rng = (this.rng = new Rng((opts.seed ^ 0x5eed_c0de) >>> 0));
    const R = opts.radius ?? 14;
    [this.centerX, this.centerY] = opts.look ? this.openSpot(opts.centerX, opts.centerY, opts.searchRadius ?? 20, opts.look) : [opts.centerX, opts.centerY];
    const cx = this.centerX;
    const cy = this.centerY;
    const spot = (r0: number, r1: number, load: CarryKind, work: EntityAnim): Site => {
      const p = this.findSpot(cx, cy, r0, r1);
      return { x: p[0], y: p[1], load, work };
    };
    this.store = spot(0, 3, CarryKind.None, EntityAnim.Idle);
    this.sites = {
      dig: [spot(R * 0.3, R * 0.7, CarryKind.Earth, EntityAnim.Work), spot(R * 0.3, R * 0.7, CarryKind.Earth, EntityAnim.Work)],
      field: spot(R * 0.3, R * 0.8, CarryKind.Sack, EntityAnim.Work),
      wood: spot(R * 0.4, R * 0.9, CarryKind.Log, EntityAnim.Work),
      build: spot(R * 0.2, R * 0.5, CarryKind.Bundle, EntityAnim.Build),
      pasture: spot(R * 0.5, R, CarryKind.None, EntityAnim.Eat),
      shore: this.findShore(cx, cy, R * 2),
    };
    const nPeople = opts.people ?? 40;
    const roles: Role[] = [];
    const share: [Role, number][] = [
      ['stroller', 0.22],
      ['carrier', 0.2],
      ['digger', 0.18],
      ['builder', 0.12],
      ['sitter', 0.1],
      ['fisher', 0.08],
      ['child', 0.1],
    ];
    for (const [role, f] of share) for (let k = 0; k < Math.round(nPeople * f); k++) roles.push(role);
    while (roles.length < nPeople) roles.push('stroller');
    roles.length = nPeople;
    const animals: [Role, number][] = [
      ['cow', opts.cows ?? 5],
      ['chick', opts.chicks ?? 4],
      ['pig', opts.pigs ?? 1],
      ['dog', opts.dogs ?? 2],
    ];
    for (const [role, n] of animals) for (let k = 0; k < n; k++) roles.push(role);

    let id = 1;
    for (const role of roles) {
      const a = this.spawn(id++, role, cx, cy, R, rng);
      this.agents.push(a);
    }
    const n = this.agents.length;
    this.frameBuf = { count: n, id: new Uint16Array(n), info: new Uint8Array(n * 4), pos: new Float32Array(n * 5) };
  }

  get count(): number {
    return this.agents.length;
  }

  /** Advance by real time; returns true when at least one tick ran (a new frame is ready). */
  advance(dtSec: number): boolean {
    this.acc += Math.min(0.5, Math.max(0, dtSec));
    let ticked = false;
    while (this.acc >= FAKE_TICK_S) {
      this.acc -= FAKE_TICK_S;
      this.tick();
      ticked = true;
    }
    return ticked;
  }

  tick(): void {
    for (const a of this.agents) this.step(a, FAKE_TICK_S);
  }

  /** The current state as an EntityFrame (a reused buffer: copy if you keep it). */
  frame(): EntityFrame {
    const f = this.frameBuf;
    this.agents.forEach((a, i) => {
      f.id[i] = a.id;
      f.info[i * 4] = a.kind;
      f.info[i * 4 + 1] = a.variant;
      f.info[i * 4 + 2] = a.walking ? (a.carry !== CarryKind.None && a.anim === EntityAnim.Walk ? EntityAnim.Carry : a.anim) : a.anim;
      f.info[i * 4 + 3] = a.carry;
      f.pos[i * 5] = a.x;
      f.pos[i * 5 + 1] = a.y;
      f.pos[i * 5 + 2] = a.vx;
      f.pos[i * 5 + 3] = a.vy;
      f.pos[i * 5 + 4] = a.heading;
    });
    return f;
  }

  // ---------------------------------------------------------------------------

  private walkable(x: number, y: number): boolean {
    const h = this.heights;
    if (x < 1 || y < 1 || x > h.width - 2 || y > h.height - 2) return false;
    if (h.depthAt(x, y) > MAX_WADE) return false;
    const gx = (h.terrainAt(x + 0.5, y) - h.terrainAt(x - 0.5, y)) / 5;
    const gy = (h.terrainAt(x, y + 0.5) - h.terrainAt(x, y - 0.5)) / 5;
    return Math.hypot(gx, gy) <= MAX_SLOPE;
  }

  private pathOk(x0: number, y0: number, x1: number, y1: number): boolean {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let i = 1; i <= n; i++) if (!this.walkable(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n)) return false;
    return true;
  }

  private findSpot(cx: number, cy: number, r0: number, r1: number): [number, number] {
    for (let k = 0; k < 300; k++) {
      const ang = this.rng.next() * Math.PI * 2;
      const r = r0 + (r1 - r0) * Math.sqrt(this.rng.next()) * (1 + k / 100);
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;
      if (this.walkable(x, y)) return [x, y];
    }
    return [cx, cy];
  }

  /** Best open spot: low vegetation around, flat, dry, near (not in) water, close to (cx, cy). */
  private openSpot(cx: number, cy: number, R: number, look: Uint8Array): [number, number] {
    const h = this.heights;
    const W = h.width;
    const veg = (x: number, y: number) => {
      const xi = Math.min(W - 1, Math.max(0, Math.round(x)));
      const yi = Math.min(h.height - 1, Math.max(0, Math.round(y)));
      return look[(yi * W + xi) * 4 + 2]! / 255;
    };
    let best: [number, number] = [cx, cy];
    let bestScore = Infinity;
    for (let y = Math.round(cy - R); y <= cy + R; y += 2)
      for (let x = Math.round(cx - R); x <= cx + R; x += 2) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > R || !this.walkable(x, y)) continue;
        let v = 0;
        let wet = 0;
        let ok = 0;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const r = 2 + (k % 4) * 2;
          const px = x + Math.cos(a) * r;
          const py = y + Math.sin(a) * r;
          v += veg(px, py);
          if (h.depthAt(px, py) > 0.3) wet++;
          if (this.walkable(px, py)) ok++;
        }
        const score = v / 16 + (16 - ok) / 16 + d / R * 0.35 + (wet > 0 && wet < 6 ? -0.15 : 0) + (wet >= 6 ? 0.5 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = [x, y];
        }
      }
    return best;
  }

  /** Dry spots next to calm-ish water, facing it. */
  private findShore(cx: number, cy: number, R: number): Site[] {
    const h = this.heights;
    const out: Site[] = [];
    for (let k = 0; k < 2000 && out.length < 4; k++) {
      const ang = this.rng.next() * Math.PI * 2;
      const r = Math.sqrt(this.rng.next()) * R;
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;
      if (!this.walkable(x, y) || h.depthAt(x, y) > 0.02) continue;
      for (let d = 0; d < 8; d++) {
        const a = (d / 8) * Math.PI * 2;
        const wx = x + Math.cos(a) * 1.2;
        const wy = y + Math.sin(a) * 1.2;
        if (h.depthAt(wx, wy) > 0.3) {
          if (out.every((s) => Math.hypot(s.x - x, s.y - y) > 2.5)) out.push({ x, y, load: CarryKind.Fish, work: EntityAnim.Fish, face: a });
          break;
        }
      }
    }
    return out;
  }

  private spawn(id: number, role: Role, cx: number, cy: number, R: number, rng: Rng): Agent {
    const kindOf: Partial<Record<Role, EntityKind>> = { child: EntityKind.Child, cow: EntityKind.Cow, chick: EntityKind.Chick, pig: EntityKind.Pig, dog: EntityKind.Dog };
    if (role === 'fisher' && !this.sites.shore.length) role = 'sitter';
    const kind = kindOf[role] ?? EntityKind.Person;
    let home: [number, number];
    switch (role) {
      case 'cow':
        home = this.near(this.sites.pasture, 3);
        break;
      case 'chick':
      case 'pig':
        home = this.near(this.store, 4);
        break;
      default:
        home = this.findSpot(cx, cy, 0, R * 0.8);
    }
    const a: Agent = {
      id,
      kind,
      variant: rng.int(0, 10),
      role,
      x: home[0],
      y: home[1],
      vx: 0,
      vy: 0,
      heading: rng.next() * Math.PI * 2,
      tx: home[0],
      ty: home[1],
      speed: 0.45,
      walking: false,
      anim: EntityAnim.Idle,
      carry: CarryKind.None,
      timer: rng.range(0, 1.5),
      label: 'start',
      homeX: home[0],
      homeY: home[1],
      site: null,
      rng: new Rng(rng.nextU32()),
    };
    // Workers start at their site.
    const site = this.siteFor(a);
    if (site && role !== 'carrier') {
      const p = this.near(site, 1.5);
      a.x = a.tx = p[0];
      a.y = a.ty = p[1];
      a.site = site;
    }
    return a;
  }

  private siteFor(a: Agent): Site | null {
    const r = a.rng;
    switch (a.role) {
      case 'digger': {
        const all = [...this.sites.dig, this.sites.field];
        return all[a.id % all.length]!;
      }
      case 'builder':
        return this.sites.build;
      case 'fisher':
        return this.sites.shore[a.id % this.sites.shore.length] ?? null;
      case 'carrier': {
        const all = [...this.sites.dig, this.sites.field, this.sites.wood, this.sites.build];
        if (this.sites.shore.length && r.next() < 0.15) return { ...this.sites.shore[0]!, load: CarryKind.Bucket };
        return all[r.int(0, all.length)]!;
      }
      default:
        return null;
    }
  }

  private near(s: { x: number; y: number }, r: number): [number, number] {
    for (let k = 0; k < 30; k++) {
      const x = s.x + this.rng.range(-r, r);
      const y = s.y + this.rng.range(-r, r);
      if (this.walkable(x, y)) return [x, y];
    }
    return [s.x, s.y];
  }

  private walkTo(a: Agent, x: number, y: number, speed: number, anim: EntityAnim, label: string): boolean {
    if (Math.hypot(x - a.x, y - a.y) < 0.2 || !this.pathOk(a.x, a.y, x, y)) return false;
    a.tx = x;
    a.ty = y;
    a.speed = speed * (0.9 + 0.2 * ((a.id * 37) % 11) / 10);
    a.walking = true;
    a.anim = anim;
    a.label = label;
    return true;
  }

  private stay(a: Agent, anim: EntityAnim, seconds: number, label: string): void {
    a.walking = false;
    a.anim = anim;
    a.timer = seconds;
    a.label = label;
    a.vx = 0;
    a.vy = 0;
  }

  /** Walk to a random reachable point within `r` of (x, y); else stay idle briefly. */
  private wander(a: Agent, x: number, y: number, r: number, speed: number, anim: EntityAnim, label: string): void {
    for (let k = 0; k < 8; k++) {
      const ang = a.rng.next() * Math.PI * 2;
      const d = r * (0.3 + 0.7 * Math.sqrt(a.rng.next()));
      if (this.walkTo(a, x + Math.cos(ang) * d, y + Math.sin(ang) * d, speed, anim, label)) return;
    }
    this.stay(a, EntityAnim.Idle, a.rng.range(1, 2), 'stuck');
  }

  private decide(a: Agent): void {
    const r = a.rng;
    switch (a.role) {
      case 'stroller': {
        if (a.label === 'arrived') {
          const p = r.next();
          this.stay(a, p < 0.75 ? EntityAnim.Idle : p < 0.9 ? EntityAnim.Sit : EntityAnim.Build, r.range(1.5, 6), 'rest');
        } else this.wander(a, a.homeX, a.homeY, 9, 0.45, EntityAnim.Walk, 'arrived');
        return;
      }
      case 'carrier': {
        if (a.label === 'toSite') {
          this.stay(a, EntityAnim.Work, r.range(1.5, 3), 'loaded');
          a.heading = Math.atan2(a.site!.y - a.y, a.site!.x - a.x);
        } else if (a.label === 'loaded') {
          a.carry = a.site!.load;
          const p = this.near(this.store, 1.2);
          if (!this.walkTo(a, p[0], p[1], 0.38, EntityAnim.Walk, 'toStore')) this.stay(a, EntityAnim.Idle, 1, 'loaded');
        } else if (a.label === 'toStore') {
          this.stay(a, EntityAnim.Idle, r.range(0.8, 1.5), 'drop');
        } else {
          a.carry = CarryKind.None;
          a.site = this.siteFor(a);
          const p = this.near(a.site!, 1.2);
          if (!this.walkTo(a, p[0], p[1], 0.45, EntityAnim.Walk, 'toSite')) this.stay(a, EntityAnim.Idle, r.range(1, 3), 'drop');
        }
        return;
      }
      case 'digger':
      case 'builder': {
        const s = a.site!;
        if (a.label === 'working') {
          if (r.next() < 0.25) this.stay(a, EntityAnim.Idle, r.range(1, 2.5), 'pause');
          else this.wander(a, s.x, s.y, 1.6, 0.35, EntityAnim.Walk, 'arrived');
        } else {
          this.stay(a, s.work, r.range(4, 11), 'working');
          if (a.role === 'builder') a.heading = Math.atan2(s.y - a.y, s.x - a.x);
        }
        return;
      }
      case 'sitter': {
        if (a.label === 'arrived' || a.label === 'start') this.stay(a, EntityAnim.Sit, r.range(8, 25), 'sat');
        else if (a.label === 'sat') this.stay(a, EntityAnim.Idle, r.range(1, 3), 'stood');
        else this.wander(a, this.store.x, this.store.y, 5, 0.4, EntityAnim.Walk, 'arrived');
        return;
      }
      case 'fisher': {
        const s = a.site!;
        if (a.label === 'start' || a.label === 'arrived') {
          this.stay(a, EntityAnim.Fish, r.range(15, 45), 'fished');
          a.heading = s.face ?? a.heading;
        } else if (a.label === 'fished') {
          a.carry = CarryKind.Fish;
          const p = this.near(this.store, 1.2);
          if (!this.walkTo(a, p[0], p[1], 0.4, EntityAnim.Walk, 'delivered')) this.stay(a, EntityAnim.Fish, 10, 'fished');
        } else if (a.label === 'delivered') {
          this.stay(a, EntityAnim.Idle, 1, 'back');
        } else {
          a.carry = CarryKind.None;
          if (!this.walkTo(a, s.x, s.y, 0.45, EntityAnim.Walk, 'arrived')) {
            a.x = s.x;
            a.y = s.y;
            this.stay(a, EntityAnim.Fish, 20, 'fished');
          }
        }
        return;
      }
      case 'child': {
        if (a.label === 'arrived') this.stay(a, r.next() < 0.7 ? EntityAnim.Idle : EntityAnim.Sit, r.range(0.8, 3), 'rest');
        else this.wander(a, this.store.x, this.store.y, 7, r.next() < 0.7 ? 1.0 : 0.35, r.next() < 0.7 ? EntityAnim.Run : EntityAnim.Walk, 'arrived');
        if (a.anim === EntityAnim.Walk) a.speed = 0.35;
        return;
      }
      case 'cow':
      case 'pig': {
        if (a.label === 'arrived' || a.label === 'start') this.stay(a, r.next() < 0.75 ? EntityAnim.Eat : EntityAnim.Idle, r.range(4, 12), 'grazed');
        else this.wander(a, a.homeX, a.homeY, a.role === 'cow' ? 4 : 3, 0.2, EntityAnim.Walk, 'arrived');
        return;
      }
      case 'chick': {
        if (a.label === 'arrived' || a.label === 'start') this.stay(a, r.next() < 0.7 ? EntityAnim.Eat : EntityAnim.Idle, r.range(1, 3.5), 'pecked');
        else this.wander(a, a.homeX, a.homeY, 2.5, 0.16, EntityAnim.Walk, 'arrived');
        return;
      }
      case 'dog': {
        if (a.label === 'arrived' || a.label === 'start') this.stay(a, r.next() < 0.6 ? EntityAnim.Idle : EntityAnim.Sit, r.range(1.5, 5), 'rested');
        else {
          const people = this.agents.filter((b) => b.kind === EntityKind.Person);
          const target = people[r.int(0, people.length)];
          const run = r.next() < 0.5;
          if (target) this.wander(a, target.x, target.y, 1.5, run ? 1.0 : 0.3, run ? EntityAnim.Run : EntityAnim.Walk, 'arrived');
          else this.stay(a, EntityAnim.Idle, 2, 'rested');
        }
        return;
      }
    }
  }

  private step(a: Agent, dt: number): void {
    if (!a.walking) {
      a.timer -= dt;
      a.vx = 0;
      a.vy = 0;
      if (a.timer <= 0) this.decide(a);
      return;
    }
    const dx = a.tx - a.x;
    const dy = a.ty - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.05) {
      a.walking = false;
      a.vx = a.vy = 0;
      this.decide(a);
      return;
    }
    const stepLen = Math.min(dist, a.speed * dt);
    const nx = a.x + (dx / dist) * stepLen;
    const ny = a.y + (dy / dist) * stepLen;
    if (!this.walkable(nx, ny)) {
      this.stay(a, EntityAnim.Idle, 1, 'blocked');
      return;
    }
    a.vx = (nx - a.x) / dt;
    a.vy = (ny - a.y) / dt;
    a.x = nx;
    a.y = ny;
    a.heading = Math.atan2(dy, dx);
  }
}
