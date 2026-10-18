/**
 * Pegged plots (docs/PEOPLE.md §3.1): good land a village has staked out
 * for farmers still to come, drawn as little wooden pegs at the corners of
 * the plot's outline with a string between them, a hand's breadth above
 * the meadow. The terrain shader paints the string and peg shadows too, so
 * the plots read from afar; these models are the close-up. One merged mesh
 * (one draw call), rebuilt only when the set of pegged cells changes.
 */
import * as THREE from 'three';
import { heightToY, type HeightSampler } from '../coords';
import { FIELD_BYTES, FieldCrop } from '../../shared/protocol';

/** LandUse.None (see sim/world.ts). */
const NONE = 0;

export interface PegGeometry {
  /** Peg positions: grid vertices (cell coords; the vertex between cells x-1 and x is x - 0.5). */
  pegs: [number, number][];
  /** String segments between neighbouring vertices along the outline. */
  strings: [number, number, number, number][];
}

/** Outline of the pegged cells: strings on the edges between a pegged and an unpegged cell, pegs at their ends. */
export function pegOutline(fields: Uint8Array, width: number, height: number): PegGeometry {
  const pegged = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && fields[FIELD_BYTES * (y * width + x)] === NONE && fields[FIELD_BYTES * (y * width + x) + 3] === FieldCrop.Pegged;
  const pegs = new Map<number, [number, number]>();
  const strings: [number, number, number, number][] = [];
  const addPeg = (x: number, y: number) => pegs.set((y + 1) * (width + 2) + x + 1, [x - 0.5, y - 0.5]);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (!pegged(x, y)) continue;
      // Edges as vertex pairs (vertex (vx, vy) is the corner at cell coords vx - 0.5, vy - 0.5).
      const edges: [number, number, number, number, boolean][] = [
        [x, y, x, y + 1, !pegged(x - 1, y)],
        [x + 1, y, x + 1, y + 1, !pegged(x + 1, y)],
        [x, y, x + 1, y, !pegged(x, y - 1)],
        [x, y + 1, x + 1, y + 1, !pegged(x, y + 1)],
      ];
      for (const [ax, ay, bx, by, open] of edges) {
        if (!open) continue;
        strings.push([ax - 0.5, ay - 0.5, bx - 0.5, by - 0.5]);
        addPeg(ax, ay);
        addPeg(bx, by);
      }
    }
  return { pegs: [...pegs.values()], strings };
}

export class PlotLayer {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private key = '';
  private fields: Uint8Array | null = null;
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });

  constructor(
    scene: THREE.Object3D,
    private readonly heights: HeightSampler,
    private readonly maxViewHeight = 70,
  ) {
    this.group.name = 'plots';
    scene.add(this.group);
  }

  get meshCount(): number {
    return this.mesh && this.group.visible ? 1 : 0;
  }

  setFields(fields: Uint8Array): void {
    this.fields = fields;
    const h = this.heights;
    const n = h.width * h.height;
    let key = '';
    for (let i = 0; i < n; i++) if (fields[FIELD_BYTES * i + 3] === FieldCrop.Pegged && fields[FIELD_BYTES * i] === NONE) key += `${i},`;
    if (key === this.key) return;
    this.key = key;
    this.rebuild(fields);
  }

  /** Terrain changed: pegs follow the ground. */
  invalidate(): void {
    if (this.key && this.fields) this.rebuild(this.fields);
  }

  update(viewHeight: number): void {
    this.group.visible = viewHeight < this.maxViewHeight;
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.material.dispose();
    this.group.removeFromParent();
  }

  private rebuild(fields: Uint8Array): void {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.removeFromParent();
      this.mesh = null;
    }
    const { pegs, strings } = pegOutline(fields, this.heights.width, this.heights.height);
    if (!pegs.length) return;
    const pos: number[] = [];
    const col: number[] = [];
    const nrm: number[] = [];
    const y = (cx: number, cy: number) => heightToY(this.heights.terrainAt(cx, cy));
    // An axis-aligned box from (x0, y0, z0) to (x1, y1, z1) in world coords, one colour per box (top lighter).
    const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: THREE.Color, top: THREE.Color) => {
      const faces: [number[], number[][]][] = [
        [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]],
        [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
        [[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
        [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
        [[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]],
      ];
      for (const [n, q] of faces) {
        const cc = n[1] === 1 ? top : c;
        for (const k of [0, 1, 2, 0, 2, 3]) {
          pos.push(...q[k]!);
          nrm.push(...n);
          col.push(cc.r, cc.g, cc.b);
        }
      }
    };
    const wood = new THREE.Color(0x8a6238);
    const woodTop = new THREE.Color(0xd8b07a);
    const string = new THREE.Color(0xf2ead2);
    const PEG = 0.035;
    const TALL = 0.2;
    const LIFT = 0.13;
    for (const [px, py] of pegs) {
      const wx = px + 0.5;
      const wz = py + 0.5;
      const g = y(px, py) - 0.03;
      box(wx - PEG, g, wz - PEG, wx + PEG, g + 0.03 + TALL, wz + PEG, wood, woodTop);
    }
    const S = 0.008;
    for (const [ax, ay, bx, by] of strings) {
      const ys = (y(ax, ay) + y(bx, by)) / 2 + LIFT;
      box(Math.min(ax, bx) + 0.5 - S, ys - S, Math.min(ay, by) + 0.5 - S, Math.max(ax, bx) + 0.5 + S, ys + S, Math.max(ay, by) + 0.5 + S, string, string);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'pegged-plots';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.mesh = mesh;
    this.group.add(mesh);
  }
}
