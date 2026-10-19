import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CarryKind, EntityAnim, EntityKind } from '../../src/shared/protocol';
import { mergeStatic, unifyAnimated } from '../../src/render/objects/loader';
import { MODELS, type ModelName } from '../../src/render/objects/manifest';
import { bakeBoneAnimation, boneAnchors, clipFrames, composeClip, sampleBone, BAKE_FPS } from '../../src/render/crowd/bake';
import {
  crowdModels,
  gaitRate,
  headingToYaw,
  lookFor,
  PERSON_CLIP_SPECS,
  PET_CLIP_SPECS,
  PersonClip,
  personClip,
  PetClip,
  petClip,
  PropKind,
  MAX_CLIPS,
} from '../../src/render/crowd/clips';
import { EntityTracks, makeFrame, readEntity, TELEPORT_CELLS, type EntityRecord } from '../../src/render/crowd/tracks';
import { FakeCrowd } from '../../src/render/crowd/fakeCrowd';
import { CrowdLayer, type CrowdModelSource } from '../../src/render/crowd/crowd';
import type { HeightSampler } from '../../src/render/coords';
import { loadGlbNode } from './glbNode';

const ASSETS = join(__dirname, '../../public/assets');

const nodeLibrary: CrowdModelSource = {
  loadGltf: (name: ModelName) => loadGlbNode(join(ASSETS, MODELS[name].file)),
  loadStatic: async (name: ModelName) => {
    const g = await loadGlbNode(join(ASSETS, MODELS[name].file));
    return mergeStatic(g.scene, (MODELS[name] as { scale?: number }).scale ?? 1);
  },
};

async function rig(name: ModelName) {
  const g = await nodeLibrary.loadGltf(name);
  const root = SkeletonUtils.clone(g.scene);
  expect(unifyAnimated(root)).toBe(true);
  let mesh: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
  });
  const nodes: THREE.Object3D[] = [];
  root.traverse((o) => nodes.push(o));
  const rest = nodes.map((o) => [o.position.clone(), o.quaternion.clone(), o.scale.clone()] as const);
  const restore = () => nodes.forEach((o, i) => (o.position.copy(rest[i]![0]), o.quaternion.copy(rest[i]![1]), o.scale.copy(rest[i]![2])));
  return { root, mesh: mesh! as THREE.SkinnedMesh, clips: g.animations, restore };
}

/** Max distance between three's CPU skinning and the baked matrices at clip time t. */
function skinError(r: Awaited<ReturnType<typeof rig>>, anim: ReturnType<typeof bakeBoneAnimation>, clipIndex: number, clip: THREE.AnimationClip, t: number): number {
  r.restore();
  const mixer = new THREE.AnimationMixer(r.root);
  const action = mixer.clipAction(clip);
  action.play();
  mixer.setTime(t);
  r.root.updateMatrixWorld(true);
  r.mesh.skeleton.update();
  const pos = r.mesh.geometry.getAttribute('position');
  const si = r.mesh.geometry.getAttribute('skinIndex');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const m = new THREE.Matrix4();
  let err = 0;
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    r.mesh.applyBoneTransform(i, a);
    b.fromBufferAttribute(pos, i).applyMatrix4(sampleBone(anim, clipIndex, t, si.getX(i), m));
    err = Math.max(err, a.distanceTo(b));
  }
  action.stop();
  mixer.uncacheRoot(r.root);
  return err;
}

