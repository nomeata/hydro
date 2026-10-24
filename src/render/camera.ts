/**
 * Orthographic, isometric-ish camera with free yaw, limited pitch, zoom and
 * pan, all smoothly damped. Positions are in fractional cell coordinates
 * (cell i centre at coordinate i, three.js x = i + 0.5), see heights.ts.
 */
import * as THREE from 'three';
import { heightToY, type HeightSampler } from './coords';

export { attachCameraInput } from './cameraInput';
export type { CameraInputOptions, CameraInputHandle } from './cameraInput';

export interface CameraState {
  /** Look-at target, fractional cell coordinates. */
  x: number;
  y: number;
  /** Rotation about the vertical axis (radians). 0 = looking towards −z. */
  yaw: number;
  /** Elevation angle of the view direction (radians). */
  pitch: number;
  /** Visible world height in three.js units (cells); smaller = closer. */
  viewHeight: number;
}

export interface CameraLimits {
  minPitch: number;
  maxPitch: number;
  minViewHeight: number;
  maxViewHeight: number;
}

const DEG = Math.PI / 180;

export class CameraController {
  readonly camera: THREE.OrthographicCamera;
  readonly limits: CameraLimits;
  /** Damping rate (1/s): higher is snappier. */
  damping = 14;
  private readonly goal: CameraState;
  private readonly cur: CameraState;
  private targetY: number;
  private viewportW = 1;
  private viewportH = 1;
  private viewportLeft = 0;
  private viewportTop = 0;
  private readonly distance: number;
  /** Optional pan limits (cells), e.g. the known land under the fog of war. */
  private panBounds: { x0: number; y0: number; x1: number; y1: number } | null = null;

