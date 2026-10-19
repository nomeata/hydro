/**
 * Selecting and editing what the player built (DESIGN.md §4), in place on
 * the map: in Look mode (or with the weir tool) a tap on a weir, gate,
 * water wheel, turbine, pole or pump selects it; a tap elsewhere (or
 * Escape) lets go. A small bubble above it names it and holds a × to take
 * it down (tap twice: "Remove?" first, so a stray touch takes nothing down);
 * a turbine, pole or pump also shows what it is doing now
 * (ui/powerReadout.ts: a gauge, the houses it lights, its head and power,
 * or why it idles).
 *
 * Handles, all HTML over the canvas, re-projected every frame, for mouse
 * and touch alike:
 * - a weir: one at each end, dragged along the wall's own line to lengthen
 *   or shorten it (never turning it), and one on the crest, dragged up or
 *   down to raise or lower it in CREST_STEP steps (arrow keys too); a ghost
 *   of the wall as it will stand follows live;
 * - a pump: its outlet, dragged anywhere within the pump's reach and lift;
 * - a water wheel: its trough's end on the bank, as the wheel tool's rules
 *   allow.
 * The ghost shows whether the new place works (red when not). Edits become
 * plans: the crew rebuilds (sim/structures/structures.ts editWeir; a moved
 * pump or wheel is taken down and placed anew).
 */
import type { Command, PowerInfo, Pt, SelectableKind, StructureInfo } from '../shared/protocol';
import type { WorldMirror } from '../client/mirror';
import { toolName } from '../shared/progress';
import { powerReadout, type PowerHouse, type Readout } from './powerReadout';
import { pumpSite } from '../sim/power/power';
import { wheelSite } from '../sim/structures/wheel';
import type { PumpGhost } from './tools';

const NS = 'http://www.w3.org/2000/svg';
/** Crest step of the height handle (m). */
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
  /** Client position of a point at height h (m) above cell (x, y), or null when off screen. */
  projectAt?(x: number, y: number, h: number): [number, number] | null;
  structures(): readonly StructureInfo[];
  power(): PowerInfo | null;
  mirror: WorldMirror;
  setPreviewPlan(cells: Float32Array | null): void;
  setPreviewLining(cells: readonly number[] | null): void;
  /** The ghost of a weir as it will stand (an edit in progress), or none. */
  setWeirGhost?(list: readonly StructureInfo[]): void;
  /** The ghost of a moved pump (red when its new place does not work), or none. */
  setPowerGhost?(g: { poles: readonly Pt[]; wires: readonly number[]; pump?: PumpGhost } | null, ok?: boolean): void;
  /** The ghost of a moved wheel (red when not), or none. */
  setWheelGhost?(site: { x: number; y: number; hx: number; hy: number } | null, ok: boolean): void;
  /** Water depth (m) and speed (m/s) at cell i (the pump's and wheel's rules). */
  depth?(i: number): number;
  speed?(i: number): number;
  command(cmd: Command): void;
  /** The village buildings (a power line's houses) and the water surface at a cell (m; a turbine's head). */
  buildings?(): readonly PowerHouse[];
  surface?(x: number, y: number): number;
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

type Drag =
  | { kind: 'end'; end: 0 | 1; id: number; at: Pt }
  | { kind: 'height'; id: number; y0: number; top0: number; top: number; moved: boolean }
  | { kind: 'route'; id: number; at: Pt; ok: boolean };

export class Selection {
  selected: Selected | null = null;
  /** The bubble over the selected thing (name, ×, and a power readout). */
  readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly note: HTMLElement;
  private readonly removeBtn: HTMLButtonElement;
  private readonly powerBox: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly line: SVGLineElement;
  private readonly ring: SVGCircleElement;
  private readonly handles: [HTMLButtonElement, HTMLButtonElement];
  private readonly heightHandle: HTMLButtonElement;
  private readonly routeHandle: HTMLButtonElement;
  /** A weir edit sent but not yet in a snapshot: shown meanwhile. */
  private pending: { ends: [Pt, Pt]; top: number; at: number } | null = null;
  private drag: Drag | null = null;
  /** A moved pump or wheel, placed anew: select it again when it shows up. */
  private reselect: { kind: 'pump' | 'wheel'; x: number; y: number; at: number } | null = null;
  private armed = false;
  /** The readout shown (its signature, to redraw only on change) and when it was last worked out. */
  private powerSig = '';
  private powerAt = 0;
  /** The live state of a selected turbine, pole or pump (tests). */
  readout: Readout | null = null;
  /** Told when the selection opens or closes (the palette hides its hint meanwhile). */
  onChange: ((sel: Selected | null) => void) | null = null;