describe('bone texture baking', () => {
  it('reproduces three.js skinning of a Kenney character at baked frames', async () => {
    const r = await rig('character_female_b');
    const anim = bakeBoneAnimation(r.root, r.mesh, r.clips, PERSON_CLIP_SPECS);
    expect(anim.boneCount).toBe(7); // one shared skeleton: root, legs, torso, arms, head
    expect(anim.clips.map((c) => c.name)).toEqual(PERSON_CLIP_SPECS.map((s) => s.name));
    expect(anim.clips.length).toBeLessThanOrEqual(MAX_CLIPS);
    // Texture is tiny: 3 texels per bone per frame.
    expect(anim.data.length).toBe(anim.frameCount * anim.boneCount * 12);
    expect(anim.data.byteLength).toBeLessThan(80_000);
    for (const [slot, src] of [
      [PersonClip.Walk, 'walk'],
      [PersonClip.Run, 'sprint'],
      [PersonClip.Work, 'pick-up'],
      [PersonClip.Build, 'interact-right'],
    ] as const) {
      const clip = r.clips.find((c) => c.name === src)!;
      for (const f of [0, 3, 7]) {
        const t = f / BAKE_FPS;
        if (t >= clip.duration) continue;
        expect(skinError(r, anim, slot, clip, t), `${src} frame ${f}`).toBeLessThan(1e-4);
      }
      // Between frames: linear interpolation of matrices stays close.
      expect(skinError(r, anim, slot, clip, 1.5 / BAKE_FPS)).toBeLessThan(0.02);
    }
  });

  it('bakes rigid-part cube pets the same way', async () => {
    const r = await rig('pet_cow');
    const anim = bakeBoneAnimation(r.root, r.mesh, r.clips, PET_CLIP_SPECS);
    expect(anim.clips.map((c) => c.name)).toEqual(['idle', 'walk', 'run', 'eat']);
    const eat = r.clips.find((c) => c.name === 'eat')!;
    for (const f of [0, 4, 9]) expect(skinError(r, anim, PetClip.Eat, eat, f / BAKE_FPS)).toBeLessThan(1e-4);
    // The eat clip actually moves something (the head goes down).
    const m0 = sampleBone(anim, PetClip.Eat, 0, 0, new THREE.Matrix4());
    let moved = 0;
    for (let b = 0; b < anim.boneCount; b++)
      for (const t of [0.1, 0.2, 0.3]) {
        const m = sampleBone(anim, PetClip.Eat, t, b, new THREE.Matrix4());
        moved = Math.max(moved, Math.abs(m.elements[13]! - sampleBone(anim, PetClip.Eat, 0, b, m0).elements[13]!));
      }
    expect(moved).toBeGreaterThan(0.01);
  });

  it('composes carry = walking legs + holding arms', async () => {
    const r = await rig('character_male_c');
    const carry = composeClip(r.clips, PERSON_CLIP_SPECS[PersonClip.Carry]!)!;
    const names = carry.tracks.map((t) => t.name);
    const walk = r.clips.find((c) => c.name === 'walk')!;
    const hold = r.clips.find((c) => c.name === 'holding-both')!;
    const legTrack = walk.tracks.find((t) => t.name.startsWith('leg-left'))!;
    expect(names).toContain(legTrack.name);
    const armWalk = walk.tracks.find((t) => t.name.startsWith('arm-left'));
    const armHold = hold.tracks.find((t) => t.name.startsWith('arm-left'))!;
    const armCarry = carry.tracks.find((t) => t.name === armHold.name)!;
    expect(Array.from(armCarry.values)).toEqual(Array.from(armHold.values));
    if (armWalk) expect(Array.from(armCarry.values)).not.toEqual(Array.from(armWalk.values));
    expect(carry.duration).toBeCloseTo(walk.duration);
  });

  it('finds hands at the ends of the arms', async () => {
    const r = await rig('character_male_a');
    const anim = bakeBoneAnimation(r.root, r.mesh, r.clips, PERSON_CLIP_SPECS);
    const anchors = boneAnchors(r.mesh);
    const L = anchors[anim.boneNames.indexOf('arm-left')]!;
    const R = anchors[anim.boneNames.indexOf('arm-right')]!;
    // T-pose: arms stretch sideways, left at +x, right at −x (model faces +z).
    expect(L.tip.x).toBeGreaterThan(L.origin.x + 0.1);
    expect(R.tip.x).toBeLessThan(R.origin.x - 0.1);
  });

  it('loops clip frames like the shader', () => {
    const clip = { name: 'x', start: 10, frames: 20, fps: 30, duration: 20 / 30 };
    const o = { f0: 0, f1: 0, a: 0 };
    clipFrames(clip, 0, o);
    expect(o).toEqual({ f0: 10, f1: 11, a: 0 });
    clipFrames(clip, 19.5 / 30, o);
    expect(o.f0).toBe(29);
    expect(o.f1).toBe(10); // wraps to the first frame
    expect(o.a).toBeCloseTo(0.5);
    clipFrames(clip, clip.duration * 3 + 1 / 30, o);
    expect(o.f0).toBe(11);
    clipFrames(clip, -1 / 30, o);
    expect(o.f0).toBe(29);
  });
});

