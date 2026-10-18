/**
 * Selecting and editing what the player built (DESIGN.md §4): in Look mode
 * (or with the weir tool) a tap on a weir, gate, water wheel, turbine,
 * pole or pump selects it. A small panel names it and offers Remove (tap
 * twice: "Remove?" first, so a stray touch takes nothing down); a weir also
 * gets − / + for its crest and a handle at each end that can be dragged out
 * or in, with a live preview. Edits become plans: the crew rebuilds
 * (sim/structures/structures.ts editWeir / removeWeir, the sim's
 * removeStructure). Handles and the outline are HTML/SVG over the canvas,
 * re-projected every frame; they work with mouse and touch alike.
 */
import type { Command, PowerInfo, Pt, SelectableKind, StructureInfo } from '../shared/protocol';
import type { WorldMirror } from '../client/mirror';
import { planWeirPreview } from '../sim/plans/plans';
import { toolName } from '../shared/progress';

const NS = 'http://www.w3.org/2000/svg';
/** Crest step of the − / + buttons (m). */
export const CREST_STEP = 0.25;
const MIN_HEIGHT = 0.5;
/** (The sim also keeps the crest within 4 m of the ground on the wall's lower side.) */
const MAX_HEIGHT = 4;
/** How long an edit is shown as sent before the snapshot catches up (ms). */
const PENDING_MS = 2500;

export interface SelectionHost {
  pick(clientX: number, clientY: number): { x: number; y: number } | null;
  /** Client (CSS pixel) position of a ground point in cell coordinates, or null when off screen. */
  project(x: number, y: number): [number, number] | null;
  structures(): readonly StructureInfo[];
  power(): PowerInfo | null;
  mirror: WorldMirror;
  setPreviewPlan(cells: Float32Array | null): void;
  setPreviewLining(cells: readonly number[] | null): void;
  command(cmd: Command): void;
  /** Called every frame (returns nothing to undo; the selection lives as long as the page). */
  onFrame(fn: () => void): void;
}

export interface Selected {
  kind: SelectableKind;
  id: number;
}

/** What a tap hits: the kind, id, and a point to ring (weirs: their two ends). */
interface Target extends Selected {
  x: number;
  y: number;
  x2?: number;
  y2?: number;
}

const NAMES: Record<SelectableKind, string> = {
  weir: toolName('weir'),
  gate: 'Sluice gate',
  wheel: toolName('wheel'),
  turbine: toolName('turbine'),
  pole: 'Power pole',
  pump: toolName('pump'),
};

export class Selection {
  selected: Selected | null = null;
  readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly crestOut: HTMLElement;
  private readonly crestBox: HTMLElement;
  private readonly note: HTMLElement;
  private readonly removeBtn: HTMLButtonElement;
  private readonly svg: SVGSVGElement;
  private readonly line: SVGLineElement;
  private readonly ring: SVGCircleElement;
  private readonly handles: [HTMLButtonElement, HTMLButtonElement];
  /** A weir edit sent but not yet in a snapshot: shown meanwhile. */
  private pending: { ends: [Pt, Pt]; top: number; at: number } | null = null;
  /** The end being dragged (0 or 1) and where it is. */
  private drag: { end: 0 | 1; id: number; at: Pt } | null = null;
  private armed = false;
  /** Told when the selection opens or closes (the palette hides its hint meanwhile). */
  onChange: ((sel: Selected | null) => void) | null = null;

