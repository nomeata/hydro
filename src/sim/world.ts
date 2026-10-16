/**
 * The authoritative world state: a structure-of-arrays grid. Every per-cell
 * field is declared in FIELD_SPECS so that serialisation and snapshotting can
 * iterate over them generically.
 */

export type FieldKind = 'f32' | 'u8' | 'u16';

export interface FieldSpec {
  readonly name: FieldName;
  readonly kind: FieldKind;
  /** Saved in save games (derived/transient fields are not). */
  readonly persist: boolean;
}

export const FIELD_SPECS = [
  { name: 'bedrock', kind: 'f32', persist: true },
  { name: 'soil', kind: 'f32', persist: true },
  { name: 'soilType', kind: 'u8', persist: true },
  { name: 'water', kind: 'f32', persist: true },
  { name: 'sediment', kind: 'f32', persist: true },
  { name: 'qx', kind: 'f32', persist: true },
  { name: 'qy', kind: 'f32', persist: true },
  { name: 'velX', kind: 'f32', persist: true },
  { name: 'velY', kind: 'f32', persist: true },
  { name: 'ground', kind: 'f32', persist: true },
  { name: 'snow', kind: 'f32', persist: true },
  { name: 'fertility', kind: 'f32', persist: true },
  { name: 'vegetation', kind: 'f32', persist: true },
  { name: 'flags', kind: 'u8', persist: true },
  { name: 'revealed', kind: 'u8', persist: true },
  { name: 'plan', kind: 'f32', persist: true },
  { name: 'inflow', kind: 'f32', persist: true },
  { name: 'flowAvg', kind: 'f32', persist: true },
  { name: 'landuse', kind: 'u8', persist: true },
  { name: 'crop', kind: 'u8', persist: true },
  { name: 'floodMemory', kind: 'u8', persist: true },
] as const satisfies readonly { name: string; kind: FieldKind; persist: boolean }[];

export type FieldName = (typeof FIELD_SPECS)[number]['name'];

type ArrayOf<K extends FieldKind> = K extends 'f32' ? Float32Array : K extends 'u8' ? Uint8Array : Uint16Array;
type Fields = { [S in (typeof FIELD_SPECS)[number] as S['name']]: ArrayOf<S['kind']> };

/** Soil types. Order matters: it indexes SOIL_PROPS. */
export const enum SoilType {
  Rock = 0,
  Gravel = 1,
  Sand = 2,
  Loam = 3,
  Clay = 4,
  Silt = 5,
  Peat = 6,
}
export const SOIL_TYPE_COUNT = 7;

export interface SoilProps {
  readonly name: string;
  /** Pore volume fraction available for groundwater. */
  readonly porosity: number;
  /** Max infiltration rate (m per hydro second) into unsaturated soil. */
  readonly infiltration: number;
  /** Lateral groundwater conductivity factor. */
  readonly conductivity: number;
  /** Erodibility multiplier for sediment pickup. */
  readonly erodibility: number;
  /** Base fertility 0..1. */
  readonly fertility: number;
  /** Max stable slope (rise/run) before talus slumping. */
  readonly repose: number;
}

export const SOIL_PROPS: readonly SoilProps[] = [
  { name: 'rock', porosity: 0.02, infiltration: 0.0, conductivity: 0.0, erodibility: 0.05, fertility: 0.0, repose: 4.0 },
  { name: 'gravel', porosity: 0.3, infiltration: 4e-4, conductivity: 1.0, erodibility: 0.4, fertility: 0.1, repose: 0.9 },
  { name: 'sand', porosity: 0.35, infiltration: 2e-4, conductivity: 0.6, erodibility: 1.2, fertility: 0.2, repose: 0.6 },
  { name: 'loam', porosity: 0.4, infiltration: 6e-5, conductivity: 0.25, erodibility: 0.8, fertility: 0.7, repose: 0.8 },
  { name: 'clay', porosity: 0.45, infiltration: 1e-5, conductivity: 0.03, erodibility: 0.4, fertility: 0.5, repose: 1.0 },
  { name: 'silt', porosity: 0.42, infiltration: 3e-5, conductivity: 0.15, erodibility: 1.5, fertility: 0.9, repose: 0.6 },
  { name: 'peat', porosity: 0.8, infiltration: 2e-5, conductivity: 0.05, erodibility: 0.6, fertility: 0.4, repose: 0.7 },
];

