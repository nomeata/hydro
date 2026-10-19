import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EntityAnim, EntityKind } from '../../src/shared/protocol';
import { FootprintBuffer, FootprintLayer, FOOTPRINT_LIFE_DAYS, PrintKind } from '../../src/render/footprints';
import type { Track } from '../../src/render/crowd/tracks';

describe('footprint ring buffer', () => {
  it('spawns, fades over its life and reuses the oldest slots when full', () => {
    const b = new FootprintBuffer(4, 2);
    expect(b.count).toBe(0);
    const i = b.spawn(1, 2, 0, PrintKind.Boot, 0.1, 10);
    expect(b.count).toBe(1);
    expect(b.alpha(i, 10)).toBe(1);
    expect(b.alpha(i, 10.5)).toBe(1);
    const mid = b.alpha(i, 11.3);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(b.alpha(i, 12)).toBe(0);
    expect(b.alpha(i, 9)).toBe(0);
    for (let k = 0; k < 5; k++) b.spawn(k, k, 0, PrintKind.Hoof, 0.1, 11 + k * 0.1);
    expect(b.count).toBe(4);
    expect(b.spawned).toBe(6);
    // The first two prints were overwritten: the oldest left is from 11.1.
    expect(Math.min(...b.birth)).toBeCloseTo(11.1, 6);
    expect(b.live(11.5)).toBe(4);
    expect(b.live(20)).toBe(0);
  });
});

function world(W: number, snow: number) {
  const look = new Uint8Array(W * W * 4);
  for (let i = 0; i < W * W; i++) look[i * 4 + 3] = snow;
  const fields = new Uint8Array(W * W * 4);
  const heights = {
    width: W,
    height: W,
    terrainAt: () => 10,
    depthAt: () => 0,
  };
  return { look, fields, heights };
}

function walker(id: number, kind: number, x: number, y: number, anim = EntityAnim.Walk): Track {
  return { id, kind, variant: 0, anim, carry: 0, x, y, fromX: x, fromY: y, toX: x, toY: y, t0: 0, vx: 0, vy: 0, targetHeading: 0, heading: 0, speed: 0.5, gen: 0, ext: null } as Track;
}

describe('footprint layer', () => {
  it('lays prints behind walkers on snow only, not on paths or bare ground, and fades on the game clock', () => {
    const W = 32;
    const { look, fields, heights } = world(W, 255);
    // A desire path along column 20, and bare ground for x >= 26.
    for (let y = 0; y < W; y++) {
      fields[(y * W + 20) * 4] = 4;
      for (let x = 26; x < W; x++) look[(y * W + x) * 4 + 3] = 0;
    }
    const layer = new FootprintLayer(heights, new THREE.Texture(), () => ({ look, fields }), 500);
    const person = walker(1, EntityKind.Person, 2, 5);
    const cow = walker(2, EntityKind.Cow, 2, 8);
    const sitter = walker(3, EntityKind.Person, 2, 11, EntityAnim.Sit);
    const tracks = [person, cow, sitter];
    layer.update(0.1, 1, tracks);
    // Walk 4 cells in 40 frames.
    for (let k = 0; k < 40; k++) {
      person.x += 0.1;
      cow.x += 0.1;
      sitter.x += 0.1;
      layer.update(0.1, 1, tracks);
    }
    const n = layer.buffer.count;
    expect(n).toBeGreaterThan(30);
    const kinds = new Set(Array.from(layer.buffer.kind.subarray(0, n)));
    expect(kinds).toEqual(new Set([PrintKind.Boot, PrintKind.Hoof]));
    // Nobody prints at the sitter's row; left and right feet alternate either side of the line.
    const ys = Array.from(layer.buffer.y.subarray(0, n));
    expect(ys.every((y) => Math.abs(y - 11) > 1)).toBe(true);
    expect(ys.some((y) => y > 5 && y < 5.2) && ys.some((y) => y < 5 && y > 4.8)).toBe(true);
    // Across the path and onto bare ground: no prints there.
    for (let k = 0; k < 240; k++) {
      person.x += 0.1;
      layer.update(0.1, 1, [person]);
    }
    const xs = Array.from(layer.buffer.x.subarray(0, layer.buffer.count));
    expect(xs.some((x) => x > 19.5 && x < 20.5)).toBe(false);
    expect(xs.some((x) => x >= 25.5)).toBe(false);
    expect(xs.some((x) => x > 21 && x < 25)).toBe(true);
    // Paused: the fade clock stands still and nothing new is laid.
    const now = layer.now;
    const spawned = layer.buffer.spawned;
    for (let k = 0; k < 100; k++) layer.update(0, 0, [person]);
    expect(layer.now).toBe(now);
    expect(layer.buffer.spawned).toBe(spawned);
    expect(layer.mesh.visible).toBe(true);
    // Running: gone after a couple of game days (30 s each at 1x); fresh snowfall covers them sooner.
    const live0 = layer.stats.live;
    expect(live0).toBeGreaterThan(0);
    layer.snowfall = 1;
    layer.update(30 * FOOTPRINT_LIFE_DAYS * 0.2, 1, []);
    expect(layer.stats.live).toBe(0);
    expect(layer.mesh.visible).toBe(false);
    layer.dispose();
  });

  it('never holds more than its capacity', () => {
    const W = 64;
    const { look, fields, heights } = world(W, 255);
    const layer = new FootprintLayer(heights, new THREE.Texture(), () => ({ look, fields }), 50);
    const ts = Array.from({ length: 10 }, (_, k) => walker(k, EntityKind.Dog, 2, 2 + k * 5));
    layer.update(0.1, 1, ts);
    for (let s = 0; s < 300; s++) {
      for (const t of ts) t.x += 0.15;
      layer.update(0.1, 1, ts);
    }
    expect(layer.buffer.spawned).toBeGreaterThan(200);
    expect(layer.buffer.count).toBe(50);
    expect(layer.stats.live).toBeLessThanOrEqual(50);
  });
});
