/**
 * Tool cards (docs/GAMEPLAY.md §3): when a tool unlocks, a small card shows
 * that tool at work in a live staged scene (sim/scenes.ts, drawn by the
 * welcome panels' machinery, introScenes.ts) with two lines of text. Shown
 * once per tool (remembered in localStorage) the next time the player picks
 * a tool after the unlock, and again from the ⓘ on the hint line.
 */
import type { SceneId } from '../shared/protocol';
import { toolName } from '../shared/progress';
import { ICONS } from './icons';
import { IntroScenes } from './introScenes';

interface CardDef {
  scene: SceneId;
  text: string;
}

/** Tools with a card (the starting tools are the welcome panels' "You shape the water"). */
export const TOOL_CARDS: Readonly<Record<string, CardDef>> = {
  weir: {
    scene: 'weir',
    text: 'In a dry summer the river shrinks and its fields go yellow. A weir holds a pool behind it all summer, spilling evenly over its crest.',
  },
  gate: {
    scene: 'gate',
    text: 'When the fields below run dry, a villager opens the gate; in autumn it closes so the reservoir refills. Before a flood spills over, it opens by itself.',
  },
  turbine: {
    scene: 'turbine',
    text: 'Water falling through a weir or a dam can do more than turn a mill: a turbine in the wall makes power, and the cottages around it light up. More head, more flow, more light.',
  },
  poles: {
    scene: 'poles',
    text: 'The turbine is down by the weir, the village up by the pond? A line of poles carries the power over: every cottage near a pole lights up.',
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
  /** Live scenes failed once: stay with the icon. */
  private noLive = false;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'tool-card';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.innerHTML = `
      <div class="intro-card panel">
        <div class="intro-art"><div class="intro-svg tool-card-icon"></div></div>
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
    this.el.querySelector('.tool-card-icon')!.innerHTML = ICONS[tool as keyof typeof ICONS] ?? '';
    this.el.hidden = false;
    try {
      const s = seenSet();
      s.add(tool);
      localStorage.setItem(SEEN_KEY, JSON.stringify([...s]));
    } catch {
      // Storage unavailable: it may show again next time.
    }
    this.art.classList.remove('live', 'live-on');
    if (this.noLive) return;
    try {
      const sc = new IntroScenes(this.art, def.scene);
      sc.onLive = () => this.art.classList.add('live');
      sc.onFail = () => {
        this.noLive = true;
        this.scenes = null;
        this.art.classList.remove('live', 'live-on');
      };
      this.scenes = sc;
    } catch (e) {
      console.warn('Tool card scene unavailable', e);
      this.noLive = true;
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
