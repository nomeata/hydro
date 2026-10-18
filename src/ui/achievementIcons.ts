/**
 * Icons for the achievements (src/shared/achievements.ts), in the chunky
 * style of icons.ts, and the round medal they sit in.
 */
import type { AchievementCategory } from '../shared/achievements';
import { ICONS } from './icons';

const svg = (body: string) => `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;

const INK = '#6b4a2b';
const WATER = '#59b3e6';
const GREEN = '#7fbf5a';

const house = (x: number, y: number, s = 1, roof = '#d9694a', wall = '#f4e3c3') =>
  `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-6 0v-7h12v7z" fill="${wall}" stroke="${INK}" stroke-width="${1.6 / s}" stroke-linejoin="round"/><path d="M-8-6.5L0-13l8 6.5z" fill="${roof}" stroke="${INK}" stroke-width="${1.6 / s}" stroke-linejoin="round"/><rect x="-1.6" y="-4.6" width="3.2" height="4.6" fill="#8a6236"/></g>`;

export const ACHIEVEMENT_ICONS: Readonly<Record<string, string>> = {
  spade: svg(
    `<path d="M4 26h24" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/><path d="M8 26c1-3 4-4 6-3" fill="none" stroke="#b98a52" stroke-width="2.4" stroke-linecap="round"/><path d="M22 4l2 2-6 9-2-1z" fill="#b98a52" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/><path d="M14 13l5 3-3 6c-1 2-4 2-5 1l-1-1c-1-1 0-3 1-4z" fill="#9aa3ad" stroke="#4b5560" stroke-width="1.6" stroke-linejoin="round"/><path d="M20 3l5 4" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>`,
  ),
  canal: svg(
    `<path d="M3 9c8 0 8 14 26 14" fill="none" stroke="#c49a62" stroke-width="10" stroke-linecap="round"/><path d="M3 9c8 0 8 14 26 14" fill="none" stroke="${WATER}" stroke-width="5" stroke-linecap="round"/><path d="M7 9.5c3 1 4 4 5 6" stroke="#bfe6fa" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M19 22c2 .6 4 .8 6 .9" stroke="#bfe6fa" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
  ),
  lake: svg(
    `<ellipse cx="16" cy="19" rx="13" ry="8" fill="#c49a62" stroke="${INK}" stroke-width="1.8"/><ellipse cx="16" cy="19" rx="10" ry="5.6" fill="${WATER}"/><path d="M10 18q2-1.5 4 0t4 0M15 21.5q2-1.5 4 0" stroke="#d8f1fc" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M6 12c0-3 2-5 2-5s2 2 2 5" fill="${GREEN}" stroke="${INK}" stroke-width="1.3"/><path d="M23 11c0-3 2-5 2-5s2 2 2 5" fill="${GREEN}" stroke="${INK}" stroke-width="1.3"/>`,
  ),
  waterfall: svg(
    `<path d="M3 5h11v8H3z" fill="#9aa3ad" stroke="#4b5560" stroke-width="1.6" stroke-linejoin="round"/><path d="M3 5h11" stroke="${WATER}" stroke-width="3"/><path d="M14 5c4 0 5 3 5 9v9" fill="none" stroke="${WATER}" stroke-width="5" stroke-linecap="round"/><path d="M17 9v10" stroke="#d8f1fc" stroke-width="1.4" stroke-linecap="round"/><path d="M8 27c3-2 6-2 11-3 4 0 7 1 10 3" fill="none" stroke="${WATER}" stroke-width="3" stroke-linecap="round"/><g fill="#fff" stroke="#8fd0f2" stroke-width="1"><circle cx="15" cy="23" r="2"/><circle cx="23" cy="23.5" r="1.8"/><circle cx="19" cy="21" r="1.4"/></g>`,
  ),
  stone: ICONS.line,
  weir: ICONS.weir,
  gate: ICONS.gate,
  wheel: ICONS.wheel,
  valve: svg(
    `<path d="M2 10h9v14H2z" fill="${WATER}"/><path d="M5 13q2-1.5 4 0" stroke="#d8f1fc" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M8 27l5-15h8l5 15z" fill="#c49a62" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/><path d="M14.5 27V12M19.5 27V12" stroke="#8d6438" stroke-width="2.2"/><rect x="14.5" y="8" width="5" height="9" fill="#b98a52" stroke="${INK}" stroke-width="1.4"/><path d="M12 7h10" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/><path d="M11 24h19" stroke="${WATER}" stroke-width="3.4" stroke-linecap="round"/><path d="M26 21l4 3-4 3" fill="none" stroke="#2f86c4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  sprout: svg(
    `<path d="M3 26h26" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/><path d="M5 26l3-3h16l3 3z" fill="#c49a62" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/><path d="M16 23V13" stroke="#4e9a3c" stroke-width="2.4" stroke-linecap="round"/><path d="M16 15c-6 0-8-4-8-7 4 0 8 2 8 7zM16 13c0-5 3-8 8-8 0 5-3 8-8 8z" fill="${GREEN}" stroke="#3f7a2e" stroke-width="1.5" stroke-linejoin="round"/><path d="M24 20q2-2 4 0" stroke="${WATER}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
  ),
  green: svg(
    `<circle cx="16" cy="16" r="12" fill="#e9d29b" stroke="${INK}" stroke-width="1.8"/><path d="M6 21c4-1 6-6 10-6s7 5 10 6c-2 3-6 5-10 5s-8-2-10-5z" fill="${GREEN}" stroke="#3f7a2e" stroke-width="1.5" stroke-linejoin="round"/><path d="M16 5c2 3 4 5 4 7a4 4 0 0 1-8 0c0-2 2-4 4-7z" fill="${WATER}" stroke="#2f86c4" stroke-width="1.4" stroke-linejoin="round"/><path d="M10 21v-3M14 22v-3M19 22v-3M23 21v-3" stroke="#3f7a2e" stroke-width="1.6" stroke-linecap="round"/>`,
  ),
  house: svg(`<path d="M3 27h26" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>${house(16, 27, 1.55)}<path d="M23 7c1-2 3-2 4 0" stroke="#bbb" stroke-width="1.6" fill="none" stroke-linecap="round"/><rect x="20" y="9" width="3" height="6" fill="#8d6438" stroke="${INK}" stroke-width="1.2"/>`),
  houses: svg(`<path d="M2 27h28" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>${house(10, 27, 1.15)}${house(22, 27, 1.15, '#4f8fc0')}`),
  village: svg(
    `<path d="M2 28h28" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>${house(8, 28, 0.9)}${house(24, 28, 0.9, '#4f8fc0')}${house(16, 20, 0.9, '#e8a23a')}`,
  ),
  wheat: svg(
    `<g stroke="#a8740a" stroke-width="1.4" stroke-linejoin="round" fill="#f2c94c"><path d="M16 29V9"/><ellipse cx="16" cy="7" rx="2.2" ry="3.4"/><ellipse cx="12.6" cy="12" rx="2" ry="3.2" transform="rotate(-30 12.6 12)"/><ellipse cx="19.4" cy="12" rx="2" ry="3.2" transform="rotate(30 19.4 12)"/><ellipse cx="12.6" cy="18" rx="2" ry="3.2" transform="rotate(-30 12.6 18)"/><ellipse cx="19.4" cy="18" rx="2" ry="3.2" transform="rotate(30 19.4 18)"/></g>`,
  ),
  fish: svg(
    `<path d="M4 25q4-3 8 0t8 0 8 0" stroke="${WATER}" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M6 14c4-6 13-6 17 0-4 6-13 6-17 0z" fill="#f0a35e" stroke="#9a5a2a" stroke-width="1.8" stroke-linejoin="round"/><path d="M23 14l6-5v10z" fill="#f0a35e" stroke="#9a5a2a" stroke-width="1.8" stroke-linejoin="round"/><circle cx="10.5" cy="13" r="1.5" fill="#3b3328"/><path d="M14 11q2 3 0 6" stroke="#9a5a2a" stroke-width="1.3" fill="none"/>`,
  ),
  sheaf: svg(
    `<g stroke="#a8740a" stroke-width="1.5" stroke-linecap="round"><path d="M16 28L9 6M16 28l7-22M16 28V5M16 28L5 10M16 28l11-18"/></g><g fill="#f2c94c" stroke="#a8740a" stroke-width="1.2"><ellipse cx="9" cy="6" rx="2" ry="3" transform="rotate(-18 9 6)"/><ellipse cx="23" cy="6" rx="2" ry="3" transform="rotate(18 23 6)"/><ellipse cx="16" cy="4.5" rx="2" ry="3"/><ellipse cx="5" cy="10" rx="2" ry="3" transform="rotate(-40 5 10)"/><ellipse cx="27" cy="10" rx="2" ry="3" transform="rotate(40 27 10)"/></g><path d="M10 20h12" stroke="#c0392b" stroke-width="3" stroke-linecap="round"/><circle cx="25" cy="24" r="4" fill="#f7c948" stroke="#b07a1e" stroke-width="1.4"/><path d="M25 21.5l.8 1.7 1.8.2-1.3 1.2.4 1.8-1.7-.9-1.7.9.4-1.8-1.3-1.2 1.8-.2z" fill="#fff6c8"/>`,
  ),
  quay: svg(
    `<path d="M2 20h28v10H2z" fill="${WATER}"/><path d="M5 24q3-2 6 0t6 0 6 0" stroke="#d8f1fc" stroke-width="1.5" fill="none" stroke-linecap="round"/><g fill="#b9b4aa" stroke="#5f5a52" stroke-width="1.4"><rect x="2" y="15" width="8" height="5" rx="1.2"/><rect x="10" y="15" width="8" height="5" rx="1.2"/><rect x="18" y="15" width="8" height="5" rx="1.2"/><rect x="26" y="15" width="5" height="5" rx="1.2"/></g>${house(11, 14, 0.85)}<path d="M23 15v-4" stroke="${INK}" stroke-width="2" stroke-linecap="round"/><circle cx="23" cy="10" r="1.6" fill="#8d6438"/>`,
  ),
  jetty: svg(
    `<path d="M2 21h28v9H2z" fill="${WATER}"/><path d="M4 25q3-2 6 0t6 0 6 0 6 0" stroke="#d8f1fc" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M2 16h6l-2 5H2z" fill="#7fbf5a" stroke="${INK}" stroke-width="1.4"/><rect x="6" y="14" width="22" height="3" rx="1" fill="#c4935c" stroke="${INK}" stroke-width="1.4"/><path d="M11 17v9M18 17v9M25 17v9" stroke="#8d6438" stroke-width="2.2" stroke-linecap="round"/><path d="M24 14l4-9" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/><path d="M28 5c1 5 0 9 0 12" stroke="#7b8d9c" stroke-width=".9" fill="none"/>`,
  ),
  pop: ICONS.faces,
  cow: svg(
    `<path d="M3 27h26" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/><path d="M7 13h15a4 4 0 0 1 4 4v4H7z" fill="#fbf7ef" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/><path d="M11 13c1 3 4 4 6 2M19 21c0-2 2-3 4-3" fill="#3b3328"/><path d="M9 21v5M13 21v5M20 21v5M24 21v5" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/><rect x="23" y="9" width="7" height="7" rx="2" fill="#fbf7ef" stroke="${INK}" stroke-width="1.6"/><path d="M24 9l-1-3M29 9l1-3" stroke="#c9a66b" stroke-width="1.6" stroke-linecap="round"/><rect x="26" y="13" width="4" height="3" rx="1.2" fill="#f2a7a0"/><circle cx="25.5" cy="11.5" r=".9" fill="#3b3328"/><path d="M7 15q-3 2-3 6" stroke="${INK}" stroke-width="1.4" fill="none" stroke-linecap="round"/>`,
  ),
  path: svg(
    `<rect x="2" y="3" width="28" height="26" rx="5" fill="${GREEN}" stroke="#3f7a2e" stroke-width="1.6"/><path d="M8 29c0-6 9-6 9-12s-7-6-5-14" fill="none" stroke="#c49a62" stroke-width="5.5" stroke-linecap="round"/><path d="M8 29c0-6 9-6 9-12s-7-6-5-14" fill="none" stroke="#dcbb8a" stroke-width="2" stroke-linecap="round" stroke-dasharray="1.5 3"/>${house(24, 12, 0.7)}<path d="M22 24l2-3 2 3M5 10l2-3 2 3" stroke="#3f7a2e" stroke-width="1.4" fill="none" stroke-linecap="round"/>`,
  ),
  forest: svg(
    `<path d="M3 27h26" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/><path d="M9 27v-5M17 27v-6M24 27v-4" stroke="#8d6438" stroke-width="2" stroke-linecap="round"/><path d="M9 4l6 10h-3l4 8H2l4-8H3z" fill="#4e9a3c" stroke="#2f6a25" stroke-width="1.4" stroke-linejoin="round"/><circle cx="18" cy="15" r="6.5" fill="${GREEN}" stroke="#3f7a2e" stroke-width="1.4"/><circle cx="25" cy="19" r="4.5" fill="#6aae4a" stroke="#3f7a2e" stroke-width="1.4"/><path d="M26 6q2 2 4 0M26 6q2-2 4 0" stroke="${WATER}" stroke-width="1.6" fill="none"/><path d="M28 7v4" stroke="${WATER}" stroke-width="1.6" stroke-linecap="round"/>`,
  ),
  storm: svg(
    `<path d="M8 15a6 6 0 0 1 1-11 8 8 0 0 1 15 3 5 5 0 0 1-1 8z" fill="#c9d6e0" stroke="#6f8292" stroke-width="1.8" stroke-linejoin="round"/><path d="M11 17l-2 4M16 17l-2 4M21 17l-2 4" stroke="#3d9bd6" stroke-width="2" stroke-linecap="round"/><path d="M2 29q4-3 8 0t8 0 8 0 6 0" stroke="${WATER}" stroke-width="2.4" fill="none" stroke-linecap="round"/>${house(24, 27, 0.8)}`,
  ),
  rebuild: svg(
    `<path d="M3 27h26" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>${house(13, 27, 1.35)}<path d="M21 5l5 5-2 2-5-5z" fill="#9aa3ad" stroke="#4b5560" stroke-width="1.4" stroke-linejoin="round"/><path d="M21 10l-6 6" stroke="#8d6438" stroke-width="2.6" stroke-linecap="round"/><path d="M27 15l1.2-2.5M29 19l2.5-.8M25 18l.5 2.6" stroke="#f2b705" stroke-width="1.8" stroke-linecap="round"/>`,
  ),
  year: svg(
    `<circle cx="16" cy="16" r="12.5" fill="#fbf5e6" stroke="${INK}" stroke-width="1.8"/><path d="M16 16V3.5A12.5 12.5 0 0 1 28.5 16z" fill="#e3f1cf"/><path d="M16 16h12.5A12.5 12.5 0 0 1 16 28.5z" fill="#fbe39a"/><path d="M16 16v12.5A12.5 12.5 0 0 1 3.5 16z" fill="#f4c99c"/><path d="M16 16H3.5A12.5 12.5 0 0 1 16 3.5z" fill="#d6e6f4"/><circle cx="16" cy="16" r="12.5" fill="none" stroke="${INK}" stroke-width="1.8"/><circle cx="21" cy="10" r="2" fill="${GREEN}"/><circle cx="22" cy="22" r="2.2" fill="#f7c948"/><circle cx="10" cy="22" r="2" fill="#e8873a"/><circle cx="10.5" cy="10" r="2" fill="#fff" stroke="#9cc7e6"/>`,
  ),
  decade: svg(
    `<path d="M8 28V12M16 28V8M24 28V4" stroke="${INK}" stroke-width="2" stroke-linecap="round"/><circle cx="8" cy="13" r="5" fill="${GREEN}" stroke="#3f7a2e" stroke-width="1.6"/><circle cx="16" cy="10" r="6.5" fill="#6aae4a" stroke="#3f7a2e" stroke-width="1.6"/><circle cx="24" cy="8" r="7.5" fill="#4e9a3c" stroke="#3f7a2e" stroke-width="1.6"/><path d="M3 28h26" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>`,
  ),
};

export const CATEGORY_COLORS: Readonly<Record<AchievementCategory, string>> = {
  water: '#3d9bd6',
  land: '#5fa548',
  people: '#e8873a',
  time: '#9a7ac4',
};

/** A round medal with the achievement's icon (styled by .medal in styles.css). */
export function medal(icon: string, category: AchievementCategory, extra = ''): string {
  return `<span class="medal ${extra}" style="--medal:${CATEGORY_COLORS[category]}"><i>${ACHIEVEMENT_ICONS[icon] ?? ''}</i></span>`;
}
