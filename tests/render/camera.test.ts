import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../../src/render/camera';
import { HeightField } from '../../src/render/heights';
import { heightToY } from '../../src/render/coords';

const VW = 800;
const VH = 600;

function makeCam(): CameraController {
  const hf = new HeightField(128, 128); // flat at 0
  const cam = new CameraController(hf);
  cam.setViewport(VW, VH);
  cam.setState({ x: 64, y: 64, yaw: 0.7, pitch: 0.6, viewHeight: 50 });
  return cam;
}

/** Project a ground point (cell coords) to client pixels. */
function toScreen(cam: CameraController, cx: number, cy: number): [number, number] {
  const v = new THREE.Vector3(cx + 0.5, 0, cy + 0.5).project(cam.camera);
  return [((v.x + 1) / 2) * VW, ((1 - v.y) / 2) * VH];
}

/** Ground point (cell coords) under a client pixel, on the y=0 plane. */
function toGround(cam: CameraController, px: number, py: number): [number, number] {
  const { origin, dir } = cam.rayAt(px, py);
  const t = -origin.y / dir.y;
  return [origin.x + dir.x * t - 0.5, origin.z + dir.z * t - 0.5];
}

const settle = (cam: CameraController): void => {
  for (let i = 0; i < 50; i++) cam.update(0.1);
};

describe('CameraController', () => {
  it('round-trips state', () => {
    const cam = makeCam();
    const s = { x: 10.5, y: 99, yaw: -2, pitch: 0.7, viewHeight: 33 };
    cam.setState(s);
    expect(cam.getState()).toEqual(s);
    expect(cam.getCurrentState()).toEqual(s);
  });

  it('clamps to world bounds and limits', () => {
    const cam = makeCam();
    cam.setState({ x: -50, y: 1000, pitch: 3, viewHeight: 1e6 });
    const s = cam.getState();
    expect(s.x).toBe(0);
    expect(s.y).toBe(127);
    expect(s.pitch).toBe(cam.limits.maxPitch);
    expect(s.viewHeight).toBe(cam.limits.maxViewHeight);
    cam.setState({ pitch: -1, viewHeight: 0.01 });
    expect(cam.getState().pitch).toBe(cam.limits.minPitch);
    expect(cam.getState().viewHeight).toBe(cam.limits.minViewHeight);
    cam.panBy(1e6, 1e6);
    const p = cam.getState();
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(127);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeLessThanOrEqual(127);
  });

  it('looks at the target from the screen centre', () => {
    const cam = makeCam();
    const [gx, gy] = toGround(cam, VW / 2, VH / 2);
    expect(gx).toBeCloseTo(64, 4);
    expect(gy).toBeCloseTo(64, 4);
  });

  it('pans so that the ground follows the pointer', () => {
    const cam = makeCam();
    const g = toGround(cam, 300, 200);
    cam.panBy(40, -25);
    settle(cam);
    const [sx, sy] = toScreen(cam, g[0], g[1]);
    expect(sx).toBeCloseTo(340, 3);
    expect(sy).toBeCloseTo(175, 3);
  });

  it('zooms around the cursor', () => {
    const cam = makeCam();
    const g = toGround(cam, 650, 120);
    cam.zoomBy(1.7, 650, 120);
    settle(cam);
    expect(cam.getState().viewHeight).toBeCloseTo(50 / 1.7);
    const [sx, sy] = toScreen(cam, g[0], g[1]);
    expect(sx).toBeCloseTo(650, 3);
    expect(sy).toBeCloseTo(120, 3);
  });

  it('rotates around a client point, keeping it fixed', () => {
    const cam = makeCam();
    const g = toGround(cam, 250, 400);
    cam.rotateBy(0.9, 250, 400);
    settle(cam);
    const [sx, sy] = toScreen(cam, g[0], g[1]);
    expect(sx).toBeCloseTo(250, 3);
    expect(sy).toBeCloseTo(400, 3);
  });

  it('twist: positive rotation turns the world clockwise on screen', () => {
    const cam = makeCam();
    // A point to the right of the centre should move down (clockwise, y down).
    const g = toGround(cam, VW / 2 + 100, VH / 2);
    cam.rotateBy(0.2);
    settle(cam);
    const [, sy] = toScreen(cam, g[0], g[1]);
    expect(sy).toBeGreaterThan(VH / 2);
  });

  it('damps towards the goal', () => {
    const cam = makeCam();
    cam.focus(80, 64);
    cam.update(1 / 60);
    const c = cam.getCurrentState().x;
    expect(c).toBeGreaterThan(64);
    expect(c).toBeLessThan(80);
    settle(cam);
    expect(cam.getCurrentState().x).toBeCloseTo(80, 4);
  });

  it('follows terrain height with the target', () => {
    const hf = new HeightField(32, 32);
    hf.terrain.fill(50);
    const cam = new CameraController(hf);
    cam.setViewport(VW, VH);
    cam.setState({ x: 16, y: 16 });
    expect(cam.targetWorld().y).toBeCloseTo(heightToY(50));
  });
});
