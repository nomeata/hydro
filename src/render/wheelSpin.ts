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
