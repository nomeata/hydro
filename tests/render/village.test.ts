import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MODELS, type ModelName } from '../../src/render/objects/manifest';
import type { StaticModel } from '../../src/render/objects/loader';
import { scatter, snowCap, VegetationLayer, VegKind } from '../../src/render/objects/vegetation';
import { SNOW_ATTRIBUTE } from '../../src/render/objects/snowCap';
import { weirSites } from '../../src/render/worldLayers';
import { SculptCrew } from '../../src/render/crowd/sculptCrew';
import type { HeightSampler } from '../../src/render/coords';
import { LandUse, SoilType } from '../../src/sim/world';
import { FIELD_BYTES } from '../../src/shared/protocol';
import {
  HOUSE_DESIGNS,
  MAX_FOOD_PROPS,
  Stage,
  buildStage,
  foodLevel,
  houseVariant,
  partsAt,
  ruinDesign,
  storeDesign,
  villageModels,
} from '../../src/render/village/houses';
import { BuildingsLayer, buildDesignGeometry, buildingKey, repaint } from '../../src/render/village/buildings';
import { CROP_RIPE, PATCH, cropKind, furrowsAlongX, patchHash } from '../../src/render/village/fields';
import { CROP_MODELS, cropPlacements } from '../../src/render/village/crops';
import { deckAt, deckHeight, deckOf } from '../../src/render/structures/decks';