describe('clip mapping', () => {
  it('maps entity animations to baked clips and props', () => {
    expect(personClip(EntityAnim.Idle, CarryKind.None, 0).clip).toBe(PersonClip.Idle);
    expect(personClip(EntityAnim.Walk, CarryKind.None, 0)).toMatchObject({ clip: PersonClip.Walk, gait: 1, prop: PropKind.None });
    expect(personClip(EntityAnim.Carry, CarryKind.Sack, 0)).toMatchObject({ clip: PersonClip.Carry, prop: PropKind.Sack });
    expect(personClip(EntityAnim.Walk, CarryKind.Log, 0)).toMatchObject({ clip: PersonClip.Carry, prop: PropKind.Log });
    expect(personClip(EntityAnim.Idle, CarryKind.Earth, 0)).toMatchObject({ clip: PersonClip.Hold, prop: PropKind.Earth });
    expect(personClip(EntityAnim.Run, CarryKind.None, 0)).toMatchObject({ clip: PersonClip.Run, gait: 2 });
    expect([PropKind.Hoe, PropKind.Shovel]).toContain(personClip(EntityAnim.Work, CarryKind.None, 3).prop);
    expect(personClip(EntityAnim.Work, CarryKind.None, 0).clip).toBe(PersonClip.Work);
    // Clearing snow off a field: the dig swing, always with a shovel.
    for (const seed of [0, 1]) expect(personClip(EntityAnim.Shovel, CarryKind.None, seed)).toMatchObject({ clip: PersonClip.Work, prop: PropKind.Shovel });
    expect(personClip(EntityAnim.Build, CarryKind.None, 0)).toMatchObject({ clip: PersonClip.Build, prop: PropKind.Hammer });
    expect(personClip(EntityAnim.Sit, CarryKind.None, 0).clip).toBe(PersonClip.Sit);
    expect(personClip(EntityAnim.Fish, CarryKind.None, 0)).toMatchObject({ clip: PersonClip.Fish, prop: PropKind.Rod });
    expect(petClip(EntityAnim.Eat).clip).toBe(PetClip.Eat);
    expect(petClip(EntityAnim.Walk).clip).toBe(PetClip.Walk);
    expect(petClip(EntityAnim.Run).clip).toBe(PetClip.Run);
    expect(petClip(EntityAnim.Sit).clip).toBe(PetClip.Idle);
    // Values of CarryKind double as prop kinds.
    expect(PropKind.Bucket as number).toBe(CarryKind.Bucket as number);
  });

  it('chooses models per kind and variant', () => {
    expect(lookFor(EntityKind.Person, 0).model).toBe('character_male_a');
    expect(lookFor(EntityKind.Person, 13).model).toBe(lookFor(EntityKind.Person, 3).model);
    expect(lookFor(EntityKind.Child, 0).scale).toBeLessThan(1);
    expect(lookFor(EntityKind.Cow, 0).model).toBe('pet_cow');
    const models = crowdModels();
    expect(models.length).toBeLessThanOrEqual(15);
    for (const m of models) expect(MODELS[m]).toBeDefined();
  });

  it('turns a protocol heading into a yaw that faces the walking direction', () => {
    for (const h of [0, 0.7, 2, -2.5]) {
      const fwd = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), headingToYaw(h));
      expect(fwd.x).toBeCloseTo(Math.cos(h));
      expect(fwd.z).toBeCloseTo(Math.sin(h));
    }
  });

  it('adapts walk playback to ground speed within bounds', () => {
    expect(gaitRate(0.45, 0.45)).toBeCloseTo(1);
    expect(gaitRate(0, 0.45)).toBeGreaterThan(0.5);
    expect(gaitRate(10, 0.45)).toBeLessThanOrEqual(2.2);
  });
});

