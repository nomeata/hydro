/**
 * Curates Kenney CC0 models from the downloaded packs into public/assets/.
 *
 *   npx tsx tools/assets.ts [kenneyDir]      (default ../assets-src or $ASSETS_SRC)
 *
 * Static models: all primitives are flattened (node transforms applied) into a
 * single indexed primitive with POSITION, NORMAL and linear COLOR_0. Colours
 * come from baseColorFactor (nature-kit authors these as sRGB values, so they
 * are linearised) times the colormap texture sampled at each vertex UV. The
 * result needs no texture at all.
 *
 * Animated models (characters, cube pets): unused animations, TANGENT and
 * TEXCOORD_1 are stripped, accessors are repacked tightly, JSON minified. The
 * pack's Textures/colormap.png is copied once next to them (same relative URI
 * as in the source GLBs).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { CHARACTER_CLIPS, MODELS, PET_CLIPS, type ModelEntry } from '../src/render/objects/manifest';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(process.argv[2] ?? process.env.ASSETS_SRC ?? join(ROOT, '..', 'assets-src'));
const OUT = join(ROOT, 'public', 'assets');

interface Glb {
  json: Json;
  bin: Buffer;
}

function readGlb(path: string): Glb {
  const b = readFileSync(path);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path}: not a GLB`);
  let off = 12;
  let json: Json = null;
  let bin = Buffer.alloc(0);
  while (off < b.length) {
    const len = b.readUInt32LE(off);
    const type = b.readUInt32LE(off + 4);
    const chunk = b.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
    else if (type === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  return { json, bin };
}

function writeGlb(path: string, json: Json, bin: Buffer): void {
  const pad = (buf: Buffer, byte: number) => {
    const n = (4 - (buf.length % 4)) % 4;
    return n ? Buffer.concat([buf, Buffer.alloc(n, byte)]) : buf;
  };
  json.buffers = [{ byteLength: bin.length }];
  const jb = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const bb = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jb.length + 8 + bb.length, 8);
  const ch = (len: number, type: number) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(len, 0);
    h.writeUInt32LE(type, 4);
    return h;
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([header, ch(jb.length, 0x4e4f534a), jb, ch(bb.length, 0x004e4942), bb]));
}

const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const CSIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** Accessor as plain numbers (normalized ints mapped to 0..1 / -1..1). */
function readAccessor(g: Glb, index: number): { data: Float64Array; n: number; count: number } {
  const a = g.json.accessors[index];
  if (a.sparse) throw new Error('sparse accessors unsupported');
  const n = NCOMP[a.type]!;
  const cs = CSIZE[a.componentType]!;
  const out = new Float64Array(a.count * n);
  if (a.bufferView === undefined) return { data: out, n, count: a.count };
  const bv = g.json.bufferViews[a.bufferView];
  const stride = bv.byteStride ?? n * cs;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const dv = new DataView(g.bin.buffer, g.bin.byteOffset, g.bin.byteLength);
  for (let i = 0; i < a.count; i++) {
    for (let k = 0; k < n; k++) {
      const o = base + i * stride + k * cs;
      let v: number;
      switch (a.componentType) {
        case 5126: v = dv.getFloat32(o, true); break;
        case 5125: v = dv.getUint32(o, true); break;
        case 5123: v = dv.getUint16(o, true); if (a.normalized) v /= 65535; break;
        case 5122: v = dv.getInt16(o, true); if (a.normalized) v = Math.max(v / 32767, -1); break;
        case 5121: v = dv.getUint8(o); if (a.normalized) v /= 255; break;
        case 5120: v = dv.getInt8(o); if (a.normalized) v = Math.max(v / 127, -1); break;
        default: throw new Error('bad componentType');
      }
      out[i * n + k] = v;
    }
  }
  return { data: out, n, count: a.count };
}

/** Raw tightly packed bytes of an accessor (for repacking). */
function accessorBytes(g: Glb, index: number): Buffer {
  const a = g.json.accessors[index];
  const n = NCOMP[a.type]!;
  const cs = CSIZE[a.componentType]!;
  const elem = n * cs;
  const out = Buffer.alloc(a.count * elem);
  if (a.bufferView === undefined) return out;
  const bv = g.json.bufferViews[a.bufferView];
  const stride = bv.byteStride ?? elem;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  for (let i = 0; i < a.count; i++) g.bin.copy(out, i * elem, base + i * stride, base + i * stride + elem);
  return out;
}

/**
 * Nature-kit recolour (sRGB 0..255, by material name): Kenney's default is a
 * cyan-teal palette; we want warmer, Settlers-like greens and earthier wood
 * and stone so the objects sit well on the terrain colours.
 */
