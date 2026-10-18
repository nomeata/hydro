/**
 * Stats bar (top right): the two headline stats, population and
 * prosperity, as small chunky bars. The population bar fills on a log scale
 * from the last tool-unlock milestone to the next and sparkles when a new
 * one is reached. Tapping the bar opens the history chart.
 */
import type { SimStats } from '../shared/protocol';
import { milestoneFraction, milestoneSpan, prosperity, toolName, unlockMilestones } from '../shared/progress';
import { ICONS } from './icons';
import { sound } from '../audio/bus';

export class StatsBar {
  readonly el: HTMLButtonElement;
  private readonly popFill: HTMLElement;
  private readonly popNum: HTMLElement;
  private readonly popRow: HTMLElement;
  private readonly prosFill: HTMLElement;
  private readonly prosNum: HTMLElement;
  private readonly prosRow: HTMLElement;
  private readonly toast: HTMLElement;
  /** Highest population seen (null until the first update: no fanfare for an old save). */
  private peak: number | null = null;
  private lastKey = '';
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** A milestone reached while a dialog was open: celebrated once it closes. */
  private pending: { population: number; tools: string[] } | null = null;

  /** `quiet`: while true (a welcome panel or tool card is open), milestone notes wait. */
  constructor(topbar: HTMLElement, onOpen: () => void, private readonly quiet: () => boolean = () => false) {
    const el = document.createElement('button');
    el.className = 'statsbar panel';
    el.dataset.testid = 'statsbar';
    el.setAttribute('aria-label', 'Population and prosperity — show history');
    el.innerHTML = `
      <span class="stat pop">
        <i class="ico">${ICONS.face}</i>
        <span class="track"><span class="fill"></span></span>
        <i class="ico">${ICONS.faces}</i>
        <b class="num">0</b>
      </span>
      <span class="stat pros">
        <i class="ico">${ICONS.frown}</i>
        <span class="track"><span class="fill"></span></span>
        <i class="ico">${ICONS.smile}</i>
        <b class="num">—</b>
        <span class="wait">waiting for settlers…</span>
      </span>`;
    this.popRow = el.querySelector('.pop')!;
    this.popFill = this.popRow.querySelector('.fill')!;
    this.popNum = this.popRow.querySelector('.num')!;
    this.prosRow = el.querySelector('.pros')!;
    this.prosFill = this.prosRow.querySelector('.fill')!;
    this.prosNum = this.prosRow.querySelector('.num')!;
    this.toast = document.createElement('div');
    this.toast.className = 'statsbar-toast panel';
    this.toast.hidden = true;
    el.addEventListener('click', onOpen);
    this.el = el;
    // Between the date and the speed controls; on phones CSS moves it to a second row.
    const speed = topbar.querySelector('.speed');
    topbar.insertBefore(el, speed);
    topbar.append(this.toast);
    this.update(undefined);
  }

  update(stats: SimStats | undefined): void {
    const v = stats?.village;
    const pop = v?.population ?? 0;
    const peak = Math.max(pop, v?.peak ?? 0);
    const pros = prosperity(stats?.villages);
    const key = `${pop}|${pros?.toFixed(0)}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      const { next, nextTools } = milestoneSpan(pop);
      this.popFill.style.width = `${(milestoneFraction(pop) * 100).toFixed(1)}%`;
      this.popNum.textContent = String(pop);
      const goal = nextTools.length ? `${nextTools.map(toolName).join(' & ')} at ${next}` : `next milestone: ${next}`;
      this.popRow.title = `${pop} villagers · ${goal}`;
      this.prosRow.classList.toggle('empty', pros === null);
      if (pros === null) {
        this.prosFill.style.width = '0%';
        this.prosNum.textContent = '—';
        this.prosRow.title = 'Waiting for settlers';
      } else {
        this.prosFill.style.width = `${pros.toFixed(1)}%`;
        // Warm orange when unhappy, fresh green when content.
        this.prosFill.style.setProperty('--hue', String(Math.round(25 + (pros / 100) * 85)));
        this.prosNum.textContent = `${Math.round(pros)}%`;
        this.prosRow.title = `Prosperity ${Math.round(pros)}% (how well the villagers are doing)`;
      }
    }
    if (this.peak === null) {
      this.peak = peak;
    } else if (peak > this.peak) {
      const crossed = milestonesBetween(this.peak, peak);
      this.peak = peak;
      if (crossed.length) this.pending = crossed[crossed.length - 1]!;
    }
    if (this.pending && !this.quiet()) {
      this.celebrate(this.pending);
      this.pending = null;
    }
  }

  /** A little sparkle burst and a short note when a milestone is reached. */
  celebrate(m: { population: number; tools: string[] }): void {
    const row = this.popRow;
    row.classList.remove('cheer');
    void row.offsetWidth; // restart the animation
    row.classList.add('cheer');
    sound.ui('fanfare');
    const burst = document.createElement('span');
    burst.className = 'sparkles';
    const n = 9;
    for (let k = 0; k < n; k++) {
      const s = document.createElement('i');
      const a = (k / n) * Math.PI * 2 + Math.random() * 0.4;
      const r = 18 + Math.random() * 16;
      s.style.setProperty('--dx', `${(Math.cos(a) * r).toFixed(1)}px`);
      s.style.setProperty('--dy', `${(Math.sin(a) * r * 0.7).toFixed(1)}px`);
      s.style.animationDelay = `${(Math.random() * 0.15).toFixed(2)}s`;
      s.textContent = k % 3 === 0 ? '✦' : '★';
      burst.append(s);
    }
    row.append(burst);
    setTimeout(() => burst.remove(), 1600);

    const tools = m.tools.map(toolName);
    this.toast.innerHTML = `<b>★ ${m.population} villagers!</b>${tools.length ? `<span>${tools.join(', ')} unlocked</span>` : ''}`;
    this.toast.hidden = false;
    this.toast.classList.remove('show');
    void this.toast.offsetWidth;
    this.toast.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast.hidden = true;
      this.toastTimer = null;
    }, 4200);
  }
}

/** Milestones (unlocks, then doublings) in (from, to]. */
export function milestonesBetween(from: number, to: number): { population: number; tools: string[] }[] {
  const out: { population: number; tools: string[] }[] = [];
  for (const m of unlockMilestones()) if (m.population > from && m.population <= to) out.push(m);
  let p = milestoneSpan(Math.max(from, 1)).next;
  while (p <= to) {
    if (!out.some((m) => m.population === p)) out.push({ population: p, tools: [] });
    p = milestoneSpan(p).next;
  }
  return out.sort((a, b) => a.population - b.population);
}