  constructor(
    private readonly heights: HeightSampler,
    limits: Partial<CameraLimits> = {},
  ) {
    const size = Math.max(heights.width, heights.height);
    this.limits = {
      minPitch: 22 * DEG,
      maxPitch: 72 * DEG,
      minViewHeight: 8,
      maxViewHeight: size * 1.15,
      ...limits,
    };
    this.distance = size * 2 + 200;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, this.distance * 4);
    const s: CameraState = {
      x: (heights.width - 1) / 2,
      y: (heights.height - 1) / 2,
      yaw: Math.PI / 4,
      pitch: 35 * DEG,
      viewHeight: Math.min(40, this.limits.maxViewHeight),
    };
    this.goal = { ...s };
    this.cur = { ...s };
    this.targetY = heightToY(heights.terrainAt(s.x, s.y));
    this.apply();
  }

  /** Limit panning to a rectangle of cells (intersected with the map), or lift the limit. */
  setPanBounds(b: { x0: number; y0: number; x1: number; y1: number } | null): void {
    this.panBounds = b;
    this.clamp(this.goal);
  }

  /** Viewport in CSS pixels (client rect of the canvas). */
  setViewport(width: number, height: number, left = 0, top = 0): void {
    this.viewportW = Math.max(1, width);
    this.viewportH = Math.max(1, height);
    this.viewportLeft = left;
    this.viewportTop = top;
    this.apply();
  }

  getState(): CameraState {
    return { ...this.goal };
  }

  /** Current (damped) state, as rendered. */
  getCurrentState(): CameraState {
    return { ...this.cur };
  }

  setState(s: Partial<CameraState>, immediate = true): void {
    Object.assign(this.goal, s);
    this.clamp(this.goal);
    if (immediate) {
      Object.assign(this.cur, this.goal);
      this.targetY = heightToY(this.heights.terrainAt(this.cur.x, this.cur.y));
      this.apply();
    }
  }

  /** World units per CSS pixel at the goal zoom. */
  unitsPerPixel(): number {
    return this.goal.viewHeight / this.viewportH;
  }

  /** Drag the view by a pointer movement in CSS pixels ("grab the ground"). */
  panBy(dxPx: number, dyPx: number): void {
    const g = this.goal;
    const upp = this.unitsPerPixel();
    const [rx, rz] = right(g.yaw);
    const [fx, fz] = forward(g.yaw);
    const k = upp / Math.sin(g.pitch);
    g.x += -rx * dxPx * upp + fx * dyPx * k;
    g.y += -rz * dxPx * upp + fz * dyPx * k;
    this.clamp(g);
  }

  /** Zoom by `factor` (>1 zooms in), keeping the ground point under the given client position fixed. */
  zoomBy(factor: number, aroundClientX?: number, aroundClientY?: number): void {
    if (!(factor > 0)) return;
    const g = this.goal;
    const before = g.viewHeight;
    g.viewHeight = clampN(before / factor, this.limits.minViewHeight, this.limits.maxViewHeight);
    const eff = before / g.viewHeight;
    if (aroundClientX !== undefined && aroundClientY !== undefined && eff !== 1) {
      const [ox, oz] = this.groundOffset(aroundClientX, aroundClientY, before);
      g.x += ox * (1 - 1 / eff);
      g.y += oz * (1 - 1 / eff);
    }
    this.clamp(g);
  }

  /** Rotate about the vertical axis, around the screen centre or a client position. */
  rotateBy(radians: number, aroundClientX?: number, aroundClientY?: number): void {
    const g = this.goal;
    if (aroundClientX !== undefined && aroundClientY !== undefined) {
      const [ox, oz] = this.groundOffset(aroundClientX, aroundClientY, g.viewHeight);
      // Rotate the target about P = target + o by `radians` (same sense as yaw).
      const c = Math.cos(radians);
      const s = Math.sin(radians);
      const vx = -ox;
      const vz = -oz;
      g.x += ox + (vx * c + vz * s);
      g.y += oz + (-vx * s + vz * c);
    }
    g.yaw += radians;
    this.clamp(g);
  }

  /** Change the pitch (positive = look more steeply down). */
  tiltBy(radians: number): void {
    this.goal.pitch += radians;
    this.clamp(this.goal);
  }

  /** Move the target to a cell position (damped). */
  focus(cx: number, cy: number): void {
    this.goal.x = cx;
    this.goal.y = cy;
    this.clamp(this.goal);
  }

  /** Advance damping and update the three.js camera. */
  update(dtSec: number): void {
    const a = 1 - Math.exp(-Math.max(0, dtSec) * this.damping);
    const c = this.cur;
    const g = this.goal;
    c.x += (g.x - c.x) * a;
    c.y += (g.y - c.y) * a;
    c.pitch += (g.pitch - c.pitch) * a;
    // Zoom damped in log space for an even feel.
    c.viewHeight = Math.exp(Math.log(c.viewHeight) + (Math.log(g.viewHeight) - Math.log(c.viewHeight)) * a);
    c.yaw += (g.yaw - c.yaw) * a;
    // Snap once the rest is far below a pixel, so a still camera is exactly still (renderer.wantsFrame).
    if (Math.abs(g.x - c.x) < 1e-5) c.x = g.x;
    if (Math.abs(g.y - c.y) < 1e-5) c.y = g.y;
    if (Math.abs(g.pitch - c.pitch) < 1e-6) c.pitch = g.pitch;
    if (Math.abs(g.yaw - c.yaw) < 1e-6) c.yaw = g.yaw;
    if (Math.abs(g.viewHeight - c.viewHeight) < 1e-6 * g.viewHeight) c.viewHeight = g.viewHeight;
    const ty = heightToY(this.heights.terrainAt(c.x, c.y));
    this.targetY += (ty - this.targetY) * (1 - Math.exp(-Math.max(0, dtSec) * 4));
    if (Math.abs(ty - this.targetY) < 1e-5) this.targetY = ty;
    this.apply();
  }

  /** Whether the camera has come to rest (the damped state reached the goal). */
  isSettled(): boolean {
    const c = this.cur;
    const g = this.goal;
    return (
      c.x === g.x &&
      c.y === g.y &&
      c.pitch === g.pitch &&
      c.yaw === g.yaw &&
      c.viewHeight === g.viewHeight &&
      this.targetY === heightToY(this.heights.terrainAt(c.x, c.y))
    );
  }

  /** Current look-at point in three.js world coordinates. */
  targetWorld(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.cur.x + 0.5, this.targetY, this.cur.y + 0.5);
  }

  /** Normalised device coordinates for a client position. */
  clientToNdc(clientX: number, clientY: number): [number, number] {
    return [
      ((clientX - this.viewportLeft) / this.viewportW) * 2 - 1,
      -((clientY - this.viewportTop) / this.viewportH) * 2 + 1,
    ];
  }

  /** Ray (origin, direction) through a client position, world coordinates. */
  rayAt(clientX: number, clientY: number): { origin: THREE.Vector3; dir: THREE.Vector3 } {
    const [nx, ny] = this.clientToNdc(clientX, clientY);
    const cam = this.camera;
    cam.updateMatrixWorld();
    const origin = new THREE.Vector3(nx, ny, -1).unproject(cam);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
    return { origin, dir };
  }

  // -------------------------------------------------------------------------

  /** Ground-plane offset (cells) from target to the point under a client position. */
  private groundOffset(clientX: number, clientY: number, viewHeight: number): [number, number] {
    const g = this.goal;
    const upp = viewHeight / this.viewportH;
    const ox = clientX - (this.viewportLeft + this.viewportW / 2);
    const oy = clientY - (this.viewportTop + this.viewportH / 2);
    const [rx, rz] = right(g.yaw);
    const [fx, fz] = forward(g.yaw);
    const k = upp / Math.sin(g.pitch);
    return [rx * ox * upp - fx * oy * k, rz * ox * upp - fz * oy * k];
  }

  private clamp(s: CameraState): void {
    const L = this.limits;
    const b = this.panBounds;
    s.x = clampN(s.x, Math.max(0, b?.x0 ?? 0), Math.min(this.heights.width - 1, b?.x1 ?? Infinity));
    s.y = clampN(s.y, Math.max(0, b?.y0 ?? 0), Math.min(this.heights.height - 1, b?.y1 ?? Infinity));
    s.pitch = clampN(s.pitch, L.minPitch, L.maxPitch);
    s.viewHeight = clampN(s.viewHeight, L.minViewHeight, L.maxViewHeight);
    if (!Number.isFinite(s.yaw)) s.yaw = 0;
  }

  private apply(): void {
    const c = this.cur;
    const cam = this.camera;
    const aspect = this.viewportW / this.viewportH;
    const hh = c.viewHeight / 2;
    cam.left = -hh * aspect;
    cam.right = hh * aspect;
    cam.top = hh;
    cam.bottom = -hh;
    const cp = Math.cos(c.pitch);
    const tx = c.x + 0.5;
    const tz = c.y + 0.5;
    const D = this.distance;
    cam.position.set(tx + Math.sin(c.yaw) * cp * D, this.targetY + Math.sin(c.pitch) * D, tz + Math.cos(c.yaw) * cp * D);
    cam.up.set(0, 1, 0);
    cam.lookAt(tx, this.targetY, tz);
    cam.near = 1;
    cam.far = D * 2.5;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }
}

/** Screen-right direction on the ground for a yaw. */
function right(yaw: number): [number, number] {
  return [Math.cos(yaw), -Math.sin(yaw)];
}

/** Screen-up ("away from viewer") direction on the ground for a yaw. */
function forward(yaw: number): [number, number] {
  return [-Math.sin(yaw), -Math.cos(yaw)];
}

function clampN(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