function rec(id: number, x: number, y: number, extra: Partial<EntityRecord> = {}): EntityRecord {
  return { id, kind: EntityKind.Person, variant: 0, anim: EntityAnim.Walk, carry: 0, x, y, vx: 0, vy: 0, heading: 0, ...extra };
}

describe('entity tracks', () => {
  it('round-trips frames', () => {
    const f = makeFrame([rec(7, 1.5, 2.5, { kind: EntityKind.Cow, variant: 3, anim: EntityAnim.Eat, carry: CarryKind.Fish, vx: 0.5, vy: -0.25, heading: 1 })]);
    expect(readEntity(f, 0)).toEqual({ id: 7, kind: EntityKind.Cow, variant: 3, anim: EntityAnim.Eat, carry: CarryKind.Fish, x: 1.5, y: 2.5, vx: 0.5, vy: -0.25, heading: 1 });
  });

  it('interpolates between snapshots, then extrapolates briefly', () => {
    const tr = new EntityTracks();
    tr.setFrame(makeFrame([rec(1, 0, 0)]), 0);
    tr.setFrame(makeFrame([rec(1, 1, 0, { vx: 10, vy: 0 })]), 100);
    expect(tr.intervalMs).toBeCloseTo(100, 0);
    const t = tr.tracks.get(1)!;
    expect(t.x).toBe(0);
    tr.advance(0.05, 150);
    expect(t.x).toBeCloseTo(0.5);
    tr.advance(0.05, 200);
    expect(t.x).toBeCloseTo(1);
    tr.advance(0.05, 250);
    expect(t.x).toBeCloseTo(1.5); // extrapolated with vx
    tr.advance(1, 5000);
    expect(t.x).toBeLessThanOrEqual(1 + 10 * 0.4 + 1e-6); // bounded
    // The next snapshot starts from where it is drawn: no jump.
    const before = t.x;
    tr.setFrame(makeFrame([rec(1, 2, 0)]), 5000);
    tr.advance(0, 5000);
    expect(t.x).toBeCloseTo(before);
  });

  it('snaps on teleports, turns smoothly and forgets vanished entities', () => {
    const tr = new EntityTracks();
    const removed: number[] = [];
    tr.onRemove = (t) => removed.push(t.id);
    tr.setFrame(makeFrame([rec(1, 0, 0), rec(2, 5, 5)]), 0);
    tr.setFrame(makeFrame([rec(1, TELEPORT_CELLS + 3, 0, { heading: Math.PI / 2 })]), 100);
    const t = tr.tracks.get(1)!;
    expect(t.x).toBe(TELEPORT_CELLS + 3);
    expect(removed).toEqual([2]);
    expect(tr.tracks.has(2)).toBe(false);
    tr.setFrame(makeFrame([rec(1, TELEPORT_CELLS + 3, 0, { heading: Math.PI })]), 200);
    const h0 = t.heading;
    tr.advance(1 / 60, 210);
    expect(t.heading).toBeGreaterThan(h0);
    expect(t.heading).toBeLessThan(Math.PI);
    for (let k = 0; k < 120; k++) tr.advance(1 / 60, 210 + k * 16);
    expect(Math.abs(Math.cos(t.heading) + 1)).toBeLessThan(1e-3);
  });
});

function flatWorld(n: number, lakeX: number): HeightSampler {
  return {
    width: n,
    height: n,
    terrainAt: (x) => (x < lakeX ? 5 : 10),
    depthAt: (x) => (x < lakeX ? 1 : 0),
  };
}

