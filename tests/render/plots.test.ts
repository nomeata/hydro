import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIELD_BYTES, FieldCrop } from '../../src/shared/protocol';
import { HeightField } from '../../src/render/heights';
import { CELL_METRES, heightToY } from '../../src/render/coords';
import { PlotLayer, pegOutline, stringPoints } from '../../src/render/village/plots';

/** A steep, bumpy hillside (up to ~1.5 m per 5 m cell) with an L-shaped pegged plot on it. */
function hillside() {
  const w = 12;
  const h = 12;
  const t = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) t[y * w + x] = 1.3 * x + 0.6 * y + 0.8 * Math.sin(x * 2.1 + y * 1.3);
  const heights = new HeightField(w, h, t);
  const fields = new Uint8Array(FIELD_BYTES * w * h);
  for (let y = 3; y < 8; y++) for (let x = 3; x < 9; x++) if (!(x > 5 && y > 5)) fields[FIELD_BYTES * (y * w + x) + 3] = FieldCrop.Pegged;
  return { heights, fields, w, h };
}

describe('pegged plots on sloped ground', () => {
  it('the string follows the drawn ground, a little above it, all along', () => {
    const { heights, fields, w, h } = hillside();
    const { strings } = pegOutline(fields, w, h);
    expect(strings.length).toBeGreaterThan(10);
    let lo = Infinity;
    let hi = -Infinity;
    for (const seg of strings) {
      const pts = stringPoints(heights, seg);
      for (let k = 0; k + 1 < pts.length; k++)
        for (let j = 0; j <= 20; j++) {
          const s = j / 20;
          const [ax, ay, az] = pts[k]!;
          const [bx, by, bz] = pts[k + 1]!;
          const x = ax + (bx - ax) * s;
          const z = az + (bz - az) * s;
          const clear = (ay + (by - ay) * s - heightToY(heights.terrainAt(x - 0.5, z - 0.5))) * CELL_METRES;
          lo = Math.min(lo, clear);
          hi = Math.max(hi, clear);
        }
    }
    // In metres: never in the ground, never more than a hand or two above it.
    expect(lo).toBeGreaterThan(0.1);
    expect(hi).toBeLessThan(0.45);
  });

  it('every side ends at a peg, and the pegs stand on (in) the ground', () => {
    const { heights, fields, w, h } = hillside();
    const { pegs, strings } = pegOutline(fields, w, h);
    const pegKeys = new Set(pegs.map(([x, y]) => `${x},${y}`));
    for (const [ax, ay, bx, by] of strings) {
      expect(pegKeys.has(`${ax},${ay}`)).toBe(true);
      expect(pegKeys.has(`${bx},${by}`)).toBe(true);
      const pts = stringPoints(heights, [ax, ay, bx, by]);
      expect(pts[0]![0]).toBeCloseTo(ax + 0.5);
      expect(pts[0]![2]).toBeCloseTo(ay + 0.5);
      expect(pts.at(-1)![0]).toBeCloseTo(bx + 0.5);
      expect(pts.at(-1)![2]).toBeCloseTo(by + 0.5);
    }
    const layer = new PlotLayer(new THREE.Scene(), heights);
    layer.setFields(fields);
    const mesh = layer.group.children[0] as THREE.Mesh;
    const pos = mesh.geometry.getAttribute('position');
    // Each peg: the lowest vertices near it are below the ground at their own spot, the highest above the string's tie.
    for (const [px, py] of pegs) {
      let bottom = Infinity;
      let top = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        if (Math.abs(x - px - 0.5) > 0.031 || Math.abs(z - py - 0.5) > 0.031) continue;
        const g = heightToY(heights.terrainAt(x - 0.5, z - 0.5));
        bottom = Math.min(bottom, pos.getY(i) - g);
        top = Math.max(top, pos.getY(i) - g);
      }
      expect(bottom).toBeLessThan(0);
      expect(top).toBeGreaterThan(stringPoints(heights, [px, py, px + 1, py])[0]![1] - heightToY(heights.terrainAt(px, py)));
    }
    layer.dispose();
  });
});
