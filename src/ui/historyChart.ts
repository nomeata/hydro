/**
 * History chart: the whole game at a glance, drawn as inline SVG. Two
 * stacked plots share the time axis (villagers on a log scale, prosperity
 * in %), over bands coloured by season; a weather strip below shows rain,
 * dry spells and floods. Stars on the villagers' right-hand axis mark the
 * population levels that unlock tools (filled once reached, outlined for the
 * ones still ahead, labelled where there is room), with a faint tick on the
 * time axis for the day each was reached; little medals between prosperity
 * and weather mark the achievements.
 */
import type { HistoryData, HistorySample } from '../shared/protocol';
import { toolName, unlockMilestones, type Milestone } from '../shared/progress';
import { STAR_PATH } from './icons';
import { achievementInfo } from '../shared/achievements';
import { CATEGORY_COLORS } from './achievementIcons';

const DAYS_PER_SEASON = 12;
const DAYS_PER_YEAR = 48;
const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'];
export const SEASON_COLORS = ['#e3f1cf', '#fbf0c0', '#f8e0c6', '#e4eef6'];
export const COLORS = {
  pop: '#2f86c4',
  pros: '#4e9a3c',
  rain: '#4aa3df',
  dry: '#d9a35b',
  power: '#e0a91b',
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
  return `<g ${attrs} transform="translate(${f1(cx - 16 * k)} ${f1(cy - 15 * k)}) scale(${k.toFixed(3)})"><path d="${STAR_PATH}" fill="${filled ? COLORS.star : '#fffdf6'}" stroke="${COLORS.starInk}" stroke-width="${f1(1.8 / k)}" stroke-linejoin="round"/></g>`;
}

function drop(cx: number, top: number, r: number): string {
  // A teardrop hanging from the top of the weather strip.
  const h = r * 2.6;
  const y = top + h;
  return `<path d="M${f1(cx)} ${f1(y - h)}C${f1(cx + r * 0.3)} ${f1(y - h * 0.55)} ${f1(cx + r)} ${f1(y - r * 1.1)} ${f1(cx + r)} ${f1(y - r)}A${f1(r)} ${f1(r)} 0 0 1 ${f1(cx - r)} ${f1(y - r)}C${f1(cx - r)} ${f1(y - r * 1.1)} ${f1(cx - r * 0.3)} ${f1(y - h * 0.55)} ${f1(cx)} ${f1(y - h)}z" fill="${COLORS.rain}" fill-opacity="0.85"/>`;
}

/** Text for a milestone star (and the readout when it is tapped). */
export function milestoneInfo(m: Milestone, day: number | undefined): string {
  const tools = m.tools.length ? m.tools.map(toolName).join(' & ') : 'A new step';
  return day === undefined ? `${tools} — unlocks at ${m.population} villagers` : `${tools} — unlocked at ${m.population} villagers, ${dayLabel(day)}`;
}

