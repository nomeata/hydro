/**
 * Achievements in the HUD: a toast with a sparkle for each newly earned one
 * (top centre, stacking, gone after a few seconds, never in the way), and
 * the Achievements card (from the menu, or by tapping a toast) listing all
 * of them: earned ones with their day, the others dimmed with what it takes.
 * The card opens with "Ideas for this valley" (sim/ideas.ts): at most three
 * of the sim's ideas whose tool is unlocked, each with a "Show me" that
 * looks at the spot. A new idea only puts a small dot on the menu button.
 */
import type { AchievementEarned, AchievementsUpdate, IdeaInfo } from '../shared/protocol';
import { ICONS } from './icons';
import { ACHIEVEMENTS, CATEGORY_NAMES, achievementInfo, type AchievementCategory } from '../shared/achievements';
import { medal } from './achievementIcons';
import { dayLabel } from './historyChart';

const TOAST_MS = 5000;
/** Toasts shown at once; more wait their turn. */
const MAX_TOASTS = 3;
/** Pause between toasts arriving together. */
const STAGGER_MS = 450;
/** Ideas shown at once. */
export const MAX_IDEAS = 3;
const SEEN_KEY = 'hydro.ideasSeen';

export interface IdeasOptions {
  /** Whether a tool is unlocked (ideas for locked tools wait). */
  unlocked: (tool: string) => boolean;
  /** "Show me": look at the idea's spot (the card has closed). */
  show: (idea: IdeaInfo) => void;
  /** A new idea arrived (dot on the menu), or all were seen. */
  news: (on: boolean) => void;
  /** Per world, so ideas seen in one world are new in the next. */
  seed: number;
  /** While true (a welcome panel or tool card is open), toasts wait. */
  quiet?: () => boolean;
}

/** How often waiting toasts look whether the dialog has closed (ms). */
const QUIET_RETRY_MS = 400;

const TOOL_ICONS: Readonly<Record<string, string>> = { poles: 'pole' };

export class AchievementsUi {
  private earned: AchievementEarned[] = [];
  private readonly known = new Set<string>();
  private readonly toasts: HTMLElement;
  private readonly queue: string[] = [];
  private showing = 0;
  private nextAt = 0;
  private pump: ReturnType<typeof setTimeout> | null = null;
  readonly panel: AchievementsPanel;
  private ideas: IdeaInfo[] = [];
  private seen: Set<string>;

  constructor(
    root: HTMLElement,
    private readonly opts: IdeasOptions | null = null,
  ) {
    this.seen = new Set(loadSeen());
    this.toasts = document.createElement('div');
    this.toasts.className = 'ach-toasts';
    this.toasts.setAttribute('role', 'status');
    this.toasts.setAttribute('aria-live', 'polite');
    this.toasts.dataset.testid = 'achievement-toasts';
    root.append(this.toasts);
    this.panel = new AchievementsPanel(root, () => this.earned, () => this.visibleIdeas(), (idea) => {
      this.panel.close();
      opts?.show(idea);
    });
    this.panel.onOpen = () => this.markSeen();
  }

  /** The ideas to show: the sim's first MAX_IDEAS for unlocked tools. */
  visibleIdeas(): IdeaInfo[] {
    const ok = this.opts?.unlocked ?? (() => true);
    return this.ideas.filter((i) => ok(i.tool)).slice(0, MAX_IDEAS);
  }

  /** New ideas from the sim (or call without to re-check after an unlock). */
  updateIdeas(list?: IdeaInfo[]): void {
    if (list) this.ideas = list;
    if (this.panel.isOpen) {
      this.panel.render();
      this.markSeen();
    }
    this.opts?.news(this.visibleIdeas().some((i) => !this.seen.has(this.key(i))));
  }

  private key(i: IdeaInfo): string {
    return `${this.opts?.seed ?? 0}:${i.id}`;
  }

  private markSeen(): void {
    const vis = this.visibleIdeas();
    if (!vis.length) return;
    for (const i of vis) this.seen.add(this.key(i));
    saveSeen([...this.seen]);
    this.opts?.news(false);
  }

  /** All earned so far (in order). */
  get list(): readonly AchievementEarned[] {
    return this.earned;
  }

  update(u: AchievementsUpdate | undefined): void {
    if (!u) return;
    this.earned = u.earned;
    for (const id of u.fresh) if (!this.known.has(id)) this.queue.push(id);
    for (const e of u.earned) this.known.add(e.id);
    if (this.panel.isOpen) this.panel.render();
    this.drain();
  }

  private drain(): void {
    if (this.pump) return;
    const now = performance.now();
    if (!this.queue.length || this.showing >= MAX_TOASTS) return;
    if (this.opts?.quiet?.()) {
      this.pump = setTimeout(() => {
        this.pump = null;
        this.drain();
      }, QUIET_RETRY_MS);
      return;
    }
    if (now < this.nextAt) {
      this.pump = setTimeout(() => {
        this.pump = null;
        this.drain();
      }, this.nextAt - now);
      return;
    }
    this.toast(this.queue.shift()!);
    this.nextAt = now + STAGGER_MS;
    this.drain();
  }