/** Stub library: every model is a unit box with a teal or grey colour. */
const stub = {
  preloadStatic: async (names: readonly ModelName[]): Promise<StaticModel[]> =>
    names.map((name) => {
      const g = new THREE.BoxGeometry(0.5, 0.5, 0.5);
      g.translate(0, 0.25, 0);
      g.deleteAttribute('uv');
      const n = g.getAttribute('position').count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set([0.1, 0.45, 0.3], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return { name, geometry: g, material: new THREE.MeshBasicMaterial(), height: 0.5, radius: 0.25 };
    }),
};

const flat = (n: number): HeightSampler => ({ width: n, height: n, terrainAt: () => 10, depthAt: () => 0 });

describe('building designs', () => {
  it('maps progress to stages', () => {
    expect(buildStage(0)).toBe(Stage.Foundation);
    expect(buildStage(0.29)).toBe(Stage.Foundation);
    expect(buildStage(0.3)).toBe(Stage.Walls);
    expect(buildStage(0.69)).toBe(Stage.Walls);
    expect(buildStage(0.7)).toBe(Stage.Roof);
    expect(buildStage(0.99)).toBe(Stage.Roof);
    expect(buildStage(1)).toBe(Stage.Done);
  });

  it('picks variants deterministically and uses all of them', () => {
    const seen = new Set<number>();
    for (let id = 0; id < 200; id++) {
      const v = houseVariant(id);
      expect(v).toBe(houseVariant(id));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(HOUSE_DESIGNS.length);
      seen.add(v);
    }
    expect(seen.size).toBe(HOUSE_DESIGNS.length);
  });

  it('builds up stage by stage: stakes, walls, roof, chimney', () => {
    for (const d of HOUSE_DESIGNS) {
      const has = (s: Stage, pred: (m: string) => boolean) => partsAt(d, s).some((p) => pred(p.m));
      const wall = (m: string) => m.startsWith('town_wall');
      const roof = (m: string) => m.startsWith('town_roof');
      expect(has(Stage.Foundation, (m) => m === 'stake')).toBe(true);
      expect(has(Stage.Foundation, wall)).toBe(false);
      expect(has(Stage.Walls, wall)).toBe(true);
      expect(has(Stage.Walls, roof)).toBe(false);
      expect(has(Stage.Walls, (m) => m === 'pole')).toBe(true);
      expect(has(Stage.Roof, roof)).toBe(true);
      expect(has(Stage.Roof, (m) => m === 'town_chimney')).toBe(false);
      expect(has(Stage.Done, roof)).toBe(true);
      expect(has(Stage.Done, (m) => m === 'town_chimney')).toBe(true);
      expect(has(Stage.Done, (m) => m === 'pole')).toBe(false);
      // Exactly one door.
      expect(partsAt(d, Stage.Done).filter((p) => p.m.includes('door')).length).toBe(1);
    }
  });

  it('draws flood ruins wrecked, not as a building site, overgrown with age', async () => {
    for (let v = 0; v < HOUSE_DESIGNS.length; v++) {
      const r = ruinDesign(v, 0);
      const ms = r.parts.map((p) => p.m as string);
      // No scaffolding, stakes, roof on top or chimney; mud, debris and leaning walls instead.
      expect(ms).not.toContain('pole');
      expect(ms).not.toContain('stake');
      expect(ms).not.toContain('town_chimney');
      expect(ms).not.toContain('survival_resource_planks');
      expect(ms).toContain('mud');
      expect(ms).toContain('rubble');
      const walls = r.parts.filter((p) => (p.m as string).includes('wall'));
      expect(walls.filter((p) => (p.lean ?? 0) > 1).length).toBeGreaterThanOrEqual(1); // one fallen flat
      expect(walls.filter((p) => Math.abs(p.lean ?? 0) > 0.05 || (p.roll ?? 0) !== 0).length).toBe(walls.length);
      const roof = r.parts.find((p) => (p.m as string).startsWith('town_roof'))!;
      expect(roof.y).toBeLessThan(0.5); // caved in
      const weeds = (k: number) => ruinDesign(v, k).parts.filter((p) => p.fresh).length;
      expect(weeds(0)).toBe(0);
      expect(weeds(1)).toBeGreaterThan(0);
      expect(weeds(2)).toBeGreaterThan(weeds(1));
    }
    expect(buildingKey({ id: 5, kind: 'ruin', x: 0, y: 0, rot: 0, progress: 0, weeds: 1 }, 0)).toMatch(/^ruin:\d:1$/);
    const map = new Map((await stub.preloadStatic(villageModels())).map((m) => [m.name, m]));
    expect(buildDesignGeometry(ruinDesign(0, 2), Stage.Done, map).getAttribute('position').count).toBeGreaterThan(100);
  });

  it('footbridge decks arch from bank to bank; people walk on them', () => {
    const d = deckOf({ id: 1, kind: 'bridge', x: 10, y: 10, x2: 10, y2: 14, rot: Math.PI / 2, width: 3, top: 31, sill: 30, open: false, progress: 1 }, () => 30.5)!;
    expect(d).not.toBeNull();
    expect(deckHeight(d, d.u0)).toBeCloseTo(30.56, 5);
    expect(deckHeight(d, (d.u0 + d.u1) / 2)).toBeGreaterThan(31);
    expect(deckAt(d, 10, 12)).toBeGreaterThan(31);
    expect(Number.isNaN(deckAt(d, 12, 12))).toBe(true);
  });

  it('only uses models from the manifest', () => {
    for (const m of villageModels()) expect(MODELS[m], m).toBeDefined();
  });

  it('shows 0–6 sacks following food per head', () => {
    expect(foodLevel(0, 4)).toBe(0);
    expect(foodLevel(-5, 4)).toBe(0);
    expect(foodLevel(80, 4)).toBe(1);
    expect(foodLevel(240, 4)).toBe(3);
    expect(foodLevel(1e6, 4)).toBe(MAX_FOOD_PROPS);
    expect(foodLevel(100, 0)).toBe(5);
    for (let k = 0; k <= MAX_FOOD_PROPS; k++) expect(partsAt(storeDesign(k), Stage.Done).filter((p) => p.m === 'sack').length).toBe(k);
  });

  it('repaints the kit teal roof and blue-grey plaster, keeping other colours', () => {
    const col = new Float32Array([0.06, 0.352, 0.242, 0.418, 0.462, 0.694, 0.604, 0.238, 0.13]);
    const roof = new THREE.Color(0.5, 0.2, 0.1);
    const plaster = new THREE.Color(0.8, 0.7, 0.5);
    repaint(col, roof, plaster);
    expect(col[0]).toBeGreaterThan(col[1]!);
    expect(col[3]).toBeCloseTo(0.8, 3);
    expect([...col.slice(6)]).toEqual([...new Float32Array([0.604, 0.238, 0.13])]);
  });

  it('merges a design into one geometry with colours', async () => {
    const ms = await stub.preloadStatic(villageModels());
    const map = new Map(ms.map((m) => [m.name, m]));
    const done = buildDesignGeometry(HOUSE_DESIGNS[0]!, Stage.Done, map);
    const found = buildDesignGeometry(HOUSE_DESIGNS[0]!, Stage.Foundation, map);
    expect(done.getAttribute('color')).toBeDefined();
    // The finished house is taller than its foundation.
    expect(done.boundingBox!.max.y).toBeGreaterThan(found.boundingBox!.max.y + 0.5);
  });

  it('draws one InstancedMesh per (variant, stage) in use', async () => {
    const scene = new THREE.Scene();
    const layer = new BuildingsLayer(scene, flat(32), { library: stub });
    await layer.ready;
    const list = [
      { id: 1, kind: 'store' as const, x: 5, y: 5, rot: 0, progress: 1 },
      { id: 2, kind: 'house' as const, x: 8, y: 5, rot: Math.PI / 2, progress: 1 },
      { id: 3, kind: 'house' as const, x: 11, y: 5, rot: 0, progress: 0.5 },
    ];
    layer.setBuildings(list);
    const keys = new Set(list.map((b) => buildingKey(b, 0)));
    expect(layer.meshCount).toBe(keys.size);
    layer.setBuildings(list.map((b) => ({ ...b, progress: 1 })));
    expect(layer.meshCount).toBe(new Set(list.map((b) => buildingKey({ ...b, progress: 1 }, 0))).size);
    layer.setBuildings([]);
    expect(layer.meshCount).toBe(0);
    layer.dispose();
  });
});

describe('fields', () => {
  it('furrow direction and crop kind are constant per patch and vary between patches', () => {
    expect(patchHash(3, 4)).toBe(patchHash(3, 4));
    const dirs = new Set<boolean>();
    const kinds = new Set<number>();
    for (let b = 0; b < 40; b++) {
      const x0 = b * PATCH;
      for (let k = 0; k < PATCH; k++) {
        expect(furrowsAlongX(x0 + k, 7)).toBe(furrowsAlongX(x0, 6));
        expect(cropKind(x0 + k, 7)).toBe(cropKind(x0, 6));
      }
      dirs.add(furrowsAlongX(x0, 6));
      kinds.add(cropKind(x0, 6));
    }
    expect(dirs.size).toBe(2);
    expect(kinds.size).toBeGreaterThanOrEqual(3);
  });

  it('places crop models only on sown field cells, inside the cell', () => {
    const n = 16;
    const f = new Uint8Array(n * n * FIELD_BYTES);
    const set = (x: number, y: number, lu: number, crop: number) => {
      f[FIELD_BYTES * (y * n + x)] = lu;
      f[FIELD_BYTES * (y * n + x) + 1] = crop;
    };
    set(2, 2, LandUse.Field, 0); // ploughed: no plants
    set(3, 2, LandUse.Field, 120);
    set(4, 2, LandUse.Field, CROP_RIPE);
    set(5, 2, LandUse.Building, 200);
    const ps = cropPlacements(f, n, n, 0, 0, n, n);
    expect(ps.length).toBe(8);
    for (const p of ps) {
      expect(Math.round(p.y)).toBe(2);
      expect([3, 4]).toContain(Math.round(p.x));
      expect(CROP_MODELS).toContain(p.model);
      expect(p.scale).toBeGreaterThan(0);
    }
    expect(cropPlacements(f, n, n, 0, 0, n, n)).toEqual(ps);
    // Clipped to the requested region.
    expect(cropPlacements(f, n, n, 4, 0, n, n).length).toBe(4);
  });
});

describe('vegetation and land use', () => {
  const n = 64;
  const look = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    look[i * 4] = SoilType.Loam;
    look[i * 4 + 1] = 128;
    look[i * 4 + 2] = 245;
  }
  const heights = flat(n);
  const landuse = new Uint8Array(n * n);
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) landuse[y * n + x] = LandUse.Field;

  it('scatter skips built-up and farmed cells', () => {
    const all = scatter({ heights, look, width: n, height: n, seed: 3 }, 0, 0, n, n);
    const some = scatter({ heights, look, width: n, height: n, seed: 3, landuse }, 0, 0, n, n);
    // Placements jitter up to ±0.4 cells: test the field's interior.
    const inFields = (p: { x: number; y: number }) => p.x >= 11 && p.x < 29 && p.y >= 11 && p.y < 29;
    expect(all.some(inFields)).toBe(true);
    expect(some.some(inFields)).toBe(false);
    expect(some.length).toBeLessThan(all.length);
    expect(some.filter((p) => p.kind === VegKind.Deciduous || p.kind === VegKind.Conifer).length).toBeGreaterThan(0);
  });

  it('VegetationLayer.setFields re-scatters around fields and buildings', async () => {
    const scene = new THREE.Scene();
    const layer = new VegetationLayer(scene, heights, look, n, n, 3, { library: stub, autoCull: false });
    await layer.ready;
    const before = layer.instanceCount;
    const fields = new Uint8Array(n * n * FIELD_BYTES);
    for (let i = 0; i < n * n; i++) fields[FIELD_BYTES * i] = landuse[i]!;
    fields[FIELD_BYTES * (40 * n + 40)] = LandUse.Building;
    layer.setFields(fields);
    layer.flush();
    const after = layer.instanceCount;
    expect(after).toBeLessThan(before);
    layer.dispose();
  });
});