  constructor(
    overlayRoot: HTMLElement,
    private readonly host: SelectionHost,
  ) {
    this.panel = document.createElement('div');
    this.panel.className = 'select-panel sel-bubble panel';
    this.panel.hidden = true;
    this.panel.dataset.testid = 'selection';
    this.panel.innerHTML = `
      <div class="sel-head"><b class="sel-title"></b><span class="sel-note"></span><button class="sel-remove" aria-label="Remove" title="Remove">×</button></div>
      <div class="sel-power" data-testid="power-readout" hidden></div>`;
    this.title = this.panel.querySelector('.sel-title')!;
    this.note = this.panel.querySelector('.sel-note')!;
    this.removeBtn = this.panel.querySelector('.sel-remove')!;
    this.powerBox = this.panel.querySelector('.sel-power')!;
    this.removeBtn.addEventListener('click', () => this.remove());
    overlayRoot.append(this.panel);

    this.svg = document.createElementNS(NS, 'svg');
    this.svg.classList.add('sel-overlay');
    this.line = document.createElementNS(NS, 'line');
    this.ring = document.createElementNS(NS, 'circle');
    this.ring.setAttribute('r', '22');
    this.svg.append(this.line, this.ring);
    this.svg.style.display = 'none';
    overlayRoot.append(this.svg);
    const handle = (cls: string, label: string, start: (e: PointerEvent) => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = cls;
      b.setAttribute('aria-label', label);
      b.hidden = true;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        this.disarm();
        start(e);
      });
      b.addEventListener('pointermove', (e) => this.dragMove(e));
      b.addEventListener('pointerup', (e) => this.dragEnd(e));
      b.addEventListener('pointercancel', () => this.dragCancel());
      overlayRoot.append(b);
      return b;
    };
    const end = (k: 0 | 1) => {
      const b = handle('sel-handle', k === 0 ? 'Move this end of the weir' : 'Move the other end of the weir', () => this.endStart(k));
      b.dataset.end = String(k);
      return b;
    };
    this.handles = [end(0), end(1)];
    this.heightHandle = handle('sel-height', 'Crest height: drag up or down', (e) => this.heightStart(e));
    this.heightHandle.dataset.testid = 'weir-height';
    this.heightHandle.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.crest(e.key === 'ArrowUp' ? CREST_STEP : -CREST_STEP);
      }
    });
    this.routeHandle = handle('sel-handle sel-route', 'Move the outlet', () => this.routeStart());
    this.routeHandle.dataset.end = 'route';
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

  /** Everything at cell (x, y), nearest first; small things (a gate, turbine or pump in or by a weir) before the weir round them. */
  private hits(x: number, y: number, only?: SelectableKind): Target[] {
    const small: [number, Target][] = [];
    const weirs: [number, Target][] = [];
    for (const t of this.targets()) {
      if (only && t.kind !== only) continue;
      if (t.kind === 'weir') {
        const d = segDist(x, y, t.x, t.y, t.x2!, t.y2!);
        if (d <= 1.8) weirs.push([d, t]);
        continue;
      }
      const d = Math.hypot(x - t.x, y - t.y);
      if (d <= (t.kind === 'pole' ? 1.3 : 1.8)) small.push([d, t]);
    }
    const by = (a: [number, Target], b: [number, Target]) => a[0] - b[0];
    return [...small.sort(by), ...weirs.sort(by)].map(([, t]) => t);
  }

  /** What is at cell (x, y), if anything. */
  hit(x: number, y: number, only?: SelectableKind): Target | null {
    return this.hits(x, y, only)[0] ?? null;
  }

  /** A tap at a client position: select what is there (a second tap on the same spot: the next thing there), or let go. Returns whether something was selected. */
  tapAt(clientX: number, clientY: number, only?: SelectableKind): boolean {
    const p = this.host.pick(clientX, clientY);
    const all = p ? this.hits(p.x, p.y, only) : [];
    if (!all.length) {
      if (!only) this.clear();
      return false;
    }
    const s = this.selected;
    const k = s ? all.findIndex((t) => t.kind === s.kind && t.id === s.id) : -1;
    this.select(all[(k + 1) % all.length]!);
    return true;
  }

  select(sel: Selected): void {
    this.selected = { kind: sel.kind, id: sel.id };
    this.pending = null;
    this.drag = null;
    this.disarm();
    this.title.textContent = NAMES[sel.kind];
    this.note.textContent = '';
    this.powerSig = '';
    this.powerAt = 0;
    this.readout = null;
    this.powerBox.hidden = true;
    this.panel.hidden = false;
    this.ghosts(false);
    this.refresh();
    // Placed at once (not only with the next frame: a slow machine draws few).
    this.frame();
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
    for (const h of [...this.handles, this.heightHandle, this.routeHandle]) h.hidden = true;
    this.ghosts(false);
    this.onChange?.(null);
  }

  /** Hide the edit ghosts (keepWeir: not the pending weir's). */
  private ghosts(keepWeir: boolean): void {
    if (!keepWeir) this.host.setWeirGhost?.([]);
    this.host.setPowerGhost?.(null);
    this.host.setWheelGhost?.(null, false);
    this.host.setPreviewPlan(null);
    this.host.setPreviewLining(null);
  }

  /** The selected structure's current info (weir or wheel), or null. */
  private info(kind: 'weir' | 'wheel'): StructureInfo | null {
    const s = this.selected;
    if (!s || s.kind !== kind) return null;
    return this.host.structures().find((o) => o.kind === kind && o.id === s.id) ?? null;
  }

  private pumpInfo(): PowerInfo['pumps'][number] | null {
    const s = this.selected;
    if (!s || s.kind !== 'pump') return null;
    return this.host.power()?.pumps.find((o) => o.id === s.id) ?? null;
  }

  /** The weir as shown: the pending edit if one is on its way. */
  private weirNow(): { ends: [Pt, Pt]; top: number; sill: number } | null {
    const w = this.info('weir');
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

  /** Update from the latest snapshot (called when structures change). */
  refresh(): void {
    const r = this.reselect;
    if (r && performance.now() - r.at < 10_000) {
      // A moved pump or wheel shows up anew: select it again.
      const t = this.targets().find((o) => {
        if (o.kind !== r.kind) return false;
        if (r.kind === 'pump') return this.host.power()?.pumps.some((p) => p.id === o.id && p.x === r.x && p.y === r.y) ?? false;
        return Math.abs(o.x - r.x) < 0.5 && Math.abs(o.y - r.y) < 0.5;
      });
      if (t && !(this.selected?.kind === t.kind && this.selected.id === t.id)) {
        this.reselect = null;
        this.select(t);
        return;
      }
    } else this.reselect = null;
    const s = this.selected;
    if (!s) return;
    if (!this.targets().some((t) => t.kind === s.kind && t.id === s.id)) {
      // Gone (taken down, or dug through); a moved one comes back.
      if (this.reselect) {
        this.selected = null;
        this.panel.hidden = true;
        this.svg.style.display = 'none';
        for (const h of [...this.handles, this.heightHandle, this.routeHandle]) h.hidden = true;
        return;
      }
      this.clear();
      return;
    }
    const w = this.weirNow();
    if (w) this.note.textContent = `crest ${fmt(w.top - w.sill)}`;
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
    this.removeBtn.textContent = '×';
    this.removeBtn.classList.remove('armed');
  }

  private endStart(end: 0 | 1): void {
    const s = this.selected;
    const w = this.weirNow();
    if (!s || !w) return;
    this.drag = { kind: 'end', end, id: s.id, at: w.ends[end] };
  }

  private heightStart(e: PointerEvent): void {
    const s = this.selected;
    const w = this.weirNow();
    if (!s || !w) return;
    this.drag = { kind: 'height', id: s.id, y0: e.clientY, top0: w.top, top: w.top, moved: false };
  }

  private routeStart(): void {
    const s = this.selected;
    if (!s) return;
    if (s.kind === 'pump') {
      const p = this.pumpInfo();
      if (p) this.drag = { kind: 'route', id: s.id, at: [p.ox, p.oy], ok: true };
    } else if (s.kind === 'wheel') {
      const w = this.info('wheel');
      if (w && w.x2 !== undefined && w.y2 !== undefined) this.drag = { kind: 'route', id: s.id, at: [w.x2, w.y2], ok: true };
    }
  }

  private dragMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    e.preventDefault();
    if (d.kind === 'height') {
      const w = this.weirNow();
      if (!w) return;
      const mid: Pt = [(w.ends[0][0] + w.ends[1][0]) / 2, (w.ends[0][1] + w.ends[1][1]) / 2];
      // Pixels per metre up the screen at the crest.
      const a = this.host.projectAt?.(mid[0], mid[1], d.top0);
      const b = this.host.projectAt?.(mid[0], mid[1], d.top0 + 1);
      const ppm = a && b ? Math.max(4, Math.abs(a[1] - b[1])) : 30;
      const raw = d.top0 + (d.y0 - e.clientY) / ppm;
      const h = Math.round((raw - w.sill) / CREST_STEP) * CREST_STEP;
      d.top = w.sill + Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h));
      if (Math.abs(e.clientY - d.y0) > 3) d.moved = true;
      this.preview();
      return;
    }
    const p = this.host.pick(e.clientX, e.clientY);
    if (!p) return;
    if (d.kind === 'end') {
      // Along the wall's own line only: lengthen or shorten, never turn it.
      const w = this.weirNow();
      if (!w) return;
      const [a, b] = w.ends;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const ux = (b[0] - a[0]) / len;
      const uy = (b[1] - a[1]) / len;
      const t = Math.round(((p.x - a[0]) * ux + (p.y - a[1]) * uy) * 2) / 2;
      d.at = [a[0] + ux * t, a[1] + uy * t];
    } else d.at = [Math.round(p.x), Math.round(p.y)];
    this.preview();
  }

  private dragEnd(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (d.kind !== 'height') this.dragMove(e);
    this.drag = null;
    const s = this.selected;
    if (!s || s.id !== d.id) {
      this.ghosts(false);
      return;
    }
    if (d.kind === 'height') {
      const w = this.weirNow();
      if (w && d.moved && Math.abs(d.top - w.top) > 0.005) this.send(d.id, w.ends, d.top);
      return;
    }
    if (d.kind === 'end') {
      const w = this.weirNow();
      if (!w) return;
      const ends: [Pt, Pt] = [w.ends[0], w.ends[1]];
      ends[d.end] = d.at;
      if (Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]) < 2) return; // too short: keep it as it was
      if (near(ends[0], w.ends[0]) && near(ends[1], w.ends[1])) return;
      this.send(d.id, ends, w.top);
      return;
    }
    // A pump or wheel moved: taken down and placed anew (the crew builds it).
    this.ghosts(true);
    this.note.textContent = '';
    if (!d.ok) return;
    if (s.kind === 'pump') {
      const p = this.pumpInfo();
      if (!p || (p.ox === d.at[0] && p.oy === d.at[1])) return;
      this.host.command({ type: 'removeStructure', kind: 'pump', id: p.id });
      this.host.command({ type: 'placePump', points: [[p.x, p.y], d.at] });
      this.reselect = { kind: 'pump', x: p.x, y: p.y, at: performance.now() };
    } else if (s.kind === 'wheel') {
      const w = this.info('wheel');
      if (!w || (w.x2 === d.at[0] && w.y2 === d.at[1])) return;
      this.host.command({ type: 'removeStructure', kind: 'wheel', id: w.id });
      this.host.command({ type: 'placeWheel', points: [[w.x, w.y], d.at] });
      this.reselect = { kind: 'wheel', x: w.x, y: w.y, at: performance.now() };
    }
  }

  private dragCancel(): void {
    this.drag = null;
    this.ghosts(!!this.pending);
  }

  /** The ghost of what the drag would make: the weir as it will stand, the pump or wheel in its new place. */
  private preview(): void {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'route') {
      const m = this.host.mirror;
      const depth = this.host.depth;
      if (!depth) return;
      const allowed = (i: number) => m.isRevealed(i % m.width, (i / m.width) | 0);
      if (this.selected?.kind === 'pump') {
        const p = this.pumpInfo();
        if (!p) return;
        const site = pumpSite({ width: m.width, height: m.height, terrain: (i) => m.terrain(i), depth, allowed }, [[p.x, p.y], d.at]);
        d.ok = !!site?.ok;
        this.host.setPowerGhost?.(site ? { poles: [], wires: [], pump: { id: -1, x: site.x, y: site.y, hx: site.hx, hy: site.hy, ox: site.ox, oy: site.oy, progress: 1, flow: 0, power: 0 } } : null, d.ok);
        this.note.textContent = site?.ok ? `lifts ${Math.max(0, site.lift).toFixed(1)} m` : (site?.reason ?? '');
      } else {
        const w = this.info('wheel');
        const speed = this.host.speed;
        if (!w || !speed) return;
        const site = wheelSite({ width: m.width, height: m.height, terrain: (i) => m.terrain(i), depth, speed, allowed }, [[w.x, w.y], d.at]);
        d.ok = !!site?.ok;
        const flat = site && site.hx === site.x && site.hy === site.y;
        this.host.setWheelGhost?.(site ? { x: site.x, y: site.y, hx: flat ? d.at[0] : site.hx, hy: flat ? d.at[1] : site.hy } : null, d.ok);
        this.note.textContent = site?.ok ? `lifts ${site.lift.toFixed(1)} m` : (site?.reason ?? '');
      }
      return;
    }
    const w = this.weirNow();
    if (!w) return;
    const ends: [Pt, Pt] = [w.ends[0], w.ends[1]];
    let top = w.top;
    if (d.kind === 'end') ends[d.end] = d.at;
    else top = d.top;
    this.note.textContent = `crest ${fmt(top - w.sill)}`;
    // (The handle's label follows at once, not only with the next frame.)
    this.heightHandle.textContent = fmt(top - w.sill);
    this.host.setWeirGhost?.([weirGhost(ends, top, w.sill)]);
  }

  // ---------------------------------------------------------------------------
  // Drawing

  /** Work out and show what the selected turbine, pole or pump does now (a few times a second). */
  private showPower(kind: 'turbine' | 'pole' | 'pump', id: number): void {
    const now = performance.now();
    if (now - this.powerAt < 250) return;
    this.powerAt = now;
    const info = this.host.power();
    const r = info ? powerReadout(info, this.host.buildings?.() ?? [], this.host.surface ?? (() => 0), kind, id) : null;
    this.readout = r;
    const html = r ? readoutHtml(r, kind) : '';
    const sig = `${r?.running}|${html}`;
    if (sig === this.powerSig) return;
    this.powerSig = sig;
    this.powerBox.hidden = !r;
    this.powerBox.classList.toggle('running', !!r?.running);
    this.powerBox.classList.toggle('idle', !!r && !r.running && r.building === undefined);
    this.powerBox.innerHTML = html;
  }

  private place(el: HTMLElement, p: [number, number] | null): void {
    el.hidden = !p;
    if (p) el.style.transform = `translate(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px)`;
  }

  /** The bubble: centred above `p` (client px), or below it near the top of the screen; kept on screen. */
  private placeBubble(p: [number, number] | null, lift: number): void {
    const el = this.panel;
    if (!p) {
      el.style.visibility = 'hidden';
      return;
    }
    el.style.visibility = '';
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const x = Math.max(6, Math.min(window.innerWidth - w - 6, p[0] - w / 2));
    let y = p[1] - lift - h;
    if (y < 70) y = p[1] + lift;
    y = Math.min(window.innerHeight - h - 6, y);
    el.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
  }

  private frame(): void {
    const s = this.selected;
    if (!s) return;
    const t = this.targets().find((o) => o.kind === s.kind && o.id === s.id);
    if (!t) return;
    if (s.kind === 'turbine' || s.kind === 'pole' || s.kind === 'pump') this.showPower(s.kind, s.id);
    const pr = this.host.project;
    this.svg.style.display = '';
    const d = this.drag;
    if (s.kind === 'weir') {
      const w = this.weirNow();
      if (!w) return;
      const ends: [Pt, Pt] = [w.ends[0], w.ends[1]];
      let top = w.top;
      if (d?.kind === 'end') ends[d.end] = d.at;
      if (d?.kind === 'height') top = d.top;
      // The pending edit stays shown as a ghost until the snapshot has it.
      if (!d) this.host.setWeirGhost?.(this.pending ? [weirGhost(ends, top, w.sill)] : []);
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
      [a, b].forEach((p, k) => this.place(this.handles[k]!, p));
      const mx = (ends[0][0] + ends[1][0]) / 2;
      const my = (ends[0][1] + ends[1][1]) / 2;
      const c = this.host.projectAt?.(mx, my, top) ?? pr(mx, my);
      this.place(this.heightHandle, c);
      const label = fmt(top - w.sill);
      if (this.heightHandle.textContent !== label) this.heightHandle.textContent = label;
      this.routeHandle.hidden = true;
      this.placeBubble(c, 34);
      return;
    }
    for (const h of this.handles) h.hidden = true;
    this.heightHandle.hidden = true;
    this.line.style.display = 'none';
    const p = pr(t.x, t.y);
    this.ring.style.display = p ? '' : 'none';
    if (p) {
      this.ring.setAttribute('cx', p[0].toFixed(1));
      this.ring.setAttribute('cy', p[1].toFixed(1));
    }
    // A pump's outlet and a wheel's trough end can be moved.
    let route: Pt | null = null;
    if (s.kind === 'pump') {
      const pu = this.pumpInfo();
      if (pu) route = d?.kind === 'route' ? d.at : [pu.ox, pu.oy];
    } else if (s.kind === 'wheel') {
      const w = this.info('wheel');
      if (w && w.x2 !== undefined && w.y2 !== undefined) route = d?.kind === 'route' ? d.at : [w.x2, w.y2];
    }
    this.place(this.routeHandle, route ? pr(route[0], route[1]) : null);
    this.routeHandle.classList.toggle('bad', d?.kind === 'route' && !d.ok);
    this.placeBubble(p, 28);
  }
}

