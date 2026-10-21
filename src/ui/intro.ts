/**
 * First-visit welcome: three panels with the core ideas, illustrated by live
 * scenes from the real engine (introScenes.ts). The mill loader
 * (loader.ts) turns while a scene loads, and stands still when WebGL or the
 * worker is unavailable.
 * Shown once (remembered in localStorage) and available again from the menu.
 */
import type { SceneId } from '../shared/protocol';
import { IntroScenes } from './introScenes';
import { LOADER_HTML } from './loader';

const SEEN_KEY = 'hydro.introSeen';

interface Panel {
  title: string;
  text: string;
  scene: SceneId;
}

const PANELS: Panel[] = [
  {
    title: 'Water shapes the land',
    text: 'Rain falls, rivers wander, groundwater rises and sinks. Over the seasons and years, water carves valleys and lays down fertile silt.',
    scene: 'water',
  },
  {
    title: 'You shape the water',
    text: 'Raise, dig and even the ground with your own hand to guide where it goes: hold to shape it, and the loose earth settles into round bowls and banks. Then watch what the water makes of it.',
    scene: 'shape',
  },
  {
    title: 'People find their place',
    text: 'Little villagers settle where the land suits them: fields on moist soil, fishers by calm water. You can’t tell them what to do, only make the land inviting.',
    scene: 'village',
  },
];

/** Shown under the last panel's text. */
const NOTE =
  'Hydro is a work in progress. Still to come: a world that keeps growing beyond the fog, mills rebuilt as power houses, and music.';

export class Intro {
  private readonly el: HTMLElement;
  private page = 0;
  private onCloseFn: (() => void) | null = null;
  private scenes: IntroScenes | null = null;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'intro';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-label', 'Welcome to Hydro');
    this.el.innerHTML = `
      <div class="intro-card panel">
        <div class="intro-art">${LOADER_HTML}</div>
        <h2></h2>
        <p class="intro-text"></p>
        <p class="intro-note" hidden>${NOTE}</p>
        <div class="intro-nav">
          <button class="skip">Skip</button>
          <div class="dots">${PANELS.map((_, k) => `<button class="dot" data-page="${k}" aria-label="Page ${k + 1}"></button>`).join('')}</div>
          <button class="next"></button>
        </div>
      </div>`;
    root.append(this.el);
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.querySelector('.skip')!.addEventListener('click', () => this.close());
    this.el.querySelector('.next')!.addEventListener('click', () => this.next());
    for (const d of this.el.querySelectorAll<HTMLButtonElement>('.dot')) {
      d.addEventListener('click', () => this.go(Number(d.dataset.page)));
    }
    // Swipe between pages on touch screens (the live scene takes no input).
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

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(onClose?: () => void): void {
    this.onCloseFn = onClose ?? null;
    this.page = 0;
    this.el.hidden = false;
    this.render();
    this.startScenes();
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.scenes?.dispose();
    this.scenes = null;
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // Storage unavailable: it will just show again next time.
    }
    const fn = this.onCloseFn;
    this.onCloseFn = null;
    fn?.();
  }

  private startScenes(): void {
    const art = this.el.querySelector<HTMLElement>('.intro-art')!;
    art.classList.remove('live', 'live-on', 'still');
    // Each opening tries afresh (a failure last time may have passed); on failure the mill stands still.
    if (this.scenes) return;
    try {
      const sc = new IntroScenes(art, PANELS[this.page]!.scene);
      sc.onLive = () => art.classList.add('live');
      sc.onFail = () => {
        this.scenes = null;
        art.classList.remove('live', 'live-on');
        art.classList.add('still');
      };
      this.scenes = sc;
    } catch (e) {
      console.warn('Welcome scenes unavailable', e);
      art.classList.add('still');
    }
  }

  private next(): void {
    if (this.page >= PANELS.length - 1) this.close();
    else this.go(this.page + 1);
  }

  private go(page: number): void {
    const p = Math.max(0, Math.min(PANELS.length - 1, page));
    if (p === this.page) return;
    this.page = p;
    this.render();
    this.scenes?.show(PANELS[p]!.scene);
  }

  private render(): void {
    const p = PANELS[this.page]!;
    const last = this.page === PANELS.length - 1;
    this.el.querySelector('h2')!.textContent = p.title;
    this.el.querySelector('.intro-text')!.textContent = p.text;
    this.el.querySelector<HTMLElement>('.intro-note')!.hidden = !last;
    this.el.querySelector('.next')!.textContent = last ? 'Let’s go!' : 'Next';
    this.el.querySelectorAll('.dot').forEach((d, k) => d.setAttribute('aria-current', String(k === this.page)));
    this.el.dataset.page = String(this.page);
  }
}
