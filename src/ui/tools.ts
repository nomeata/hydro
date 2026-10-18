/**
 * Tool palette and drawing interaction. The three sculpting brushes (Raise,
 * Dig, Even) change the ground at once while the pointer is held (the sim
 * applies it, the client predicts it: client/sculptor.ts); they stay
 * selected. The structure tools place *plans* the crew builds, one per use.
 * While a tool is active, one finger / the left mouse button draws or
 * brushes, and two fingers still pan and zoom.
 * Each tool's hint says which problem of the land it solves (GAMEPLAY.md
 * §3). Sluice gates are worked by the villagers (sim/structures/gatekeeper.ts),
 * not by the player.
 */
import type { Command, Pt } from '../shared/protocol';
import { planWeirPreview, rasterisePath, weirLowest, type PlanGrid } from '../sim/plans/plans';
import { BRUSH_DEFAULT_SIZE, BRUSH_SIZES } from '../sim/plans/sculpt';
import type { Sculptor } from '../client/sculptor';
import type { BrushTool } from '../shared/protocol';
import type { WorldMirror } from '../client/mirror';
import { ICONS } from './icons';
import { isUnlocked, unlockPopulation } from '../shared/unlocks';
import { wheelSite, wheelSites, type WheelGrid, type WheelSite } from '../sim/structures/wheel';
import { polePositions, pumpSite, turbineSite, type PowerGrid2D, type PumpSite, type TurbineSite } from '../sim/power/power';
import { toolName } from '../shared/progress';

export type ToolId = 'look' | BrushTool | 'weir' | 'gate' | 'wheel' | 'power' | 'erase';

const BRUSHES: readonly ToolId[] = ['raise', 'dig', 'even'];
export function isBrush(id: ToolId): id is BrushTool {
  return BRUSHES.includes(id);
}

/** Touch: wait this long before the brush bites, so a second finger (pan, zoom) can still come (ms). */
const TOUCH_DELAY = 90;

/**
 * The power tools share one palette button (so the palette stays one row
 * on a phone); the options line picks the turbine, the power line or the
 * electric pump. Each unlocks on its own (src/shared/unlocks.ts).
 */
export type PowerMode = 'turbine' | 'poles' | 'pump';

interface ModeDef {
  id: PowerMode;
  icon: string;
  hint: string;
}

const POWER_MODES: ModeDef[] = [
  {
    id: 'turbine',
    icon: ICONS.turbine,
    hint: 'Light for the village: tap the crest of a weir or dam. The water falling through it turns a turbine, and the houses near it light up.',
  },
  {
    id: 'poles',
    icon: ICONS.pole,
    hint: 'The village too far from the turbine? Draw a line of poles from it to the houses: every house near a pole gets light.',
  },
  {
    id: 'pump',
    icon: ICONS.pump,
    hint: 'Water up onto a plateau or into a high basin: draw from the water to where it should go. It runs on the turbines’ spare power; a turbine below a pumped basin gives it back in the evening.',
  },
];

