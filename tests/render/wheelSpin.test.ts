import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { noriaAxle, undershotSign, wheelQuaternion } from '../../src/render/wheelSpin';
import { StructuresLayer } from '../../src/render/structures/structures';
import { MillWheelsLayer } from '../../src/render/village/millwheels';
import type { BuildingInfo, StructureInfo } from '../../src/shared/protocol';

/** Horizontal motion (x, z) of the wheel's bottom point when turning from `a0` to `a1`. */
function bottomMotion(yaw: number, a0: number, a1: number): [number, number] {
  const p0 = new THREE.Vector3(0, -1, 0).applyQuaternion(wheelQuaternion(yaw, a0));
  const p1 = new THREE.Vector3(0, -1, 0).applyQuaternion(wheelQuaternion(yaw, a1));
  return [p1.x - p0.x, p1.z - p0.z];
}

describe('undershot wheels turn with the current', () => {
  it('the bottom moves downstream for any yaw and flow across the axle', () => {
    for (let k = 0; k < 24; k++) {
      const yaw = (k / 24) * Math.PI * 2 - 1;
      for (const fa of [0, 0.7, 1.9, 3.3, 4.4, 5.6]) {
        const vx = Math.cos(fa);
        const vy = Math.sin(fa);
        // The wheel's plane direction, (−sin, −cos): skip currents along the axle.
        const across = Math.abs(-Math.sin(yaw) * vx - Math.cos(yaw) * vy);
        if (across < 0.2) continue;
        const s = undershotSign(yaw, vx, vy);
        const [dx, dz] = bottomMotion(yaw, 0.3, 0.3 + s * 0.01);
        expect(dx * vx + dz * vy).toBeGreaterThan(0);
      }
    }
  });

  it('keeps its way when the current runs along the axle', () => {
    expect(undershotSign(0, 1, 0, -1)).toBe(-1);
    expect(undershotSign(0, 0, 0, 1)).toBe(1);
  });

  it('the mill layer turns its wheel that way', () => {
    const heights = { width: 32, height: 32, terrainAt: () => 1, depthAt: () => 0.5 };
    for (const [rot, vx, vy] of [
      [0, 0, 1],
      [0, 0, -1],
      [Math.PI / 2, 1, 0],
      [Math.PI / 2, -1, 0],
    ] as const) {
      const layer = new MillWheelsLayer(new THREE.Scene(), heights);
      layer.flowAt = (_x, _y, out) => {
        out[0] = vx;
        out[1] = vy;
        return out;
      };
      const mill = { id: 1, kind: 'mill', x: 10, y: 10, rot, progress: 1, spin: 1 } as unknown as BuildingInfo;
      layer.setBuildings([mill]);
      const m0 = new THREE.Matrix4();
      const m1 = new THREE.Matrix4();
      layer.mesh.getMatrixAt(0, m0);
      layer.update(0.05, 1);
      layer.mesh.getMatrixAt(0, m1);
      const b0 = new THREE.Vector3(0, -1, 0).applyMatrix4(m0);
      const b1 = new THREE.Vector3(0, -1, 0).applyMatrix4(m1);
      expect((b1.x - b0.x) * vx + (b1.z - b0.z) * vy).toBeGreaterThan(0);
    }
  });
});

/** The player's noria as the layer draws it: its instance matrix applied to the unit model's axes. */
function noriaFrames(head: [number, number], v: [number, number]): { axle: THREE.Vector3; bottom: THREE.Vector3; top: THREE.Vector3 } {
  const heights = { width: 32, height: 32, terrainAt: (x: number) => (x > 12.5 ? 4 : 1), depthAt: (x: number) => (x > 12.5 ? 0 : 0.6) };
  const layer = new StructuresLayer(new THREE.Scene(), heights);
  layer.flowAt = (_x, _y, out) => {
    out[0] = v[0];
    out[1] = v[1];
    return out;
  };
  const [hx, hy] = head;
  const wh = {
    id: 7, kind: 'wheel', x: 10, y: 10, x2: 10 + hx, y2: 10 + hy, rot: Math.atan2(hy, hx), width: Math.hypot(hx, hy),
    top: 4, sill: 0.5, open: true, progress: 1, speed: 1, flow: 1,
  } as StructureInfo;
  layer.setStructures([wh]);
  const mesh = (layer as unknown as { pieces: { noria: { mesh: THREE.InstancedMesh } } }).pieces.noria.mesh;
  const m0 = new THREE.Matrix4();
  const m1 = new THREE.Matrix4();
  layer.update(0.01);
  mesh.getMatrixAt(0, m0);
  layer.update(0.02);
  mesh.getMatrixAt(0, m1);
  const at = (m: THREE.Matrix4, x: number, y: number) => new THREE.Vector3(x, y, 0).applyMatrix4(m);
  // The unit noria (structures.ts noriaGeometry): axle along local x, buckets on the +x (trough) side.
  const c = at(m0, 0, 0);
  return {
    axle: at(m0, 1, 0).sub(c).setY(0).normalize(),
    bottom: at(m1, 0, -0.5).sub(at(m0, 0, -0.5)),
    top: at(m1, 0, 0.5).sub(at(m0, 0, 0.5)),
  };
}

describe('the noria', () => {
  it('stands across the current, its axle towards the head (snapped to it when nearly so)', () => {
    expect(noriaAxle(Math.PI / 2, 0, 2, 1, 0)).toBeCloseTo(Math.PI / 2);
    expect(noriaAxle(0, 2, 0, -1, 0)).toBeCloseTo(-Math.PI / 2, 5);
    expect(noriaAxle(0, 2, 0, -1, 1)).toBeCloseTo(Math.PI / 4);
    expect(noriaAxle(0.3, 2, 0, 0, 0)).toBe(0.3);
    expect(noriaAxle(Math.PI / 2, 0.3, 2, 1, 0)).toBeCloseTo(Math.atan2(2, 0.3));
  });

  for (const [name, head, v] of [
    ['bank across the current', [2, 0], [0, 1.2]],
    ['bank across the current, flowing the other way', [2, 0], [0, -1.2]],
    ['head downstream along the bank', [2, 0], [1, 0.2]],
    ['head upstream, diagonally', [2, 1], [-1, 0.6]],
  ] as const) {
    it(`turns with its plane along the current and its bottom downstream (${name})`, () => {
      const f = noriaFrames(head as [number, number], v as [number, number]);
      const sp = Math.hypot(v[0], v[1]);
      // Plane along the flow: the axle is across it…
      expect(Math.abs(f.axle.x * v[0] + f.axle.z * v[1]) / sp).toBeLessThan(0.36);
      // …and points to the bank where the trough is.
      expect(f.axle.x * head[0] + f.axle.z * head[1]).toBeGreaterThan(0);
      // The bottom moves with the current, the top against it.
      expect(f.bottom.x * v[0] + f.bottom.z * v[1]).toBeGreaterThan(0);
      expect(f.top.x * v[0] + f.top.z * v[1]).toBeLessThan(0);
    });
  }
});
