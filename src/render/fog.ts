/**
 * Fog of war (docs/PEOPLE.md §6): unknown land is simply not there. Known
 * land fades softly into the background sky at its edge, so the player
 * never sees the (rectangular) extent of the world until they reach it.
 *
 * The sim sends `revealed` (0..255 per cell, soft edge). Here it becomes
 * - a linear-filtered R8 texture that the terrain and water shaders read:
 *   the terrain mesh itself turns into the cloud sea where land is hidden
 *   (vertices move to a smooth "fog height", the surface takes a white/blue
 *   haze colour), water fades out;
 * - a coarse fog height texture: the terrain blurred over ~40 cells plus a
 *   lift, so the clouds follow the large landscape but hide every detail;
 * - CPU queries for the other layers (vegetation, buildings, crowd, flow
 *   flecks, camera bounds, chunk visibility).
 */
import * as THREE from 'three';
import type { HeightField } from './heights';

/** Spacing (cells) of the fog height grid. */
export const FOG_CELL = 8;
/** Revealed value from which a cell counts as known (objects shown, plans allowed). */
export const KNOWN = 128;
/** Cloud tops sit this far (m) above the blurred terrain. */
const FOG_LIFT = 3.5;
/** Blur radius (cells) of the fog height. */
const FOG_BLUR = 20;

export interface FogUniforms {
  uReveal: { value: THREE.Texture };
  uFogH: { value: THREE.Texture };
  uFogGrid: { value: THREE.Vector2 };
  uFogOn: { value: number };
  uFogHigh: { value: THREE.Color };
  uFogLow: { value: THREE.Color };
  /** Background gradient (linear colours) and drawing-buffer size, to fade into. */
  uBgTop: { value: THREE.Color };
  uBgBottom: { value: THREE.Color };
  uViewport: { value: THREE.Vector2 };
}

/**
 * GLSL shared by terrain and water (vertex and fragment): revealed lookup,
 * fog height and the billow noise. Needs `uniform vec2 uGrid` and
 * `uniform float uTime` declared by the including shader.
 */
export const FOG_GLSL = /* glsl */ `
uniform sampler2D uReveal;
uniform highp sampler2D uFogH;
uniform vec2 uFogGrid;
uniform float uFogOn;
uniform vec3 uFogHigh;
uniform vec3 uFogLow;
uniform vec3 uBgTop;
uniform vec3 uBgBottom;
uniform vec2 uViewport;

/** 0 = hidden, 1 = known, smooth in between (cell coordinates). */
float revealAt(vec2 cell) {
  if (uFogOn < 0.5) return 1.0;
  return textureLod(uReveal, (cell + 0.5) / uGrid, 0.0).r;
}

float fogHash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

float fogNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fogHash(i), fogHash(i + vec2(1.0, 0.0)), u.x),
             mix(fogHash(i + vec2(0.0, 1.0)), fogHash(i + vec2(1.0, 1.0)), u.x), u.y);
}

/** Slowly drifting billows, 0..1. */
float fogBillow(vec2 p, float t) {
  return 0.62 * fogNoise(p * 0.085 + vec2(t * 0.021, t * 0.012))
       + 0.38 * fogNoise(p * 0.21 + vec2(-t * 0.016, t * 0.019) + 7.3);
}

/** Cloud-top height (m) at a cell position: blurred terrain + lift (bilinear). */
float fogBaseH(vec2 cell) {
  vec2 g = cell / ${FOG_CELL.toFixed(1)};
  vec2 i = floor(g);
  vec2 f = g - i;
  ivec2 c = ivec2(i);
  ivec2 m = ivec2(uFogGrid) - 1;
  float a = texelFetch(uFogH, clamp(c, ivec2(0), m), 0).r;
  float b = texelFetch(uFogH, clamp(c + ivec2(1, 0), ivec2(0), m), 0).r;
  float d = texelFetch(uFogH, clamp(c + ivec2(0, 1), ivec2(0), m), 0).r;
  float e = texelFetch(uFogH, clamp(c + ivec2(1, 1), ivec2(0), m), 0).r;
  return mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
}

/** Haze colour of the cloud sea (bright tops, soft blue hollows). */
vec3 fogColour(float billow) {
  return mix(uFogLow, uFogHigh, smoothstep(0.25, 0.75, billow));
}
`;

/**
 * GLSL (terrain vertex shader): pull a hidden vertex up/down to the cloud
 * sea. Expects `vec2 fogCell` (cell coords) and `float hY` (scaled height,
 * modified in place), `uHeightScale`.
 */
/** Fragment-only GLSL: the background (sky) colour behind this pixel, linear; same as sky.ts. */
export const FOG_FRAGMENT_GLSL = /* glsl */ `
vec3 fogBackground() {
  vec2 uv = gl_FragCoord.xy / uViewport;
  vec3 c = mix(uBgBottom, uBgTop, smoothstep(0.0, 1.0, uv.y));
  vec2 d = uv - 0.5;
  return c * (1.0 - dot(d, d) * 0.35);
}
`;

