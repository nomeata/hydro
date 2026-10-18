/**
 * "Show me" for the ideas (ui/achievements.ts): a soft, dashed ring drawn
 * on the ground around a spot for a few seconds, then gone. An SVG over
 * the canvas, re-projected every frame so it stays put while the camera
 * glides there.
 */
const NS = 'http://www.w3.org/2000/svg';
const SHOW_MS = 6000;
const POINTS = 28;

/** Canvas-relative CSS pixel position of a ground point (cell coordinates), or null when off screen. */
export type GroundProjector = (x: number, y: number) => [number, number] | null;

export class AreaHighlight {
  private readonly svg: SVGSVGElement;
  private readonly ring: SVGPolygonElement;
  private readonly glow: SVGPolygonElement;
  private raf = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    root: HTMLElement,
    private readonly project: GroundProjector,
  ) {
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.classList.add('area-highlight');
    this.svg.dataset.testid = 'area-highlight';
    this.glow = document.createElementNS(NS, 'polygon');
    this.glow.classList.add('glow');
    this.ring = document.createElementNS(NS, 'polygon');
    this.ring.classList.add('ring');
    this.svg.append(this.glow, this.ring);
    this.svg.style.display = 'none';
    root.append(this.svg);
  }

  /** Ring the ground within r cells of (x, y) for a few seconds. */
  show(x: number, y: number, r: number): void {
    cancelAnimationFrame(this.raf);
    if (this.timer) clearTimeout(this.timer);
    const start = performance.now();
    this.svg.style.display = '';
    // Gone on time even when frames are slow.
    this.timer = setTimeout(() => {
      cancelAnimationFrame(this.raf);
      this.svg.style.display = 'none';
    }, SHOW_MS);
    const frame = (now: number) => {
      const t = now - start;
      if (t > SHOW_MS) {
        this.svg.style.display = 'none';
        return;
      }
      const pts: string[] = [];
      for (let k = 0; k < POINTS; k++) {
        const a = (k / POINTS) * Math.PI * 2;
        const p = this.project(x + Math.cos(a) * r, y + Math.sin(a) * r);
        if (p) pts.push(`${p[0].toFixed(1)},${p[1].toFixed(1)}`);
      }
      const s = pts.join(' ');
      this.ring.setAttribute('points', s);
      this.glow.setAttribute('points', s);
      // Fade in, breathe, fade out.
      const fade = Math.min(1, t / 400, (SHOW_MS - t) / 700);
      this.svg.style.opacity = String(fade * (0.75 + 0.25 * Math.sin(t / 260)));
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }
}
