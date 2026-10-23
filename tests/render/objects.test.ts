import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as THREE from 'three';
import { CHARACTER_CLIPS, MODELS, PET_CLIPS, type ModelName } from '../../src/render/objects/manifest';
import { mergeStatic, unifyAnimated, vertexColorMaterial, type StaticModel } from '../../src/render/objects/loader';
import { scatter, VegetationLayer, VegKind, vegetationModels, type Placement } from '../../src/render/objects/vegetation';
import type { HeightSampler } from '../../src/render/coords';
import { SoilType } from '../../src/sim/world';

const ASSETS = join(__dirname, '../../public/assets');

function glbJson(path: string): any {
  const b = readFileSync(path);
  expect(b.readUInt32LE(0)).toBe(0x46546c67);
  const len = b.readUInt32LE(12);
  return JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
}

describe('asset manifest', () => {
  const entries = Object.entries(MODELS) as [ModelName, (typeof MODELS)[ModelName]][];

  it('every model file exists, is a valid GLB and resolves its textures', () => {
    for (const [name, e] of entries) {
      const path = join(ASSETS, e.file);
      expect(existsSync(path), `${name}: ${e.file}`).toBe(true);
      const j = glbJson(path);
      for (const img of j.images ?? []) {
        expect(img.uri, `${name} must reference external shared texture`).toBeTruthy();
        expect(existsSync(join(dirname(path), img.uri)), `${name}: ${img.uri}`).toBe(true);
      }
      if ('animated' in e && e.animated) {
        const clips = (j.animations ?? []).map((a: any) => a.name);
        const want = e.category === 'character' ? ['idle', 'walk', 'sit', 'interact-right'] : ['idle', 'walk', 'eat'];
        for (const c of want) expect(clips, `${name} clip ${c}`).toContain(c);
        for (const c of clips) expect([...CHARACTER_CLIPS, ...PET_CLIPS] as string[]).toContain(c);
      } else {
        expect(j.images ?? []).toHaveLength(0);
        expect(j.meshes).toHaveLength(1);
        expect(j.meshes[0].primitives).toHaveLength(1);
        expect(j.meshes[0].primitives[0].attributes.COLOR_0).toBeDefined();
      }
    }
  });

  it('stays within the download budget', () => {
    let total = 0;
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else total += s.size;
      }
    };
    walk(ASSETS);
    expect(total).toBeLessThan(4 * 1024 * 1024);
  });
});

describe('mergeStatic', () => {
  it('bakes transforms and material colours into one geometry', () => {
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xff0000 }));
    a.position.set(0, 0.5, 0);
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x00ff00 }));
    b.position.set(0, 2, 0);
    b.scale.set(1, 2, 1);
    root.add(a, b);
    const { geometry, map } = mergeStatic(root, 0.5);
    expect(map).toBeNull();
    const pos = geometry.getAttribute('position');
    const col = geometry.getAttribute('color');
    expect(pos.count).toBe(48);
    expect(geometry.getIndex()!.count).toBe(72);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.y).toBeCloseTo(0);
    expect(geometry.boundingBox!.max.y).toBeCloseTo(1.5); // (2 + 1) * 0.5
    expect(col.getX(0)).toBeCloseTo(1);
    expect(col.getY(0)).toBeCloseTo(0);
    expect(col.getY(47)).toBeCloseTo(1);
    expect(col.getX(47)).toBeCloseTo(0);
  });
});

describe('unifyAnimated', () => {
  it('turns rigid animated parts into one skinned mesh that follows its bones', () => {
    const root = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    body.name = 'body';
    body.position.y = 1;
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.5, 0.2), mat);
    leg.name = 'leg';
    leg.position.set(0.3, -0.75, 0);
    body.add(leg);
    root.add(body);
    expect(unifyAnimated(root)).toBe(true);
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    expect(meshes).toHaveLength(1);
    const sm = meshes[0] as THREE.SkinnedMesh;
    expect(sm.isSkinnedMesh).toBe(true);
    const legNode = root.getObjectByName('leg')!;
    expect(legNode).toBeDefined();
    // Bind pose: a leg vertex sits where it was.
    const v = new THREE.Vector3();
    root.updateMatrixWorld(true);
    sm.skeleton.update();
    const legVertex = 24; // first vertex of the second box
    sm.getVertexPosition(legVertex, v);
    const before = v.clone();
    expect(before.y).toBeCloseTo(1 - 0.75 + 0.25);
    // Animate: lift the leg node, its vertices follow; body vertices don't.
    legNode.position.y += 0.5;
    root.updateMatrixWorld(true);
    sm.skeleton.update();
    sm.getVertexPosition(legVertex, v);
    expect(v.y - before.y).toBeCloseTo(0.5);
    sm.getVertexPosition(0, v);
    expect(v.y).toBeCloseTo(1.5);
  });
});

