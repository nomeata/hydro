/**
 * The sculpting brush's cursor (ui/tools.ts): a ring draped over the ground
 * (or the water) under the pointer, its radius the brush's, with a softer
 * inner ring where the brush works hardest. Coloured by the tool: earthy
 * for Raise, blue for Dig, pale green for Even. Drawn on top of everything.
 */
import * as THREE from 'three';
import type { BrushTool } from '../shared/protocol';
import { heightToY, type HeightSampler } from './coords';

const N = 64;
const COLORS: Record<BrushTool, number> = { raise: 0xf0b45a, dig: 0x7cc8ff, even: 0xc9f0a0 };

export class BrushCursor {
  private readonly outer: THREE.LineLoop;
  private readonly inner: THREE.LineLoop;
  private readonly group = new THREE.Group();
  private state: { x: number; y: number; r: number; tool: BrushTool; active: boolean } | null = null;

  constructor(
    scene: THREE.Scene,
    private readonly heights: HeightSampler,
  ) {
    const make = (opacity: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
      const m = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity, depthTest: false, depthWrite: false });
      const l = new THREE.LineLoop(g, m);
      l.renderOrder = 20;
      l.frustumCulled = false;
      return l;
    };
    this.outer = make(0.9);
    this.inner = make(0.45);
    this.group.add(this.outer, this.inner);
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Show the brush at (x, y) cells with radius r (active: being held), or hide it (null). */
  set(c: { x: number; y: number; r: number; tool: BrushTool; active: boolean } | null): void {
    this.state = c;
    this.group.visible = !!c;
    if (c) {
      const col = COLORS[c.tool];
      (this.outer.material as THREE.LineBasicMaterial).color.setHex(col);
      (this.inner.material as THREE.LineBasicMaterial).color.setHex(col);
      (this.outer.material as THREE.LineBasicMaterial).opacity = c.active ? 1 : 0.75;
      this.update();
    }
  }

  /** Re-drape over the ground (call every frame while shown: the ground moves under the brush). */
  update(): void {
    const c = this.state;
    if (!c) return;
    this.drape(this.outer, c.x, c.y, c.r);
    this.drape(this.inner, c.x, c.y, c.r * 0.45);
  }

  private drape(line: THREE.LineLoop, x: number, y: number, r: number): void {
    const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = pos.array as Float32Array;
    const h = this.heights;
    for (let k = 0; k < N; k++) {
      const t = (k / N) * Math.PI * 2;
      const px = x + Math.cos(t) * r;
      const py = y + Math.sin(t) * r;
      const cx = Math.max(0, Math.min(h.width - 1, px));
      const cy = Math.max(0, Math.min(h.height - 1, py));
      a[k * 3] = px + 0.5;
      a[k * 3 + 1] = heightToY(h.terrainAt(cx, cy) + h.depthAt(cx, cy)) + 0.04;
      a[k * 3 + 2] = py + 0.5;
    }
    pos.needsUpdate = true;
  }
}