describe('fake crowd', () => {
  it('is deterministic, lively and stays out of deep water', () => {
    const h = flatWorld(96, 40);
    const make = () => new FakeCrowd(h, { seed: 5, centerX: 52, centerY: 48 });
    const a = make();
    const b = make();
    expect(a.count).toBe(52); // 40 people + 12 animals
    const anims = new Set<number>();
    const carries = new Set<number>();
    const start = a.agents.map((g) => [g.x, g.y]);
    for (let k = 0; k < 600; k++) {
      a.tick();
      b.tick();
      const f = a.frame();
      for (let i = 0; i < f.count; i++) {
        anims.add(f.info[i * 4 + 2]!);
        carries.add(f.info[i * 4 + 3]!);
        expect(h.depthAt(f.pos[i * 5]!, f.pos[i * 5 + 1]!)).toBeLessThanOrEqual(0.25);
      }
    }
    expect(Array.from(a.frame().pos)).toEqual(Array.from(b.frame().pos));
    for (const want of [EntityAnim.Walk, EntityAnim.Carry, EntityAnim.Work, EntityAnim.Build, EntityAnim.Sit, EntityAnim.Fish, EntityAnim.Eat, EntityAnim.Run])
      expect(anims, `anim ${want}`).toContain(want);
    expect(carries.size).toBeGreaterThanOrEqual(3);
    const moved = a.agents.filter((g, i) => Math.hypot(g.x - start[i]![0]!, g.y - start[i]![1]!) > 1).length;
    expect(moved).toBeGreaterThan(15);
    const kinds = new Set(a.agents.map((g) => g.kind));
    for (const k of [EntityKind.Person, EntityKind.Child, EntityKind.Cow, EntityKind.Chick, EntityKind.Dog]) expect(kinds).toContain(k);
  });
});

describe('CrowdLayer', () => {
  it('draws 400 entities in few instanced draws and updates cheaply', async () => {
    const h = flatWorld(256, 0);
    const scene = new THREE.Scene();
    const layer = new CrowdLayer(scene, h, { library: nodeLibrary });
    await layer.ready;
    const list: EntityRecord[] = [];
    const kinds = [EntityKind.Person, EntityKind.Person, EntityKind.Person, EntityKind.Child, EntityKind.Cow, EntityKind.Chick, EntityKind.Pig, EntityKind.Dog, EntityKind.Sheep];
    for (let i = 0; i < 400; i++)
      list.push(
        rec(i + 1, 20 + (i % 20) * 2, 20 + Math.floor(i / 20) * 2, {
          kind: kinds[i % kinds.length]!,
          variant: i % 10,
          anim: i % 9,
          carry: i % 7,
          vx: 0.3,
          heading: i,
        }),
      );
    let now = 0;
    const move = (dx: number) => {
      for (const e of list) e.x += dx;
      layer.setFrame(makeFrame(list), now);
    };
    move(0);
    layer.update(1 / 60, now);
    expect(layer.stats.entities).toBe(400);
    expect(layer.stats.drawn).toBe(400);
    expect(layer.drawCalls).toBeLessThanOrEqual(16); // ≤ 10 people + 5 animal models + 1 props
    expect(layer.stats.props).toBeGreaterThan(50);
    const meshes = layer.group.children.filter((c) => (c as THREE.InstancedMesh).isInstancedMesh && c.visible) as THREE.InstancedMesh[];
    expect(meshes.reduce((s, m) => s + (m.name === 'crowd-props' ? 0 : m.count), 0)).toBe(400);
    for (const m of meshes) {
      const arr = m.instanceMatrix.array;
      for (let i = 0; i < m.count * 16; i++) expect(Number.isFinite(arr[i]!)).toBe(true);
    }
    // Feet on the ground (terrain 10 m at x ≥ 0).
    const person = meshes.find((m) => m.name.startsWith('crowd-character'))!;
    expect(person.instanceMatrix.array[13]).toBeCloseTo(10 * 0.4);
    // CPU microbench: 400 entities at 60 fps with 10 Hz snapshots.
    const t0 = performance.now();
    const frames = 600;
    for (let k = 0; k < frames; k++) {
      now += 1000 / 60;
      if (k % 6 === 0) move(0.05);
      layer.update(1 / 60, now);
    }
    const perFrame = (performance.now() - t0) / frames;
    console.log(`crowd: 400 entities, ${layer.drawCalls} draw calls, ${perFrame.toFixed(3)} ms/frame CPU (Node), ${layer.stats.textures} bone textures, ${layer.stats.textureBytes} B`);
    expect(perFrame).toBeLessThan(8);
    layer.dispose();
  });
});
