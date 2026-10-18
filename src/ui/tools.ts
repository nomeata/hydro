/**
 * Tool palette and drawing interaction. Tools only create *plans*; the
 * builders realise them over time. While a drawing tool is active, one
 * finger / the left mouse button draws, and two fingers still pan and zoom.
 * Each tool's hint says which problem of the land it solves (GAMEPLAY.md
 * §3). Sluice gates are worked by the villagers (sim/structures/gatekeeper.ts),
 * not by the player.
 */
import type { Command, Pt } from '../shared/protocol';
import { planDike, planLevel, planTrench, rasterisePath, type PlanGrid } from '../sim/plans/plans';
import type { WorldMirror } from '../client/mirror';
import { ICONS } from './icons';
import { isUnlocked, unlockPopulation } from '../shared/unlocks';
import { toolName } from '../shared/progress';

export type ToolId = 'look' | 'trench' | 'dike' | 'level' | 'weir' | 'gate' | 'erase';

export interface ToolHost {
  canvas: HTMLCanvasElement;
  mirror: WorldMirror;
  pick(clientX: number, clientY: number): { x: number; y: number } | null;
  setPreviewPlan(cells: Float32Array | null): void;
  /** Optimistic lining preview (cell indices), or null. */
  setPreviewLining?(cells: readonly number[] | null): void;
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
  {
    id: 'trench',
    label: 'Trench',
    icon: ICONS.trench,
    hint: 'Dig from the river down to dry land: water follows the trench, fields follow the water. Its floor slopes evenly from start to end.',
  },
  { id: 'dike', label: 'Dike', icon: ICONS.dike, hint: 'Raise a level bank to keep a flood off the fields, or to hold a pond.' },
  { id: 'level', label: 'Level', icon: ICONS.level, hint: 'Flatten a slope into a terrace or a basin, at the height where you start.' },
  // No lining tool: villagers line the banks near their homes (planLining stays a command for scenes and tests).
  {
    id: 'weir',
    label: toolName('weir'),
    icon: ICONS.weir,
    hint: 'Draw across a river: it holds a pool through the dry summer and spills over its crest.',
  },
  {
    id: 'gate',
    label: toolName('gate'),
    icon: ICONS.gate,
    hint: 'Tap a dike or weir to put a sluice gate in it. Villagers open it to water their fields in summer; it opens by itself before the water spills over.',
  },
  { id: 'erase', label: 'Remove', icon: ICONS.erase, hint: 'Brush over plans to remove them.' },
];

/** Slider settings per tool: width (cells) and depth/height (m). */
interface ToolSettings {
  width: number;
  amount?: number;
  maxWidth: number;
  amountLabel?: 'Depth' | 'Height';
}

const SETTINGS: Partial<Record<ToolId, ToolSettings>> = {
  trench: { width: 2, amount: 1.5, maxWidth: 8, amountLabel: 'Depth' },
  dike: { width: 2, amount: 2, maxWidth: 8, amountLabel: 'Height' },
  level: { width: 2, maxWidth: 8 },
  weir: { width: 2, amount: 1, maxWidth: 4, amountLabel: 'Height' },
  gate: { width: 1, amount: 2, maxWidth: 3, amountLabel: 'Height' },
};

export class ToolPalette {
  tool: ToolId = 'look';

  private readonly settings = structuredClone(SETTINGS);
  private readonly buttons = new Map<ToolId, HTMLButtonElement>();
  private readonly options: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly sizeOut: HTMLOutputElement;
  private readonly sizeInput: HTMLInputElement;
  private readonly amountOut: HTMLOutputElement;
  private readonly amountLabel: HTMLElement;
  private readonly amountInput: HTMLInputElement;

