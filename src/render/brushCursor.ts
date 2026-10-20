/**
 * The sculpting brush's cursor (ui/tools.ts): a ring draped over the ground
 * (or the water) under the pointer, its radius the brush's. Each brush has
 * its own colour and shape, so they never look alike: Raise is gold, with
 * little arrows standing up round the ring; Dig is blue, a dashed ring with
 * arrows pointing down; Even is pale green, with a softer inner ring and a
 * flat ring at the level it evens towards (the mean of the ground under it).
 * Raise and Dig also show their stamp (plans/sculpt.ts): two faint dashed
 * arcs across the ring, the flattened sphere's section as it would stand
 * pressed in (or pushed up) by its full cap height. Contour lines (every
 * CONTOUR m) inside and around the ring, out to where the loose earth
 * slumps, show the shape of the ground as it changes. Drawn on top of
 * everything.
 */
import * as THREE from 'three';
import type { BrushTool } from '../shared/protocol';
import { capHeight } from '../sim/plans/sculpt';
import { heightToY, type HeightSampler } from './coords';

const N = 64;
export const BRUSH_COLORS: Record<BrushTool, number> = { raise: 0xf0b45a, dig: 0x7cc8ff, even: 0xc9f0a0 };
/** Contour interval (m). */
const CONTOUR = 0.25;
/** Arrows round the ring. */
const ARROWS = 8;
/** Height of an arrow (three.js units, at the default exaggeration about a metre). */
const ARROW = 0.55;
/** Segments per stamp arc (every other one drawn: dashed). */
const ARC = 24;

export class BrushCursor {
  private readonly outer: THREE.LineSegments;
  private readonly inner: THREE.LineLoop;
  private readonly marks: THREE.LineSegments;
  private readonly level: THREE.LineLoop;
  private readonly stamp: THREE.LineSegments;
  private readonly contours: THREE.LineSegments;
  private readonly group = new THREE.Group();
  private state: { x: number; y: number; r: number; tool: BrushTool; active: boolean } | null = null;
  private contourCap = 0;

