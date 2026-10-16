/**
 * Test helper: load a Kenney GLB in Node with three's GLTFLoader. Image
 * references are stripped (no DOM image decoding in Node); geometry,
 * skeletons and animation clips are kept.
 */
import { readFileSync } from 'node:fs';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export function loadGlbNode(path: string): Promise<GLTF> {
  const b = readFileSync(path);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8'));
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const m of json.materials ?? []) {
    const pbr = m.pbrMetallicRoughness;
    if (pbr) delete pbr.baseColorTexture;
  }
  const binStart = 20 + jsonLen;
  const binLen = b.readUInt32LE(binStart);
  const bin = b.subarray(binStart + 8, binStart + 8 + binLen);
  let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(pad, 0x20)]);
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBytes.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(out, 20);
  const o = 20 + jsonBytes.length;
  out.writeUInt32LE(bin.length, o);
  out.writeUInt32LE(0x004e4942, o + 4);
  bin.copy(out, o + 8);
  const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  return new Promise((resolve, reject) => new GLTFLoader().parse(ab, '', resolve, reject));
}
