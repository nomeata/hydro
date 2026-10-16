/**
 * Per-entity interpolation between entity snapshots (pure, no three.js).
 *
 * Each snapshot gives a target position per id. The rendered position moves
 * from where it was when the snapshot arrived to the target over one
 * (smoothed) snapshot interval, so motion is continuous and lags the sim by
 * at most one interval. If the next snapshot is late, the entity keeps going
 * with the snapshot velocity for at most `MAX_EXTRAPOLATE_S`. Jumps longer
 * than `TELEPORT_CELLS` snap. Headings turn smoothly towards the snapshot
 * heading.
 */
import type { EntityFrame } from '../../shared/protocol';

export const MAX_EXTRAPOLATE_S = 0.4;
export const TELEPORT_CELLS = 4;
/** Heading smoothing rate (1/s) and maximum turn rate (rad/s). */
const TURN_RATE = 9;
const MAX_TURN = 7;

export interface Track {
  readonly id: number;
  kind: number;
  variant: number;
  anim: number;
  carry: number;
  /** Rendered position (cells). */
  x: number;
  y: number;
  /** Interpolation start / target (cells) and target snapshot time (ms). */
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  t0: number;
  /** Snapshot velocity (cells/s). */
  vx: number;
  vy: number;
  /** Target and rendered heading (radians, protocol convention). */
  targetHeading: number;
  heading: number;
  /** Smoothed ground speed of the rendered position (cells/s). */
  speed: number;
  /** Frame generation in which it was last seen. */
  gen: number;
  /** Renderer-side state (animation, height smoothing). */
  ext: unknown;
}

/** Decoded view of one entity in a frame. */
export interface EntityRecord {
  id: number;
  kind: number;
  variant: number;
  anim: number;
  carry: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
}

/** Read entity `i` of a frame. */
export function readEntity(f: EntityFrame, i: number, out: EntityRecord = {} as EntityRecord): EntityRecord {
  out.id = f.id[i]!;
  out.kind = f.info[i * 4]!;
  out.variant = f.info[i * 4 + 1]!;
  out.anim = f.info[i * 4 + 2]!;
  out.carry = f.info[i * 4 + 3]!;
  out.x = f.pos[i * 5]!;
  out.y = f.pos[i * 5 + 1]!;
  out.vx = f.pos[i * 5 + 2]!;
  out.vy = f.pos[i * 5 + 3]!;
  out.heading = f.pos[i * 5 + 4]!;
  return out;
}

/** Build an EntityFrame from records (tests, fake crowd). */
export function makeFrame(list: readonly Omit<EntityRecord, never>[]): EntityFrame {
  const n = list.length;
  const f: EntityFrame = { count: n, id: new Uint16Array(n), info: new Uint8Array(n * 4), pos: new Float32Array(n * 5) };
  list.forEach((e, i) => {
    f.id[i] = e.id;
    f.info.set([e.kind, e.variant, e.anim, e.carry], i * 4);
    f.pos.set([e.x, e.y, e.vx, e.vy, e.heading], i * 5);
  });
  return f;
}

export function wrapAngle(a: number): number {
  return a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
}

export class EntityTracks {
  readonly tracks = new Map<number, Track>();
  /** Smoothed snapshot interval (ms). */
  intervalMs = 100;
  private lastFrameMs: number | null = null;
  private gen = 0;
  private readonly rec = {} as EntityRecord;

  /** Called for tracks that disappear from the frames. */
  onRemove: ((t: Track) => void) | null = null;

  setFrame(f: EntityFrame, nowMs: number): void {
    if (this.lastFrameMs !== null) {
      const iv = Math.min(600, Math.max(20, nowMs - this.lastFrameMs));
      this.intervalMs += (iv - this.intervalMs) * 0.25;
    }
    this.lastFrameMs = nowMs;
    const gen = ++this.gen;
    const r = this.rec;
    for (let i = 0; i < f.count; i++) {
      readEntity(f, i, r);
      let t = this.tracks.get(r.id);
      if (!t) {
        t = {
          id: r.id,
          kind: r.kind,
          variant: r.variant,
          anim: r.anim,
          carry: r.carry,
          x: r.x,
          y: r.y,
          fromX: r.x,
          fromY: r.y,
          toX: r.x,
          toY: r.y,
          t0: nowMs,
          vx: r.vx,
          vy: r.vy,
          targetHeading: r.heading,
          heading: r.heading,
          speed: Math.hypot(r.vx, r.vy),
          gen,
          ext: null,
        };
        this.tracks.set(r.id, t);
      }
      t.kind = r.kind;
      t.variant = r.variant;
      t.anim = r.anim;
      t.carry = r.carry;
      if (Math.hypot(r.x - t.x, r.y - t.y) > TELEPORT_CELLS) {
        t.x = r.x;
        t.y = r.y;
        t.heading = r.heading;
      }
      t.fromX = t.x;
      t.fromY = t.y;
      t.toX = r.x;
      t.toY = r.y;
      t.t0 = nowMs;
      t.vx = r.vx;
      t.vy = r.vy;
      t.targetHeading = r.heading;
      t.gen = gen;
    }
    for (const [id, t] of this.tracks) {
      if (t.gen !== gen) {
        this.tracks.delete(id);
        this.onRemove?.(t);
      }
    }
  }

  /** Advance rendered positions/headings to `nowMs`. */
  advance(dtSec: number, nowMs: number): void {
    const iv = this.intervalMs;
    const dt = Math.max(0, dtSec);
    const kTurn = 1 - Math.exp(-TURN_RATE * dt);
    const kSpeed = 1 - Math.exp(-6 * dt);
    for (const t of this.tracks.values()) {
      const el = nowMs - t.t0;
      let x: number;
      let y: number;
      if (el <= iv) {
        const a = Math.max(0, el / iv);
        x = t.fromX + (t.toX - t.fromX) * a;
        y = t.fromY + (t.toY - t.fromY) * a;
      } else {
        const ex = Math.min(MAX_EXTRAPOLATE_S, (el - iv) / 1000);
        x = t.toX + t.vx * ex;
        y = t.toY + t.vy * ex;
      }
      if (dt > 0) {
        const v = Math.hypot(x - t.x, y - t.y) / dt;
        t.speed += (Math.min(v, 5) - t.speed) * kSpeed;
      }
      t.x = x;
      t.y = y;
      const d = wrapAngle(t.targetHeading - t.heading);
      const step = Math.max(-MAX_TURN * dt, Math.min(MAX_TURN * dt, d * kTurn));
      t.heading = wrapAngle(t.heading + step);
    }
  }
}
