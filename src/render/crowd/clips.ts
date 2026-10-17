/**
 * Which model, baked clip, playback rate and hand prop an entity gets.
 * Pure (no three.js scene access) so it can be unit-tested.
 */
import { CarryKind, EntityAnim, EntityKind } from '../../shared/protocol';
import type { ModelName } from '../objects/manifest';
import type { ClipSpec } from './bake';

const ARMS = ['arm-left', 'arm-right'];

/** Baked clip slots of the Kenney mini-characters (indices into the bone texture's clip table). */
export const enum PersonClip {
  Idle = 0,
  Walk = 1,
  Run = 2,
  /** Walk with both arms holding something in front. */
  Carry = 3,
  /** Stand holding something in front. */
  Hold = 4,
  /** Bending down repeatedly (pick-up, slowed): digging / hoeing. */
  Work = 5,
  /** Right-hand interaction: hammering. */
  Build = 6,
  Sit = 7,
  /** Sitting with the right arm forward holding a rod. */
  Fish = 8,
}

export const PERSON_CLIP_SPECS: readonly ClipSpec[] = [
  { name: 'idle', source: 'idle' },
  { name: 'walk', source: 'walk' },
  { name: 'run', source: 'sprint' },
  { name: 'carry', source: 'walk', overrideBones: ARMS, overrideSource: 'holding-both' },
  { name: 'hold', source: 'idle', overrideBones: ARMS, overrideSource: 'holding-both' },
  { name: 'work', source: 'pick-up' },
  { name: 'build', source: 'interact-right' },
  { name: 'sit', source: 'sit' },
  { name: 'fish', source: 'sit', overrideBones: ['arm-right'], overrideSource: 'holding-right' },
];

/** Baked clip slots of the cube pets. */
export const enum PetClip {
  Idle = 0,
  Walk = 1,
  Run = 2,
  Eat = 3,
}

export const PET_CLIP_SPECS: readonly ClipSpec[] = [
  { name: 'idle', source: 'idle' },
  { name: 'walk', source: 'walk' },
  { name: 'run', source: 'run' },
  { name: 'eat', source: 'eat' },
];

/** Max clips per model (size of the shader's clip table). */
export const MAX_CLIPS = 12;

/** Props drawn by the crowd: carried loads (values = CarryKind) and hand tools. */
export const enum PropKind {
  None = 0,
  Earth = 1,
  Sack = 2,
  Fish = 3,
  Log = 4,
  Bundle = 5,
  Bucket = 6,
  Stone = 7,
  Hoe = 8,
  Shovel = 9,
  Hammer = 10,
  Rod = 11,
  Axe = 12,
}
export const PROP_KINDS = 13;