describe('snow on objects', () => {
  const n = 64;
  const lookWith = (snow: number) => {
    const look = new Uint8Array(n * n * 4);
    for (let i = 0; i < n * n; i++) {
      look[i * 4] = SoilType.Loam;
      look[i * 4 + 1] = 128;
      look[i * 4 + 2] = 245;
      look[i * 4 + 3] = snow;
    }
    return look;
  };
  const heights = flat(n);
  const isTree = (p: { kind: VegKind }) => p.kind === VegKind.Deciduous || p.kind === VegKind.Conifer;

  it('trees keep their species and places when it snows, and carry the cover', () => {
    const bare = scatter({ heights, look: lookWith(0), width: n, height: n, seed: 3 }, 0, 0, n, n).filter(isTree);
    const snowy = scatter({ heights, look: lookWith(230), width: n, height: n, seed: 3 }, 0, 0, n, n).filter(isTree);
    expect(snowy.map((p) => [p.kind, p.x, p.y])).toEqual(bare.map((p) => [p.kind, p.x, p.y]));
    expect(snowy.every((p) => (p.snow ?? 0) > 0.85)).toBe(true);
    expect(snowCap(0)).toBe(0);
    expect(snowCap(0.95)).toBe(1);
    expect(snowCap(0.5)).toBeGreaterThan(0.3);
  });

  it('VegetationLayer caps trees with snow per instance, and dulls deciduous leaves in winter', async () => {
    const scene = new THREE.Scene();
    const layer = new VegetationLayer(scene, heights, lookWith(0), n, n, 3, { library: stub, autoCull: false, season: 3 });
    await layer.ready;
    const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, -1000, 1000);
    camera.position.set(32, 100, 32);
    camera.lookAt(32, 0, 32);
    const snowOf = () => {
      layer.cull(camera);
      const tree = layer.group.children.find((m) => m.name.startsWith('veg-tree') && (m as THREE.InstancedMesh).count > 0) as THREE.InstancedMesh;
      const a = tree.geometry.getAttribute(SNOW_ATTRIBUTE);
      return { cap: a.getX(0), dull: a.getY(0), material: tree.material as THREE.Material };
    };
    const before = snowOf();
    expect(before.cap).toBe(0);
    expect(before.dull).toBeGreaterThan(0);
    expect(before.material.name).toMatch(/-snow$/);
    layer.update(lookWith(230));
    layer.flush();
    expect(snowOf().cap).toBeGreaterThan(0.8);
    layer.dispose();
  });
});

