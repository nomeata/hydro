/**
 * Heads-up display: date/season/weather badge and speed controls, plus the
 * optional stats overlay (?stats=1).
 */
import type { Snapshot } from '../shared/protocol';
import { ICONS } from './icons';

const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
const SPEEDS = [
  { speed: 0, label: ICONS.pause, title: 'Pause' },
  { speed: 1, label: ICONS.play, title: 'Normal speed' },
  { speed: 3, label: '3×', title: 'Fast' },
  { speed: 10, label: '10×', title: 'Very fast' },
];

export class Hud {
  private readonly dateEl: HTMLElement;
  private readonly speedButtons: HTMLButtonElement[] = [];
  private readonly slowEl: HTMLElement;
  private readonly statsEl: HTMLElement | null;
  private lastIcon = '';
  private fps = 60;

  constructor(root: HTMLElement, onSpeed: (speed: number) => void, showStats: boolean) {
    const bar = document.createElement('div');
    bar.className = 'topbar';
    this.dateEl = document.createElement('div');
    this.dateEl.className = 'date panel';
    this.dateEl.dataset.testid = 'date';
    bar.append(this.dateEl);

    const speed = document.createElement('div');
    speed.className = 'speed panel';
    for (const s of SPEEDS) {
      const b = document.createElement('button');
      b.innerHTML = s.label;
      b.title = s.title;
      b.setAttribute('aria-label', s.title);
      b.dataset.speed = String(s.speed);
      b.addEventListener('click', () => {
        onSpeed(s.speed);
        this.setSpeed(s.speed);
      });
      this.speedButtons.push(b);
      speed.append(b);
    }
    this.slowEl = document.createElement('span');
    this.slowEl.className = 'slow';
    speed.append(this.slowEl);
    bar.append(speed);
    root.append(bar);

    this.statsEl = showStats ? document.createElement('div') : null;
    if (this.statsEl) {
      this.statsEl.className = 'stats';
      root.append(this.statsEl);
    }
    this.setSpeed(1);
  }

  setSpeed(speed: number): void {
    for (const b of this.speedButtons) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === speed));
  }

  update(s: Snapshot): void {
    const t = s.time;
    const raining = s.climate.fronts.some((f) => f.intensity > 0.3);
    const snowing = raining && s.climate.fronts.some((f) => f.snow);
    const icon = snowing ? 'snow' : raining ? 'rain' : s.climate.fronts.length ? 'cloud' : 'sun';
    const text = `${SEASONS[t.season]}, day ${t.dayOfSeason + 1}`;
    const sub = `Year ${t.year + 1} · ${Math.round(s.climate.temperature)}°C`;
    const html = `<span class="icon">${ICONS[icon]}</span><span>${text}<small>${sub}</small></span>`;
    if (html !== this.lastIcon) {
      this.dateEl.innerHTML = html;
      this.lastIcon = html;
    }
    const req = s.stats.speedRequested;
    const ach = s.stats.speedAchieved;
    this.slowEl.textContent = req > 0 && ach < req * 0.8 ? `${ach.toFixed(1)}×` : '';

    if (this.statsEl) {
      this.statsEl.textContent =
        `fps ${this.fps.toFixed(0)}\n` +
        `step ${s.stats.msPerStep.toFixed(2)} ms\n` +
        `speed ${ach.toFixed(2)}× / ${req}×\n` +
        `water ${(s.stats.surfaceWater / 1e6).toFixed(3)} Mm³\n` +
        `outflow ${(s.stats.outflowPerDay / 1e3).toFixed(0)} k m³/day\n` +
        `fronts ${s.climate.fronts.length}` +
        (s.stats.village
          ? `\n${(s.stats.village.count ?? 1) > 1 ? `${s.stats.village.count} villages` : 'village'} ${s.stats.village.population} ppl, ${s.stats.village.houses} houses\n` +
            `food ${s.stats.village.food.toFixed(0)}, w ${s.stats.village.wellbeing.toFixed(2)}` +
            (s.stats.villages ?? [])
              .map((v, k) => `\n v${k + 1}: ${v.population} ppl, w ${v.wellbeing.toFixed(2)}, limit ${v.limit ?? '–'}`)
              .join('')
          : '') +
        (s.stats.power
          ? `\npower ${(s.stats.power.produced / 1000).toFixed(1)} kW (day ${s.stats.power.dayMean.toFixed(1)})\n` +
            `houses ${s.stats.power.houses}: ${(s.stats.power.supplied / 1000).toFixed(1)}/${(s.stats.power.demand / 1000).toFixed(1)} kW` +
            (s.stats.power.pumping > 0 ? `, pumps ${(s.stats.power.pumping / 1000).toFixed(1)} kW` : '')
          : '');
    }
  }

  frame(dtSec: number): void {
    if (dtSec > 0) this.fps = this.fps * 0.95 + (1 / dtSec) * 0.05;
  }
}
