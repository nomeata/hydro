/**
 * Tool palette and drawing interaction. Tools only create *plans*; the
 * builders realise them over time. While a drawing tool is active, one
 * finger / the left mouse button draws, and two fingers still pan and zoom.
 */
import type { Command, Pt } from '../shared/protocol';
import { planDike, planTrench, type PlanGrid } from '../sim/plans/plans';
import type { WorldMirror } from '../client/mirror';
import { ICONS } from './icons';

export type ToolId = 'look' | 'trench' | 'dike' | 'erase';

export interface ToolHost {
  canvas: HTMLCanvasElement;
  mirror: WorldMirror;
  pick(clientX: number, clientY: number): { x: number; y: number } | null;
  setPreviewPlan(cells: Float32Array | null): void;
  /** Whether single-pointer drags pan the camera. */
  setCameraPrimaryPointer(enabled: boolean): void;
  command(cmd: Command): void;
}

interface ToolDef {
  id: ToolId;
  label: string;
  icon: string;
  hint: string;
}

const TOOLS: ToolDef[] = [
  { id: 'look', label: 'Look', icon: ICONS.hand, hint: '' },
  { id: 'trench', label: 'Trench', icon: ICONS.trench, hint: 'Draw a trench. Its floor slopes evenly from start to end.' },
  { id: 'dike', label: 'Dike', icon: ICONS.dike, hint: 'Draw a dike. Its crest is level.' },
  { id: 'erase', label: 'Remove', icon: ICONS.erase, hint: 'Brush over plans to remove them.' },
];

export class ToolPalette {
  tool: ToolId = 'look';
  width = 2;
  depth = 1.5;
  height = 2;

  private readonly buttons = new Map<ToolId, HTMLButtonElement>();
  private readonly options: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly sizeOut: HTMLOutputElement;
  private readonly amountOut: HTMLOutputElement;
  private readonly amountLabel: HTMLElement;
  private readonly amountInput: HTMLInputElement;

  private pointers = new Set<number>();
  private drawing: { id: number; points: Pt[] } | null = null;
  private previewPending = false;
  /** Keep the preview until the sim confirms the plan. */
  private awaitingPlan = false;

  constructor(
    root: HTMLElement,
    private readonly host: ToolHost,
  ) {
    const wrap = document.createElement('div');
    wrap.className = 'tools';

    this.hint = document.createElement('div');
    this.hint.className = 'hint';

    this.options = document.createElement('div');
    this.options.className = 'options panel';
    this.options.hidden = true;
    this.options.innerHTML = `
      <label>Width <output data-k="size"></output><input type="range" min="1" max="8" step="1" data-k="size"></label>
      <label><span data-k="amountLabel">Depth</span> <output data-k="amount"></output><input type="range" min="0.5" max="6" step="0.5" data-k="amount"></label>`;
    this.sizeOut = this.options.querySelector('output[data-k=size]')!;
    this.amountOut = this.options.querySelector('output[data-k=amount]')!;
    this.amountLabel = this.options.querySelector('[data-k=amountLabel]')!;
    const sizeIn = this.options.querySelector<HTMLInputElement>('input[data-k=size]')!;
    this.amountInput = this.options.querySelector<HTMLInputElement>('input[data-k=amount]')!;
    sizeIn.value = String(this.width);
    sizeIn.addEventListener('input', () => {
      this.width = Number(sizeIn.value);
      this.refreshOptions();
    });
    this.amountInput.addEventListener('input', () => {
      if (this.tool === 'dike') this.height = Number(this.amountInput.value);
      else this.depth = Number(this.amountInput.value);
      this.refreshOptions();
    });

    const row = document.createElement('div');
    row.className = 'toolrow panel';
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.innerHTML = `${t.icon}<span>${t.label}</span>`;
      b.dataset.tool = t.id;
      b.setAttribute('aria-label', t.label);
      b.addEventListener('click', () => this.select(t.id));
      this.buttons.set(t.id, b);
      row.append(b);
    }
    wrap.append(this.hint, this.options, row);
    root.append(wrap);