  private pointers = new Set<number>();
  private drawing: { id: number; points: Pt[] } | null = null;
  private previewPending = false;
  /** Keep the preview until the sim confirms the plan. */
  private awaitingPlan = false;
  /** Highest village population seen (drives tool unlocks). */
  private population = 0;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.sizeInput = this.options.querySelector<HTMLInputElement>('input[data-k=size]')!;
    this.amountInput = this.options.querySelector<HTMLInputElement>('input[data-k=amount]')!;
    this.sizeInput.addEventListener('input', () => {
      const st = this.settings[this.tool];
      if (st) st.width = Number(this.sizeInput.value);
      this.refreshOptions();
    });
    this.amountInput.addEventListener('input', () => {
      const st = this.settings[this.tool];
      if (st && st.amount !== undefined) st.amount = Number(this.amountInput.value);
      this.refreshOptions();
    });

    const row = document.createElement('div');
    row.className = 'toolrow panel';
    TOOLS.forEach((t, k) => {
      const key = hotkey(k);
      const b = document.createElement('button');
      b.innerHTML = `${t.icon}<span>${t.label}</span><i class="lock">${ICONS.lock}</i>${key ? `<kbd class="key">${key}</kbd>` : ''}`;
      b.dataset.tool = t.id;
      b.setAttribute('aria-label', t.label);
      b.addEventListener('click', () => this.select(t.id));
      this.buttons.set(t.id, b);
      row.append(b);
    });
    wrap.append(this.hint, this.options, row);
    root.append(wrap);

