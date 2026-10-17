/** Small inline SVG icons, drawn in a chunky, friendly style. */
const svg = (body: string, vb = '0 0 32 32') =>
  `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  pause: svg('<rect x="8" y="6" width="6" height="20" rx="2" fill="currentColor"/><rect x="18" y="6" width="6" height="20" rx="2" fill="currentColor"/>'),
  play: svg('<path d="M9 5l18 11-18 11z" fill="currentColor" stroke="currentColor" stroke-linejoin="round" stroke-width="2"/>'),
  hand: svg(
    '<path d="M10 17V8a2 2 0 0 1 4 0v7V5a2 2 0 0 1 4 0v10V7a2 2 0 0 1 4 0v9-5a2 2 0 0 1 4 0v8c0 6-4 10-9 10-4 0-6-2-8-5l-4-6a2 2 0 0 1 3-2z" fill="#f3d2a8" stroke="#6b4a2b" stroke-width="1.8" stroke-linejoin="round"/>',
  ),
  trench: svg(
    '<path d="M3 22h7l3 5h6l3-5h7" fill="none" stroke="#6b4a2b" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 27h6l3-5H10z" fill="#59b3e6"/><path d="M21 3l3 3-9 9-3-3z" fill="#9aa3ad" stroke="#4b5560" stroke-width="1.5"/><path d="M12 12l3 3-5 5c-1 1-3 0-3-1v-2z" fill="#b98a52" stroke="#6b4a2b" stroke-width="1.5"/>',
  ),
  dike: svg(
    '<path d="M2 26h28" stroke="#6b4a2b" stroke-width="2.4" stroke-linecap="round"/><path d="M5 26l6-12h10l6 12z" fill="#c49a62" stroke="#6b4a2b" stroke-width="2" stroke-linejoin="round"/><path d="M11 14h10" stroke="#7fbf5a" stroke-width="3" stroke-linecap="round"/><path d="M24 20c2 1 4 1 6 0" stroke="#59b3e6" stroke-width="2.2" fill="none" stroke-linecap="round"/>',
  ),
  level: svg(
    '<path d="M3 24c4-6 7-9 10-6s5 2 7-1 6-3 9 1" fill="none" stroke="#b98a52" stroke-width="2" stroke-dasharray="2 2.5" stroke-linecap="round"/><path d="M3 22h26v5H3z" fill="#c49a62" stroke="#6b4a2b" stroke-width="2" stroke-linejoin="round"/><path d="M9 6h14l-2 9H11z" fill="#9aa3ad" stroke="#4b5560" stroke-width="1.6" stroke-linejoin="round"/><path d="M16 15v5" stroke="#6b4a2b" stroke-width="2.4" stroke-linecap="round"/>',
  ),
  erase: svg(
    '<circle cx="16" cy="16" r="11" fill="#fbe1d6" stroke="#b5482d" stroke-width="2.4"/><path d="M11 11l10 10M21 11L11 21" stroke="#b5482d" stroke-width="2.6" stroke-linecap="round"/>',
  ),
  sun: svg(
    '<g stroke="#e8a23a" stroke-width="2.4" stroke-linecap="round"><path d="M16 2v4M16 26v4M2 16h4M26 16h4M6 6l3 3M23 23l3 3M6 26l3-3M23 9l3-3"/></g><circle cx="16" cy="16" r="7" fill="#f7c948" stroke="#e8a23a" stroke-width="2"/>',
  ),
  moon: svg('<path d="M21 4a12 12 0 1 0 7 17A10 10 0 0 1 21 4z" fill="#f4e7a1" stroke="#c9b45a" stroke-width="2"/>'),
  rain: svg(
    '<path d="M9 18a6 6 0 0 1 1-12 8 8 0 0 1 15 3 5 5 0 0 1-1 9z" fill="#dfe8ef" stroke="#7b8d9c" stroke-width="2" stroke-linejoin="round"/><g stroke="#3d9bd6" stroke-width="2.4" stroke-linecap="round"><path d="M11 22l-2 5M17 22l-2 5M23 22l-2 5"/></g>',
  ),
  snow: svg(
    '<path d="M9 17a6 6 0 0 1 1-12 8 8 0 0 1 15 3 5 5 0 0 1-1 9z" fill="#eef3f7" stroke="#7b8d9c" stroke-width="2" stroke-linejoin="round"/><g fill="#9cc7e6"><circle cx="10" cy="24" r="2"/><circle cx="17" cy="27" r="2"/><circle cx="23" cy="23" r="2"/></g>',
  ),
  lock: svg(
    '<path d="M10 14v-3a6 6 0 0 1 12 0v3" fill="none" stroke="#6b4a2b" stroke-width="2.8" stroke-linecap="round"/><rect x="7" y="14" width="18" height="14" rx="3" fill="#e8b84a" stroke="#6b4a2b" stroke-width="2.2"/><circle cx="16" cy="21" r="2" fill="#6b4a2b"/>',
  ),
  cloud: svg(
    '<circle cx="12" cy="12" r="5" fill="#f7c948"/><path d="M9 25a6 6 0 0 1 1-12 8 8 0 0 1 15 3 5 5 0 0 1-1 9z" fill="#eef3f7" stroke="#7b8d9c" stroke-width="2" stroke-linejoin="round"/>',
  ),
} as const;