export const PEOPLE_MODELS: readonly ModelName[] = [
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

export interface KindLook {
  readonly model: ModelName;
  /** Extra scale on top of the manifest height. */
  readonly scale: number;
  readonly person: boolean;
  /** Linear RGB tint (multiplies the texture). */
  readonly tint: readonly [number, number, number];
  /** Ground speed (cells/s) at which the walk clip plays at rate 1 (no foot sliding). */
  readonly walkRef: number;
  readonly runRef: number;
}

const WHITE = [1, 1, 1] as const;

/** Model and look for an entity kind and appearance variant. */
export function lookFor(kind: number, variant: number): KindLook {
  switch (kind) {
    case EntityKind.Person:
      return { model: PEOPLE_MODELS[variant % PEOPLE_MODELS.length]!, scale: 1, person: true, tint: WHITE, walkRef: 0.45, runRef: 1.1 };
    case EntityKind.Child:
      return { model: PEOPLE_MODELS[variant % PEOPLE_MODELS.length]!, scale: 0.68, person: true, tint: WHITE, walkRef: 0.32, runRef: 0.8 };
    case EntityKind.Cow:
      return { model: 'pet_cow', scale: 1, person: false, tint: WHITE, walkRef: 0.2, runRef: 0.6 };
    case EntityKind.Pig:
      return { model: 'pet_pig', scale: 1, person: false, tint: WHITE, walkRef: 0.22, runRef: 0.6 };
    case EntityKind.Chick:
      return { model: 'pet_chick', scale: 1, person: false, tint: WHITE, walkRef: 0.16, runRef: 0.45 };
    case EntityKind.Dog:
      return { model: 'pet_dog', scale: 1, person: false, tint: WHITE, walkRef: 0.3, runRef: 0.9 };
    case EntityKind.Sheep:
      // No sheep in the Kenney cube pets: a pale, slightly bigger bunny-ish stand-in.
      return { model: 'pet_hog', scale: 0.95, person: false, tint: [1.25, 1.2, 1.1], walkRef: 0.2, runRef: 0.6 };
    default:
      return { model: 'pet_dog', scale: 1, person: false, tint: WHITE, walkRef: 0.3, runRef: 0.9 };
  }
}

/** Every model the crowd may need. */
export function crowdModels(): ModelName[] {
  const s = new Set<ModelName>();
  for (const k of [EntityKind.Person, EntityKind.Cow, EntityKind.Pig, EntityKind.Chick, EntityKind.Dog, EntityKind.Sheep])
    for (let v = 0; v < (k === EntityKind.Person ? PEOPLE_MODELS.length : 1); v++) s.add(lookFor(k, v).model);
  return [...s];
}

export interface ClipChoice {
  clip: number;
  /** Playback rate before speed adaptation. */
  rate: number;
  /** Clip whose rate follows ground speed (walk-like) — 0 none, 1 walk, 2 run. */
  gait: 0 | 1 | 2;
  /** Prop in the right hand / both hands. */
  prop: PropKind;
}

/** Clip, rate and prop for a person (or child). `seed` varies tools per entity. */
export function personClip(anim: number, carry: number, seed: number): ClipChoice {
  const carrying = carry !== CarryKind.None;
  const load = carry as unknown as PropKind;
  switch (anim) {
    case EntityAnim.Walk:
      return carrying ? { clip: PersonClip.Carry, rate: 1, gait: 1, prop: load } : { clip: PersonClip.Walk, rate: 1, gait: 1, prop: PropKind.None };
    case EntityAnim.Carry:
      return { clip: carrying ? PersonClip.Carry : PersonClip.Walk, rate: 1, gait: 1, prop: carrying ? load : PropKind.None };
    case EntityAnim.Run:
      return { clip: PersonClip.Run, rate: 1, gait: 2, prop: PropKind.None };
    case EntityAnim.Work:
      return { clip: PersonClip.Work, rate: 0.42, gait: 0, prop: seed & 1 ? PropKind.Shovel : PropKind.Hoe };
    case EntityAnim.Build:
      return { clip: PersonClip.Build, rate: 1.1, gait: 0, prop: PropKind.Hammer };
    case EntityAnim.Chop:
      return { clip: PersonClip.Build, rate: 0.75, gait: 0, prop: PropKind.Axe };
    case EntityAnim.Sit:
      return { clip: PersonClip.Sit, rate: 1, gait: 0, prop: PropKind.None };
    case EntityAnim.Fish:
      return { clip: PersonClip.Fish, rate: 1, gait: 0, prop: PropKind.Rod };
    case EntityAnim.Idle:
    case EntityAnim.Eat:
    default:
      return carrying ? { clip: PersonClip.Hold, rate: 1, gait: 0, prop: load } : { clip: PersonClip.Idle, rate: 1, gait: 0, prop: PropKind.None };
  }
}

export function petClip(anim: number): ClipChoice {
  switch (anim) {
    case EntityAnim.Walk:
    case EntityAnim.Carry:
      return { clip: PetClip.Walk, rate: 1, gait: 1, prop: PropKind.None };
    case EntityAnim.Run:
      return { clip: PetClip.Run, rate: 1, gait: 2, prop: PropKind.None };
    case EntityAnim.Eat:
    case EntityAnim.Work:
      return { clip: PetClip.Eat, rate: 0.7, gait: 0, prop: PropKind.None };
    default:
      return { clip: PetClip.Idle, rate: 1, gait: 0, prop: PropKind.None };
  }
}

/** Walk/run playback rate for a ground speed (cells/s), so feet roughly stick to the ground. */
export function gaitRate(speed: number, ref: number): number {
  return Math.min(2.2, Math.max(0.55, speed / ref));
}

/**
 * Protocol heading (radians, direction (cos h, sin h) in cell coordinates)
 * → three.js yaw about +y for a model that faces +z.
 */
export function headingToYaw(heading: number): number {
  return Math.PI / 2 - heading;
}