/** Build the chart for `data` at `width` CSS pixels. */
export function buildChart(data: HistoryData, width: number): Chart {
  const W = Math.max(280, Math.round(width));
  const narrow = W < 480;
  // Wide charts name the tools next to the axis stars; narrow ones only on tap.
  const labels = W >= 560;
  const ML = narrow ? 34 : 40;
  const MR = labels ? 104 : 28;
  const samples = data.samples;
  const last = samples[samples.length - 1];
  const now = last ? last.d + last.n : 0;
  const milestones = unlockMilestones();
  const reached = new Map(data.milestones.map((m) => [m.population, m.day]));
  const ahead = milestones.filter((m) => !reached.has(m.population));
  const dEnd = Math.max(DAYS_PER_SEASON, now);
  const x0 = ML;
  const x1 = W - MR;
  const dayToX = (d: number) => x0 + (d / dEnd) * (x1 - x0);
  const xToDay = (x: number) => ((x - x0) / (x1 - x0)) * dEnd;

  // Vertical layout.
  const popTop = 10;
  const popH = Math.round(Math.min(170, Math.max(110, W * 0.26)));
  const popBot = popTop + popH;
  const prosTop = popBot + 20;
  const prosH = Math.round(popH * 0.6);
  const prosBot = prosTop + prosH;
  const medalTop = prosBot + 3;
  const medalH = 20;
  const wxTop = medalTop + medalH + 1;
  const wxH = 26;
  const wxBot = wxTop + wxH;
  const axisH = 30;
  const H = wxBot + axisH;

  // Population: log scale from 1 to a power of ten covering the data (with
  // a little headroom) and the next milestone.
  const maxP = Math.max(10, ...samples.map((s) => s.p * 1.02), ahead[0]?.population ?? 0);
  const topP = 10 ** Math.ceil(Math.log10(maxP) - 1e-9);
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
  // Milestone levels (faint; the stars on the right axis say what they are).
  for (const m of milestones) {
    if (m.population > topP) continue;
    const y = popY(m.population);
    parts.push(`<line x1="${x0}" x2="${x1}" y1="${f1(y)}" y2="${f1(y)}" stroke="${COLORS.starInk}" stroke-opacity="${reached.has(m.population) ? 0.3 : 0.45}" stroke-dasharray="2 4"/>`);
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
  // Power produced (M6), behind prosperity: a golden area scaled to its own peak.
  const maxE = Math.max(0, ...samples.map((s) => s.e ?? 0));
  if (maxE > 0) {
    const eY = (e: number) => prosBot - (e / maxE) * prosH * 0.85;
    for (const seg of line((s) => (s.e !== undefined ? eY(s.e) : null), prosBot))
      parts.push(`<path class="power" d="${seg}" fill="${COLORS.power}" fill-opacity="0.22" stroke="${COLORS.power}" stroke-width="1.4" stroke-linejoin="round"/>`);
    parts.push(
      `<text x="${x1 - 6}" y="${prosTop + 14}" text-anchor="end" font-size="11" font-weight="700" fill="${COLORS.power}">Power (up to ${maxE >= 10 ? Math.round(maxE) : maxE.toFixed(1)} kW)</text>`,
    );
  }
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

  // Milestone stars on the right-hand axis at their population level (those
  // within the axis range): filled once reached, outlined while ahead. Stars
  // too close to the one below step outwards; labels are nudged apart.
  const starR = narrow ? 6 : 7;
  const shown = milestones.filter((m) => m.population <= topP);
  let prevY = Infinity;
  let col = 0;
  let labelY = Infinity;
  for (const m of shown) {
    const day = reached.get(m.population);
    const y = popY(m.population);
    col = prevY - y < 2 * starR - 1 ? (col + 1) % 2 : 0;
    prevY = y;
    const x = x1 + starR + 2 + col * (starR + 3);
    const cls = day === undefined ? 'star ahead' : 'star reached';
    parts.push(
      `<g class="${cls}" data-info="${esc(milestoneInfo(m, day))}" data-population="${m.population}"${day === undefined ? ' opacity="0.7"' : ''}><title>${esc(milestoneInfo(m, day))}</title><circle cx="${f1(x)}" cy="${f1(y)}" r="${starR + 3}" fill="transparent"/>${star(x, y, starR, day !== undefined, 'pointer-events="none"')}</g>`,
    );
    if (labels) {
      const ly = Math.min(y + 3.5, labelY - 11);
      labelY = ly;
      const name = m.tools.length ? m.tools.map(toolName).join(' & ') : String(m.population);
      parts.push(
        `<text x="${f1(x1 + 3 * starR + 12)}" y="${f1(ly)}" font-size="10" font-weight="${day === undefined ? 400 : 700}" fill="${COLORS.starInk}"${day === undefined ? ' fill-opacity="0.75"' : ''} pointer-events="none">${esc(name)}</text>`,
      );
    }
    // A faint tick on the time axis for the day it was reached.
    if (day !== undefined) {
      const tx = dayToX(day + 0.5);
      parts.push(`<path d="M${f1(tx)} ${wxBot}v5" stroke="${COLORS.starInk}" stroke-opacity="0.55" stroke-width="1.5"/>`);
    }
  }

  // Achievement medals along the timeline; those close together share one (with a count).
  const earned = [...(data.achievements ?? [])].sort((a, b) => a.day - b.day);
  const groups: { x: number; day: number; ids: string[] }[] = [];
  for (const e of earned) {
    const x = Math.max(x0 + 8, Math.min(x1 - 8, dayToX(e.day + 0.5)));
    const g = groups[groups.length - 1];
    if (g && x - g.x < 17) g.ids.push(e.id);
    else groups.push({ x, day: e.day, ids: [e.id] });
  }
  const my = medalTop + medalH / 2;
  for (const g of groups) {
    const names = g.ids.map((id) => achievementInfo(id)?.title ?? id);
    const first = achievementInfo(g.ids[0]!);
    const color = first ? CATEGORY_COLORS[first.category] : COLORS.star;
    const info = `${names.join(', ')} — ${dayLabel(g.day)}`;
    const rib = `<path d="M${f1(g.x - 4)} ${f1(my + 2)}l-2 7 3-1.5 2 2.5 1-7zM${f1(g.x + 4)} ${f1(my + 2)}l2 7-3-1.5-2 2.5-1-7z" fill="${color}" stroke="#fff" stroke-width="0.8"/>`;
    const disc = `<circle cx="${f1(g.x)}" cy="${f1(my - 1)}" r="7" fill="#fff4d0" stroke="${color}" stroke-width="2.6"/><circle cx="${f1(g.x)}" cy="${f1(my - 1)}" r="3" fill="${COLORS.star}"/>`;
    const count = g.ids.length > 1 ? `<text x="${f1(g.x + 7)}" y="${f1(my - 5)}" font-size="9" font-weight="700" fill="${COLORS.ink}" pointer-events="none">${g.ids.length}</text>` : '';
    parts.push(`<g class="medal-mark" data-info="${esc(info)}"><rect x="${f1(g.x - 9)}" y="${medalTop}" width="18" height="${medalH}" fill="transparent"/>${rib}${disc}</g>${count}`);
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
  if (s.e !== undefined && s.e > 0) parts.push(`${s.e >= 10 ? Math.round(s.e) : s.e.toFixed(1)} kW power${s.l ? `, ${s.l} house${s.l === 1 ? '' : 's'} lit` : ''}`);
  if (s.h > 0) parts.push(`flood: ${s.h} house${s.h === 1 ? '' : 's'} lost`);
  else if (s.f >= 20) parts.push('fields flooded');
  return parts.join(' · ');
}
