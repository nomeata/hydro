import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { undershotSign, wheelQuaternion } from '../../src/render/wheelSpin';
import { MillWheelsLayer } from '../../src/render/village/millwheels';
import type { BuildingInfo } from '../../src/shared/protocol';

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