    const c = host.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onCancel(e));
    window.addEventListener('keydown', (e) => this.onKey(e));
    this.select('look');
    this.setPopulation(0);
  }

  /** Villagers in all villages (from snapshot stats): unlocks tools at milestones. */
  setPopulation(population: number): void {
    this.population = Math.max(this.population, population);
    for (const [id, b] of this.buttons) {
      const locked = !isUnlocked(id, this.population);
      b.classList.toggle('locked', locked);
      const k = TOOLS.findIndex((t) => t.id === id);
      const key = hotkey(k);
      const name = `${TOOLS[k]!.label}${key ? ` (${key})` : ''}`;
      b.title = locked ? `${name}: unlocks at ${unlockPopulation(id)} villagers` : name;
    }
  }

  /** Keyboard: digits 1…9, 0 pick the tools in palette order; Escape returns to Look. */
  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    // Not while a dialog (welcome panels, history, menu) covers the game.
    if (document.querySelector('dialog[open]')) return;
    for (const d of document.querySelectorAll('[role=dialog]')) if (!d.closest('[hidden]')) return;
    if (e.key === 'Escape') {
      this.select('look');
      return;
    }
    if (!/^[0-9]$/.test(e.key)) return;
    const k = e.key === '0' ? 9 : Number(e.key) - 1;
    const tool = TOOLS[k];
    if (!tool) return;
    e.preventDefault();
    this.select(tool.id);
  }

  isLocked(id: ToolId): boolean {
    return !isUnlocked(id, this.population);
  }

  /** Current width (cells) of the selected tool. */
  get width(): number {
    return this.settings[this.tool]?.width ?? 2;
  }

  /** Current depth/height (m) of the selected tool. */
  get amount(): number {
    return this.settings[this.tool]?.amount ?? 0;
  }

  select(id: ToolId): void {
    if (this.isLocked(id)) {
      // A locked tool only says when it will be ready.
      this.hint.textContent = `Unlocks at ${unlockPopulation(id)} villagers`;
      if (this.hintTimer) clearTimeout(this.hintTimer);
      this.hintTimer = setTimeout(() => {
        this.hintTimer = null;
        this.hint.textContent = TOOLS.find((t) => t.id === this.tool)!.hint;
      }, 2500);
      return;
    }
    this.tool = id;
    this.drawing = null;
    for (const [k, b] of this.buttons) b.setAttribute('aria-pressed', String(k === id));
    const st = this.settings[id];
    this.options.hidden = !st;
    this.amountInput.closest('label')!.hidden = st?.amount === undefined;
    this.hint.textContent = TOOLS.find((t) => t.id === id)!.hint;
    this.host.setCameraPrimaryPointer(id === 'look');
    if (!this.awaitingPlan) this.clearPreview();
    if (st) {
      this.sizeInput.max = String(st.maxWidth);
      this.sizeInput.value = String(st.width);
      if (st.amount !== undefined) this.amountInput.value = String(st.amount);
    }
    this.refreshOptions();
  }

  private refreshOptions(): void {
    const st = this.settings[this.tool];
    const w = this.width;
    this.sizeOut.textContent = this.tool === 'gate' ? `${w} cell${w > 1 ? 's' : ''}` : `${w * 5} m`;
    this.amountLabel.textContent = st?.amountLabel ?? 'Depth';
    this.amountOut.textContent = `${this.amount} m`;
  }

  private clearPreview(): void {
    this.host.setPreviewPlan(null);
    this.host.setPreviewLining?.(null);
  }

  /** Called when a snapshot with a new plan (or lining) arrives. */
  planUpdated(): void {
    if (this.awaitingPlan && !this.drawing) {
      this.awaitingPlan = false;
      this.clearPreview();
    }
  }

  private onDown(e: PointerEvent): void {
    this.pointers.add(e.pointerId);
    if (this.tool === 'look') return;
    if (this.pointers.size > 1) {
      // Second finger: this is a pan/zoom gesture, abandon the stroke.
      this.drawing = null;
      if (!this.awaitingPlan) this.clearPreview();
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
    if (this.tool === 'look') return;
    const d = this.drawing;
    if (!d || d.id !== e.pointerId) return;
    this.drawing = null;
    const points = simplify(d.points);
    const ends: Pt[] = [points[0]!, points[points.length - 1]!];
    const width = this.width;
    const amount = this.amount;
    let cmd: Command | null = null;
    switch (this.tool) {
      case 'trench':
        cmd = { type: 'planTrench', points, width, depth: amount };
        break;
      case 'dike':
        cmd = { type: 'planDike', points, width, height: amount };
        break;
      case 'level':
        cmd = { type: 'planLevel', points, width };
        break;
      case 'weir':
        cmd = { type: 'planWeir', points: ends, width, height: amount };
        break;
      case 'gate':
        cmd = { type: 'placeGate', points: ends, width, height: amount };
        break;
    }
    if (cmd) {
      this.host.command(cmd);
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
      if (!this.awaitingPlan) this.clearPreview();
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
      const ends: Pt[] = [pts[0]!, pts[pts.length - 1]!];
      const width = this.width;
      const amount = this.amount;
      let lining: number[] | null = null;
      if (this.tool === 'trench') planTrench(grid, pts, width, amount);
      else if (this.tool === 'dike') planDike(grid, pts, width, amount);
      else if (this.tool === 'level') planLevel(grid, pts, width);
      else if (this.tool === 'weir') {
        planDike(grid, ends, width, amount);
        lining = [...rasterisePath(grid, ends, width / 2 + 1).keys()];
      } else if (this.tool === 'gate' && Math.hypot(ends[1]![0] - ends[0]![0], ends[1]![1] - ends[0]![1]) >= 1.5) {
        // Drawn across a channel: a dam with the gate at its lowest point (a tap previews nothing).
        planDike(grid, ends, 2, amount);
      }
      // Plans only go on known land (the sim drops the rest too).
      const m = this.host.mirror;
      m.maskUnrevealed(grid.plan);
      if (lining) lining = lining.filter((i) => m.isRevealed(i % m.width, (i / m.width) | 0));
      this.host.setPreviewPlan(grid.plan);
      this.host.setPreviewLining?.(lining);
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

/** Hotkey for the k-th tool: 1…9, then 0 (none beyond the tenth). */
function hotkey(k: number): string | null {
  return k < 9 ? String(k + 1) : k === 9 ? '0' : null;
}