export interface ToolHost {
  canvas: HTMLCanvasElement;
  mirror: WorldMirror;
  pick(clientX: number, clientY: number): { x: number; y: number } | null;
  setPreviewPlan(cells: Float32Array | null): void;
  /** Optimistic lining preview (cell indices), or null. */
  setPreviewLining?(cells: readonly number[] | null): void;
  /**
   * Tool cards (ui/toolCards.ts): whether `tool` (a palette tool or a power
   * mode) has one, whether it should still be shown after its unlock, and show it.
   */
  hasCard?(tool: string): boolean;
  cardDue?(tool: string): boolean;
  showCard?(tool: string): void;
  /** Water depth (m) at cell i of the latest snapshot (the wheel's preview). */
  depth?(i: number): number;
  /** Speed of the water (m/s) at cell i of the latest snapshot (the wheel's preview). */
  speed?(i: number): number;
  /** The wheel tool's ghost wheel (good site or not), or none; and the good sites it marks on the map. */
  setWheelGhost?(site: { x: number; y: number; hx: number; hy: number } | null, ok: boolean): void;
  setWheelSites?(sites: readonly { x: number; y: number; hx: number; hy: number }[] | null): void;
  /** Whether single-pointer drags pan the camera. */
  setCameraPrimaryPointer(enabled: boolean): void;
  /**
   * A tap on the canvas (Look mode, or the weir tool tapping a weir): select
   * what is there (ui/selection.ts). Returns whether something was selected.
   */
  tap?(clientX: number, clientY: number, only?: 'weir'): boolean;
  /** A tool was picked: close the selection. */
  deselect?(): void;
  command(cmd: Command): void;
  /** The brushes' prediction and sending (client/sculptor.ts). */
  sculptor?: Sculptor;
  /** The brush's ring under the pointer, or none. */
  setBrushCursor?(c: { x: number; y: number; r: number; tool: BrushTool; active: boolean } | null): void;
  /** The brush worked around (x, y) this frame (the cosmetic crew comes to look). */
  brushed?(x: number, y: number, r: number): void;
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
    id: 'raise',
    label: 'Raise',
    icon: ICONS.raise,
    hint: 'Hold to heap up earth: a bank to keep a flood off the fields, or to hold a pond. Make it high enough: water pouring over loose earth cuts through it. Across a river, build a weir.',
  },
  {
    id: 'dig',
    label: 'Dig',
    icon: ICONS.dig,
    hint: 'Hold to dig: brush a channel from the river down to dry land and the water follows; fields follow the water. A rough channel smooths itself once water runs in it.',
  },
  {
    id: 'even',
    label: 'Even',
    icon: ICONS.even,
    hint: 'Brush to smooth the ground towards its mean: level a terrace or a basin, round off a bank, fill a ditch. Brush again to make it flatter.',
  },
  // No lining tool: villagers line the banks near their homes (planLining stays a command for scenes and tests).
  {
    id: 'weir',
    label: toolName('weir'),
    icon: ICONS.weir,
    hint: 'Draw across a river: a stone wall (up to 4 m) that the water may flow over. It holds the pool at its crest all summer and spills the rest safely, where a mill can use the fall. Tap a weir to change it.',
  },
  {
    id: 'gate',
    label: toolName('gate'),
    icon: ICONS.gate,
    hint: 'Tap a weir or a bank to put a sluice gate in it, or draw across a channel for a wall with a gate. Villagers open it to water their fields in summer; it opens by itself before the water spills over.',
  },
  {
    id: 'wheel',
    label: toolName('wheel'),
    icon: ICONS.wheel,
    hint: 'A noria lifts the river up to fields on the terrace: draw from quick water (the gold rings: main channel, narrows, below a weir) onto the bank. Higher bank, bigger wheel, less water.',
  },
  { id: 'power', label: toolName('power'), icon: ICONS.turbine, hint: '' },
  {
    id: 'erase',
    label: 'Remove',
    icon: ICONS.erase,
    hint: 'Brush over anything built to take it away: the crew takes down weirs, gates and wheels. Or tap a single thing in Look mode and press Remove.',
  },
];

/** Slider settings per tool: width (cells; none for the weir, whose shape follows from its height) and depth/height (m). */
interface ToolSettings {
  width: number;
  noWidth?: boolean;
  amount?: number;
  maxWidth: number;
  amountLabel?: 'Depth' | 'Height';
  maxAmount?: number;
}

const SETTINGS: Partial<Record<ToolId, ToolSettings>> = {
  weir: { width: 2, amount: 1.5, maxWidth: 2, amountLabel: 'Height', noWidth: true, maxAmount: 4 },
  gate: { width: 1, amount: 2, maxWidth: 3, amountLabel: 'Height' },
};

export class ToolPalette {
  tool: ToolId = 'look';