  constructor(
    scene: THREE.Scene,
    private readonly heights: HeightSampler,
  ) {
    const mat = (opacity: number, vertexColors = false) =>
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity, depthTest: false, depthWrite: false, vertexColors });
    const geo = (n: number, size = 3) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      if (size === 4) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
      return g;
    };
    const setup = <T extends THREE.Line>(l: T, order = 20): T => {
      l.renderOrder = order;
      l.frustumCulled = false;
      return l;
    };
    // The outer ring as segments (Dig's is dashed: every other one left out).
    this.outer = setup(new THREE.LineSegments(geo(N * 2), mat(0.9)));
    this.inner = setup(new THREE.LineLoop(geo(N), mat(0.45)));
    this.marks = setup(new THREE.LineSegments(geo(ARROWS * 6), mat(0.95)));
    this.level = setup(new THREE.LineLoop(geo(N), mat(0.8)));
    this.stamp = setup(new THREE.LineSegments(geo(ARC * 2), mat(0.4)));
    this.contours = setup(new THREE.LineSegments(geo(0, 4), mat(1, true)), 19);
    this.group.add(this.contours, this.outer, this.inner, this.marks, this.level, this.stamp);
    this.group.visible = false;
    scene.add(this.group);
  }

  /** The cursor shown (tests). */
  get shown(): { tool: BrushTool; active: boolean; contours: number } | null {
    const c = this.state;
    return c ? { tool: c.tool, active: c.active, contours: this.contours.geometry.drawRange.count / 2 } : null;
  }

  /** Show the brush at (x, y) cells with radius r (active: being held), or hide it (null). */
  set(c: { x: number; y: number; r: number; tool: BrushTool; active: boolean } | null): void {
    this.state = c;
    this.group.visible = !!c;
    if (c) {
      const col = BRUSH_COLORS[c.tool];
      for (const l of [this.outer, this.inner, this.marks, this.level, this.stamp]) (l.material as THREE.LineBasicMaterial).color.setHex(col);
      (this.outer.material as THREE.LineBasicMaterial).opacity = c.active ? 1 : 0.75;
      this.level.visible = c.tool === 'even';
      this.inner.visible = c.tool === 'even';
      this.stamp.visible = c.tool !== 'even';
      this.update();
    }
  }

  /** Re-drape over the ground (call every frame while shown: the ground moves under the brush). */
  update(): void {
    const c = this.state;
    if (!c) return;
    this.ring(c.x, c.y, c.r, c.tool === 'dig');
    this.arrows(c);
    if (c.tool === 'even') {
      this.drape(this.inner, c.x, c.y, c.r * 0.45);
      this.flat(c.x, c.y, c.r * 0.8);
    } else this.arcs(c);
    this.contour(c);
  }

  private surf(px: number, py: number): number {
    const h = this.heights;
    const cx = Math.max(0, Math.min(h.width - 1, px));
    const cy = Math.max(0, Math.min(h.height - 1, py));
    return heightToY(h.terrainAt(cx, cy) + h.depthAt(cx, cy)) + 0.04;
  }

  private ring(x: number, y: number, r: number, dashed: boolean): void {
    const pos = this.outer.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = pos.array as Float32Array;
    let n = 0;
    for (let k = 0; k < N; k++) {
      if (dashed && k % 4 >= 2) continue;
      for (const j of [k, k + 1]) {
        const t = (j / N) * Math.PI * 2;
        const px = x + Math.cos(t) * r;
        const py = y + Math.sin(t) * r;
        a.set([px + 0.5, this.surf(px, py), py + 0.5], n * 3);
        n++;
      }
    }
    this.outer.geometry.setDrawRange(0, n);
    pos.needsUpdate = true;
  }

  private drape(line: THREE.LineLoop, x: number, y: number, r: number): void {
    const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = pos.array as Float32Array;
    for (let k = 0; k < N; k++) {
      const t = (k / N) * Math.PI * 2;
      const px = x + Math.cos(t) * r;
      const py = y + Math.sin(t) * r;
      a[k * 3] = px + 0.5;
      a[k * 3 + 1] = this.surf(px, py);
      a[k * 3 + 2] = py + 0.5;
    }
    pos.needsUpdate = true;
  }

  /** Even: a flat ring at the mean ground height under the brush (where it evens towards). */
  private flat(x: number, y: number, r: number): void {
    const h = this.heights;
    let s = 0;
    let m = 0;
    const R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        s += h.terrainAt(Math.max(0, Math.min(h.width - 1, x + dx)), Math.max(0, Math.min(h.height - 1, y + dy)));
        m++;
      }
    const yy = heightToY(m ? s / m : 0) + 0.04;
    const pos = this.level.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = pos.array as Float32Array;
    for (let k = 0; k < N; k++) {
      const t = (k / N) * Math.PI * 2;
      a.set([x + Math.cos(t) * r + 0.5, yy, y + Math.sin(t) * r + 0.5], k * 3);
    }
    pos.needsUpdate = true;
  }

  /** Raise and Dig: the stamp's section along both axes, pressed by its full cap height from the ground at the centre. */
  private arcs(c: { x: number; y: number; r: number; tool: BrushTool }): void {
    const pos = this.stamp.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = pos.array as Float32Array;
    const h = this.heights;
    const g = h.terrainAt(Math.max(0, Math.min(h.width - 1, c.x)), Math.max(0, Math.min(h.height - 1, c.y)));
    const cap = capHeight(c.r) * (c.tool === 'dig' ? -1 : 1);
    let n = 0;
    for (const [ux, uy] of [
      [1, 0],
      [0, 1],
    ] as const)
      for (let k = 0; k < ARC; k += 2)
        for (const j of [k, k + 1]) {
          const t = (j / ARC) * 2 - 1;
          a.set([c.x + ux * t * c.r + 0.5, heightToY(g + cap * Math.sqrt(Math.max(0, 1 - t * t))) + 0.04, c.y + uy * t * c.r + 0.5], n * 3);
          n++;
        }
    this.stamp.geometry.setDrawRange(0, n);
    pos.needsUpdate = true;
  }

  /** Raise: arrows standing up round the ring; Dig: arrows pointing down; Even: little level ticks. */
  private arrows(c: { x: number; y: number; r: number; tool: BrushTool }): void {
    const pos = this.marks.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = pos.array as Float32Array;
    let n = 0;
    const put = (x: number, y: number, z: number) => a.set([x, y, z], n++ * 3);
    for (let k = 0; k < ARROWS; k++) {
      const t = ((k + 0.5) / ARROWS) * Math.PI * 2;
      const ux = Math.cos(t);
      const uy = Math.sin(t);
      const px = c.x + ux * c.r;
      const py = c.y + uy * c.r;
      const g = this.surf(px, py);
      const X = px + 0.5;
      const Z = py + 0.5;
      // The arrow's head opens along the ring's tangent.
      const hx = -uy * 0.18;
      const hz = ux * 0.18;
      if (c.tool === 'even') {
        // A short flat dash across the ring.
        put(X - ux * 0.35, g, Z - uy * 0.35);
        put(X + ux * 0.35, g, Z + uy * 0.35);
        continue;
      }
      const up = c.tool === 'raise';
      const tip = up ? g + ARROW : g;
      const tail = up ? g : g + ARROW;
      const back = up ? tip - 0.2 : tip + 0.2;
      put(X, tail, Z);
      put(X, tip, Z);
      put(X, tip, Z);
      put(X + hx, back, Z + hz);
      put(X, tip, Z);
      put(X - hx, back, Z - hz);
    }
    this.marks.geometry.setDrawRange(0, n);
    pos.needsUpdate = true;
  }

  /** Contour lines (marching squares on the ground) within 1.5 radii (and at least 4 cells beyond the ring, where the earth slumps), fading out at the edge. */
  private contour(c: { x: number; y: number; r: number; tool: BrushTool; active: boolean }): void {
    const h = this.heights;
    const R = Math.max(c.r * 1.5, c.r + 4);
    const step = 0.5;
    const n = Math.ceil((2 * R) / step) + 1;
    const x0 = c.x - R;
    const y0 = c.y - R;
    const z = new Float32Array(n * n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++)
        z[j * n + i] = h.terrainAt(Math.max(0, Math.min(h.width - 1, x0 + i * step)), Math.max(0, Math.min(h.height - 1, y0 + j * step)));
    const segs: number[] = [];
    const lerp = (a: number, b: number, l: number) => (l - a) / (b - a);
    for (let j = 0; j + 1 < n; j++)
      for (let i = 0; i + 1 < n; i++) {
        const a = z[j * n + i]!;
        const b = z[j * n + i + 1]!;
        const d = z[(j + 1) * n + i]!;
        const e = z[(j + 1) * n + i + 1]!;
        const lo = Math.min(a, b, d, e);
        const hi = Math.max(a, b, d, e);
        for (let l = Math.ceil(lo / CONTOUR) * CONTOUR; l < hi; l += CONTOUR) {
          // Crossings on the four edges of the square (top, right, bottom, left).
          const pts: [number, number][] = [];
          if ((a < l) !== (b < l)) pts.push([i + lerp(a, b, l), j]);
          if ((b < l) !== (e < l)) pts.push([i + 1, j + lerp(b, e, l)]);
          if ((d < l) !== (e < l)) pts.push([i + lerp(d, e, l), j + 1]);
          if ((a < l) !== (d < l)) pts.push([i, j + lerp(a, d, l)]);
          for (let k = 0; k + 1 < pts.length; k += 2) segs.push(pts[k]![0], pts[k]![1], pts[k + 1]![0], pts[k + 1]![1], l);
        }
      }
    const m = segs.length / 5;
    if (m * 2 > this.contourCap) {
      this.contourCap = Math.ceil(m * 2 * 1.5);
      this.contours.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.contourCap * 3), 3));
      this.contours.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.contourCap * 4), 4));
    }
    const P = (this.contours.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const C = (this.contours.geometry.getAttribute('color') as THREE.BufferAttribute).array as Float32Array;
    const col = new THREE.Color(BRUSH_COLORS[c.tool]).lerp(new THREE.Color(0xffffff), 0.35);
    const base = c.active ? 0.85 : 0.5;
    let v = 0;
    for (let s = 0; s < m; s++) {
      const l = segs[s * 5 + 4]!;
      // Every metre a bolder line.
      const major = Math.abs(l - Math.round(l)) < 1e-3;
      for (const k of [0, 2]) {
        const px = x0 + segs[s * 5 + k]! * step;
        const py = y0 + segs[s * 5 + k + 1]! * step;
        const d = Math.hypot(px - c.x, py - c.y) / R;
        const alpha = base * (major ? 1 : 0.6) * Math.max(0, Math.min(1, (1 - d) * 3));
        P.set([px + 0.5, heightToY(l) + 0.03, py + 0.5], v * 3);
        C.set([col.r, col.g, col.b, alpha], v * 4);
        v++;
      }
    }
    this.contours.geometry.setDrawRange(0, v);
    this.contours.geometry.getAttribute('position').needsUpdate = true;
    this.contours.geometry.getAttribute('color').needsUpdate = true;
  }
}