const NATURE_PALETTE: Record<string, [number, number, number]> = {
  leafsGreen: [96, 172, 70],
  leafsDark: [50, 128, 80],
  grass: [116, 182, 72],
  leafsFall: [238, 140, 52],
  stone: [190, 188, 180],
  stoneDark: [140, 140, 138],
  woodBark: [150, 102, 66],
  woodBarkDark: [118, 82, 60],
  wood: [196, 142, 92],
  woodDark: [150, 104, 72],
  dirt: [168, 122, 82],
  dirtDark: [136, 98, 66],
};

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

const textureCache = new Map<string, PNG>();
function loadTexture(path: string): PNG {
  let t = textureCache.get(path);
  if (!t) {
    t = PNG.sync.read(readFileSync(path));
    textureCache.set(path, t);
  }
  return t;
}

function sampleLinear(png: PNG, u: number, v: number): [number, number, number] {
  u -= Math.floor(u);
  v -= Math.floor(v);
  const x = Math.min(png.width - 1, Math.floor(u * png.width));
  const y = Math.min(png.height - 1, Math.floor(v * png.height));
  const o = (y * png.width + x) * 4;
  return [srgbToLinear(png.data[o]! / 255), srgbToLinear(png.data[o + 1]! / 255), srgbToLinear(png.data[o + 2]! / 255)];
}

function nodeMatrix(node: Json): Matrix4 {
  const m = new Matrix4();
  if (node.matrix) return m.fromArray(node.matrix);
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  return m.compose(new Vector3(...t), new Quaternion(...r), new Vector3(...s));
}

