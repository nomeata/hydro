/**
 * A handful of animated characters and cube pets milling about near a point:
 * pure ambience (M1). Each agent picks a deterministic-random nearby target on
 * suitable ground, turns smoothly, walks there following the terrain, then
 * idles with some variety (look around, sit, interact; pets eat).
 */
import * as THREE from 'three';
import { heightToY, type HeightSampler } from '../coords';
import { Rng } from '../../shared/rng';
import { LOOK_CHANNELS } from '../../shared/protocol';
import { instantiateAnimated, modelLibrary, type AnimatedModel } from './loader';
import type { ModelName } from './manifest';

export type Habitat = 'land' | 'water' | 'shore' | 'forest';

interface Species {
  readonly model: ModelName;
  /** Walking speed in cells per second. */
  readonly speed: number;
  /** Walk clip playback rate at that speed. */
  readonly walkRate: number;
  readonly habitat: Habitat;
  /** Idle clips with relative weights and duration ranges (s). */
  readonly idles: readonly { clip: string; w: number; min: number; max: number }[];
  /** How far from home it roams (fraction of the layer radius). */
  readonly roam: number;
  readonly person: boolean;
}

const PERSON_IDLES = [
  { clip: 'idle', w: 5, min: 1.5, max: 4 },
  { clip: 'sit', w: 1, min: 4, max: 9 },
  { clip: 'interact-right', w: 1.2, min: 1.2, max: 2.5 },
  { clip: 'pick-up', w: 1, min: 1.0, max: 1.6 },
  { clip: 'emote-yes', w: 0.6, min: 1.0, max: 1.6 },
  { clip: 'interact-left', w: 0.8, min: 1.2, max: 2.5 },
];
const GRAZER_IDLES = [
  { clip: 'idle', w: 2, min: 2, max: 5 },
  { clip: 'eat', w: 4, min: 3, max: 8 },
];
const SMALL_IDLES = [
  { clip: 'idle', w: 3, min: 1, max: 3 },
  { clip: 'eat', w: 2, min: 1.5, max: 3 },
  { clip: 'gesture-positive', w: 0.7, min: 1, max: 1.6 },
];

export const PEOPLE: readonly ModelName[] = [
  'character_male_a',
  'character_female_a',
  'character_male_b',
  'character_female_b',
  'character_male_c',
  'character_female_c',
  'character_male_d',
  'character_female_d',
  'character_male_e',
  'character_female_e',
];

const SPECIES: Record<string, Omit<Species, 'model'>> = {
  person: { speed: 0.42, walkRate: 1.0, habitat: 'land', idles: PERSON_IDLES, roam: 1, person: true },
  pet_cow: { speed: 0.18, walkRate: 0.8, habitat: 'land', idles: GRAZER_IDLES, roam: 0.6, person: false },
  pet_pig: { speed: 0.22, walkRate: 1, habitat: 'land', idles: SMALL_IDLES, roam: 0.5, person: false },
  pet_hog: { speed: 0.22, walkRate: 1, habitat: 'forest', idles: SMALL_IDLES, roam: 0.8, person: false },
  pet_chick: { speed: 0.25, walkRate: 1.5, habitat: 'land', idles: SMALL_IDLES, roam: 0.35, person: false },
  pet_bunny: { speed: 0.35, walkRate: 1.3, habitat: 'land', idles: SMALL_IDLES, roam: 0.9, person: false },
  pet_deer: { speed: 0.3, walkRate: 0.9, habitat: 'forest', idles: GRAZER_IDLES, roam: 1.2, person: false },
  pet_dog: { speed: 0.45, walkRate: 1.3, habitat: 'land', idles: SMALL_IDLES, roam: 0.8, person: false },
  pet_cat: { speed: 0.3, walkRate: 1.1, habitat: 'land', idles: SMALL_IDLES, roam: 0.5, person: false },
  pet_fox: { speed: 0.35, walkRate: 1.1, habitat: 'forest', idles: SMALL_IDLES, roam: 1.2, person: false },
  pet_beaver: { speed: 0.2, walkRate: 1.1, habitat: 'shore', idles: SMALL_IDLES, roam: 1.5, person: false },
  pet_fish: { speed: 0.25, walkRate: 1, habitat: 'water', idles: [{ clip: 'idle', w: 1, min: 1, max: 3 }], roam: 2, person: false },
};

export interface WandererOptions {
  /** Number of people (≤ 12). */
  count: number;
  seed: number;
  centerX: number;
  centerY: number;
  radius: number;
  /** Pets per species; default: 2 cows, pig, 3 chicks, bunny, dog, deer, beaver, fish. */
  pets?: Partial<Record<ModelName, number>>;
  /** Optional look texture (RGBA per cell) to find forest edges. */
  look?: Uint8Array;
  library?: AnimatedModelSource;
}

