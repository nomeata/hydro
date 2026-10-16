/**
 * Data textures used by the terrain and water shaders, and a helper that
 * uploads a band of rows with a direct texSubImage2D (three.js' own
 * `updateRanges` only handles RGBA, single-row ranges).
 */
import * as THREE from 'three';

/** Plan target sentinel used on the GPU instead of NaN (GPU NaN handling is unreliable). */
export const PLAN_NONE = -1e9;

export function makeFloatTexture(width: number, height: number, data?: Float32Array): THREE.DataTexture {
  const buf = data ?? new Float32Array(width * height);
  const t = new THREE.DataTexture(buf, width, height, THREE.RedFormat, THREE.FloatType);
  nearest(t);
  t.needsUpdate = true;
  return t;
}

export function makeByteTexture(
  width: number,
  height: number,
  channels: 2 | 4,
  data?: Uint8Array,
): THREE.DataTexture {
  const buf = data ?? new Uint8Array(width * height * channels);
  const t = new THREE.DataTexture(buf, width, height, channels === 4 ? THREE.RGBAFormat : THREE.RGFormat, THREE.UnsignedByteType);
  nearest(t);
  t.unpackAlignment = channels === 4 ? 4 : 2;
  t.needsUpdate = true;
  return t;
}

function nearest(t: THREE.DataTexture): void {
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.flipY = false;
  t.colorSpace = THREE.NoColorSpace;
}

/** Copy plan heights (NaN = none) into a GPU buffer using PLAN_NONE. Returns true if any cell has a plan. */
export function packPlan(src: Float32Array, dst: Float32Array): boolean {
  let any = false;
  const n = Math.min(src.length, dst.length);
  for (let i = 0; i < n; i++) {
    const v = src[i]!;
    if (v === v) {
      dst[i] = v;
      any = true;
    } else dst[i] = PLAN_NONE;
  }
  return any;
}

/** Velocity: signed bytes are uploaded as RG8 unorm and re-signed in the shader. */
export function packVel(src: Int8Array, dst: Uint8Array): void {
  dst.set(new Uint8Array(src.buffer, src.byteOffset, Math.min(src.length, dst.length)));
}

/**
 * Upload rows [y0, y1) of a single-channel float DataTexture. Falls back to a
 * full upload when the texture has not been uploaded yet.
 */
export function uploadFloatRows(renderer: THREE.WebGLRenderer, tex: THREE.DataTexture, y0: number, y1: number): void {
  const props = renderer.properties.get(tex) as { __webglTexture?: WebGLTexture; __version?: number };
  const pendingFull = props.__version !== tex.version;
  if (!props.__webglTexture || pendingFull) {
    tex.needsUpdate = true;
    return;
  }
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const img = tex.image as { width: number; height: number; data: Float32Array };
  const w = img.width;
  y0 = Math.max(0, y0);
  y1 = Math.min(img.height, y1);
  if (y1 <= y0) return;
  renderer.state.activeTexture(gl.TEXTURE0);
  renderer.state.bindTexture(gl.TEXTURE_2D, props.__webglTexture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, w, y1 - y0, gl.RED, gl.FLOAT, img.data, y0 * w);
}

/**
 * Small tileable noise texture (RGBA8, linear + mipmaps, repeat) for water
 * ripples and foam: R,G = two smooth noise fields (normal perturbation),
 * B = finer noise (foam breakup), A = cellular-ish sparkle.
 */
export function makeNoiseTexture(size = 64, seed = 7): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const lattice = (period: number, s: number): ((x: number, y: number) => number) => {
    const g = new Float32Array(period * period);
    let h = s * 2654435761;
    for (let i = 0; i < g.length; i++) {
      h = Math.imul(h ^ (h >>> 15), 2246822519) ^ Math.imul(h ^ (h >>> 13), 3266489917);
      g[i] = ((h >>> 0) % 10000) / 10000;
    }
    return (x, y) => {
      const fx = x * period;
      const fy = y * period;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const at = (i: number, j: number): number => g[(((j % period) + period) % period) * period + (((i % period) + period) % period)]!;
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      return a + (b - a) * sy;
    };
  };
  const n1 = lattice(4, seed);
  const n2 = lattice(8, seed + 1);
  const n3 = lattice(5, seed + 2);
  const n4 = lattice(10, seed + 3);
  const n5 = lattice(16, seed + 4);
  const n6 = lattice(32, seed + 5);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const r = n1(u, v) * 0.65 + n2(u, v) * 0.35;
      const g = n3(u, v) * 0.65 + n4(u, v) * 0.35;
      const b = n5(u, v) * 0.6 + n6(u, v) * 0.4;
      const a = n6(u + 0.37, v + 0.71);
      const i = (y * size + x) * 4;
      data[i] = Math.round(r * 255);
      data[i + 1] = Math.round(g * 255);
      data[i + 2] = Math.round(b * 255);
      data[i + 3] = Math.round(a * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}