  /** Show one achievement's toast. */
  toast(id: string): void {
    const a = achievementInfo(id);
    if (!a) return;
    const el = document.createElement('button');
    el.className = 'ach-toast panel';
    el.dataset.testid = 'achievement-toast';
    el.dataset.id = id;
    el.innerHTML = `${medal(a.icon, a.category)}<span class="txt"><small>Achievement</small><b>${a.title}</b><span>${a.description}</span></span>`;
    el.addEventListener('click', () => this.panel.open(id));
    const m = el.querySelector('.medal')!;
    m.append(sparkles());
    this.toasts.append(el);
    this.showing++;
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => {
        el.remove();
        this.showing--;
        this.drain();
      }, 450);
    }, TOAST_MS);
  }
}

function loadSeen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveSeen(ids: string[]): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-60)));
  } catch {
    // No storage (private mode): the dot just comes back after a reload.
  }
}

function sparkles(): HTMLElement {
  const burst = document.createElement('span');
  burst.className = 'sparkles';
  const n = 10;
  for (let k = 0; k < n; k++) {
    const s = document.createElement('i');
    const a = (k / n) * Math.PI * 2 + Math.random() * 0.4;
    const r = 26 + Math.random() * 14;
    s.style.setProperty('--dx', `${(Math.cos(a) * r).toFixed(1)}px`);
    s.style.setProperty('--dy', `${(Math.sin(a) * r).toFixed(1)}px`);
    s.style.animationDelay = `${(0.15 + Math.random() * 0.25).toFixed(2)}s`;
    s.textContent = k % 3 === 0 ? '✦' : '★';
    burst.append(s);
  }
  return burst;
}

/** The Achievements card: all of them, by category. */
export class AchievementsPanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly count: HTMLElement;
  private onClose: (() => void) | null = null;
  /** Called whenever the card opens. */
  onOpen: (() => void) | null = null;

  constructor(
    root: HTMLElement,
    private readonly earned: () => readonly AchievementEarned[],
    private readonly ideas: () => readonly IdeaInfo[] = () => [],
    private readonly show: (idea: IdeaInfo) => void = () => {},
  ) {
    const el = document.createElement('div');
    el.className = 'history-overlay ach-overlay';
    el.hidden = true;
    el.innerHTML = `
      <div class="history-card ach-card panel" role="dialog" aria-modal="true" aria-labelledby="ach-title" data-testid="achievements">
        <header>
          <h2 id="ach-title">Achievements <span class="ach-count"></span></h2>
          <button class="close" aria-label="Close" data-testid="achievements-close">×</button>
        </header>
        <div class="ach-body"></div>
      </div>`;
    this.body = el.querySelector('.ach-body')!;
    this.count = el.querySelector('.ach-count')!;
    el.querySelector('.close')!.addEventListener('click', () => this.close());
    el.addEventListener('click', (e) => {
      if (e.target === el) this.close();
    });
    this.body.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.idea-show');
      const idea = b && this.ideas().find((i) => i.id === b.dataset.id);
      if (idea) this.show(idea);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.hidden) this.close();
    });
    this.el = el;
    root.append(el);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** Open the card (scrolled to `id`, which is highlighted, if given). */
  open(id?: string, onClose?: () => void): void {
    this.onClose = onClose ?? null;
    this.el.hidden = false;
    this.render();
    this.onOpen?.();
    if (id) {
      const item = this.body.querySelector<HTMLElement>(`[data-id="${id}"]`);
      if (item) {
        item.classList.add('flash');
        item.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }

  render(): void {
    const got = new Map(this.earned().map((e) => [e.id, e.day]));
    const total = ACHIEVEMENTS.length;
    const n = ACHIEVEMENTS.filter((a) => got.has(a.id)).length;
    this.count.innerHTML = `<b>${n}</b> of ${total}<span class="ach-meter"><span style="width:${((n / total) * 100).toFixed(1)}%"></span></span>`;
    const cats = [...new Set(ACHIEVEMENTS.map((a) => a.category))] as AchievementCategory[];
    this.body.innerHTML = this.ideasHtml() + cats
      .map((c) => {
        const items = ACHIEVEMENTS.filter((a) => a.category === c)
          .map((a) => {
            const day = got.get(a.id);
            const when = day === undefined ? '' : `<em>${dayLabel(day)}</em>`;
            return `<li class="ach-item${day === undefined ? ' locked' : ''}" data-id="${a.id}">${medal(a.icon, a.category)}<span class="txt"><b>${a.title}</b><span>${a.description}</span>${when}</span></li>`;
          })
          .join('');
        return `<section><h3>${CATEGORY_NAMES[c]}</h3><ul>${items}</ul></section>`;
      })
      .join('');
  }

  /** "Ideas for this valley": a few gentle suggestions, if the sim has any. */
  private ideasHtml(): string {
    const list = this.ideas();
    if (!list.length) return '';
    const items = list
      .map((i) => {
        const a = i.achievement ? achievementInfo(i.achievement) : undefined;
        const towards = a ? `<em>Towards ${a.title}</em>` : '';
        const icon = (ICONS as Readonly<Record<string, string>>)[TOOL_ICONS[i.tool] ?? i.tool] ?? '';
        return `<li class="idea" data-id="${i.id}" data-kind="${i.kind}"><span class="idea-icon">${icon}</span><span class="txt"><span>${i.text}</span>${towards}</span><button class="idea-show" data-id="${i.id}" data-testid="idea-show">Show me</button></li>`;
      })
      .join('');
    return `<section class="ideas" data-testid="ideas"><h3>Ideas for this valley</h3><ul>${items}</ul></section>`;
  }
}