/** Where models come from (a ModelLibrary, or a stub in tests). */
export interface AnimatedModelSource {
  loadAnimated(name: ModelName): Promise<AnimatedModel>;
}

const DEFAULT_PETS: Partial<Record<ModelName, number>> = {
  pet_cow: 2,
  pet_pig: 1,
  pet_chick: 3,
  pet_bunny: 1,
  pet_dog: 1,
  pet_deer: 1,
  pet_beaver: 1,
  pet_fish: 2,
};

const MAX_WADE_DEPTH = 0.2;
const MAX_SLOPE = 0.45; // rise/run

interface Agent {
  sp: Species;
  obj: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  current: THREE.AnimationAction | null;
  homeX: number;
  homeY: number;
  roam: number;
  x: number;
  y: number;
  heading: number;
  tx: number;
  ty: number;
  state: 'idle' | 'walk';
  timer: number;
  rng: Rng;
  speedJitter: number;
}

export class WandererLayer {
  readonly group = new THREE.Group();
  readonly ready: Promise<void>;
  private agents: Agent[] = [];
  private disposed = false;

  constructor(
    scene: THREE.Object3D,
    private readonly heights: HeightSampler,
    private readonly opts: WandererOptions,
  ) {
    this.group.name = 'wanderers';
    scene.add(this.group);
    const lib = opts.library ?? modelLibrary();
    const rng = new Rng((opts.seed ^ 0x77a11e55) >>> 0);
    const wanted: { model: ModelName; key: string }[] = [];
    const n = Math.max(0, Math.min(12, opts.count));
    for (let i = 0; i < n; i++) wanted.push({ model: PEOPLE[i % PEOPLE.length]!, key: 'person' });
    for (const [model, k] of Object.entries(opts.pets ?? DEFAULT_PETS) as [ModelName, number][])
      for (let i = 0; i < k; i++) wanted.push({ model, key: model });
    const uniq = [...new Set(wanted.map((w) => w.model))];
    this.ready = Promise.all(uniq.map((m) => lib.loadAnimated(m))).then((models) => {
      if (this.disposed) return;
      const byName = new Map(models.map((m) => [m.name, m]));
      for (const w of wanted) {
        const m = byName.get(w.model);
        if (m) this.spawn(m, { model: w.model, ...SPECIES[w.key]! }, rng);
      }
    });
  }

  get count(): number {
    return this.agents.length;
  }

  /** Positions (cell coordinates) and model names, for tests/debugging. */
  positions(): { model: ModelName; x: number; y: number; state: string }[] {
    return this.agents.map((a) => ({ model: a.sp.model, x: a.x, y: a.y, state: a.state }));
  }

  update(dtSec: number): void {
    const dt = Math.min(0.1, Math.max(0, dtSec));
    for (const a of this.agents) this.step(a, dt);
  }

  dispose(): void {
    this.disposed = true;
    for (const a of this.agents) a.mixer.stopAllAction();
    this.agents = [];
    this.group.removeFromParent();
  }

  // ---------------------------------------------------------------------------

