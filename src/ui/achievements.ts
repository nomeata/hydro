/**
 * Achievements in the HUD: a toast with a sparkle for each newly earned one
 * (top centre, stacking, gone after a few seconds, never in the way), and
 * the Achievements card (from the menu, or by tapping a toast) listing all
 * of them: earned ones with their day, the others dimmed with what it takes.
 */
import type { AchievementEarned, AchievementsUpdate } from '../shared/protocol';
import { ACHIEVEMENTS, CATEGORY_NAMES, achievementInfo, type AchievementCategory } from '../shared/achievements';
import { medal } from './achievementIcons';
import { dayLabel } from './historyChart';

const TOAST_MS = 5000;
/** Toasts shown at once; more wait their turn. */
const MAX_TOASTS = 3;
/** Pause between toasts arriving together. */
const STAGGER_MS = 450;

export class AchievementsUi {
  private earned: AchievementEarned[] = [];
  private readonly known = new Set<string>();
  private readonly toasts: HTMLElement;
  private readonly queue: string[] = [];
  private showing = 0;
  private nextAt = 0;
  private pump: ReturnType<typeof setTimeout> | null = null;
  readonly panel: AchievementsPanel;

  constructor(root: HTMLElement) {
    this.toasts = document.createElement('div');
    this.toasts.className = 'ach-toasts';
    this.toasts.setAttribute('role', 'status');
    this.toasts.setAttribute('aria-live', 'polite');
    this.toasts.dataset.testid = 'achievement-toasts';
    root.append(this.toasts);
    this.panel = new AchievementsPanel(root, () => this.earned);
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

  constructor(
    root: HTMLElement,
    private readonly earned: () => readonly AchievementEarned[],
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
    this.body.innerHTML = cats
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
}