  private readonly settings = structuredClone(SETTINGS);
  private readonly buttons = new Map<ToolId, HTMLButtonElement>();
  private readonly options: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly hintText: HTMLElement;
  private readonly hintInfo: HTMLButtonElement;
  /** A tool (or power mode) just unlocked whose card shows at the next pick. */
  private cardPending: string | null = null;
  /** The power tool's current mode, and its buttons on the options line. */
  mode: PowerMode = 'turbine';
  private readonly modes: HTMLElement;
  private readonly modeButtons = new Map<PowerMode, HTMLButtonElement>();
  private readonly sizeOut: HTMLOutputElement;
  private readonly sizeInput: HTMLInputElement;
  private readonly amountOut: HTMLOutputElement;
  private readonly amountLabel: HTMLElement;
  private readonly amountInput: HTMLInputElement;
  /** The brushes' options line: sizes and Undo. */
  private readonly brushRow: HTMLElement;
  private readonly sizeButtons: HTMLButtonElement[] = [];
  private readonly undoButton: HTMLButtonElement;
  /** Index into BRUSH_SIZES. */
  brushSize = BRUSH_DEFAULT_SIZE;
  /** The stroke being brushed: pointer, where it is on screen, the last ground point and time. */
  private brush: { id: number; cx: number; cy: number; at: { x: number; y: number } | null; t: number; start: number; touch: boolean } | null = null;
  private brushRaf = 0;
  /** Where the mouse hovers with a brush (the ring), in client pixels. */
  private hover: { x: number; y: number } | null = null;

  private pointers = new Set<number>();
  /** A possible tap in Look mode: where and when the pointer went down. */
  private tap: { id: number; x: number; y: number } | null = null;
  /** The tools' column (the selection panel goes in above the palette). */
  private readonly wrap: HTMLElement;
  private drawing: { id: number; points: Pt[] } | null = null;
  private previewPending = false;
  /** The last preview left out a house or a footbridge. */
  private housesSkipped = false;
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
    this.wrap = wrap;

    this.hint = document.createElement('div');
    this.hint.className = 'hint';
    this.hint.hidden = true;
    this.hintText = document.createElement('span');
    this.hintInfo = document.createElement('button');
    this.hintInfo.className = 'hint-info';
    this.hintInfo.textContent = 'ⓘ';
    this.hintInfo.hidden = true;
    this.hintInfo.addEventListener('click', () => this.host.showCard?.(this.tool));
    this.hint.append(this.hintText, this.hintInfo);