/** Flatten a static model into one vertex-coloured primitive. */
function flattenStatic(srcPath: string, outPath: string, factorIsSrgb: boolean): { verts: number; tris: number; bbox: number[] } {
  const g = readGlb(srcPath);
  const j = g.json;
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  let anyDoubleSided = false;

  const visit = (ni: number, parent: Matrix4) => {
    const node = j.nodes[ni];
    const world = parent.clone().multiply(nodeMatrix(node));
    if (node.mesh !== undefined) {
      const normalM = new Matrix3().getNormalMatrix(world);
      const flip = world.determinant() < 0;
      for (const prim of j.meshes[node.mesh].primitives) {
        if ((prim.mode ?? 4) !== 4) continue;
        const mat = prim.material !== undefined ? j.materials[prim.material] : {};
        if (mat.doubleSided) anyDoubleSided = true;
        const pbr = mat.pbrMetallicRoughness ?? {};
        const remap = factorIsSrgb ? NATURE_PALETTE[mat.name as string] : undefined;
        const f = remap
          ? remap.map((c) => srgbToLinear(c / 255))
          : (pbr.baseColorFactor ?? [1, 1, 1, 1]).slice(0, 3).map((c: number) => (factorIsSrgb ? srgbToLinear(c) : c));
        let tex: PNG | null = null;
        let uv: Float64Array | null = null;
        if (pbr.baseColorTexture) {
          const texInfo = pbr.baseColorTexture;
          const img = j.images[j.textures[texInfo.index].source];
          if (!img.uri) throw new Error('embedded textures unsupported');
          tex = loadTexture(join(dirname(srcPath), decodeURIComponent(img.uri)));
          const tt = texInfo.extensions?.KHR_texture_transform;
          if (tt && (tt.offset || tt.scale || tt.rotation)) throw new Error('non-identity KHR_texture_transform');
          const tc = tt?.texCoord ?? texInfo.texCoord ?? 0;
          uv = readAccessor(g, prim.attributes[`TEXCOORD_${tc}`]).data;
        }
        const p = readAccessor(g, prim.attributes.POSITION);
        const nrm = prim.attributes.NORMAL !== undefined ? readAccessor(g, prim.attributes.NORMAL).data : null;
        const vc = prim.attributes.COLOR_0 !== undefined ? readAccessor(g, prim.attributes.COLOR_0) : null;
        const base = pos.length / 3;
        const v = new Vector3();
        for (let i = 0; i < p.count; i++) {
          v.set(p.data[i * 3]!, p.data[i * 3 + 1]!, p.data[i * 3 + 2]!).applyMatrix4(world);
          pos.push(v.x, v.y, v.z);
          if (nrm) {
            v.set(nrm[i * 3]!, nrm[i * 3 + 1]!, nrm[i * 3 + 2]!).applyMatrix3(normalM).normalize();
            nor.push(v.x, v.y, v.z);
          } else nor.push(0, 1, 0);
          let c: [number, number, number] = [f[0], f[1], f[2]];
          if (tex && uv) {
            const s = sampleLinear(tex, uv[i * 2]!, uv[i * 2 + 1]!);
            c = [c[0] * s[0], c[1] * s[1], c[2] * s[2]];
          }
          if (vc) c = [c[0] * vc.data[i * vc.n]!, c[1] * vc.data[i * vc.n + 1]!, c[2] * vc.data[i * vc.n + 2]!];
          col.push(c[0], c[1], c[2]);
        }
        const ind = prim.indices !== undefined ? readAccessor(g, prim.indices).data : Float64Array.from({ length: p.count }, (_, i) => i);
        for (let t = 0; t + 2 < ind.length; t += 3) {
          const a = base + ind[t]!;
          const b = base + ind[t + 1]!;
          const c2 = base + ind[t + 2]!;
          if (flip) idx.push(a, c2, b);
          else idx.push(a, b, c2);
        }
      }
    }
    for (const c of node.children ?? []) visit(c, world);
  };
  const scene = j.scenes[j.scene ?? 0];
  for (const n of scene.nodes) visit(n, new Matrix4());

  const vcount = pos.length / 3;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vcount; i++)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, pos[i * 3 + k]!);
      max[k] = Math.max(max[k]!, pos[i * 3 + k]!);
    }
  // Quantized layout (KHR_mesh_quantization): f32 positions, i8 normals
  // (stride 4), u16 normalized linear colours.
  const posB = Buffer.from(new Float32Array(pos).buffer);
  const norB = Buffer.alloc(vcount * 4);
  for (let i = 0; i < vcount; i++)
    for (let k = 0; k < 3; k++) norB.writeInt8(Math.round(Math.max(-1, Math.min(1, nor[i * 3 + k]!)) * 127), i * 4 + k);
  const colB = Buffer.alloc(vcount * 8);
  for (let i = 0; i < vcount; i++) {
    for (let k = 0; k < 3; k++) colB.writeUInt16LE(Math.round(Math.max(0, Math.min(1, col[i * 3 + k]!)) * 65535), i * 8 + k * 2);
    colB.writeUInt16LE(65535, i * 8 + 6);
  }
  const big = vcount > 65535;
  let idxB = Buffer.from(big ? new Uint32Array(idx).buffer : new Uint16Array(idx).buffer);
  const idxLen = idxB.length;
  if (idxB.length % 4) idxB = Buffer.concat([idxB, Buffer.alloc(4 - (idxB.length % 4))]);
  const bin = Buffer.concat([posB, norB, colB, idxB]);
  let off = 0;
  const views = [posB, norB, colB, idxB].map((b, i) => {
    const v: Json = { buffer: 0, byteOffset: off, byteLength: i === 3 ? idxLen : b.length, target: i === 3 ? 34963 : 34962 };
    if (i === 1) v.byteStride = 4;
    off += b.length;
    return v;
  });
  const json: Json = {
    asset: { version: '2.0', generator: 'hydro tools/assets.ts (from Kenney CC0)' },
    extensionsUsed: ['KHR_mesh_quantization'],
    extensionsRequired: ['KHR_mesh_quantization'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: outPath.split('/').pop()!.replace('.glb', '') }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: 'vertexColor', doubleSided: anyDoubleSided, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vcount, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5120, normalized: true, count: vcount, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, normalized: true, count: vcount, type: 'VEC4' },
      { bufferView: 3, componentType: big ? 5125 : 5123, count: idx.length, type: 'SCALAR' },
    ],
    bufferViews: views,
  };
  writeGlb(outPath, json, bin);
  return { verts: vcount, tris: idx.length / 3, bbox: [...min, ...max] };
}