/** A weir as the ghost shows it. */
function weirGhost(ends: [Pt, Pt], top: number, sill: number): StructureInfo {
  return {
    id: -1,
    kind: 'weir',
    x: ends[0][0],
    y: ends[0][1],
    x2: ends[1][0],
    y2: ends[1][1],
    rot: Math.atan2(ends[1][1] - ends[0][1], ends[1][0] - ends[0][0]),
    width: Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]),
    top,
    sill,
    open: false,
    progress: 1,
  };
}

/** A height in metres, short: "1.5 m", "1.75 m". */
function fmt(h: number): string {
  return `${h.toFixed(2).replace(/0$/, '')} m`;
}

const HOUSE_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6 6 1.5 11 6V11H1Z"/><rect class="win" x="4.6" y="6.2" width="2.8" height="2.6"/></svg>';
const RUNNER_ICON =
  '<svg class="pw-runner" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke-width="2"/><path d="M10 2.5V17.5M3.5 6.2 16.5 13.8M3.5 13.8 16.5 6.2" stroke-width="1.6"/></svg>';

/** The readout's HTML: a gauge with the runner (turning or still), the houses lit, and a line of text. */
function readoutHtml(r: Readout, kind: string): string {
  if (r.building !== undefined) return `<div class="pw-text">${r.text}</div>`;
  const parts: string[] = [];
  if (r.gauge !== undefined) {
    const pct = Math.round(Math.max(0, Math.min(1, r.gauge)) * 100);
    parts.push(
      `<div class="pw-top">${kind === 'turbine' ? RUNNER_ICON : ''}<div class="pw-gauge" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span class="pw-fill" style="width:${pct}%"></span><span class="pw-label">${r.gaugeLabel ?? ''}</span></div>${
        r.head !== undefined ? `<span class="pw-head" title="Head: the fall of the water through the wall">↧ ${r.head.toFixed(1)} m</span>` : ''
      }</div>`,
    );
  }
  if (r.houses > 0) {
    const shown = Math.min(r.houses, 12);
    let icons = '';
    for (let k = 0; k < shown; k++) icons += `<i class="pw-house${k < Math.round((r.lit * shown) / r.houses) ? ' lit' : ''}">${HOUSE_ICON}</i>`;
    if (r.houses > shown) icons += `<span class="pw-more">+${r.houses - shown}</span>`;
    parts.push(`<div class="pw-houses" title="${r.lit} of ${r.houses} houses lit">${icons}</div>`);
  }
  parts.push(`<div class="pw-text">${r.text}</div>`);
  return parts.join('');
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