/**
 * GLSL hook in the terrain vertex shader. Unknown land keeps its real
 * height: it simply fades into the background in the fragment shader.
 */
export const FOG_VERTEX_GLSL = /* glsl */ ``;

export class FogField {
  readonly width: number;
  readonly height: number;
  /** Revealed 0..255 per cell (the texture's data). */
  readonly revealed: Uint8Array;
  readonly revealTex: THREE.DataTexture;
  readonly heightTex: THREE.DataTexture;
  readonly uniforms: FogUniforms;
  /** Bounding box of known land (cells), or null when nothing is known. */
  bounds: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** Whether fog is in play (false for worlds without villages: all known). */
  readonly enabled: boolean;
  private readonly gw: number;
  private readonly gh: number;

  constructor(width: number, height: number, revealed: Uint8Array | undefined) {
    this.width = width;
    this.height = height;
    this.enabled = !!revealed;
    this.revealed = new Uint8Array(width * height);
    if (revealed) this.revealed.set(revealed.subarray(0, width * height));
    else this.revealed.fill(255);
    const t = new THREE.DataTexture(this.revealed, width, height, THREE.RedFormat, THREE.UnsignedByteType);
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.flipY = false;
    t.unpackAlignment = 1;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    this.revealTex = t;
    this.gw = Math.ceil(width / FOG_CELL) + 1;
    this.gh = Math.ceil(height / FOG_CELL) + 1;
    const h = new THREE.DataTexture(new Float32Array(this.gw * this.gh), this.gw, this.gh, THREE.RedFormat, THREE.FloatType);
    h.minFilter = THREE.NearestFilter;
    h.magFilter = THREE.NearestFilter;
    h.generateMipmaps = false;
    h.flipY = false;
    h.colorSpace = THREE.NoColorSpace;
    h.needsUpdate = true;
    this.heightTex = h;
    this.uniforms = {
      uReveal: { value: this.revealTex },
      uFogH: { value: this.heightTex },
      uFogGrid: { value: new THREE.Vector2(this.gw, this.gh) },
      uFogOn: { value: this.enabled ? 1 : 0 },
      uFogHigh: { value: new THREE.Color(0xf7f8fc) },
      uFogLow: { value: new THREE.Color(0xc9d6ea) },
      uBgTop: { value: new THREE.Color(0xbfe3f2) },
      uBgBottom: { value: new THREE.Color(0xe9f3dc) },
      uViewport: { value: new THREE.Vector2(1, 1) },
    };
    this.updateBounds();
  }

  /** New revealed data from a snapshot. */
  setRevealed(r: Uint8Array): void {
    this.revealed.set(r.subarray(0, this.revealed.length));
    this.revealTex.needsUpdate = true;
    this.updateBounds();
  }

  /** Recompute the cloud-top heights from the terrain (cheap: ~1k nodes). */
  updateHeight(heights: HeightField): void {
    const W = this.width;
    const H = this.height;
    const t = heights.terrain;
    const out = this.heightTex.image.data as Float32Array;
    const R = FOG_BLUR;
    for (let gy = 0; gy < this.gh; gy++)
      for (let gx = 0; gx < this.gw; gx++) {
        const cx = gx * FOG_CELL;
        const cy = gy * FOG_CELL;
        let s = 0;
        let wsum = 0;
        for (let y = Math.max(0, cy - R); y <= Math.min(H - 1, cy + R); y += 3)
          for (let x = Math.max(0, cx - R); x <= Math.min(W - 1, cx + R); x += 3) {
            const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (R * R);
            if (d2 > 1) continue;
            const wgt = 1 - d2;
            s += t[y * W + x]! * wgt;
            wsum += wgt;
          }
        out[gy * this.gw + gx] = (wsum > 0 ? s / wsum : 0) + FOG_LIFT;
      }
    this.heightTex.needsUpdate = true;
  }

  /** Revealed value 0..255 at the nearest cell (outside the map: 0). */
  at(x: number, y: number): number {
    const cx = Math.round(x);
    const cy = Math.round(y);
    if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) return 0;
    return this.revealed[cy * this.width + cx]!;
  }

  /** Whether the cell at (x, y) is known land. */
  known(x: number, y: number): boolean {
    return this.at(x, y) >= KNOWN;
  }

  /** True when no cell in the rectangle (plus a one-cell margin) is even partly revealed. */
  hidden(x0: number, y0: number, x1: number, y1: number): boolean {
    if (!this.enabled) return false;
    const W = this.width;
    const r = this.revealed;
    for (let y = Math.max(0, y0 - 1); y < Math.min(this.height, y1 + 1); y++)
      for (let x = Math.max(0, x0 - 1); x < Math.min(W, x1 + 1); x++) if (r[y * W + x]! > 0) return false;
    return true;
  }

  private updateBounds(): void {
    const W = this.width;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const r = this.revealed;
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < W; x++) {
        if (r[y * W + x]! < KNOWN) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    this.bounds = x1 >= x0 ? { x0, y0, x1, y1 } : null;
  }

  dispose(): void {
    this.revealTex.dispose();
    this.heightTex.dispose();
  }
}
