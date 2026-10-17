/**
 * The history panel: a closable card (like the welcome panels) with the
 * history chart, a readout line for the day under the finger/mouse, and a
 * legend. While open it refreshes every few seconds.
 */
import type { HistoryData } from '../shared/protocol';
import { COLORS, SEASON_COLORS, buildChart, describeSample, sampleAt, type ChartLayout } from './historyChart';
import { STAR_PATH } from './icons';
import { CATEGORY_COLORS } from './achievementIcons';

const REFRESH_MS = 3000;
const HINT = 'Tap or hover the chart for details.';

const mini = (body: string, w = 22, h = 14) => `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${body}</svg>`;
const LEGEND: [string, string][] = [
  [mini(`<path d="M2 10l6-5 5 3 7-6" fill="none" stroke="${COLORS.pop}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`), 'Villagers'],
  [mini(`<path d="M2 9l6-4 5 2 7-4" fill="none" stroke="${COLORS.pros}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`), 'Prosperity'],
  [
    mini(SEASON_COLORS.map((c, k) => `<rect x="${k * 5.5}" y="1" width="5" height="12" rx="1.5" fill="${c}" stroke="rgba(90,70,40,.25)"/>`).join('')),
    'Seasons',
  ],
  [mini(`<path d="M11 1C12 5 15 7 15 9.5a4 4 0 0 1-8 0C7 7 10 5 11 1z" fill="${COLORS.rain}"/>`), 'Rain'],
  [
    mini(
      `<defs><pattern id="lh" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="${COLORS.dry}" fill-opacity=".16"/><line x1="0" y1="0" x2="0" y2="5" stroke="${COLORS.dry}" stroke-opacity=".6" stroke-width="2"/></pattern></defs><rect x="1" y="1" width="20" height="12" rx="2" fill="url(#lh)"/>`,
    ),
    'Dry spell',
  ],
  [mini(`<path d="M3 9q4-6 8 0t8 0" fill="none" stroke="${COLORS.flood}" stroke-width="2.2" stroke-linecap="round"/>`), 'Flood'],
  [
    mini(
      `<g transform="scale(0.42) translate(1 0)"><path d="${STAR_PATH}" fill="${COLORS.star}" stroke="${COLORS.starInk}" stroke-width="3" stroke-linejoin="round"/></g><g transform="translate(13 0) scale(0.42)"><path d="${STAR_PATH}" fill="#fffdf6" stroke="${COLORS.starInk}" stroke-width="3" stroke-dasharray="4 3" stroke-linejoin="round"/></g>`,
      28,
    ),
    'New tools (reached · ahead)',
  ],
  [
    mini(
      `<path d="M7 9l-2 5 2.5-1 1.5 2 1-5zM15 9l2 5-2.5-1-1.5 2-1-5z" fill="${CATEGORY_COLORS.water}"/><circle cx="11" cy="6.5" r="5" fill="#fff4d0" stroke="${CATEGORY_COLORS.people}" stroke-width="2"/><circle cx="11" cy="6.5" r="2" fill="${COLORS.star}"/>`,
      22,
      16,
    ),
    'Achievements',
  ],
];

export class HistoryPanel {
  readonly el: HTMLElement;
  private readonly chartEl: HTMLElement;
  private readonly readout: HTMLElement;
  private data: HistoryData | null = null;
  private layout: ChartLayout | null = null;
  /** Day under the cursor (kept across refreshes), or null. */
  private day: number | null = null;
  /** The text of the star or medal last tapped (kept across refreshes), or null. */
  private info: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onClose: (() => void) | null = null;

  constructor(
    root: HTMLElement,
    private readonly fetch: () => Promise<HistoryData>,
  ) {
    const el = document.createElement('div');
    el.className = 'history-overlay';
    el.hidden = true;
    el.innerHTML = `
      <div class="history-card panel" role="dialog" aria-modal="true" aria-labelledby="history-title" data-testid="history">
        <header>
          <h2 id="history-title">Your valley so far</h2>
          <button class="close" aria-label="Close" data-testid="history-close">×</button>
        </header>
        <div class="history-chart"></div>
        <p class="history-readout">${HINT}</p>
        <ul class="history-legend">${LEGEND.map(([icon, label]) => `<li>${icon}<span>${label}</span></li>`).join('')}</ul>
      </div>`;
    this.chartEl = el.querySelector('.history-chart')!;
    this.readout = el.querySelector('.history-readout')!;
    el.querySelector('.close')!.addEventListener('click', () => this.close());
    el.addEventListener('click', (e) => {
      if (e.target === el) this.close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.hidden) this.close();
    });
    window.addEventListener('resize', () => {
      if (!this.el.hidden) this.render();
    });
    this.chartEl.addEventListener('pointermove', (e) => this.point(e));
    this.chartEl.addEventListener('pointerdown', (e) => this.point(e));
    this.chartEl.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') this.select(null);
    });
    this.el = el;
    root.append(el);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(onClose?: () => void): void {
    this.onClose = onClose ?? null;
    this.el.hidden = false;
    this.day = null;
    this.info = null;
    this.readout.textContent = HINT;
    void this.refresh();
    this.timer ??= setInterval(() => void this.refresh(), REFRESH_MS);
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }

  private async refresh(): Promise<void> {
    const data = await this.fetch();
    if (this.el.hidden) return;
    this.data = data;
    this.render();
  }

  private render(): void {
    if (!this.data) return;
    const width = this.chartEl.clientWidth || 320;
    const chart = buildChart(this.data, width);
    this.chartEl.innerHTML = chart.svg;
    this.layout = chart.layout;
    this.select(this.day);
  }

  private point(e: PointerEvent): void {
    const L = this.layout;
    if (!L) return;
    const svg = this.chartEl.querySelector('svg');
    if (!svg) return;
    const target = (e.target as Element).closest?.('.star, .medal-mark');
    if (target) {
      this.day = null;
      this.info = target.getAttribute('data-info') ?? '';
      this.clearCursor();
      this.readout.textContent = this.info;
      return;
    }
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * L.width;
    const y = ((e.clientY - r.top) / r.height) * L.height;
    if (x < L.x0 - 6 || x > L.x1 + 6 || y < L.top - 4 || y > L.bottom + 30) return;
    this.select(Math.max(0, Math.min(L.now - 0.01, L.xToDay(x))));
  }

  private clearCursor(): void {
    const g = this.chartEl.querySelector('.cursor');
    if (g) g.innerHTML = '';
  }

  private select(day: number | null): void {
    this.day = day;
    if (day !== null) this.info = null;
    const L = this.layout;
    const s = day === null || !this.data ? null : sampleAt(this.data.samples, day);
    const g = this.chartEl.querySelector('.cursor');
    if (!L || !g) return;
    if (!s) {
      g.innerHTML = '';
      if (day === null) this.readout.textContent = this.info ?? HINT;
      return;
    }
    const x = L.dayToX(s.d + s.n / 2).toFixed(1);
    let html = `<line x1="${x}" x2="${x}" y1="${L.top}" y2="${L.bottom}" stroke="${COLORS.ink}" stroke-opacity="0.45" stroke-width="1.5"/>`;
    if (s.p > 0) {
      html += `<circle cx="${x}" cy="${L.popY(s.p).toFixed(1)}" r="5" fill="${COLORS.pop}" stroke="#fff" stroke-width="2"/>`;
      html += `<circle cx="${x}" cy="${L.prosY(s.w).toFixed(1)}" r="5" fill="${COLORS.pros}" stroke="#fff" stroke-width="2"/>`;
    }
    g.innerHTML = html;
    this.readout.textContent = describeSample(s);
  }
}
