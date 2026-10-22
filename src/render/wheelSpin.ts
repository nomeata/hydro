/**
 * Which way an undershot wheel turns: only its bottom dips into the water,
 * so the bottom moves with the current. Shared by the village mills
 * (village/millwheels.ts) and the player's water wheels (structures).
 *
 * Both wheels are modelled with the axle along local x and turn by an angle
 * about it; for a positive angle step the bottom point (0, −r, 0) moves
 * along local −z. The orientation quaternions below are the ones the layers
 * draw with; `bottomDirection` maps local −z through the yaw.
 */
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const tmpQ = new THREE.Quaternion();

/** Orientation of a wheel turned by `yaw` about the vertical, then by `angle` about its axle. */
export function wheelQuaternion(yaw: number, angle: number, out = new THREE.Quaternion()): THREE.Quaternion {
  out.setFromAxisAngle(UP, yaw);
  return out.multiply(tmpQ.setFromAxisAngle(X, angle));
}

/** Horizontal direction (cell x, cell y) the bottom of a wheel with this yaw moves in as its angle grows. */
export function bottomDirection(yaw: number): [number, number] {
  // Local −z rotated by `yaw` about +y: (−sin yaw, −cos yaw) in (x, z).
  return [-Math.sin(yaw), -Math.cos(yaw)];
}

/**
 * +1 or −1: the sign of the angular velocity that moves the bottom of the
 * wheel with the current (vx, vy) (m/s, cell axes). Keeps `prev` when the
 * current runs (almost) along the axle.
 */
export function undershotSign(yaw: number, vx: number, vy: number, prev = 1): number {
  const [bx, by] = bottomDirection(yaw);
  const along = bx * vx + by * vy;
  const speed = Math.hypot(vx, vy);
  if (Math.abs(along) <= 0.15 * speed || speed < 1e-3) return prev;
  return along > 0 ? 1 : -1;
}

/** A noria's axle may lie this far (radians) off the line to its head cell before the trough bends. */
const AXLE_SNAP = 0.35;

/**
 * The direction (radians, cell axes, as `StructureInfo.rot`) of a noria's
 * axle. A noria stands with its wheel plane along the current, so the axle
 * lies across it, pointing to the bank its trough leads to (towards
 * `(hx, hy)`, the head cell relative to the wheel). Without a current to
 * go by, or when the line to the head is nearly across it anyway, the axle
 * points straight at the head (`rot`): one straight trough.
 */
export function noriaAxle(rot: number, hx: number, hy: number, vx: number, vy: number): number {
  const speed = Math.hypot(vx, vy);
  if (speed < 0.05) return rot;
  // Across the current, on the head's side.
  let ax = -vy / speed;
  let ay = vx / speed;
  const tx = hx || hy ? hx : Math.cos(rot);
  const ty = hx || hy ? hy : Math.sin(rot);
  if (ax * tx + ay * ty < 0) {
    ax = -ax;
    ay = -ay;
  }
  const a = Math.atan2(ay, ax);
  const t = Math.atan2(ty, tx);
  const off = Math.abs(Math.atan2(Math.sin(a - t), Math.cos(a - t)));
  return off <= AXLE_SNAP ? t : a;
}