  constructor(
    overlayRoot: HTMLElement,
    private readonly host: SelectionHost,
  ) {
    this.panel = document.createElement('div');
    this.panel.className = 'select-panel panel';
    this.panel.hidden = true;
    this.panel.dataset.testid = 'selection';
    this.panel.innerHTML = `
      <div class="sel-head"><b class="sel-title"></b><button class="sel-close" aria-label="Close">×</button></div>
      <div class="sel-row">
        <span class="sel-crest"><button class="sel-lower" aria-label="Lower the crest">−</button><span>Crest <output></output></span><button class="sel-raise" aria-label="Raise the crest">+</button></span>
        <button class="sel-remove">Remove</button>
      </div>
      <div class="sel-note"></div>`;
    this.title = this.panel.querySelector('.sel-title')!;
    this.crestBox = this.panel.querySelector('.sel-crest')!;
    this.crestOut = this.panel.querySelector('.sel-crest output')!;
    this.note = this.panel.querySelector('.sel-note')!;
    this.removeBtn = this.panel.querySelector('.sel-remove')!;
    this.panel.querySelector('.sel-close')!.addEventListener('click', () => this.clear());
    this.panel.querySelector('.sel-lower')!.addEventListener('click', () => this.crest(-CREST_STEP));
    this.panel.querySelector('.sel-raise')!.addEventListener('click', () => this.crest(CREST_STEP));
    this.removeBtn.addEventListener('click', () => this.remove());

    this.svg = document.createElementNS(NS, 'svg');
    this.svg.classList.add('sel-overlay');
    this.line = document.createElementNS(NS, 'line');
    this.ring = document.createElementNS(NS, 'circle');
    this.ring.setAttribute('r', '22');
    this.svg.append(this.line, this.ring);
    this.svg.style.display = 'none';
    overlayRoot.append(this.svg);
    const handle = (end: 0 | 1) => {
      const b = document.createElement('button');
      b.className = 'sel-handle';
      b.dataset.end = String(end);
      b.setAttribute('aria-label', end === 0 ? 'Move this end of the weir' : 'Move the other end of the weir');
      b.hidden = true;
      b.addEventListener('pointerdown', (e) => this.dragStart(e, end));
      b.addEventListener('pointermove', (e) => this.dragMove(e));
      b.addEventListener('pointerup', (e) => this.dragEnd(e));
      b.addEventListener('pointercancel', () => this.dragCancel());
      overlayRoot.append(b);
      return b;
    };
    this.handles = [handle(0), handle(1)];
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.selected) this.clear();
    });
    host.onFrame(() => this.frame());
  }

  // ---------------------------------------------------------------------------
  // Hit testing

  /** Everything selectable, as targets. */
  private targets(): Target[] {
    const out: Target[] = [];
    for (const s of this.host.structures()) {
      if (s.kind === 'weir' && s.x2 !== undefined && s.y2 !== undefined) out.push({ kind: 'weir', id: s.id, x: s.x, y: s.y, x2: s.x2, y2: s.y2 });
      else if (s.kind === 'gate' || s.kind === 'wheel') out.push({ kind: s.kind, id: s.id, x: s.x, y: s.y });
    }
    const p = this.host.power();
    if (p) {
      for (const t of p.turbines) out.push({ kind: 'turbine', id: t.id, x: t.x, y: t.y });
      for (const t of p.poles) out.push({ kind: 'pole', id: t.id, x: t.x, y: t.y });
      for (const t of p.pumps) out.push({ kind: 'pump', id: t.id, x: t.hx, y: t.hy });
    }
    return out;
  }

  /** What is at cell (x, y), if anything (weirs: anywhere along their line; small things win). */
  hit(x: number, y: number, only?: SelectableKind): Target | null {
    let best: Target | null = null;
    let bd = Infinity;
    for (const t of this.targets()) {
      if (only && t.kind !== only) continue;
      let d: number;
      let r: number;
      if (t.kind === 'weir') {
        d = segDist(x, y, t.x, t.y, t.x2!, t.y2!) + 0.4;
        r = 2.2;
      } else {
        d = Math.hypot(x - t.x, y - t.y);
        r = t.kind === 'pole' ? 1.3 : 1.8;
      }
      if (d <= r && d < bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  }

  /** A tap at a client position: select what is there. Returns whether something was selected. */
  tapAt(clientX: number, clientY: number, only?: SelectableKind): boolean {
    const p = this.host.pick(clientX, clientY);
    const t = p ? this.hit(p.x, p.y, only) : null;
    if (!t) {
      if (!only) this.clear();
      return false;
    }
    this.select(t);
    return true;
  }

  select(sel: Selected): void {
    this.selected = { kind: sel.kind, id: sel.id };
    this.pending = null;
    this.disarm();
    this.title.textContent = NAMES[sel.kind];
    const weir = sel.kind === 'weir';
    this.crestBox.hidden = !weir;
    this.note.textContent = weir
      ? 'Drag its ends to move them; − / + lower or raise the wall’s crest. The crew rebuilds it.'
      : sel.kind === 'gate'
        ? 'Removing it fills the opening back up to the dam’s crest.'
        : '';
    this.note.hidden = !this.note.textContent;
    this.panel.hidden = false;
    this.refresh();
    this.onChange?.(this.selected);
  }

  clear(): void {
    if (!this.selected && this.panel.hidden) return;
    this.selected = null;
    this.pending = null;
    this.drag = null;
    this.disarm();
    this.panel.hidden = true;
    this.svg.style.display = 'none';
    for (const h of this.handles) h.hidden = true;
    this.host.setPreviewPlan(null);
    this.host.setPreviewLining(null);
    this.onChange?.(null);
  }

  /** The selected structure's current info (weir), or null. */
  private weirInfo(): StructureInfo | null {
    const s = this.selected;
    if (!s || s.kind !== 'weir') return null;
    return this.host.structures().find((o) => o.kind === 'weir' && o.id === s.id) ?? null;
  }

  /** The weir as shown: the pending edit if one is on its way. */
  private weirNow(): { ends: [Pt, Pt]; top: number; sill: number } | null {
    const w = this.weirInfo();
    if (!w || w.x2 === undefined || w.y2 === undefined) return null;
    const p = this.pending;
    if (p && performance.now() - p.at > PENDING_MS) this.pending = null;
    else if (p && Math.abs(p.top - w.top) < 0.01 && near(p.ends[0], [w.x, w.y]) && near(p.ends[1], [w.x2, w.y2])) this.pending = null;
    const ends: [Pt, Pt] = this.pending?.ends ?? [
      [w.x, w.y],
      [w.x2, w.y2],
    ];
    return { ends, top: this.pending?.top ?? w.top, sill: w.sill };
  }

  /** Update the panel from the latest snapshot (called when structures change). */
  refresh(): void {
    const s = this.selected;
    if (!s) return;
    if (!this.targets().some((t) => t.kind === s.kind && t.id === s.id)) {
      // Gone (taken down, or dug through).
      this.clear();
      return;
    }
    const w = this.weirNow();
    if (w) {
      const h = w.top - w.sill;
      this.crestOut.textContent = `${h.toFixed(2).replace(/0$/, '')} m`;
      (this.panel.querySelector('.sel-lower') as HTMLButtonElement).disabled = h <= MIN_HEIGHT + 0.01;
      (this.panel.querySelector('.sel-raise') as HTMLButtonElement).disabled = h >= MAX_HEIGHT - 0.01;
    }
  }

  // ---------------------------------------------------------------------------
  // Edits

  private crest(dz: number): void {
    this.disarm();
    const s = this.selected;
    const w = this.weirNow();
    if (!s || !w) return;
    const top = Math.max(w.sill + MIN_HEIGHT, Math.min(w.sill + MAX_HEIGHT, w.top + dz));
    if (Math.abs(top - w.top) < 0.005) return;
    this.send(s.id, w.ends, top);
  }

  private send(id: number, ends: [Pt, Pt], top: number): void {
    this.pending = { ends, top, at: performance.now() };
    this.host.command({ type: 'editWeir', id, points: [ends[0], ends[1]], top });
    this.refresh();
  }

  private remove(): void {
    const s = this.selected;
    if (!s) return;
    if (!this.armed) {
      // First tap: ask.
      this.removeBtn.textContent = 'Remove?';
      this.removeBtn.classList.add('armed');
      // Asked until something else is pressed or selected (no timer: a slow second tap still counts).
      this.armed = true;
      return;
    }
    this.disarm();
    this.host.command({ type: 'removeStructure', kind: s.kind, id: s.id });
    this.clear();
  }

  private disarm(): void {
    this.armed = false;
    this.removeBtn.textContent = 'Remove';
    this.removeBtn.classList.remove('armed');
  }

  private dragStart(e: PointerEvent, end: 0 | 1): void {
    const s = this.selected;
    const w = this.weirNow();
    if (!s || !w) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    this.drag = { end, id: s.id, at: w.ends[end] };
  }

  private dragMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    e.preventDefault();
    const p = this.host.pick(e.clientX, e.clientY);
    if (!p) return;
    d.at = [Math.round(p.x * 2) / 2, Math.round(p.y * 2) / 2];
    this.preview();
  }

  private dragEnd(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.dragMove(e);
    this.drag = null;
    const w = this.weirNow();
    this.host.setPreviewPlan(null);
    this.host.setPreviewLining(null);
    if (!w || this.selected?.id !== d.id) return;
    const ends: [Pt, Pt] = [w.ends[0], w.ends[1]];
    ends[d.end] = d.at;
    if (Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]) < 2) return; // too short: keep it as it was
    if (near(ends[0], w.ends[0]) && near(ends[1], w.ends[1])) return;
    this.send(d.id, ends, w.top);
  }

  private dragCancel(): void {
    this.drag = null;
    this.host.setPreviewPlan(null);
    this.host.setPreviewLining(null);
  }

  /** Preview the dragged weir: the new ground it raises and the stone it lays. */
  private preview(): void {
    const d = this.drag;
    const w = this.weirNow();
    if (!d || !w) return;
    const ends: [Pt, Pt] = [w.ends[0], w.ends[1]];
    ends[d.end] = d.at;
    const m = this.host.mirror;
    const grid = m.previewGrid();
    const lined = planWeirPreview(grid, ends[0], ends[1], w.top);
    m.maskUnrevealed(grid.plan);
    this.host.setPreviewPlan(grid.plan);
    this.host.setPreviewLining(lined.filter((i) => m.isRevealed(i % m.width, (i / m.width) | 0) && m.plannable(i)));
  }

  // ---------------------------------------------------------------------------
  // Drawing

  private frame(): void {
    const s = this.selected;
    if (!s) return;
    const t = this.targets().find((o) => o.kind === s.kind && o.id === s.id);
    if (!t) return;
    const pr = this.host.project;
    this.svg.style.display = '';
    if (s.kind === 'weir') {
      const w = this.weirNow();
      if (!w) return;
      const ends: [Pt, Pt] = [w.ends[0], w.ends[1]];
      if (this.drag) ends[this.drag.end] = this.drag.at;
      const a = pr(ends[0][0], ends[0][1]);
      const b = pr(ends[1][0], ends[1][1]);
      this.ring.style.display = 'none';
      this.line.style.display = a && b ? '' : 'none';
      if (a && b) {
        this.line.setAttribute('x1', a[0].toFixed(1));
        this.line.setAttribute('y1', a[1].toFixed(1));
        this.line.setAttribute('x2', b[0].toFixed(1));
        this.line.setAttribute('y2', b[1].toFixed(1));
      }
      [a, b].forEach((p, k) => {
        const h = this.handles[k]!;
        h.hidden = !p;
        if (p) h.style.transform = `translate(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px)`;
      });
    } else {
      for (const h of this.handles) h.hidden = true;
      this.line.style.display = 'none';
      const p = pr(t.x, t.y);
      this.ring.style.display = p ? '' : 'none';
      if (p) {
        this.ring.setAttribute('cx', p[0].toFixed(1));
        this.ring.setAttribute('cy', p[1].toFixed(1));
      }
    }
  }
}

function segDist(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

function near(a: Pt, b: Pt): boolean {
  return Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
}