describe('weir building sites', () => {
  it('are on the dry bank at both ends of an unfinished weir, and the crew keeps its feet dry', () => {
    // A river along y 8..12 (wet), a weir across it from (20, 4) to (20, 16).
    const heights: HeightSampler = { width: 32, height: 32, terrainAt: () => 10, depthAt: (_x, y) => (y >= 8 && y <= 12 ? 1 : 0) };
    const weir = { id: 1, kind: 'weir' as const, x: 20, y: 4, x2: 20, y2: 16, rot: Math.PI / 2, width: 12, top: 11, sill: 10, open: false, progress: 0.4 };
    const sites = weirSites({ heights, structures: { structures: [weir] } } as never);
    expect(sites.length).toBe(2);
    for (const [x, y] of sites) {
      expect(heights.depthAt(x, y)).toBe(0);
      expect(Math.abs(x - 20)).toBeLessThan(0.01);
    }
    expect(Math.min(...sites.map(([, y]) => Math.abs(y - 7.5)))).toBeLessThan(0.6);
    expect(weirSites({ heights, structures: { structures: [{ ...weir, progress: 1 }] } } as never)).toEqual([]);
    const crew = new SculptCrew(undefined, (x, y) => heights.depthAt(x, y) < 0.05);
    for (let k = 0; k < 60 * 30; k++) {
      for (const [x, y] of sites) crew.site(x, y);
      crew.advance(1 / 60);
    }
    expect(crew.count).toBeGreaterThan(0);
    const f = crew.frame();
    for (let k = 0; k < f.count; k++) expect(heights.depthAt(f.pos[k * 5]!, f.pos[k * 5 + 1]!)).toBe(0);
  });
});
