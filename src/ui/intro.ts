/**
 * First-visit welcome: three animated panels with the core ideas. Shown once
 * (remembered in localStorage) and available again from the menu.
 */

const SEEN_KEY = 'hydro.introSeen';

interface Panel {
  title: string;
  text: string;
  art: string;
}

/* Inline SVG illustrations, animated with SMIL/CSS, in the HUD's chunky style. */
const ART_WATER = `
<svg viewBox="0 0 240 150" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="240" height="150" rx="14" fill="#bfe3f2"/>
  <path d="M0 70 C40 50 70 62 110 52 S190 40 240 58 V150 H0Z" fill="#8cc46a"/>
  <path d="M0 98 C50 84 90 96 140 86 S210 80 240 90 V150 H0Z" fill="#79b45a"/>
  <path d="M20 150 C40 120 90 128 105 104 S150 84 175 92 S220 110 240 104" fill="none" stroke="#3d9bd6" stroke-width="13" stroke-linecap="round"/>
  <path d="M20 150 C40 120 90 128 105 104 S150 84 175 92 S220 110 240 104" fill="none" stroke="#e8f6ff" stroke-width="2.5" stroke-dasharray="6 16" stroke-linecap="round">
    <animate attributeName="stroke-dashoffset" from="0" to="-44" dur="1.2s" repeatCount="indefinite"/>
  </path>
  <g>
    <animateTransform attributeName="transform" type="translate" values="-30 0; 40 0; -30 0" dur="9s" repeatCount="indefinite"/>
    <path d="M70 40a12 12 0 0 1 3-23 16 16 0 0 1 30 4 10 10 0 0 1 2 19z" fill="#f5f8fb" stroke="#9aaab8" stroke-width="2"/>
    <g stroke="#3d9bd6" stroke-width="2.5" stroke-linecap="round">
      <path d="M78 46v6"><animate attributeName="opacity" values="1;0;1" dur="0.8s" repeatCount="indefinite"/><animateTransform attributeName="transform" type="translate" values="0 0;0 14" dur="0.8s" repeatCount="indefinite"/></path>
      <path d="M90 46v6"><animate attributeName="opacity" values="1;0;1" dur="0.8s" begin="0.25s" repeatCount="indefinite"/><animateTransform attributeName="transform" type="translate" values="0 0;0 14" dur="0.8s" begin="0.25s" repeatCount="indefinite"/></path>
      <path d="M102 46v6"><animate attributeName="opacity" values="1;0;1" dur="0.8s" begin="0.5s" repeatCount="indefinite"/><animateTransform attributeName="transform" type="translate" values="0 0;0 14" dur="0.8s" begin="0.5s" repeatCount="indefinite"/></path>
    </g>
  </g>
  <circle cx="200" cy="30" r="12" fill="#f7c948"/>
</svg>`;

const ART_SHAPE = `
<svg viewBox="0 0 240 150" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="240" height="150" rx="14" fill="#bfe3f2"/>
  <!-- water flowing in from the left, filling the new trench -->
  <path fill="#3d9bd6" opacity="0.9">
    <animate attributeName="d" dur="6s" repeatCount="indefinite" keyTimes="0;0.35;0.7;0.9;1"
      values="M0 92 H40 V92 H0Z; M0 92 H40 V92 H0Z; M0 88 H200 V104 H0Z; M0 88 H200 V104 H0Z; M0 92 H40 V92 H0Z"/>
  </path>
  <!-- the ground, a trench being dug into it -->
  <path fill="#8b6a43" stroke="#6b4a2b" stroke-width="2" stroke-linejoin="round">
    <animate attributeName="d" dur="6s" repeatCount="indefinite" keyTimes="0;0.35;0.9;1"
      values="M0 92 H240 V150 H0Z; M0 92 H60 L70 104 H190 L200 92 H240 V150 H0Z; M0 92 H60 L70 104 H190 L200 92 H240 V150 H0Z; M0 92 H240 V150 H0Z"/>
  </path>
  <path d="M0 92 H240" stroke="#7fbf5a" stroke-width="6"/>
  <!-- a dike holding water back on the right -->
  <path d="M206 92 L214 72 H228 L236 92Z" fill="#c49a62" stroke="#6b4a2b" stroke-width="2" stroke-linejoin="round"/>
  <path d="M214 72 H228" stroke="#7fbf5a" stroke-width="4" stroke-linecap="round"/>
  <!-- the plan: a dashed line that is being drawn -->
  <path d="M60 80 H200" stroke="#e8873a" stroke-width="3" stroke-dasharray="6 5" fill="none">
    <animate attributeName="stroke-dashoffset" values="0;-22" dur="1s" repeatCount="indefinite"/>
    <animate attributeName="opacity" dur="6s" repeatCount="indefinite" keyTimes="0;0.3;0.35;1" values="1;1;0;0"/>
  </path>
  <!-- a hand drawing it -->
  <g>
    <animateTransform attributeName="transform" type="translate" dur="6s" repeatCount="indefinite" keyTimes="0;0.3;0.35;1" values="50 46; 190 46; 190 30; 50 46"/>
    <path d="M6 22V9a3 3 0 0 1 6 0v8V4a3 3 0 0 1 6 0v12V7a3 3 0 0 1 6 0v10-4a3 3 0 0 1 6 0v9c0 7-5 12-11 12-5 0-8-3-10-6l-5-8a3 3 0 0 1 5-3z" fill="#f3d2a8" stroke="#6b4a2b" stroke-width="2" stroke-linejoin="round"/>
  </g>
</svg>`;