/** Strip unused data from an animated model and repack its buffer. */
function pruneAnimated(srcPath: string, outPath: string, keepClips: readonly string[]): string[] {
  const g = readGlb(srcPath);
  const j = g.json;
  for (const m of j.meshes)
    for (const p of m.primitives) {
      delete p.attributes.TANGENT;
      delete p.attributes.TEXCOORD_1;
    }
  j.animations = (j.animations ?? []).filter((a: Json) => keepClips.includes(a.name));
  // Repack: accessors tightly packed into three bufferViews (vertex
  // attributes, indices, other data such as animation keys and matrices).
  const used = new Map<number, number>();
  const newAcc: Json[] = [];
  const kinds = { vertex: [] as Buffer[], index: [] as Buffer[], other: [] as Buffer[] };
  const kindOff = { vertex: 0, index: 0, other: 0 };
  const accKind: (keyof typeof kinds)[] = [];
  const accLen: number[] = [];
  const remap = (i: number, kind: keyof typeof kinds): number => {
    let r = used.get(i);
    if (r !== undefined) return r;
    const a: Json = { ...j.accessors[i] };
    const bytes = accessorBytes(g, i);
    const padded = bytes.length % 4 ? Buffer.concat([bytes, Buffer.alloc(4 - (bytes.length % 4))]) : bytes;
    a.byteOffset = kindOff[kind];
    kinds[kind].push(padded);
    kindOff[kind] += padded.length;
    if (kind !== 'vertex' || j.accessors[i].type !== 'VEC3') {
      // min/max are only required for POSITION.
      delete a.min;
      delete a.max;
    }
    r = newAcc.length;
    newAcc.push(a);
    accKind.push(kind);
    accLen.push(bytes.length);
    used.set(i, r);
    return r;
  };
  for (const m of j.meshes)
    for (const p of m.primitives) {
      for (const k of Object.keys(p.attributes)) p.attributes[k] = remap(p.attributes[k], 'vertex');
      if (p.indices !== undefined) p.indices = remap(p.indices, 'index');
      if (p.targets) for (const t of p.targets) for (const k of Object.keys(t)) t[k] = remap(t[k], 'vertex');
    }
  for (const s of j.skins ?? []) if (s.inverseBindMatrices !== undefined) s.inverseBindMatrices = remap(s.inverseBindMatrices, 'other');
  for (const a of j.animations)
    for (const s of a.samplers) {
      s.input = remap(s.input, 'other');
      s.output = remap(s.output, 'other');
    }
  const views: Json[] = [];
  const viewIndex: Record<string, number> = {};
  const chunks: Buffer[] = [];
  let off = 0;
  for (const kind of ['vertex', 'index', 'other'] as const) {
    if (!kinds[kind].length) continue;
    const buf = Buffer.concat(kinds[kind]);
    const v: Json = { buffer: 0, byteOffset: off, byteLength: buf.length };
    if (kind === 'vertex') v.target = 34962;
    if (kind === 'index') v.target = 34963;
    if (kind === 'vertex') {
      // Vertex attributes sharing a view would need byteStride: one view each.
      newAcc.forEach((a, i) => {
        if (accKind[i] !== 'vertex') return;
        a.bufferView = views.length;
        views.push({ buffer: 0, byteOffset: off + a.byteOffset, byteLength: accLen[i], target: 34962 });
        a.byteOffset = 0;
      });
    } else {
      viewIndex[kind] = views.length;
      views.push(v);
    }
    chunks.push(buf);
    off += buf.length;
  }
  newAcc.forEach((a, i) => {
    if (accKind[i] !== 'vertex') a.bufferView = viewIndex[accKind[i]!];
  });
  for (const img of j.images ?? []) if (img.bufferView !== undefined) throw new Error('embedded images unsupported');
  j.accessors = newAcc;
  j.bufferViews = views;
  writeGlb(outPath, j, Buffer.concat(chunks));
  return (j.images ?? []).map((i: Json) => i.uri as string);
}

function main(): void {
  if (!existsSync(SRC)) throw new Error(`Kenney source dir not found: ${SRC}`);
  mkdirSync(OUT, { recursive: true });
  const produced = new Set<string>();
  const entries = Object.entries(MODELS) as [string, ModelEntry][];
  const packs = new Set<string>();
  for (const [name, e] of entries) {
    const src = join(SRC, e.src);
    const out = join(OUT, e.file);
    packs.add(e.src.split('/')[0]!);
    produced.add(out);
    if (e.animated) {
      const clips = e.category === 'character' ? CHARACTER_CLIPS : PET_CLIPS;
      const uris = pruneAnimated(src, out, clips);
      for (const uri of uris) {
        const dst = join(dirname(out), uri);
        if (!produced.has(dst)) {
          produced.add(dst);
          mkdirSync(dirname(dst), { recursive: true });
          copyFileSync(join(dirname(src), uri), dst);
        }
      }
    } else {
      const r = flattenStatic(src, out, e.src.startsWith('nature-kit/'));
      const h = (r.bbox[4]! - r.bbox[1]!) * (e.scale ?? 1);
      console.log(`${name.padEnd(28)} ${String(r.tris).padStart(5)} tris  h=${h.toFixed(2)}`);
    }
  }
  // License files of every pack used.
  for (const p of packs) {
    const dst = join(OUT, `LICENSE-kenney-${p}.txt`);
    copyFileSync(join(SRC, p, 'License.txt'), dst);
    produced.add(dst);
  }
  // Remove stale files (in place, so a running dev server keeps serving).
  let total = 0;
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (!produced.has(p)) rmSync(p);
      else total += s.size;
    }
  };
  walk(OUT);
  console.log(`${entries.length} models, total ${(total / 1024 / 1024).toFixed(2)} MB in ${OUT}`);
}

main();
