import { describe, expect, it } from 'vitest';
import { FlowParticles } from '../../src/render/flow';
import { HeightField } from '../../src/render/heights';
import { CameraController } from '../../src/render/camera';
import { seasonBlend, seasonPalette } from '../../src/render/seasons';
import { VEL_SCALE } from '../../src/shared/protocol';

function channel(W: number, H: number, vx: number): { hf: HeightField; vel: Int8Array } {
  const hf = new HeightField(W, H, new Float32Array(W * H));
  const vel = new Int8Array(W * H * 2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (y >= 28 && y <= 36) {
        hf.depth[i] = 1;
        vel[2 * i] = Math.round((vx / VEL_SCALE) * 127);
      }
    }
  }
  return { hf, vel };
}

describe('FlowParticles', () => {
  it('spawns in flowing water and drifts downstream', () => {
    const { hf, vel } = channel(64, 64, 1.5);
    const cam = new CameraController(hf);
    cam.setViewport(800, 600);
    cam.setState({ x: 32, y: 32, viewHeight: 36 });
    cam.update(0);
    const f = new FlowParticles(hf);
    f.setVelocity(vel);
    f.gameSpeed = 1;
    f.update(0.05, cam);
    expect(f.count).toBeGreaterThan(20);
    const px = (f as unknown as { px: Float32Array }).px;
    const py = (f as unknown as { py: Float32Array }).py;
    const x0 = Array.from(px.slice(0, 10));
    for (let i = 0; i < 10; i++) {
      expect(py[i]!).toBeGreaterThan(26);
      expect(py[i]!).toBeLessThan(38);
    }
    f.update(0.1, cam);
    // Same particles (no deaths in 0.1 s) moved in +x.
    for (let i = 0; i < 5; i++) expect(px[i]!).toBeGreaterThan(x0[i]!);
  });

  it('freezes when paused and spawns nothing in still water', () => {
    const { hf, vel } = channel(64, 64, 1.5);
    const cam = new CameraController(hf);
    cam.setViewport(800, 600);
    cam.setState({ x: 32, y: 32, viewHeight: 36 });
    const f = new FlowParticles(hf);
    f.setVelocity(vel);
    f.gameSpeed = 0;
    f.update(0.05, cam);
    const px = (f as unknown as { px: Float32Array }).px;
    const x0 = px[0]!;
    f.update(0.1, cam);
    expect(px[0]).toBe(x0);

    const still = channel(64, 64, 0);
    const g = new FlowParticles(still.hf);
    g.setVelocity(still.vel);
    g.update(0.05, cam);
    expect(g.count).toBe(0);
  });
});

describe('season palette', () => {
  it('holds each season in its middle and blends at boundaries', () => {
    expect(seasonBlend(0.5)).toMatchObject({ a: 0, t: 0 });
    expect(seasonBlend(2.5)).toMatchObject({ a: 2, t: 0 });
    const edge = seasonBlend(3.0);
    expect(edge.a).toBe(2);
    expect(edge.t).toBeCloseTo(0.5);
    // Autumn grass is warmer (more red relative to green) than summer grass.
    const summer = seasonPalette(1.5);
    const autumn = seasonPalette(2.5);
    expect(autumn.grassLush.r / autumn.grassLush.g).toBeGreaterThan(summer.grassLush.r / summer.grassLush.g);
  });
});
