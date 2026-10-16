/**
 * Curated Kenney (CC0) models shipped in public/assets/.
 *
 * `file` is relative to the assets base (see `assetUrl`). `src` is the path in
 * the downloaded Kenney packs (../assets-src) that tools/assets.ts processes:
 *  - static models are flattened to ONE primitive with baked linear vertex
 *    colours (material colours and colormap texture sampled per vertex), so they
 *    need no texture and merge into a single InstancedMesh each;
 *  - animated models (characters, pets) are pruned (unused animations,
 *    tangents and second UV set removed) and keep the pack's shared
 *    `Textures/colormap.png` next to them.
 *
 * Sizing: `scale` multiplies model units into world units (1 unit = 1 cell =
 * 5 m). Alternatively `height` gives the desired world height and the loader
 * computes the scale from the bounding box (used for animated models).
 *
 * This file must stay free of three.js imports (tools/assets.ts imports it).
 */

export type ObjectCategory =
  | 'tree'
  | 'conifer'
  | 'bush'
  | 'rock'
  | 'grass'
  | 'flower'
  | 'reed'
  | 'water-plant'
  | 'mushroom'
  | 'log'
  | 'crop'
  | 'fence'
  | 'building'
  | 'prop'
  | 'character'
  | 'pet';

export interface ModelEntry {
  readonly file: string;
  readonly category: ObjectCategory;
  /** Model units → world units. */
  readonly scale?: number;
  /** Desired world height (overrides scale), for animated models. */
  readonly height?: number;
  /** Skinned/node-animated model with clips (loaded with its texture, not merged). */
  readonly animated?: boolean;
  /** Needs back faces (thin planes). */
  readonly doubleSided?: boolean;
  /** Source path below the Kenney download directory. */
  readonly src: string;
}

const NK = 'nature-kit/Models/GLTF format/';
const FT = 'fantasy-town-kit/Models/GLB format/';
const SK = 'survival-kit/Models/GLB format/';
const MC = 'mini-characters/Models/GLB format/';
const CP = 'cube-pets/Models/GLB format/';

/** Common scale of nature-kit models (trees ≈ 0.9–1.3 cells tall). */
export const NATURE_SCALE = 0.75;
/** Scale of fantasy-town modular parts (a wall is 0.8 cells tall). */
export const TOWN_SCALE = 0.8;
const SURVIVAL_SCALE = 0.6;

function nk(name: string, category: ObjectCategory, extra: Partial<ModelEntry> = {}): ModelEntry {
  return { file: `static/${name}.glb`, category, scale: NATURE_SCALE, src: NK + name + '.glb', ...extra };
}
function ft(name: string, category: ObjectCategory, extra: Partial<ModelEntry> = {}): ModelEntry {
  return { file: `static/town-${name}.glb`, category, scale: TOWN_SCALE, src: FT + name + '.glb', ...extra };
}
function sk(name: string, category: ObjectCategory, extra: Partial<ModelEntry> = {}): ModelEntry {
  return { file: `static/survival-${name}.glb`, category, scale: SURVIVAL_SCALE, src: SK + name + '.glb', ...extra };
}
function ch(name: string): ModelEntry {
  return { file: `characters/${name}.glb`, category: 'character', height: 0.55, animated: true, src: MC + name + '.glb' };
}
function pet(name: string, height: number): ModelEntry {
  return { file: `pets/${name}.glb`, category: 'pet', height, animated: true, src: CP + name + '.glb' };
}

