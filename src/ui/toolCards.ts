/**
 * Tool cards (docs/GAMEPLAY.md §3): when a tool unlocks, a small card shows
 * that tool at work in a live staged scene (sim/scenes.ts, drawn by the
 * welcome panels' machinery, introScenes.ts) with two lines of text. Shown
 * once per tool (remembered in localStorage) the next time the player picks
 * a tool after the unlock, and again from the ⓘ on the hint line.
 */
import type { SceneId } from '../shared/protocol';
import { toolName } from '../shared/progress';
import { IntroScenes } from './introScenes';
import { LOADER_HTML } from './loader';

interface CardDef {
  scene: SceneId;
  text: string;
}

/** Tools with a card (the starting tools are the welcome panels' "You shape the water"). */
export const TOOL_CARDS: Readonly<Record<string, CardDef>> = {
  gate: {
    scene: 'gate',
    text: 'Hold water back behind a bank, and let the villagers release it to their dry fields: tap a bank you raised where it holds water above lower ground (the gold marks) to set a sluice gate in it. In autumn it closes so the pond refills; before a flood spills over, it opens by itself.',
  },
  weir: {
    scene: 'weir',
    text: 'Heaped earth must never be overtopped: water pouring over it cuts through. A weir is a stone wall that water can spill over safely: across a river it raises the water for your canals, and its drop turns mills and, later, turbines. Up to 4 m high; tap a weir later to move its ends or change its crest.',
  },
  turbine: {
    scene: 'turbine',
    text: 'Water falling through a weir or a dam can do more than turn a mill: a turbine in the wall makes power, and the cottages around it light up. More head, more flow, more light.',
  },
  pump: {
    scene: 'pump',
    text: 'At night the turbines make more than the cottages need: an electric pump lifts river water up into a basin. In the evening a turbine in the basin’s wall gives it back as light. Pumped storage.',
  },
  wheel: {
    scene: 'wheel',
    text: 'A noria lifts river water up to a canal on the terrace above, so fields beyond the floodplain can be watered. Set it where the current is quick: in the main channel, a narrows, or the race below your weir. The higher the bank, the taller the wheel and the less it lifts; in still water it stands still.',
  },
};

const SEEN_KEY = 'hydro.toolCardsSeen';

function seenSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export class ToolCards {
  private readonly el: HTMLElement;
  private readonly art: HTMLElement;
  private scenes: IntroScenes | null = null;
  private onCloseFn: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'tool-card';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.innerHTML = `
      <div class="intro-card panel">
        <div class="intro-art">${LOADER_HTML}</div>
        <h2></h2>
        <p class="intro-text"></p>
        <div class="intro-nav"><span></span><button class="next">Got it</button></div>
      </div>`;
    this.art = this.el.querySelector('.intro-art')!;
    root.append(this.el);
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.querySelector('.next')!.addEventListener('click', () => this.close());
    window.addEventListener('keydown', (e) => {
      if (this.el.hidden) return;
      if (e.key === 'Escape' || e.key === 'Enter') this.close();
    });
  }

  static has(tool: string): boolean {
    return tool in TOOL_CARDS;
  }

  /** Whether this browser has seen the card of `tool`. */
  static seen(tool: string): boolean {
    return seenSet().has(tool);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  get tool(): string | null {
    return this.el.hidden ? null : (this.el.dataset.tool ?? null);
  }

  open(tool: string, onClose?: () => void): void {
    const def = TOOL_CARDS[tool];
    if (!def) return;
    if (!this.el.hidden) this.close();
    this.onCloseFn = onClose ?? null;
    this.el.dataset.tool = tool;
    this.el.setAttribute('aria-label', toolName(tool));
    this.el.querySelector('h2')!.textContent = toolName(tool);
    this.el.querySelector('.intro-text')!.textContent = def.text;
    this.el.hidden = false;
    try {
      const s = seenSet();
      s.add(tool);
      localStorage.setItem(SEEN_KEY, JSON.stringify([...s]));
    } catch {
      // Storage unavailable: it may show again next time.
    }
    this.art.classList.remove('live', 'live-on', 'still');
    // Each opening tries afresh (a failure last time may have passed); on failure the mill stands still.
    try {
      const sc = new IntroScenes(this.art, def.scene);
      sc.onLive = () => this.art.classList.add('live');
      sc.onFail = () => {
        this.scenes = null;
        this.art.classList.remove('live', 'live-on');
        this.art.classList.add('still');
      };
      this.scenes = sc;
    } catch (e) {
      console.warn('Tool card scene unavailable', e);
      this.art.classList.add('still');
    }
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.scenes?.dispose();
    this.scenes = null;
    const fn = this.onCloseFn;
    this.onCloseFn = null;
    fn?.();
  }
}