// --- vegetation --------------------------------------------------------------

function world(n: number, f: (x: number, y: number) => { soil: number; moist: number; veg: number; depth?: number; h?: number }) {
  const look = new Uint8Array(n * n * 4);
  const depth = new Float32Array(n * n);
  const terrain = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const c = f(x, y);
      const i = y * n + x;
      look[i * 4] = c.soil;
      look[i * 4 + 1] = Math.round(c.moist * 255);
      look[i * 4 + 2] = Math.round(c.veg * 255);
      depth[i] = c.depth ?? 0;
      terrain[i] = c.h ?? 10;
    }
  const heights: HeightSampler = {
    width: n,
    height: n,
    terrainAt: (x, y) => terrain[Math.min(n - 1, Math.max(0, Math.round(y))) * n + Math.min(n - 1, Math.max(0, Math.round(x)))]!,
    depthAt: (x, y) => depth[Math.min(n - 1, Math.max(0, Math.round(y))) * n + Math.min(n - 1, Math.max(0, Math.round(x)))]!,
  };
  return { look, heights, depth };
}

describe('vegetation scatter', () => {
  const n = 64;
  const w = world(n, (x, y) => {
    if (x < 16) return { soil: SoilType.Loam, moist: 0.5, veg: 0.95 }; // forest
    if (x < 32) return { soil: SoilType.Rock, moist: 0.2, veg: 0.05 }; // rocky
    if (x < 48) return { soil: SoilType.Silt, moist: 0.9, veg: 0.4, depth: y < 32 ? 0.6 : 0 }; // lake + meadow
    return { soil: SoilType.Loam, moist: 0.3, veg: 0 }; // bare
  });
  const inp = { heights: w.heights, look: w.look, width: n, height: n, seed: 42 };
  const all = scatter(inp, 0, 0, n, n);
  const inRegion = (p: Placement, x0: number, x1: number) => Math.round(p.x) >= x0 && Math.round(p.x) < x1;

  it('is deterministic', () => {
    expect(scatter(inp, 0, 0, n, n)).toEqual(all);
    expect(scatter({ ...inp, seed: 43 }, 0, 0, n, n)).not.toEqual(all);
  });

  it('chunks compose to the whole', () => {
    const parts = [...scatter(inp, 0, 0, 32, n), ...scatter(inp, 32, 0, n, n)];
    expect(parts.length).toBe(all.length);
  });

  it('puts forest on high vegetation, rocks on rock soil, nothing but lilies in water', () => {
    const trees = all.filter((p) => p.kind === VegKind.Deciduous || p.kind === VegKind.Conifer);
    expect(trees.filter((p) => inRegion(p, 0, 16)).length).toBeGreaterThan(16 * 64 * 0.5);
    expect(trees.filter((p) => !inRegion(p, 0, 16)).length).toBe(0);
    const rocks = all.filter((p) => p.kind === VegKind.Rock || p.kind === VegKind.BigRock);
    expect(rocks.filter((p) => inRegion(p, 16, 32)).length).toBeGreaterThan(16 * 64 * 0.2);
    for (let y = 0; y < 32; y++)
      for (let x = 32; x < 48; x++) {
        const here = all.filter((p) => Math.round(p.x) === x && Math.round(p.y) === y);
        for (const p of here) expect(p.kind).toBe(VegKind.Lily);
      }
    expect(all.some((p) => p.kind === VegKind.Lily)).toBe(true);
    // Shore cells next to the lake get reeds.
    expect(all.filter((p) => p.kind === VegKind.Reed && p.y >= 32 && p.y < 35 && inRegion(p, 32, 48)).length).toBeGreaterThan(5);
    // Bare ground stays bare (except the odd stone).
    expect(all.filter((p) => inRegion(p, 51, 64) && p.kind !== VegKind.Rock).map((p) => [p.kind, p.x, p.y])).toEqual([]);
  });

  it('VegetationLayer culls per chunk and keeps draw calls low', async () => {
    const big = world(256, (x, y) => ({ soil: (x + y) % 97 < 10 ? SoilType.Rock : SoilType.Loam, moist: 0.5, veg: ((x * 7 + y * 3) % 100) / 100 }));
    const geometry = new THREE.BoxGeometry(0.2, 1, 0.2).translate(0, 0.5, 0);
    const stub = {
      preloadStatic: async (names: readonly ModelName[]): Promise<StaticModel[]> =>
        names.map((name) => ({ name, geometry, material: vertexColorMaterial(), height: 1, radius: 0.1 })),
    };
    const scene = new THREE.Scene();
    const layer = new VegetationLayer(scene, big.heights, big.look, 256, 256, 1, { library: stub });
    await layer.ready;
    expect(layer.instanceCount).toBeGreaterThan(10000);
    const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 100);
    cam.position.set(40, 20, 40);
    cam.lookAt(32, 2, 32);
    cam.updateMatrixWorld();
    layer.cull(cam);
    const meshes = layer.group.children as THREE.InstancedMesh[];
    const drawn = meshes.filter((m) => m.visible && m.count > 0);
    expect(drawn.length).toBe(layer.meshCount);
    expect(layer.meshCount).toBeLessThanOrEqual(vegetationModels().length);
    expect(layer.meshCount).toBeLessThan(40);
    const visibleInstances = drawn.reduce((s, m) => s + m.count, 0);
    expect(visibleInstances).toBeLessThan(layer.instanceCount / 2);
    layer.setDetail(0);
    expect(layer.meshCount).toBeLessThan(drawn.length);
    layer.dispose();
  });

  it('VegetationLayer culls in squares inside the chunks, and draws every instance in view exactly once', async () => {
    const big = world(256, (x, y) => ({ soil: SoilType.Loam, moist: 0.5, veg: ((x * 7 + y * 3) % 100) / 100 }));
    const geometry = new THREE.BoxGeometry(0.2, 1, 0.2).translate(0, 0.5, 0);
    const stub = {
      preloadStatic: async (names: readonly ModelName[]): Promise<StaticModel[]> =>
        names.map((name) => ({ name, geometry, material: vertexColorMaterial(), height: 1, radius: 0.1 })),
    };
    const layer = new VegetationLayer(new THREE.Scene(), big.heights, big.look, 256, 256, 1, { library: stub, autoCull: false });
    await layer.ready;
    const drawnKeys = () => {
      const keys: string[] = [];
      for (const m of layer.group.children as THREE.InstancedMesh[]) {
        if (!m.visible) continue;
        const a = m.instanceMatrix.array;
        for (let i = 0; i < m.count; i++) keys.push(`${m.name}@${a[i * 16 + 12]!.toFixed(3)},${a[i * 16 + 14]!.toFixed(3)}`);
      }
      return keys;
    };
    const camAt = (x: number, z: number, half: number) => {
      const cam = new THREE.OrthographicCamera(-half, half, half, -half, -500, 500);
      cam.position.set(x + 20, 30, z + 20);
      cam.lookAt(x, 0, z);
      cam.updateMatrixWorld();
      return cam;
    };
    // Everything: the whole map in view.
    layer.cull(camAt(128, 128, 400));
    const all = drawnKeys();
    expect(all.length).toBe(layer.instanceCount);
    expect(new Set(all).size).toBe(all.length);
    const allSet = new Set(all);
    // Views straddling chunk (64) and square (16) borders.
    for (const [x, z, half] of [
      [64, 64, 10],
      [47, 130, 14],
      [200, 30, 25],
      [128, 128, 40],
    ] as const) {
      const cam = camAt(x, z, half);
      layer.cull(cam);
      const keys = drawnKeys();
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of keys) expect(allSet.has(k)).toBe(true);
      // Every instance whose foot is in view is drawn.
      const drawnSet = new Set(keys);
      const pv = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      const v = new THREE.Vector3();
      let inView = 0;
      for (const k of all) {
        const [px, pz] = k.split('@')[1]!.split(',').map(Number);
        v.set(px!, 0, pz!).applyMatrix4(pv);
        if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
        inView++;
        expect(drawnSet.has(k)).toBe(true);
      }
      expect(inView).toBeGreaterThan(0);
      // Culling is finer than whole chunks: far fewer than everything.
      expect(keys.length).toBeLessThan(all.length / 3);
    }
    layer.dispose();
  });
});