const ART_VILLAGE = `
<svg viewBox="0 0 240 150" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="240" height="150" rx="14" fill="#bfe3f2"/>
  <rect y="78" width="240" height="72" fill="#8cc46a"/>
  <path d="M0 120 C60 110 120 128 240 112 V150 H0Z" fill="#3d9bd6"/>
  <!-- fields ripening -->
  <g>
    <rect x="132" y="84" width="88" height="22" rx="3">
      <animate attributeName="fill" values="#8b6a43;#6fb04f;#e9c24a;#e9c24a;#8b6a43" keyTimes="0;0.35;0.7;0.9;1" dur="7s" repeatCount="indefinite"/>
    </rect>
    <path d="M136 90H216M136 95H216M136 100H216" stroke="#00000022" stroke-width="2"/>
  </g>
  <!-- houses popping up one after another -->
  <g transform="translate(30 58)">
    <g><animateTransform attributeName="transform" type="scale" values="0;1;1" keyTimes="0;0.1;1" dur="7s" repeatCount="indefinite"/>
      <path d="M0 30V14L13 3L26 14V30Z" fill="#f1e6c9" stroke="#6b4a2b" stroke-width="2"/><path d="M-3 16L13 1L29 16" fill="none" stroke="#c4553a" stroke-width="6" stroke-linejoin="round"/><rect x="10" y="20" width="7" height="10" fill="#8b5a33"/></g>
  </g>
  <g transform="translate(66 62)">
    <g><animateTransform attributeName="transform" type="scale" values="0;0;1;1" keyTimes="0;0.25;0.35;1" dur="7s" repeatCount="indefinite"/>
      <path d="M0 26V12L11 3L22 12V26Z" fill="#e9d9b5" stroke="#6b4a2b" stroke-width="2"/><path d="M-3 14L11 1L25 14" fill="none" stroke="#b98a52" stroke-width="6" stroke-linejoin="round"/><rect x="8" y="17" width="6" height="9" fill="#8b5a33"/></g>
  </g>
  <g transform="translate(96 56)">
    <g><animateTransform attributeName="transform" type="scale" values="0;0;1;1" keyTimes="0;0.5;0.6;1" dur="7s" repeatCount="indefinite"/>
      <path d="M0 30V14L13 3L26 14V30Z" fill="#f1e6c9" stroke="#6b4a2b" stroke-width="2"/><path d="M-3 16L13 1L29 16" fill="none" stroke="#7d4a3a" stroke-width="6" stroke-linejoin="round"/><rect x="10" y="20" width="7" height="10" fill="#8b5a33"/></g>
  </g>
  <!-- a villager walking to the field and back -->
  <g>
    <animateTransform attributeName="transform" type="translate" values="60 96; 150 96; 60 96" dur="7s" repeatCount="indefinite"/>
    <circle cx="0" cy="0" r="5" fill="#f3d2a8" stroke="#6b4a2b" stroke-width="1.5"/>
    <rect x="-4" y="5" width="8" height="9" rx="2" fill="#3d9bd6" stroke="#6b4a2b" stroke-width="1.5"/>
  </g>
  <!-- a fisher at the shore, a fish jumping -->
  <circle cx="200" cy="116" r="4" fill="#f3d2a8" stroke="#6b4a2b" stroke-width="1.5"/>
  <path d="M202 114 L218 104" stroke="#6b4a2b" stroke-width="1.5"/>
  <path d="M0 0 c4 -3 9 -3 12 0 c-3 3 -8 3 -12 0z M12 0 l4 -3 v6z" fill="#e8873a">
    <animateMotion dur="2.4s" repeatCount="indefinite" path="M190 136 Q200 118 212 136"/>
  </path>
</svg>`;

