import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import * as THREE from 'three';
import { LAMP, PANE, houseGlowSpots } from '../../src/render/power/power';
import { HOUSE_DESIGNS, houseVariant } from '../../src/render/village/houses';
import { MODELS } from '../../src/render/objects/manifest';
import { loadGlbNode } from './glbNode';

const ASSETS = join(__dirname, '../../public/assets');
const EPS = 1e-6;

/** Footprint (tile units) of a house design, from its plinth (footprint + 0.16). */
function footprint(variant: number): { nx: number; nz: number } {
  const plinth = HOUSE_DESIGNS[variant]!.parts.find((p) => p.m === 'plinth')!;
  return { nx: plinth.s![0] - 0.16, nz: plinth.s![2] - 0.16 };
}

describe('lit houses (power layer)', () => {
  // Ids covering every design, in all four orientations.
  const ids = Array.from({ length: 40 }, (_, i) => i + 1);
  const variants = new Set(ids.map(houseVariant));
  const X = 30;
  const Y = 50;
  const FOOT = 2;

  it('covers every house design', () => {
    expect(variants.size).toBe(HOUSE_DESIGNS.length);
  });

  for (let q = 0; q < 4; q++) {
    it(`window glow lies in the wall, inside the footprint (rotation ${q})`, () => {
      const rot = (q * Math.PI) / 2;
      for (const id of ids) {
        const v = houseVariant(id);
        const d = HOUSE_DESIGNS[v]!;
        const { nx, nz } = footprint(v);
        const spots = houseGlowSpots({ id, x: X, y: Y, rot }, FOOT);
        expect(spots.panes.length).toBeGreaterThan(0);
        // Back into the house's own frame (tile units) the way buildings.ts places it.
        const inv = new THREE.Matrix4().makeRotationY(rot).invert();
        const local = (x: number, z: number) => new THREE.Vector3(x - X - 0.5, 0, z - Y - 0.5).applyMatrix4(inv).divideScalar(d.scale);
        for (const p of spots.panes) {
          const l = local(p.x, p.z);
          // Inside the footprint …
          expect(Math.abs(l.x)).toBeLessThanOrEqual(nx / 2 + EPS);
          expect(Math.abs(l.z)).toBeLessThanOrEqual(nz / 2 + EPS);
          // … facing out of one wall, within that wall's slab (0.1 thick, outer face on the edge).
          const n = new THREE.Vector3(p.nx, 0, p.nz).applyMatrix4(inv);
          expect(Math.abs(n.x) + Math.abs(n.z)).toBeCloseTo(1);
          const half = Math.abs(n.x) > 0.5 ? nx / 2 : nz / 2;
          const depth = half - l.dot(n);
          expect(depth).toBeGreaterThan(0.01);
          expect(depth).toBeLessThan(0.1);
          // Up the wall, the pane within it.
          const y = (p.y - FOOT) / d.vscale;
          expect(y - PANE.h / 2).toBeGreaterThan(0.07);
          expect(y + PANE.h / 2).toBeLessThan(1.07);
        }
        // The door lamp hangs with its back against the outer wall face.
        const l = local(spots.lamp.x, spots.lamp.z);
        const out = Math.max(Math.abs(l.x) - nx / 2, Math.abs(l.z) - nz / 2) * d.scale;
        expect(out).toBeCloseTo(LAMP.half, 6);
        expect(Math.min(Math.abs(l.x) - nx / 2, Math.abs(l.z) - nz / 2)).toBeLessThan(0);
      }
    });
  }

  it('the pane sits within the window models’ wall slab', async () => {
    for (const name of ['town_wall_window', 'town_wall_wood_window'] as const) {
      const gltf = await loadGlbNode(join(ASSETS, MODELS[name].file));
      const box = new THREE.Box3().setFromObject(gltf.scene);
      // Outer face on the tile edge, the pane behind it but in front of the inner face.
      expect(box.max.x).toBeCloseTo(0.5, 3);
      expect(0.5 - PANE.inset).toBeLessThan(box.max.x);
      expect(0.5 - PANE.inset).toBeGreaterThan(0.4);
    }
  });
});
