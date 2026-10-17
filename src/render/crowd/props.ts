/**
 * Carried props and hand tools, merged into ONE geometry so all props of the
 * crowd are a single instanced draw. Each vertex carries `aPropKind`; each
 * instance carries `aKind`, and the vertex shader collapses the vertices of
 * the other props to a point (zero-area triangles produce no fragments).
 * Props are small (≤ ~600 vertices each), so the wasted vertex work is minor.
 *
 * Prop frames (model units of a ~0.67 tall Kenney character):
 *  - loads (Earth … Stone): centred at the origin, long axis along x
 *    (across the carrier's chest);
 *  - tools (Hoe … Rod): the grip at the origin, the handle along +z from the
 *    grip (the T-pose fist points along ±x, the arm swings about x).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ModelName } from '../objects/manifest';
import { PROP_KINDS, PropKind } from './clips';

export interface PropSource {
  loadStatic(name: ModelName): Promise<{ geometry: THREE.BufferGeometry }>;
}

function srgb(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
}

/** Non-indexed copy with a constant linear vertex colour (unless it has one). */
function coloured(g: THREE.BufferGeometry, hex?: number): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g.clone();
  for (const k of Object.keys(out.attributes)) if (!['position', 'normal', 'color'].includes(k)) out.deleteAttribute(k);
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  if (hex !== undefined || !out.getAttribute('color')) {
    const c = srgb(hex ?? 0xffffff);
    const n = out.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  } else {
    const c = out.getAttribute('color');
    if (c.itemSize !== 3) {
      const col = new Float32Array(c.count * 3);
      for (let i = 0; i < c.count; i++) col.set([c.getX(i), c.getY(i), c.getZ(i)], i * 3);
      out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
  }
  return out;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(parts.map((p) => coloured(p)), false)!;
}

/** Scale so that the largest bbox extent is `size`, and move it as described in the file header. */
function normalise(g: THREE.BufferGeometry, size: number, tool: boolean): THREE.BufferGeometry {
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const ext = new THREE.Vector3().subVectors(bb.max, bb.min);
  const s = size / Math.max(ext.x, ext.y, ext.z, 1e-6);
  const c = new THREE.Vector3().addVectors(bb.min, bb.max).multiplyScalar(0.5);
  if (tool) {
    // Upright Kenney tools (handle bottom at y = min): grip 30% up the handle,
    // then lay the handle along +z.
    g.translate(-c.x, -(bb.min.y + ext.y * 0.3), -c.z);
    g.scale(s, s, s);
    g.rotateX(Math.PI / 2);
  } else {
    g.translate(-c.x, -c.y, -c.z);
    g.scale(s, s, s);
  }
  return g;
}

function sack(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, 1);
  g.scale(1.25, 0.8, 0.85);
  const knot = new THREE.CylinderGeometry(0.12, 0.2, 0.25, 6).translate(0, 0.45, 0);
  return merge([coloured(g, 0xc9a66b), coloured(knot, 0xa9864b)]);
}

function earthBasket(): THREE.BufferGeometry {
  const basket = new THREE.CylinderGeometry(0.55, 0.42, 0.45, 8).translate(0, 0, 0);
  const rim = new THREE.TorusGeometry(0.55, 0.05, 4, 8).rotateX(Math.PI / 2).translate(0, 0.22, 0);
  const heap = new THREE.SphereGeometry(0.5, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.55, 1).translate(0, 0.2, 0);
  return merge([coloured(basket, 0xa47a43), coloured(rim, 0x8a6234), coloured(heap, 0x6b4a2e)]);
}

function bundle(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(1, 0.55, 0.5);
  const strap1 = new THREE.BoxGeometry(0.08, 0.6, 0.55).translate(-0.25, 0, 0);
  const strap2 = new THREE.BoxGeometry(0.08, 0.6, 0.55).translate(0.25, 0, 0);
  return merge([coloured(body, 0x9fb37c), coloured(strap1, 0x6e4b2a), coloured(strap2, 0x6e4b2a)]);
}

/** A dressed stone block for lining, a little chipped. */
function stone(): THREE.BufferGeometry {
  const block = new THREE.BoxGeometry(1, 0.55, 0.7);
  const chip = new THREE.BoxGeometry(0.3, 0.2, 0.3).translate(0.4, 0.22, 0.25);
  return merge([coloured(block, 0xb3ada2), coloured(chip, 0x9d978c)]);
}

function rod(): THREE.BufferGeometry {
  // Grip at the origin, rod along +y (normalise lays it along +z), tip raised.
  const pole = new THREE.CylinderGeometry(0.012, 0.025, 1, 5).translate(0, 0.5 - 0.15, 0);
  const line = new THREE.CylinderGeometry(0.004, 0.004, 0.5, 3).translate(0, -0.25, 0).rotateZ(0.15).translate(0, 0.85, 0.02);
  return merge([coloured(pole, 0x7a5532), coloured(line, 0xe8e8e0)]);
}

/** Target sizes (largest extent, model units) of each prop. */
const SIZES: Record<number, number> = {
  [PropKind.Earth]: 0.2,
  [PropKind.Sack]: 0.24,
  [PropKind.Fish]: 0.2,
  [PropKind.Log]: 0.34,
  [PropKind.Bundle]: 0.24,
  [PropKind.Bucket]: 0.15,
  [PropKind.Stone]: 0.2,
  [PropKind.Hoe]: 0.42,
  [PropKind.Shovel]: 0.42,
  [PropKind.Hammer]: 0.2,
  [PropKind.Rod]: 0.7,
};

const KENNEY: Partial<Record<number, ModelName>> = {
  [PropKind.Fish]: 'survival_fish',
  [PropKind.Log]: 'log',
  [PropKind.Bucket]: 'survival_bucket',
  [PropKind.Hoe]: 'survival_tool_hoe',
  [PropKind.Shovel]: 'survival_tool_shovel',
  [PropKind.Hammer]: 'survival_tool_hammer',
};

export function isTool(kind: number): boolean {
  return kind >= PropKind.Hoe;
}

/** Build the merged prop geometry (with per-vertex `aPropKind`). */
export async function buildPropGeometry(lib: PropSource | null): Promise<THREE.BufferGeometry> {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 1; k < PROP_KINDS; k++) {
    let g: THREE.BufferGeometry | null = null;
    const model = KENNEY[k];
    if (model && lib) {
      try {
        g = coloured((await lib.loadStatic(model)).geometry);
        if (k === PropKind.Log) g.rotateY(Math.PI / 2); // log.glb lies along z
        if (k === PropKind.Fish) g.rotateZ(Math.PI / 2 - 0.25); // hang it head down
      } catch {
        g = null;
      }
    }
    if (!g) {
      if (k === PropKind.Sack) g = sack();
      else if (k === PropKind.Earth) g = earthBasket();
      else if (k === PropKind.Bundle) g = bundle();
      else if (k === PropKind.Stone) g = stone();
      else if (k === PropKind.Rod) g = rod();
      else if (isTool(k)) g = coloured(new THREE.BoxGeometry(0.06, 1, 0.06).translate(0, 0.5, 0), 0x7a5532);
      else g = coloured(new THREE.BoxGeometry(1, 0.6, 0.6), k === PropKind.Fish ? 0x8fb4c8 : k === PropKind.Log ? 0x8a5a33 : 0x9a9a9a);
    }
    g = normalise(g, SIZES[k]!, isTool(k));
    const n = g.getAttribute('position').count;
    g.setAttribute('aPropKind', new THREE.BufferAttribute(new Float32Array(n).fill(k), 1));
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false)!;
  merged.computeBoundingSphere();
  return merged;
}