export const MODELS = {
  // --- deciduous trees (green, dark, autumn variants) ----------------------
  tree_default: nk('tree_default', 'tree'),
  tree_default_fall: nk('tree_default_fall', 'tree'),
  tree_oak: nk('tree_oak', 'tree'),
  tree_oak_dark: nk('tree_oak_dark', 'tree'),
  tree_oak_fall: nk('tree_oak_fall', 'tree'),
  tree_detailed: nk('tree_detailed', 'tree'),
  tree_detailed_fall: nk('tree_detailed_fall', 'tree'),
  tree_fat: nk('tree_fat', 'tree'),
  tree_fat_fall: nk('tree_fat_fall', 'tree'),
  tree_simple: nk('tree_simple', 'tree'),
  tree_simple_fall: nk('tree_simple_fall', 'tree'),
  tree_small: nk('tree_small', 'tree'),
  tree_small_fall: nk('tree_small_fall', 'tree'),
  tree_tall: nk('tree_tall', 'tree'),
  tree_tall_dark: nk('tree_tall_dark', 'tree'),
  tree_thin: nk('tree_thin', 'tree'),
  tree_thin_fall: nk('tree_thin_fall', 'tree'),
  // --- conifers --------------------------------------------------------------
  tree_cone: nk('tree_cone', 'conifer'),
  tree_cone_dark: nk('tree_cone_dark', 'conifer'),
  tree_cone_fall: nk('tree_cone_fall', 'conifer'),
  tree_pineDefaultA: nk('tree_pineDefaultA', 'conifer'),
  tree_pineDefaultB: nk('tree_pineDefaultB', 'conifer'),
  tree_pineRoundA: nk('tree_pineRoundA', 'conifer'),
  tree_pineRoundC: nk('tree_pineRoundC', 'conifer'),
  tree_pineTallA: nk('tree_pineTallA', 'conifer'),
  tree_pineTallB: nk('tree_pineTallB', 'conifer'),
  tree_pineSmallA: nk('tree_pineSmallA', 'conifer'),
  tree_pineSmallC: nk('tree_pineSmallC', 'conifer'),
  // --- bushes ----------------------------------------------------------------
  plant_bush: nk('plant_bush', 'bush'),
  plant_bushDetailed: nk('plant_bushDetailed', 'bush'),
  plant_bushLarge: nk('plant_bushLarge', 'bush'),
  plant_bushSmall: nk('plant_bushSmall', 'bush'),
  plant_bushTriangle: nk('plant_bushTriangle', 'bush'),
  plant_bushLargeTriangle: nk('plant_bushLargeTriangle', 'bush'),
  // --- rocks & stones --------------------------------------------------------
  stone_largeA: nk('stone_largeA', 'rock'),
  stone_largeB: nk('stone_largeB', 'rock'),
  stone_largeC: nk('stone_largeC', 'rock'),
  stone_smallA: nk('stone_smallA', 'rock'),
  stone_smallB: nk('stone_smallB', 'rock'),
  stone_smallC: nk('stone_smallC', 'rock'),
  stone_smallFlatA: nk('stone_smallFlatA', 'rock'),
  stone_tallA: nk('stone_tallA', 'rock'),
  stone_tallB: nk('stone_tallB', 'rock'),
  rock_largeA: nk('rock_largeA', 'rock'),
  rock_smallA: nk('rock_smallA', 'rock'),
  rock_smallB: nk('rock_smallB', 'rock'),
  rock_smallFlatA: nk('rock_smallFlatA', 'rock'),
  // --- grass, flowers, reeds, water plants -----------------------------------
  grass: nk('grass', 'grass'),
  grass_large: nk('grass_large', 'grass'),
  grass_leafs: nk('grass_leafs', 'grass'),
  grass_leafsLarge: nk('grass_leafsLarge', 'grass'),
  flower_purpleA: nk('flower_purpleA', 'flower'),
  flower_redA: nk('flower_redA', 'flower'),
  flower_yellowA: nk('flower_yellowA', 'flower'),
  flower_yellowB: nk('flower_yellowB', 'flower'),
  reeds_tall: nk('crops_bambooStageB', 'reed', { file: 'static/reeds_tall.glb' }),
  reeds: nk('crops_bambooStageA', 'reed', { file: 'static/reeds.glb' }),
  plant_flatTall: nk('plant_flatTall', 'reed'),
  plant_flatShort: nk('plant_flatShort', 'reed'),
  lily_large: nk('lily_large', 'water-plant'),
  lily_small: nk('lily_small', 'water-plant'),
  // --- mushrooms, logs, stumps ----------------------------------------------
  mushroom_red: nk('mushroom_red', 'mushroom'),
  mushroom_redGroup: nk('mushroom_redGroup', 'mushroom'),
  mushroom_tan: nk('mushroom_tan', 'mushroom'),
  mushroom_tanGroup: nk('mushroom_tanGroup', 'mushroom'),
  log: nk('log', 'log'),
  log_large: nk('log_large', 'log'),
  log_stack: nk('log_stack', 'log'),
  stump_old: nk('stump_old', 'log'),
  stump_round: nk('stump_round', 'log'),
  stump_roundDetailed: nk('stump_roundDetailed', 'log'),
  // --- crops -------------------------------------------------------------------
  crops_wheatStageA: nk('crops_wheatStageA', 'crop'),
  crops_wheatStageB: nk('crops_wheatStageB', 'crop'),
  crops_cornStageA: nk('crops_cornStageA', 'crop'),
  crops_cornStageB: nk('crops_cornStageB', 'crop'),
  crops_cornStageC: nk('crops_cornStageC', 'crop'),
  crops_cornStageD: nk('crops_cornStageD', 'crop'),
  crops_leafsStageA: nk('crops_leafsStageA', 'crop'),
  crops_leafsStageB: nk('crops_leafsStageB', 'crop'),
  crop_carrot: nk('crop_carrot', 'crop'),
  crop_pumpkin: nk('crop_pumpkin', 'crop'),
  crop_melon: nk('crop_melon', 'crop'),
  crop_turnip: nk('crop_turnip', 'crop'),
  crops_dirtRow: nk('crops_dirtRow', 'crop'),
  crops_dirtSingle: nk('crops_dirtSingle', 'crop'),
  // --- fences ----------------------------------------------------------------
  fence_simple: nk('fence_simple', 'fence'),
  fence_planks: nk('fence_planks', 'fence'),
  fence_gate: nk('fence_gate', 'fence'),
  fence_corner: nk('fence_corner', 'fence'),
  // --- nature-kit props ---------------------------------------------------------
  campfire_stones: nk('campfire_stones', 'prop'),
  tent_smallClosed: nk('tent_smallClosed', 'prop'),
  canoe: nk('canoe', 'prop'),
  bridge_wood: nk('bridge_wood', 'prop'),
  bridge_stone: nk('bridge_stone', 'prop'),
  sign: nk('sign', 'prop'),
  path_stone: nk('path_stone', 'prop'),
  pot_large: nk('pot_large', 'prop'),
  // --- fantasy town: modular building parts, mills ----------------------------
  town_watermill: ft('watermill', 'building'),
  town_windmill: ft('windmill', 'building'),
  town_wheel: ft('wheel', 'prop'),
  town_wall_wood: ft('wall-wood', 'building'),
  town_wall_wood_door: ft('wall-wood-door', 'building'),
  town_wall_wood_window: ft('wall-wood-window-shutters', 'building'),
  town_wall_wood_corner: ft('wall-wood-corner', 'building'),
  town_wall: ft('wall', 'building'),
  town_wall_door: ft('wall-door', 'building'),
  town_wall_window: ft('wall-window-shutters', 'building'),
  town_wall_corner: ft('wall-corner', 'building'),
  town_roof: ft('roof', 'building'),
  town_roof_corner: ft('roof-corner', 'building'),
  town_roof_gable: ft('roof-gable', 'building'),
  town_roof_gable_end: ft('roof-gable-end', 'building'),
  town_roof_point: ft('roof-point', 'building'),
  town_chimney: ft('chimney', 'building'),
  town_overhang: ft('overhang', 'building'),
  town_stairs_wood: ft('stairs-wood', 'building'),
  town_pillar_wood: ft('pillar-wood', 'building'),
  town_planks: ft('planks', 'building'),
  town_fence: ft('fence', 'fence'),
  town_fence_gate: ft('fence-gate', 'fence'),
  town_hedge: ft('hedge', 'bush'),
  town_cart: ft('cart', 'prop'),
  town_stall: ft('stall', 'prop'),
  town_lantern: ft('lantern', 'prop'),
  // --- survival kit: resources, tools ----------------------------------------
  survival_resource_wood: sk('resource-wood', 'prop'),
  survival_resource_planks: sk('resource-planks', 'prop'),
  survival_resource_stone: sk('resource-stone', 'prop'),
  survival_bucket: sk('bucket', 'prop'),
  survival_barrel: sk('barrel', 'prop'),
  survival_box: sk('box', 'prop'),
  survival_signpost: sk('signpost', 'prop'),
  survival_campfire: sk('campfire-pit', 'prop'),
  survival_workbench: sk('workbench', 'prop'),
  survival_fish: sk('fish', 'prop'),
  survival_tool_shovel: sk('tool-shovel', 'prop'),
  survival_tool_axe: sk('tool-axe', 'prop'),
  survival_tool_hoe: sk('tool-hoe', 'prop'),
  survival_tool_pickaxe: sk('tool-pickaxe', 'prop'),
  survival_tool_hammer: sk('tool-hammer', 'prop'),
  // --- characters --------------------------------------------------------------
  character_male_a: ch('character-male-a'),
  character_male_b: ch('character-male-b'),
  character_male_c: ch('character-male-c'),
  character_male_d: ch('character-male-d'),
  character_male_e: ch('character-male-e'),
  character_female_a: ch('character-female-a'),
  character_female_b: ch('character-female-b'),
  character_female_c: ch('character-female-c'),
  character_female_d: ch('character-female-d'),
  character_female_e: ch('character-female-e'),
  // --- cube pets -----------------------------------------------------------------
  pet_cow: pet('animal-cow', 0.42),
  pet_pig: pet('animal-pig', 0.3),
  pet_hog: pet('animal-hog', 0.32),
  pet_chick: pet('animal-chick', 0.16),
  pet_bunny: pet('animal-bunny', 0.2),
  pet_deer: pet('animal-deer', 0.5),
  pet_fish: pet('animal-fish', 0.15),
  pet_beaver: pet('animal-beaver', 0.22),
  pet_dog: pet('animal-dog', 0.26),
  pet_cat: pet('animal-cat', 0.22),
  pet_fox: pet('animal-fox', 0.24),
} as const satisfies Record<string, ModelEntry>;

export type ModelName = keyof typeof MODELS;

/** Animation clips kept by tools/assets.ts (others are stripped). */
export const CHARACTER_CLIPS = [
  'idle',
  'walk',
  'sprint',
  'sit',
  'pick-up',
  'interact-right',
  'interact-left',
  'emote-yes',
  'emote-no',
  'crouch',
  'holding-both',
  'holding-right',
  'attack-melee-right',
] as const;
export const PET_CLIPS = ['idle', 'walk', 'run', 'eat', 'gesture-positive'] as const;

export function modelNames(category: ObjectCategory): ModelName[] {
  return (Object.keys(MODELS) as ModelName[]).filter((n) => MODELS[n].category === category);
}

/** URL of an asset file below public/assets/, respecting Vite's base path. */
export function assetUrl(file: string): string {
  let base = '/';
  try {
    base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  } catch {
    /* not under Vite */
  }
  if (!base.endsWith('/')) base += '/';
  return `${base}assets/${file}`;
}