    const c = host.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onCancel(e));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.select('look');
    });
    this.select('look');
  }

  select(id: ToolId): void {
    this.tool = id;
    this.drawing = null;
    for (const [k, b] of this.buttons) b.setAttribute('aria-pressed', String(k === id));
    this.options.hidden = id !== 'trench' && id !== 'dike';
    this.hint.textContent = TOOLS.find((t) => t.id === id)!.hint;
    this.host.setCameraPrimaryPointer(id === 'look');
    if (!this.awaitingPlan) this.host.setPreviewPlan(null);
    this.amountInput.value = String(id === 'dike' ? this.height : this.depth);
    this.refreshOptions();
  }

  private refreshOptions(): void {
    this.sizeOut.textContent = `${this.width * 5} m`;
    this.amountLabel.textContent = this.tool === 'dike' ? 'Height' : 'Depth';
    this.amountOut.textContent = `${this.tool === 'dike' ? this.height : this.depth} m`;
  }

  /** Called when a snapshot with a new plan arrives. */
  planUpdated(): void {
    if (this.awaitingPlan && !this.drawing) {
      this.awaitingPlan = false;
      this.host.setPreviewPlan(null);
    }
  }

  private onDown(e: PointerEvent): void {
    this.pointers.add(e.pointerId);
    if (this.tool === 'look') return;
    if (this.pointers.size > 1) {
      // Second finger: this is a pan/zoom gesture, abandon the stroke.
      this.drawing = null;
      if (!this.awaitingPlan) this.host.setPreviewPlan(null);
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = this.host.pick(e.clientX, e.clientY);
    if (!p) return;
    this.drawing = { id: e.pointerId, points: [[p.x, p.y]] };
    if (this.tool === 'erase') this.erase(p.x, p.y);
    else this.schedulePreview();
  }

  private onMove(e: PointerEvent): void {
    const d = this.drawing;
    if (!d || d.id !== e.pointerId) return;
    const p = this.host.pick(e.clientX, e.clientY);
    if (!p) return;
    const last = d.points[d.points.length - 1]!;
    if (Math.hypot(p.x - last[0], p.y - last[1]) < 0.75) return;
    d.points.push([p.x, p.y]);
    if (this.tool === 'erase') this.erase(p.x, p.y);
    else this.schedulePreview();
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    const d = this.drawing;
    if (!d || d.id !== e.pointerId) return;
    this.drawing = null;
    if (this.tool === 'trench') {
      this.host.command({ type: 'planTrench', points: simplify(d.points), width: this.width, depth: this.depth });
      this.awaitingPlan = true;
    } else if (this.tool === 'dike') {
      this.host.command({ type: 'planDike', points: simplify(d.points), width: this.width, height: this.height });
      this.awaitingPlan = true;
    }
    // One stroke per tool use: go back to looking around, so a stray touch
    // never places a second plan.
    this.select('look');
  }

  private onCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.drawing?.id === e.pointerId) {
      this.drawing = null;
      if (!this.awaitingPlan) this.host.setPreviewPlan(null);
    }
  }

  private erase(x: number, y: number): void {
    this.host.command({ type: 'cancelPlan', x, y, radius: 2 });
  }

  private schedulePreview(): void {
    if (this.previewPending) return;
    this.previewPending = true;
    requestAnimationFrame(() => {
      this.previewPending = false;
      const d = this.drawing;
      if (!d) return;
      const grid: PlanGrid = this.host.mirror.previewGrid();
      const pts = simplify(d.points);
      if (this.tool === 'trench') planTrench(grid, pts, this.width, this.depth);
      else if (this.tool === 'dike') planDike(grid, pts, this.width, this.height);
      this.host.setPreviewPlan(grid.plan);
    });
  }
}

/** Drop points closer than one cell to the previous kept point. */
function simplify(points: Pt[]): Pt[] {
  if (points.length <= 2) return points.slice();
  const out: Pt[] = [points[0]!];
  for (let k = 1; k < points.length - 1; k++) {
    const a = out[out.length - 1]!;
    const p = points[k]!;
    if (Math.hypot(p[0] - a[0], p[1] - a[1]) >= 1.5) out.push(p);
  }
  out.push(points[points.length - 1]!);
  return out;
}
