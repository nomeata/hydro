/**
 * History chart: the whole game at a glance, drawn as inline SVG. Two
 * stacked plots share the time axis (villagers on a log scale, prosperity
 * in %), over bands coloured by season; a weather strip below shows rain,
 * dry spells and floods; stars along the top mark the tool-unlock
 * milestones (filled once reached, outlined for the ones still ahead).
 */
import type { HistoryData, HistorySample } from '../shared/protocol';
import { toolName, unlockMilestones } from '../shared/progress';
import { STAR_PATH } from './icons';

const DAYS_PER_SEASON = 12;
const DAYS_PER_YEAR = 48;
const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'];
export const SEASON_COLORS = ['#e3f1cf', '#fbf0c0', '#f8e0c6', '#e4eef6'];
export const COLORS = {
  pop: '#2f86c4',
  pros: '#4e9a3c',
  rain: '#4aa3df',
  dry: '#d9a35b',
  flood: '#2b6cb0',
  star: '#f2b705',
  starInk: '#a8740a',
  ink: '#3b3328',
  muted: '#7a6c58',
  grid: 'rgba(90, 70, 40, 0.14)',
};
/**
 * A day counts as dry below this fraction of the record's mean
 * precipitation (map means are rarely zero: some front is always about),
 * and warm above WARM_C.
 */
const DRY_FRACTION = 0.3;
const WARM_C = 10;
/** Dry warm runs at least this long are shaded as dry spells. */
const DRY_SPELL_DAYS = 6;

export interface ChartLayout {
  width: number;
  height: number;
  /** Plot area x range and the day → x mapping. */
  x0: number;
  x1: number;
  dayToX(d: number): number;
  xToDay(x: number): number;
  /** Vertical extent of the hover area. */
  top: number;
  bottom: number;
  popY(p: number): number;
  prosY(w: number): number;
  /** Day where the data ends ("now"). */
  now: number;
}

export interface Chart {
  svg: string;
  layout: ChartLayout;
}

/** "Year 2 · Summer, day 5" for a game day. */
export function dayLabel(d: number, n = 1): string {
  const year = Math.floor(d / DAYS_PER_YEAR) + 1;
  const doy = d % DAYS_PER_YEAR;
  const season = SEASON_NAMES[Math.floor(doy / DAYS_PER_SEASON)]!;
  const ds = (doy % DAYS_PER_SEASON) + 1;
  if (n <= 1) return `Year ${year} · ${season}, day ${ds}`;
  if (n >= DAYS_PER_YEAR) return `Year ${year}`;
  return `Year ${year} · ${season}, days ${ds}–${ds + n - 1}`;
}

/** Runs of dry warm days (as [startDay, endDay)) of at least DRY_SPELL_DAYS. */
export function drySpells(samples: readonly HistorySample[]): [number, number][] {
  const out: [number, number][] = [];
  const days = samples.reduce((n, s) => n + s.n, 0);
  const mean = days ? samples.reduce((r, s) => r + s.r * s.n, 0) / days : 0;
  const dryMM = Math.max(0.2, mean * DRY_FRACTION);
  let start = -1;
  let end = -1;
  const flush = () => {
    if (start >= 0 && end - start >= DRY_SPELL_DAYS) out.push([start, end]);
    start = -1;
  };
  for (const s of samples) {
    const dry = s.r < dryMM && s.t > WARM_C;
    if (dry) {
      if (start < 0 || s.d > end) {
        flush();
        start = s.d;
      }
      end = s.d + s.n;
    } else flush();
  }
  flush();
  return out;
}

const f1 = (x: number) => x.toFixed(1);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function star(cx: number, cy: number, r: number, filled: boolean, attrs: string): string {
  const k = r / 13;
  return `<g ${attrs} transform="translate(${f1(cx - 16 * k)} ${f1(cy - 15 * k)}) scale(${k.toFixed(3)})"><path d="${STAR_PATH}" fill="${filled ? COLORS.star : '#fffdf6'}" stroke="${COLORS.starInk}" stroke-width="${f1(1.8 / k)}" stroke-linejoin="round"${filled ? '' : ' stroke-dasharray="3 2.2"'}/></g>`;
}