const PANELS: Panel[] = [
  {
    title: 'Water shapes the land',
    text: 'Rain falls, rivers wander, groundwater rises and sinks. Over the seasons and years, water carves valleys and lays down fertile silt.',
    art: ART_WATER,
  },
  {
    title: 'You shape the water',
    text: 'Draw trenches, dikes and level ground to guide where it goes. Your plans build themselves, then watch what the water makes of them.',
    art: ART_SHAPE,
  },
  {
    title: 'People find their place',
    text: 'Little villagers settle where the land suits them: fields on moist soil, fishers by calm water. You can’t tell them what to do, only make the land inviting.',
    art: ART_VILLAGE,
  },
];

export class Intro {
  private readonly el: HTMLElement;
  private page = 0;
  private onCloseFn: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'intro';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-label', 'Welcome to Hydro');
    root.append(this.el);
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    window.addEventListener('keydown', (e) => {
      if (this.el.hidden) return;
      if (e.key === 'Escape') this.close();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') this.next();
      else if (e.key === 'ArrowLeft') this.go(this.page - 1);
    });
  }

  /** Whether this browser has seen the intro before. */
  static seen(): boolean {
    try {
      return localStorage.getItem(SEEN_KEY) === '1';
    } catch {
      return false;
    }
  }

  open(onClose?: () => void): void {
    this.onCloseFn = onClose ?? null;
    this.page = 0;
    this.render();
    this.el.hidden = false;
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // Storage unavailable: it will just show again next time.
    }
    const fn = this.onCloseFn;
    this.onCloseFn = null;
    fn?.();
  }

  private next(): void {
    if (this.page >= PANELS.length - 1) this.close();
    else this.go(this.page + 1);
  }

  private go(page: number): void {
    this.page = Math.max(0, Math.min(PANELS.length - 1, page));
    this.render();
  }

  private render(): void {
    const p = PANELS[this.page]!;
    const last = this.page === PANELS.length - 1;
    const dots = PANELS.map(
      (_, k) => `<button class="dot" data-page="${k}" aria-label="Page ${k + 1}" aria-current="${k === this.page}"></button>`,
    ).join('');
    this.el.innerHTML = `
      <div class="intro-card panel">
        <div class="intro-art">${p.art}</div>
        <h2>${p.title}</h2>
        <p>${p.text}</p>
        <div class="intro-nav">
          <button class="skip">Skip</button>
          <div class="dots">${dots}</div>
          <button class="next">${last ? 'Let’s go!' : 'Next'}</button>
        </div>
      </div>`;
    this.el.querySelector('.skip')!.addEventListener('click', () => this.close());
    this.el.querySelector('.next')!.addEventListener('click', () => this.next());
    for (const d of this.el.querySelectorAll<HTMLButtonElement>('.dot')) {
      d.addEventListener('click', () => this.go(Number(d.dataset.page)));
    }
    // Swipe between pages on touch screens.
    let x0: number | null = null;
    const card = this.el.querySelector<HTMLElement>('.intro-card')!;
    card.addEventListener('pointerdown', (e) => (x0 = e.clientX));
    card.addEventListener('pointerup', (e) => {
      if (x0 === null) return;
      const dx = e.clientX - x0;
      x0 = null;
      if (dx < -40) this.next();
      else if (dx > 40) this.go(this.page - 1);
    });
  }
}
