/**
 * The client's side of the sculpting brushes: brush samples are applied to
 * the mirror at once (the same kernel as the sim, plans/sculpt.ts), so the
 * ground moves under the finger without waiting for the worker, and sent to
 * the sim in one command per frame. Each command carries a sequence number;
 * snapshots say which one the sim has applied (Snapshot.sculptSeq), and
 * until then the predicted change is laid again over the terrain rows a
 * snapshot brings (`reconcile`). The sim's terrain is always the final word.
 */
import type { BrushTool, Command, Snapshot } from '../shared/protocol';
import { brushSample, type SculptGrid } from '../sim/plans/sculpt';
import type { WorldMirror } from './mirror';

interface Batch {
  seq: number;
  cells: number[];
  dz: number[];
}

export class Sculptor {
  private seq = 0;
  private strokeId = 0;
  private tool: BrushTool = 'dig';
  private radius = 2.5;
  private samples: number[] = [];
  private batch: Batch = { seq: 0, cells: [], dz: [] };
  private pending: Batch[] = [];
  private y0 = Infinity;
  private y1 = -Infinity;
  private readonly grid: SculptGrid;
  /** Strokes the sim can undo (from snapshots). */
  undoable = 0;
  /** The current stroke touched (came near) cells the brush leaves alone. */
  touchedFixed = false;

  constructor(
    private readonly mirror: WorldMirror,
    private readonly send: (cmd: Command) => void,
    /** Mirror rows [y0, y1] changed by the prediction (for the renderer). */
    private readonly onRows: (y0: number, y1: number) => void,
  ) {
    this.grid = {
      width: mirror.width,
      height: mirror.height,
      terrain: (i) => mirror.terrainH[i]!,
      fixed: (i) => mirror.isFixed(i),
    };
  }

  /** Start a new stroke (one undo step). */
  begin(tool: BrushTool, radius: number): void {
    this.flush();
    this.tool = tool;
    this.radius = radius;
    this.strokeId++;
    this.touchedFixed = false;
  }

  /** The brush held at (x, y) (cells) for dt seconds: change the mirror now, send with the next flush. */
  sample(x: number, y: number, dt: number): void {
    const m = this.mirror;
    const W = m.width;
    const r = this.radius;
    const t = m.terrainH;
    brushSample(this.grid, this.tool, x, y, r, dt, (i, dz) => {
      t[i] = t[i]! + dz;
      this.batch.cells.push(i);
      this.batch.dz.push(dz);
    });
    if (!this.touchedFixed) {
      for (let cy = Math.max(0, Math.floor(y - r)); cy <= Math.min(m.height - 1, Math.ceil(y + r)) && !this.touchedFixed; cy++)
        for (let cx = Math.max(0, Math.floor(x - r)); cx <= Math.min(W - 1, Math.ceil(x + r)); cx++)
          if (m.fixed[cy * W + cx] === 1 && Math.hypot(cx - x, cy - y) < r) {
            this.touchedFixed = true;
            break;
          }
    }
    this.samples.push(x, y, dt);
    this.y0 = Math.min(this.y0, Math.max(0, Math.floor(y - r)));
    this.y1 = Math.max(this.y1, Math.min(m.height - 1, Math.ceil(y + r)));
  }

  /** Send the samples since the last flush (call once per frame). */
  flush(): void {
    if (!this.samples.length) return;
    const seq = ++this.seq;
    this.send({ type: 'sculpt', tool: this.tool, radius: this.radius, stroke: this.strokeId, seq, samples: this.samples });
    this.batch.seq = seq;
    if (this.batch.cells.length) this.pending.push(this.batch);
    this.batch = { seq: 0, cells: [], dz: [] };
    this.samples = [];
    if (this.y1 >= this.y0) this.onRows(this.y0, this.y1);
    this.y0 = Infinity;
    this.y1 = -Infinity;
  }

  /** Forget the prediction (the world was replaced: a scene restart). */
  reset(): void {
    this.pending = [];
    this.batch = { seq: 0, cells: [], dz: [] };
    this.samples = [];
    this.y0 = Infinity;
    this.y1 = -Infinity;
  }

  /** Undo the last stroke (the sim's terrain comes back with the next snapshot). */
  undo(): void {
    this.flush();
    this.send({ type: 'undoSculpt' });
    this.undoable = Math.max(0, this.undoable - 1);
  }

  /**
   * Call with each snapshot before the mirror and renderer see it: drop what
   * the sim has applied, and lay what it has not over the snapshot's rows.
   */
  reconcile(s: Snapshot): void {
    if (s.undoable !== undefined) this.undoable = s.undoable;
    const ack = s.sculptSeq ?? 0;
    if (this.pending.length) this.pending = this.pending.filter((b) => b.seq > ack);
    const tr = s.terrain;
    if (!tr) return;
    const W = this.mirror.width;
    const lo = tr.y0 * W;
    const hi = tr.y1 * W;
    const add = (b: Batch) => {
      for (let k = 0; k < b.cells.length; k++) {
        const i = b.cells[k]!;
        if (i >= lo && i < hi) tr.data[i - lo] = tr.data[i - lo]! + b.dz[k]!;
      }
    };
    for (const b of this.pending) add(b);
    add(this.batch);
  }
}