function drop(cx: number, top: number, r: number): string {
  // A teardrop hanging from the top of the weather strip.
  const h = r * 2.6;
  const y = top + h;
  return `<path d="M${f1(cx)} ${f1(y - h)}C${f1(cx + r * 0.3)} ${f1(y - h * 0.55)} ${f1(cx + r)} ${f1(y - r * 1.1)} ${f1(cx + r)} ${f1(y - r)}A${f1(r)} ${f1(r)} 0 0 1 ${f1(cx - r)} ${f1(y - r)}C${f1(cx - r)} ${f1(y - r * 1.1)} ${f1(cx - r * 0.3)} ${f1(y - h * 0.55)} ${f1(cx)} ${f1(y - h)}z" fill="${COLORS.rain}" fill-opacity="0.85"/>`;
}

/**
 * Build the chart for `data` at `width` CSS pixels. `peak` is the highest
 * population so far (for the milestones still ahead).
 */
export function buildChart(data: HistoryData, width: number): Chart {
  const W = Math.max(280, Math.round(width));
  const narrow = W < 480;
  const ML = narrow ? 34 : 40;
  const MR = 10;
  const samples = data.samples;
  const last = samples[samples.length - 1];
  const now = last ? last.d + last.n : 0;
  const milestones = unlockMilestones();
  const reached = new Map(data.milestones.map((m) => [m.population, m.day]));
  const ahead = milestones.filter((m) => !reached.has(m.population));
  // Leave a little "future" on the right for the stars still ahead.
  const span = Math.max(DAYS_PER_SEASON, now);
  const future = ahead.length ? Math.max(span * 0.12, (ahead.length * 22 * span) / Math.max(100, W - ML - MR - ahead.length * 22)) : 0;
  const dEnd = span + future;
  const x0 = ML;
  const x1 = W - MR;
  const dayToX = (d: number) => x0 + (d / dEnd) * (x1 - x0);
  const xToDay = (x: number) => ((x - x0) / (x1 - x0)) * dEnd;

  // Vertical layout.
  const starTop = 4;
  const starH = 26;
  const popTop = starTop + starH;
  const popH = Math.round(Math.min(170, Math.max(110, W * 0.26)));
  const popBot = popTop + popH;
  const prosTop = popBot + 20;
  const prosH = Math.round(popH * 0.6);
  const prosBot = prosTop + prosH;
  const wxTop = prosBot + 4;
  const wxH = 26;
  const wxBot = wxTop + wxH;
  const axisH = 30;
  const H = wxBot + axisH;

  // Population: log scale from 1 to a power of ten covering the data and the next milestone.
  const maxP = Math.max(10, ...samples.map((s) => s.p), ahead[0]?.population ?? 0);
  const topP = 10 ** Math.ceil(Math.log10(maxP * 1.02));
  const popY = (p: number) => popBot - (Math.log10(Math.max(1, p)) / Math.log10(topP)) * popH;
  const prosY = (w: number) => prosBot - (w / 100) * prosH;

  const parts: string[] = [];
  const font = `font-family="inherit" fill="${COLORS.muted}"`;

  // Season bands (behind everything), across both plots and the weather strip.
  const nSeasons = Math.ceil(dEnd / DAYS_PER_SEASON);
  for (let k = 0; k < nSeasons; k++) {
    const a = dayToX(k * DAYS_PER_SEASON);
    const b = Math.min(x1, dayToX((k + 1) * DAYS_PER_SEASON));
    const c = SEASON_COLORS[k % 4]!;
    for (const [t, bt] of [
      [popTop, popBot],
      [prosTop, prosBot],
      [wxTop, wxBot],
    ] as const)
      parts.push(`<rect x="${f1(a)}" y="${t}" width="${f1(b - a + 0.5)}" height="${bt - t}" fill="${c}"/>`);
  }
  // The future, faded.
  if (future > 0) {
    const a = dayToX(now);
    parts.push(`<rect x="${f1(a)}" y="${popTop}" width="${f1(x1 - a)}" height="${wxBot - popTop}" fill="#fbf5e6" fill-opacity="0.7"/>`);
  }

  // Dry spells: a warm wash with a hatch, across everything.
  for (const [a, b] of drySpells(samples)) {
    const xa = dayToX(a);
    const xb = dayToX(b);
    parts.push(`<rect class="dry" x="${f1(xa)}" y="${popTop}" width="${f1(xb - xa)}" height="${wxBot - popTop}" fill="url(#hatch)"/>`);
  }

  // Grid and y ticks: population.
  for (let p = 1; p <= topP; p *= 10) {
    const y = popY(p);
    parts.push(`<line x1="${x0}" x2="${x1}" y1="${f1(y)}" y2="${f1(y)}" stroke="${COLORS.grid}"/>`);
    parts.push(`<text x="${x0 - 5}" y="${f1(y + 4)}" text-anchor="end" font-size="11" ${font}>${p >= 1000 ? `${p / 1000}k` : p}</text>`);
  }
  // Milestone levels.
  for (const m of milestones) {
    if (m.population > topP) continue;
    const y = popY(m.population);
    parts.push(`<line x1="${x0}" x2="${x1}" y1="${f1(y)}" y2="${f1(y)}" stroke="${COLORS.starInk}" stroke-opacity="0.45" stroke-dasharray="2 4"/>`);
  }
  // Prosperity.
  for (const w of [0, 50, 100]) {
    const y = prosY(w);
    parts.push(`<line x1="${x0}" x2="${x1}" y1="${f1(y)}" y2="${f1(y)}" stroke="${COLORS.grid}"/>`);
    parts.push(`<text x="${x0 - 5}" y="${f1(y + 4)}" text-anchor="end" font-size="11" ${font}>${w}%</text>`);
  }
  // Plot titles.
  parts.push(`<text x="${x0 + 6}" y="${popTop + 14}" font-size="12" font-weight="700" fill="${COLORS.ink}">Villagers</text>`);
  parts.push(`<text x="${x0 + 6}" y="${prosTop + 14}" font-size="12" font-weight="700" fill="${COLORS.ink}">Prosperity</text>`);

  // Floods: a thin line across the plots where houses were lost, a wave mark in the strip.
  for (const s of samples) {
    if (s.h <= 0 && s.f < 20) continue;
    const x = dayToX(s.d + s.n / 2);
    if (s.h > 0) parts.push(`<line x1="${f1(x)}" x2="${f1(x)}" y1="${popTop}" y2="${wxTop}" stroke="${COLORS.flood}" stroke-opacity="0.35" stroke-dasharray="3 3"/>`);
    const r = s.h > 0 ? 6 : 4.5;
    const y = wxBot - 5;
    parts.push(
      `<path d="M${f1(x - r)} ${f1(y)}q${f1(r / 2)} ${f1(-r)} ${f1(r)} 0t${f1(r)} 0" fill="none" stroke="${COLORS.flood}" stroke-width="2.2" stroke-linecap="round"/>`,
    );
  }

  // Rain drops for the rainier days, sized by the amount relative to the
  // wettest day; thinned so they never merge into a blob.
  const maxR = Math.max(5, ...samples.map((s) => s.r));
  const rainDays = samples.reduce((n, s) => n + s.n, 0);
  const meanR = rainDays ? samples.reduce((a, s) => a + s.r * s.n, 0) / rainDays : 0;
  const rainy = Math.max(1, meanR * 1.25);
  let lastX = -Infinity;
  let lastR = 0;
  for (const s of samples) {
    if (s.r < rainy) continue;
    const x = dayToX(s.d + s.n / 2);
    const r = 1 + 4 * Math.sqrt(s.r / maxR);
    if (x - lastX < (r + lastR) * 0.9) {
      continue;
    }
    lastX = x;
    lastR = r;
    parts.push(drop(x, wxTop + 1, r));
  }

  // Lines.
  const line = (pick: (s: HistorySample) => number | null, area: number | null) => {
    let d = '';
    let pen = false;
    let first = 0;
    let lastPx = 0;
    const segs: string[] = [];
    for (const s of samples) {
      const v = pick(s);
      const x = dayToX(s.d + s.n / 2);
      if (v === null) {
        if (pen && area !== null) segs.push(`${d}L${f1(lastPx)} ${area}L${f1(first)} ${area}z`);
        else if (pen) segs.push(d);
        pen = false;
        d = '';
        continue;
      }
      d += `${pen ? 'L' : 'M'}${f1(x)} ${f1(v)}`;
      if (!pen) first = x;
      pen = true;
      lastPx = x;
    }
    if (pen) segs.push(area !== null ? `${d}L${f1(lastPx)} ${area}L${f1(first)} ${area}z` : d);
    return segs;
  };
  for (const seg of line((s) => (s.p > 0 ? popY(s.p) : null), popBot))
    parts.push(`<path d="${seg}" fill="${COLORS.pop}" fill-opacity="0.08"/>`);
  for (const seg of line((s) => (s.p > 0 ? popY(s.p) : null), null))
    parts.push(`<path d="${seg}" fill="none" stroke="${COLORS.pop}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`);
  for (const seg of line((s) => (s.p > 0 ? prosY(s.w) : null), null))
    parts.push(`<path d="${seg}" fill="none" stroke="${COLORS.pros}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`);
  // Today's values as end dots.
  if (last && last.p > 0) {
    parts.push(`<circle cx="${f1(dayToX(last.d + last.n / 2))}" cy="${f1(popY(last.p))}" r="4" fill="${COLORS.pop}" stroke="#fff" stroke-width="2"/>`);
    parts.push(`<circle cx="${f1(dayToX(last.d + last.n / 2))}" cy="${f1(prosY(last.w))}" r="4" fill="${COLORS.pros}" stroke="#fff" stroke-width="2"/>`);
  }
  if (!samples.some((s) => s.p > 0)) {
    parts.push(`<text x="${f1((x0 + x1) / 2)}" y="${f1((popTop + popBot) / 2 + 4)}" text-anchor="middle" font-size="13" ${font}>Waiting for the first settlers…</text>`);
  }

  // "Now" marker.
  if (future > 0) {
    const x = dayToX(now);
    parts.push(`<line x1="${f1(x)}" x2="${f1(x)}" y1="${popTop}" y2="${wxBot}" stroke="${COLORS.muted}" stroke-opacity="0.5"/>`);
  }

  // Plot frames.
  for (const [t, b] of [
    [popTop, popBot],
    [prosTop, prosBot],
  ] as const)
    parts.push(`<rect x="${x0}" y="${t}" width="${x1 - x0}" height="${b - t}" fill="none" stroke="${COLORS.grid}" stroke-width="1.5" rx="3"/>`);

  // X axis: years (and seasons when there is room).
  const yearW = dayToX(DAYS_PER_YEAR) - dayToX(0);
  const every = yearW >= 46 ? 1 : Math.ceil(46 / yearW);
  for (let y = 0; y * DAYS_PER_YEAR <= dEnd; y++) {
    const x = dayToX(y * DAYS_PER_YEAR);
    parts.push(`<line x1="${f1(x)}" x2="${f1(x)}" y1="${popTop}" y2="${wxBot + 4}" stroke="${COLORS.muted}" stroke-opacity="${y === 0 ? 0 : 0.35}"/>`);
    if (y % every === 0 && x + 20 < x1 + MR)
      parts.push(`<text x="${f1(x + 3)}" y="${wxBot + 26}" font-size="12" font-weight="700" fill="${COLORS.ink}">Year ${y + 1}</text>`);
  }
  if (yearW / 4 >= 34) {
    for (let k = 0; k < nSeasons; k++) {
      const a = dayToX(k * DAYS_PER_SEASON);
      const b = Math.min(x1, dayToX((k + 1) * DAYS_PER_SEASON));
      if (b - a < 30) continue;
      const name = SEASON_NAMES[k % 4]!;
      parts.push(`<text x="${f1((a + b) / 2)}" y="${wxBot + 12}" text-anchor="middle" font-size="10" ${font}>${b - a > 60 ? name : name.slice(0, 3)}</text>`);
    }
  }

  // Stars along the top: reached at their day, upcoming in the future zone.
  const starY = starTop + starH / 2;
  const starR = 10;
  let prevStar = -Infinity;
  for (const m of milestones) {
    const day = reached.get(m.population);
    if (day === undefined) continue;
    // Keep close stars (and their labels) apart.
    const x = Math.max(prevStar + 2 * starR + 18, Math.max(x0 + starR, Math.min(x1 - starR, dayToX(day))));
    prevStar = x;
    const info = `${m.population} villagers on ${dayLabel(day)} — ${m.tools.map(toolName).join(' & ')} unlocked`;
    parts.push(`<line x1="${f1(dayToX(day))}" x2="${f1(dayToX(day))}" y1="${starY + starR}" y2="${f1(popY(m.population))}" stroke="${COLORS.starInk}" stroke-opacity="0.35" stroke-dasharray="2 3"/>`);
    parts.push(star(x, starY, starR, true, `class="star reached" data-info="${esc(info)}"`));
    parts.push(`<text x="${f1(x + starR + 2)}" y="${f1(starY + 4)}" font-size="10" font-weight="700" fill="${COLORS.starInk}" pointer-events="none">${m.population}</text>`);
  }
  if (ahead.length) {
    const a = dayToX(now) + starR + 2;
    const step = Math.min(30, (x1 - starR - a) / Math.max(1, ahead.length - 1));
    ahead.forEach((m, k) => {
      const x = ahead.length === 1 ? (a + x1 - starR) / 2 : a + k * step;
      const info = `${m.tools.map(toolName).join(' & ')} — unlocks at ${m.population} villagers`;
      parts.push(star(x, starY, starR - 1, false, `class="star ahead" data-info="${esc(info)}"`));
    });
  }

  const defs = `<defs><pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="${COLORS.dry}" fill-opacity="0.16"/><line x1="0" y1="0" x2="0" y2="7" stroke="${COLORS.dry}" stroke-opacity="0.5" stroke-width="2"/></pattern></defs>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="History of villagers and prosperity">${defs}${parts.join('')}<g class="cursor"></g></svg>`;
  return {
    svg,
    layout: { width: W, height: H, x0, x1, dayToX, xToDay, top: popTop, bottom: wxBot, popY, prosY, now },
  };
}

/** The sample covering (or nearest to) `day`. */
export function sampleAt(samples: readonly HistorySample[], day: number): HistorySample | null {
  let best: HistorySample | null = null;
  let bestD = Infinity;
  for (const s of samples) {
    if (day >= s.d && day < s.d + s.n) return s;
    const d = Math.abs(s.d + s.n / 2 - day);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** One line describing a sample. */
export function describeSample(s: HistorySample): string {
  const parts = [dayLabel(s.d, s.n)];
  if (s.p > 0) parts.push(`${s.p} villager${s.p === 1 ? '' : 's'}`, `prosperity ${Math.round(s.w)}%`);
  else parts.push('no villagers yet');
  parts.push(s.r >= 0.05 ? `${s.r.toFixed(1)} mm rain${s.n > 1 ? '/day' : ''}` : 'dry', `${Math.round(s.t)} °C`);
  if (s.h > 0) parts.push(`flood: ${s.h} house${s.h === 1 ? '' : 's'} lost`);
  else if (s.f >= 20) parts.push('fields flooded');
  return parts.join(' · ');
}