/** Land use per cell. */
export const enum LandUse {
  None = 0,
  Field = 1,
  Garden = 2,
  Pasture = 3,
  Path = 4,
  Building = 5,
  Yard = 6,
  Bridge = 7,
}

/** Bit flags in the `flags` field. */
export const enum CellFlag {
  /** Stone lining: no erosion, no slumping. */
  Lined = 1,
  /** Open boundary: water leaving the map here is removed. */
  Outlet = 2,
  /** A structure occupies the cell. */
  Structure = 4,
}

export class World {
  readonly width: number;
  readonly height: number;
  readonly size: number;
  /** World offset of this grid in the infinite world (cells). */
  originX = 0;
  originY = 0;
  readonly seed: number;

  // Field arrays, filled in by the constructor from FIELD_SPECS.
  declare readonly bedrock: Float32Array;
  declare readonly soil: Float32Array;
  declare readonly soilType: Uint8Array;
  declare readonly water: Float32Array;
  declare readonly sediment: Float32Array;
  /** Discharge per unit width (m²/s) across the face to the +x neighbour. */
  declare readonly qx: Float32Array;
  /** Discharge per unit width (m²/s) across the face to the +y neighbour. */
  declare readonly qy: Float32Array;
  declare readonly velX: Float32Array;
  declare readonly velY: Float32Array;
  declare readonly ground: Float32Array;
  declare readonly snow: Float32Array;
  declare readonly fertility: Float32Array;
  declare readonly vegetation: Float32Array;
  declare readonly flags: Uint8Array;
  declare readonly revealed: Uint8Array;
  declare readonly plan: Float32Array;
  /** Prescribed boundary/spring inflow, m³ per hydro second. */
  declare readonly inflow: Float32Array;
  /** Exponential moving average of |discharge|, used for river detection. */
  declare readonly flowAvg: Float32Array;
  /** Land use (LandUse enum). */
  declare readonly landuse: Uint8Array;
  /** Crop growth stage 0..255 on fields (0 = bare/ploughed, 255 = ripe). */
  declare readonly crop: Uint8Array;
  /** Recent flooding: 255 when flooded, decays by 1 per day. */
  declare readonly floodMemory: Uint8Array;

  constructor(width: number, height: number, seed: number) {
    this.width = width;
    this.height = height;
    this.size = width * height;
    this.seed = seed;
    const self = this as unknown as Record<string, Float32Array | Uint8Array | Uint16Array>;
    for (const spec of FIELD_SPECS) {
      self[spec.name] = allocate(spec.kind, this.size);
    }
    this.plan.fill(NaN);
  }

  field<N extends FieldName>(name: N): Fields[N] {
    return (this as unknown as Fields)[name];
  }

  idx(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Terrain surface height (bedrock + soil). */
  terrain(i: number): number {
    return this.bedrock[i]! + this.soil[i]!;
  }

  /** Water surface height. */
  surface(i: number): number {
    return this.bedrock[i]! + this.soil[i]! + this.water[i]!;
  }

  /** Total stored water volume (surface + ground + snow), m per cell area. */
  totalWater(): number {
    let s = 0;
    const { water, ground, snow } = this;
    for (let i = 0; i < this.size; i++) s += water[i]! + ground[i]! + snow[i]!;
    return s;
  }
}

function allocate(kind: FieldKind, n: number): Float32Array | Uint8Array | Uint16Array {
  switch (kind) {
    case 'f32':
      return new Float32Array(n);
    case 'u8':
      return new Uint8Array(n);
    case 'u16':
      return new Uint16Array(n);
  }
}