    this.options = document.createElement('div');
    this.options.className = 'options panel';
    this.options.hidden = true;
    this.options.innerHTML = `
      <label>Width <output data-k="size"></output><input type="range" min="1" max="8" step="1" data-k="size"></label>
      <label><span data-k="amountLabel">Depth</span> <output data-k="amount"></output><input type="range" min="0.5" max="6" step="0.5" data-k="amount"></label>`;
    this.modes = document.createElement('div');
    this.modes.className = 'modes';
    for (const m of POWER_MODES) {
      const b = document.createElement('button');
      b.dataset.mode = m.id;
      b.innerHTML = `${m.icon}<span>${toolName(m.id)}</span><i class="lock">${ICONS.lock}</i>`;
      b.addEventListener('click', () => this.selectMode(m.id));
      this.modeButtons.set(m.id, b);
      this.modes.append(b);
    }
    this.options.prepend(this.modes);
    this.brushRow = document.createElement('div');
    this.brushRow.className = 'brushes';
    BRUSH_SIZES.forEach((r, k) => {
      const b = document.createElement('button');
      b.dataset.size = String(k);
      const d = 6 + k * 5;
      b.innerHTML = `<i class="dot" style="width:${d}px;height:${d}px"></i><span>${['Small', 'Medium', 'Large'][k] ?? r}</span>`;
      b.title = `Brush ${Math.round(r * 2 * 5)} m across`;
      b.addEventListener('click', () => this.setBrushSize(k));
      this.sizeButtons.push(b);
      this.brushRow.append(b);
    });
    this.undoButton = document.createElement('button');
    this.undoButton.className = 'undo';
    this.undoButton.dataset.testid = 'undo';
    this.undoButton.innerHTML = `${ICONS.undo}<span>Undo</span>`;
    this.undoButton.title = 'Undo the last stroke (Ctrl+Z)';
    this.undoButton.addEventListener('click', () => this.undo());
    this.brushRow.append(this.undoButton);
    this.options.prepend(this.brushRow);
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
    c.addEventListener('pointerleave', () => {
      this.hover = null;
      if (!this.brush) this.host.setBrushCursor?.(null);
    });
    this.select('look');
    this.setPopulation(0);
    this.setBrushSize(this.brushSize);
  }

  /** Pick a brush size (index into BRUSH_SIZES). */
  setBrushSize(k: number): void {
    this.brushSize = Math.max(0, Math.min(BRUSH_SIZES.length - 1, k));
    this.sizeButtons.forEach((b, j) => b.setAttribute('aria-pressed', String(j === this.brushSize)));
  }

  /** The brush radius (cells). */
  get brushRadius(): number {
    return BRUSH_SIZES[this.brushSize]!;
  }

  /** Undo the last sculpt stroke. */
  undo(): void {
    const sc = this.host.sculptor;
    if (!sc) return;
    if (this.brush) this.endBrush();
    sc.undo();
    this.refreshUndo();
  }

  /** Enable Undo when there is a stroke to undo (after each snapshot). */
  refreshUndo(): void {
    this.undoButton.disabled = (this.host.sculptor?.undoable ?? 0) <= 0;
  }

  /** Put a panel (the selection's) into the tools' column, above the palette. */
  insertPanel(el: HTMLElement): void {
    this.wrap.insertBefore(el, this.wrap.lastElementChild);
  }

  /** Villagers in all villages (from snapshot stats): unlocks tools at milestones. */
  setPopulation(population: number): void {
    const before = this.population;
    this.population = Math.max(this.population, population);
    for (const id of [...TOOLS.map((t) => t.id as string), ...POWER_MODES.map((m) => m.id)]) {
      const need = unlockPopulation(id);
      if (need > 0 && before < need && this.population >= need && this.host.cardDue?.(id)) this.cardPending = id;
    }
    for (const [id, b] of this.modeButtons) {
      const locked = !isUnlocked(id, this.population);
      b.classList.toggle('locked', locked);
      b.title = locked ? `${toolName(id)}: unlocks at ${unlockPopulation(id)} villagers` : toolName(id);
    }
    for (const [id, b] of this.buttons) {
      const locked = this.isLocked(id);
      b.classList.toggle('locked', locked);
      const k = TOOLS.findIndex((t) => t.id === id);
      const key = hotkey(k);
      const name = `${TOOLS[k]!.label}${key ? ` (${key})` : ''}`;
      b.title = locked ? `${name}: unlocks at ${unlockPopulation(id === 'power' ? 'turbine' : id)} villagers` : name;
    }
  }

  /** Keyboard: digits 1…9, 0 pick the tools in palette order; Escape returns to Look; Ctrl/Cmd+Z undoes the last stroke. */
  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    // Not while a dialog (welcome panels, history, menu) covers the game.
    if (document.querySelector('dialog[open]')) return;
    for (const d of document.querySelectorAll('[role=dialog]')) if (!d.closest('[hidden]')) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      this.undo();
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
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
    return !isUnlocked(id === 'power' ? 'turbine' : id, this.population);
  }

  /** The hint (and card) key of a tool: the power tool's is its mode's. */
  private hintOf(id: ToolId): { text: string; card: string } {
    if (id === 'power') {
      const m = POWER_MODES.find((o) => o.id === this.mode)!;
      return { text: m.hint, card: m.id };
    }
    return { text: TOOLS.find((t) => t.id === id)!.hint, card: id };
  }

  private showHint(id: ToolId): void {
    const h = this.hintOf(id);
    this.setHint(h.text, this.host.hasCard?.(h.card) ?? false);
  }

  /** Pick a power mode (on the options line). */
  selectMode(m: PowerMode): void {
    if (!isUnlocked(m, this.population)) {
      this.flashHint(`Unlocks at ${unlockPopulation(m)} villagers`);
      return;
    }
    this.mode = m;
    for (const [k, b] of this.modeButtons) b.setAttribute('aria-pressed', String(k === m));
    if (this.tool === 'power') this.showHint('power');
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
      this.setHint(`Unlocks at ${unlockPopulation(id === 'power' ? 'turbine' : id)} villagers`, false);
      if (this.hintTimer) clearTimeout(this.hintTimer);
      this.hintTimer = setTimeout(() => {
        this.hintTimer = null;
        this.showHint(this.tool);
      }, 2500);
      return;
    }
    // The first pick after a tool unlocked: its card.
    if (this.cardPending) {
      const t = this.cardPending;
      this.cardPending = null;
      this.host.showCard?.(t);
    }
    this.tool = id;
    this.drawing = null;
    for (const [k, b] of this.buttons) b.setAttribute('aria-pressed', String(k === id));
    const st = this.settings[id];
    // The power tool's options line holds its modes (when there is more than one to pick).
    const modes = id === 'power' && POWER_MODES.length > 1;
    const brush = isBrush(id);
    if (this.brush) this.endBrush(true);
    this.options.hidden = !st && !modes && !brush;
    this.modes.hidden = !modes;
    this.brushRow.hidden = !brush;
    if (!brush) this.host.setBrushCursor?.(null);
    this.refreshUndo();
    this.sizeInput.closest('label')!.hidden = !st || !!st.noWidth;
    this.amountInput.closest('label')!.hidden = st?.amount === undefined;
    if (id === 'power') {
      // Stay with the last mode, unless it is still locked.
      if (!isUnlocked(this.mode, this.population)) this.mode = 'turbine';
      for (const [k, b] of this.modeButtons) b.setAttribute('aria-pressed', String(k === this.mode));
    }
    this.showHint(id);
    this.markWheelSites(id === 'wheel');
    this.host.setCameraPrimaryPointer(id === 'look');
    if (id !== 'look') this.host.deselect?.();
    if (!this.awaitingPlan) this.clearPreview();
    if (st) {
      this.sizeInput.max = String(st.maxWidth);
      this.sizeInput.value = String(st.width);
      if (st.amount !== undefined) {
        this.amountInput.max = String(st.maxAmount ?? 6);
        this.amountInput.value = String(st.amount);
      }
    }
    this.refreshOptions();
  }

  /** The hint line, with an ⓘ to reopen the tool's card. */
  private setHint(text: string, info: boolean): void {
    this.hintText.textContent = text;
    this.hint.hidden = !text;
    this.hintInfo.hidden = !info;
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
    this.host.setWheelGhost?.(null, false);
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
    if (this.tool === 'look') {
      this.tap = this.pointers.size === 1 && (e.pointerType !== 'mouse' || e.button === 0) ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
      return;
    }
    if (this.pointers.size > 1) {
      // Second finger: this is a pan/zoom gesture, abandon the stroke.
      this.drawing = null;
      if (this.brush) this.endBrush(true);
      if (!this.awaitingPlan) this.clearPreview();
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (isBrush(this.tool)) {
      this.startBrush(e);
      return;
    }
    const p = this.host.pick(e.clientX, e.clientY);
    if (!p) return;
    this.drawing = { id: e.pointerId, points: [[p.x, p.y]] };
    this.housesSkipped = false;
    if (this.tool === 'erase') this.erase(p.x, p.y);
    else this.schedulePreview();
  }

  private onMove(e: PointerEvent): void {
    if (this.tap?.id === e.pointerId && Math.hypot(e.clientX - this.tap.x, e.clientY - this.tap.y) > 8) this.tap = null;
    const b = this.brush;
    if (b && b.id === e.pointerId) {
      b.cx = e.clientX;
      b.cy = e.clientY;
      return;
    }
    if (!b && isBrush(this.tool) && e.pointerType === 'mouse' && this.pointers.size === 0) this.hoverBrush(e.clientX, e.clientY);
    const d = this.drawing;
    if (!d && this.tool === 'wheel' && e.pointerType === 'mouse' && this.pointers.size === 0) this.hoverWheel(e.clientX, e.clientY);
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
    if (this.tool === 'look') {
      const t = this.tap;
      this.tap = null;
      // (No time limit: a slow, still press is a tap too.)
      if (t?.id === e.pointerId && Math.hypot(e.clientX - t.x, e.clientY - t.y) <= 8) this.host.tap?.(e.clientX, e.clientY);
      return;
    }
    if (this.brush?.id === e.pointerId) {
      // The brushes stay selected.
      this.endBrush();
      if (e.pointerType === 'mouse') this.hoverBrush(e.clientX, e.clientY);
      return;
    }
    const d = this.drawing;
    if (!d || d.id !== e.pointerId) return;
    this.drawing = null;
    if (this.tool === 'weir') {
      // A tap on an existing weir selects it (to move its ends, change its crest or take it down).
      const a = d.points[0]!;
      const b = d.points[d.points.length - 1]!;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1.5 && this.host.tap?.(e.clientX, e.clientY, 'weir')) {
        this.select('look');
        return;
      }
    }
    if (this.tool === 'wheel' || this.tool === 'power') {
      // The wheel's stroke is short: count where it was let go, however close to the last point.
      const p = this.host.pick(e.clientX, e.clientY);
      if (p) d.points.push([p.x, p.y]);
    }
    const points = simplify(d.points);
    const ends: Pt[] = [points[0]!, points[points.length - 1]!];
    const width = this.width;
    const amount = this.amount;
    let cmd: Command | null = null;
    let reason: string | null = null;
    switch (this.tool) {
      case 'weir':
        if (Math.hypot(ends[1]![0] - ends[0]![0], ends[1]![1] - ends[0]![1]) >= 1.5) cmd = { type: 'planWeir', points: ends, height: amount };
        break;
      case 'gate':
        cmd = { type: 'placeGate', points: ends, width, height: amount };
        break;
      case 'wheel': {
        // A bad site is shown by the red ghost alone; letting go there places nothing.
        const site = this.wheelPreview(ends);
        if (site?.ok) cmd = { type: 'placeWheel', points: ends };
        this.host.setWheelGhost?.(null, false);
        break;
      }
      case 'power': {
        if (this.mode === 'turbine') {
          const p = ends[1]!;
          const site = this.turbinePreview(p);
          if (site?.ok) {
            cmd = { type: 'placeTurbine', points: [p] };
            reason = headText(site);
          } else if (site?.reason) reason = site.reason;
        } else if (this.mode === 'poles') {
          cmd = { type: 'placePoles', points };
        } else {
          const site = this.pumpPreview(ends);
          if (site?.ok) cmd = { type: 'placePump', points: ends };
          else if (site?.reason) reason = site.reason;
        }
        break;
      }
    }
    if (cmd) {
      this.host.command(cmd);
      this.awaitingPlan = true;
      if (this.housesSkipped && !reason) reason = 'The plan goes round the houses: the crew never builds over them.';
    }
    // A wheel let go on a bad site places nothing: the tool stays, its red ghost said why.
    if (this.tool === 'wheel' && !cmd) {
      if (e.pointerType === 'mouse') this.hoverWheel(e.clientX, e.clientY);
      return;
    }
    // One structure per tool use: go back to looking around, so a stray
    // touch never places a second one (the brushes stay selected).
    this.select('look');
    if (reason) this.flashHint(reason);
  }

  /** Show a passing message on the hint line, then the current tool's hint again. */
  private flashHint(text: string): void {
    this.setHint(text, false);
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      this.showHint(this.tool);
    }, 3000);
  }

  /** The grid the wheel's site rules look at (the mirror and the latest depths and speeds). */
  private wheelGrid(): WheelGrid | null {
    const m = this.host.mirror;
    const { depth, speed } = this.host;
    if (!depth || !speed) return null;
    return { width: m.width, height: m.height, terrain: (i) => m.terrain(i), depth, speed, allowed: (i) => m.isRevealed(i % m.width, (i / m.width) | 0) };
  }

  /** Where a wheel drawn along `ends` would go (the sim's own rule, on the mirror). */
  private wheelPreview(ends: Pt[]): WheelSite | null {
    const g = this.wheelGrid();
    return g ? wheelSite(g, ends) : null;
  }

  /** Show the ghost wheel for a site (or hide it). */
  private showWheelGhost(site: WheelSite | null): void {
    this.host.setWheelGhost?.(site, site?.ok ?? false);
  }

  private hoverPending: { x: number; y: number } | null = null;

  /** The mouse over the map with the wheel tool: the ghost of a wheel tapped there. */
  private hoverWheel(clientX: number, clientY: number): void {
    const first = !this.hoverPending;
    this.hoverPending = { x: clientX, y: clientY };
    if (!first) return;
    requestAnimationFrame(() => {
      const h = this.hoverPending;
      this.hoverPending = null;
      if (!h || this.drawing || this.tool !== 'wheel') return;
      const p = this.host.pick(h.x, h.y);
      this.showWheelGhost(p ? this.wheelPreview([[p.x, p.y]]) : null);
    });
  }

  private sitesTimer: ReturnType<typeof setInterval> | null = null;

  /** While the wheel tool is held, mark the good sites on the map (refreshed as the river changes). */
  private markWheelSites(on: boolean): void {
    if (this.sitesTimer) clearInterval(this.sitesTimer);
    this.sitesTimer = null;
    if (!on) {
      this.host.setWheelSites?.(null);
      return;
    }
    const mark = () => {
      const g = this.wheelGrid();
      this.host.setWheelSites?.(g ? wheelSites(g) : null);
    };
    mark();
    this.sitesTimer = setInterval(mark, 2000);
  }

  /** The grid the power previews look at (the mirror and the latest depths). */
  private powerGrid(): PowerGrid2D | null {
    const m = this.host.mirror;
    const depth = this.host.depth;
    if (!depth) return null;
    return { width: m.width, height: m.height, terrain: (i) => m.terrain(i), depth, allowed: (i) => m.isRevealed(i % m.width, (i / m.width) | 0) };
  }

  private turbinePreview(p: Pt): TurbineSite | null {
    const g = this.powerGrid();
    return g ? turbineSite(g, p) : null;
  }

  private pumpPreview(ends: Pt[]): PumpSite | null {
    const g = this.powerGrid();
    return g ? pumpSite(g, ends) : null;
  }

  private onCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.brush?.id === e.pointerId) this.endBrush(true);
    if (this.drawing?.id === e.pointerId) {
      this.drawing = null;
      if (!this.awaitingPlan) this.clearPreview();
    }
  }

  // ---------------------------------------------------------------------------
  // Brushes

  private startBrush(e: PointerEvent): void {
    const now = performance.now();
    this.brush = { id: e.pointerId, cx: e.clientX, cy: e.clientY, at: null, t: now, start: now, touch: e.pointerType !== 'mouse' };
    this.lastPick = null;
    this.host.sculptor?.begin(this.tool as BrushTool, this.brushRadius);
    cancelAnimationFrame(this.brushRaf);
    this.brushRaf = requestAnimationFrame(this.brushFrame);
  }

  /** The ground point under the brush: the same as last frame while the pointer stands still (the ground moves, the brush does not). */
  private lastPick: { cx: number; cy: number; p: { x: number; y: number } } | null = null;
  private pickBrush(cx: number, cy: number): { x: number; y: number } | null {
    const l = this.lastPick;
    if (l && Math.abs(l.cx - cx) < 0.5 && Math.abs(l.cy - cy) < 0.5) return l.p;
    const p = this.host.pick(cx, cy);
    this.lastPick = p ? { cx, cy, p } : null;
    return p;
  }

  /** Every frame while the brush is held: brush from where it was to where it is now, for the time since. */
  private readonly brushFrame = (): void => {
    if (!this.brush) return;
    this.brushRaf = requestAnimationFrame(this.brushFrame);
    this.brushStep();
  };

  /** Brush for the time since the last step (each frame, and once more when let go: slow frames lose nothing). */
  private brushStep(): void {
    const b = this.brush;
    if (!b) return;
    const now = performance.now();
    // Real hold time (a slow frame still counts in full, up to a limit: the sim caps each sample too).
    const dt = Math.min(0.25, (now - b.t) / 1000);
    b.t = now;
    const p = this.pickBrush(b.cx, b.cy);
    const tool = this.tool as BrushTool;
    const r = this.brushRadius;
    if (!p) {
      this.host.setBrushCursor?.(null);
      b.at = null;
      return;
    }
    const waiting = b.touch && now - b.start < TOUCH_DELAY;
    this.host.setBrushCursor?.({ x: p.x, y: p.y, r, tool, active: !waiting });
    if (waiting) return;
    const sc = this.host.sculptor;
    if (!sc) return;
    const from = b.at ?? p;
    const n = Math.max(1, Math.ceil(Math.hypot(p.x - from.x, p.y - from.y) / (r * 0.4)));
    for (let k = 1; k <= n; k++) {
      const u = k / n;
      sc.sample(from.x + (p.x - from.x) * u, from.y + (p.y - from.y) * u, dt / n);
    }
    b.at = p;
    sc.flush();
    this.host.brushed?.(p.x, p.y, r);
  }

  /** Let go of the brush (cancelled: a second finger came, nothing more is brushed). */
  private endBrush(cancelled = false): void {
    if (!cancelled) this.brushStep();
    const b = this.brush;
    this.brush = null;
    cancelAnimationFrame(this.brushRaf);
    const sc = this.host.sculptor;
    sc?.flush();
    if (!b) return;
    if (b.touch || cancelled) this.host.setBrushCursor?.(null);
    if (sc?.touchedFixed && !cancelled) this.flashHint('The brushes go round houses, bridges and structures: those stay as they are.');
    this.refreshUndo();
  }

  private hoverRaf = 0;
  /** The mouse over the map with a brush: its ring. */
  private hoverBrush(clientX: number, clientY: number): void {
    const first = !this.hover;
    this.hover = { x: clientX, y: clientY };
    if (!first && this.hoverRaf) return;
    this.hoverRaf = requestAnimationFrame(() => {
      this.hoverRaf = 0;
      const h = this.hover;
      if (!h || this.brush || !isBrush(this.tool)) return;
      const p = this.host.pick(h.x, h.y);
      this.host.setBrushCursor?.(p ? { x: p.x, y: p.y, r: this.brushRadius, tool: this.tool as BrushTool, active: false } : null);
    });
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
      const amount = this.amount;
      let lining: number[] | null = null;
      if (this.tool === 'weir') {
        if (Math.hypot(ends[1]![0] - ends[0]![0], ends[1]![1] - ends[0]![1]) >= 1.5) {
          const low = weirLowest(grid, ends[0]!, ends[1]!);
          if (Number.isFinite(low)) lining = planWeirPreview(grid, ends[0]!, ends[1]!, low + amount);
        }
      } else if (this.tool === 'gate' && Math.hypot(ends[1]![0] - ends[0]![0], ends[1]![1] - ends[0]![1]) >= 1.5) {
        // Drawn across a channel: a stone wall with the gate at its lowest point (a tap previews nothing).
        const low = weirLowest(grid, ends[0]!, ends[1]!);
        if (Number.isFinite(low)) lining = planWeirPreview(grid, ends[0]!, ends[1]!, low + amount);
      } else if (this.tool === 'wheel') {
        // The ghost wheel and its trough, pointing where the water goes: as built when the site is good, red when not.
        this.showWheelGhost(this.wheelPreview(ends));
      } else if (this.tool === 'power') {
        const W = this.host.mirror.width;
        if (this.mode === 'turbine') {
          const site = this.turbinePreview(ends[1]!);
          if (site) {
            lining = [site.y * W + site.x, ...(site.a >= 0 ? [site.a] : []), ...(site.b >= 0 ? [site.b] : [])];
            if (site.ok) this.setHint(headText(site), false);
            else if (site.reason) this.setHint(site.reason, false);
          }
        } else if (this.mode === 'poles') {
          lining = polePositions(pts).map(([x, y]) => y * W + x);
        } else {
          const site = this.pumpPreview(ends);
          if (site) {
            lining = [...rasterisePath(grid, [[site.x, site.y], [site.ox, site.oy]], 0.5).keys()];
            if (site.ok) this.setHint(`Lifts the water ${Math.max(0, site.lift).toFixed(1)} m.`, false);
            else if (site.reason) this.setHint(site.reason, false);
          }
        }
      }
      // Plans only go on known land (the sim drops the rest too).
      const m = this.host.mirror;
      this.housesSkipped = m.maskUnrevealed(grid.plan);
      if (lining) lining = lining.filter((i) => m.isRevealed(i % m.width, (i / m.width) | 0) && (this.tool === 'power' || this.tool === 'wheel' || m.plannable(i)));
      this.host.setPreviewPlan(grid.plan);
      this.host.setPreviewLining?.(lining);
    });
  }
}

/** What a turbine site would give (the hint line). */
function headText(site: TurbineSite): string {
  return site.power > 0
    ? `${site.head.toFixed(1)} m of head: about ${kw(site.power)} now.`
    : 'No head here yet: it turns once the water stands higher on one side.';
}

/** Power in friendly units. */
function kw(watts: number): string {
  return watts >= 9500 ? `${Math.round(watts / 1000)} kW` : `${(watts / 1000).toFixed(1)} kW`;
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