  private suitable(sp: Species, x: number, y: number): boolean {
    const h = this.heights;
    if (x < 1 || y < 1 || x > h.width - 2 || y > h.height - 2) return false;
    const d = h.depthAt(x, y);
    if (sp.habitat === 'water') return d > 0.35;
    if (d > MAX_WADE_DEPTH) return false;
    const gx = (h.terrainAt(x + 0.5, y) - h.terrainAt(x - 0.5, y)) / 5;
    const gy = (h.terrainAt(x, y + 0.5) - h.terrainAt(x, y - 0.5)) / 5;
    if (Math.hypot(gx, gy) > MAX_SLOPE) return false;
    if (sp.habitat === 'shore') {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        if (h.depthAt(x + Math.cos(a) * 2, y + Math.sin(a) * 2) > 0.3) return true;
      }
      return false;
    }
    if (sp.habitat === 'forest' && this.opts.look) {
      const xi = Math.round(x);
      const yi = Math.round(y);
      const v = this.opts.look[(yi * h.width + xi) * LOOK_CHANNELS + 2]! / 255;
      return v > 0.35;
    }
    return true;
  }

  /** Straight path is walkable (sampled every half cell). */
  private pathOk(sp: Species, x0: number, y0: number, x1: number, y1: number): boolean {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len * 2));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (!this.suitable(sp, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
    }
    return true;
  }

  private findHome(sp: Species, rng: Rng): [number, number] | null {
    const { centerX, centerY, radius } = this.opts;
    const far = sp.habitat === 'land' ? radius * 0.6 : radius * 2.5;
    for (let tries = 0; tries < 200; tries++) {
      const a = rng.next() * Math.PI * 2;
      const r = Math.sqrt(rng.next()) * far * (1 + tries / 60);
      const x = centerX + Math.cos(a) * r;
      const y = centerY + Math.sin(a) * r;
      if (this.suitable(sp, x, y)) return [x, y];
    }
    return null;
  }

  private spawn(model: AnimatedModel, sp: Species, rng: Rng): void {
    const home = this.findHome(sp, rng);
    if (!home) return;
    const obj = instantiateAnimated(model);
    const mixer = new THREE.AnimationMixer(obj);
    const actions = new Map<string, THREE.AnimationAction>();
    for (const clip of model.clips) actions.set(clip.name, mixer.clipAction(clip));
    const a: Agent = {
      sp,
      obj,
      mixer,
      actions,
      current: null,
      homeX: home[0],
      homeY: home[1],
      roam: sp.roam * this.opts.radius * 0.5,
      x: home[0],
      y: home[1],
      heading: rng.next() * Math.PI * 2,
      tx: home[0],
      ty: home[1],
      state: 'idle',
      timer: rng.range(0, 2),
      rng: new Rng(rng.nextU32()),
      speedJitter: 0.85 + 0.3 * rng.next(),
    };
    this.play(a, 'idle', 0);
    // Desynchronise animation phases.
    mixer.update(rng.range(0, 3));
    this.place(a);
    this.group.add(obj);
    this.agents.push(a);
  }

  private play(a: Agent, clip: string, fade = 0.3, rate = 1): void {
    const next = a.actions.get(clip) ?? a.actions.get('idle');
    if (!next) return;
    next.timeScale = rate;
    if (next === a.current) return;
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.play();
    if (a.current && fade > 0) a.current.crossFadeTo(next, fade, false);
    else if (a.current) a.current.stop();
    a.current = next;
  }

  private pickIdle(a: Agent): void {
    const ids = a.sp.idles;
    let total = 0;
    for (const i of ids) total += i.w;
    let r = a.rng.next() * total;
    let chosen = ids[0]!;
    for (const i of ids) {
      r -= i.w;
      if (r <= 0) {
        chosen = i;
        break;
      }
    }
    a.state = 'idle';
    a.timer = a.rng.range(chosen.min, chosen.max);
    this.play(a, chosen.clip);
  }

  private pickTarget(a: Agent): boolean {
    for (let tries = 0; tries < 10; tries++) {
      const ang = a.rng.next() * Math.PI * 2;
      const r = (0.25 + 0.75 * Math.sqrt(a.rng.next())) * a.roam;
      // Stay near home: aim around home, biased back when far away.
      const tx = a.homeX + Math.cos(ang) * r;
      const ty = a.homeY + Math.sin(ang) * r;
      if (Math.hypot(tx - a.x, ty - a.y) < 0.6) continue;
      if (this.pathOk(a.sp, a.x, a.y, tx, ty)) {
        a.tx = tx;
        a.ty = ty;
        a.state = 'walk';
        this.play(a, 'walk', 0.25, a.sp.walkRate * a.speedJitter);
        return true;
      }
    }
    return false;
  }

  private step(a: Agent, dt: number): void {
    a.mixer.update(dt);
    if (a.state === 'idle') {
      a.timer -= dt;
      // Pets occasionally turn a little while idling.
      if (a.timer <= 0) {
        if (a.rng.next() < 0.75 && this.pickTarget(a)) return;
        this.pickIdle(a);
      }
      this.place(a);
      return;
    }
    const dx = a.tx - a.x;
    const dy = a.ty - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.08) {
      this.pickIdle(a);
      return;
    }
    // Smooth turning towards the target.
    const want = Math.atan2(dx, dy);
    let diff = want - a.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const turnRate = 4; // rad/s
    a.heading += Math.max(-turnRate * dt, Math.min(turnRate * dt, diff));
    const align = Math.max(0, Math.cos(diff));
    const speed = a.sp.speed * a.speedJitter * align * Math.min(1, dist * 3);
    const nx = a.x + Math.sin(a.heading) * speed * dt;
    const ny = a.y + Math.cos(a.heading) * speed * dt;
    if (this.suitable(a.sp, nx, ny)) {
      a.x = nx;
      a.y = ny;
    } else {
      // Water rose or terrain changed: give up and rethink.
      this.pickIdle(a);
    }
    this.place(a);
  }

  private place(a: Agent): void {
    const h = this.heights;
    let yM = h.terrainAt(a.x, a.y);
    if (a.sp.habitat === 'water') yM += Math.max(0, h.depthAt(a.x, a.y) - 0.25);
    a.obj.position.set(a.x + 0.5, heightToY(yM), a.y + 0.5);
    a.obj.rotation.set(0, a.heading, 0);
  }
}
