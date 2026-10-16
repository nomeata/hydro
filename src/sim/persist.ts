/**
 * Save games: a JSON header followed by the raw bytes of every persisted
 * world field, gzip-compressed. Fields are matched by name, so adding new
 * fields stays backwards compatible (missing ones keep their defaults).
 */
import { FIELD_SPECS, World, type FieldName } from './world';
import { Simulation, type SimState } from './sim';

export const SAVE_VERSION = 1;
const MAGIC = 0x31445948; // "HYD1" little-endian

interface SaveHeader {
  version: number;
  seed: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  /** Extra info from the caller (e.g. start point, generator options). */
  meta: Record<string, unknown>;
  fields: { name: string; kind: string; bytes: number }[];
  sim: SimState;
}

export interface LoadedGame {
  sim: Simulation;
  meta: Record<string, unknown>;
}

export async function saveGame(sim: Simulation, meta: Record<string, unknown> = {}): Promise<ArrayBuffer> {
  const w = sim.world;
  const fields: SaveHeader['fields'] = [];
  const chunks: Uint8Array[] = [];
  for (const spec of FIELD_SPECS) {
    if (!spec.persist) continue;
    const arr = w.field(spec.name);
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    fields.push({ name: spec.name, kind: spec.kind, bytes: bytes.byteLength });
    chunks.push(bytes);
  }
  const header: SaveHeader = {
    version: SAVE_VERSION,
    seed: w.seed,
    width: w.width,
    height: w.height,
    originX: w.originX,
    originY: w.originY,
    meta,
    fields,
    sim: sim.getState(),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const prefix = new Uint8Array(8);
  const dv = new DataView(prefix.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, headerBytes.byteLength, true);
  const raw = concat([prefix, headerBytes, ...chunks]);
  return gzip(raw);
}

export async function loadGame(data: ArrayBuffer): Promise<LoadedGame> {
  const raw = new Uint8Array(await gunzip(data));
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw.byteLength < 8 || dv.getUint32(0, true) !== MAGIC) throw new Error('Not a Hydro save file');
  const hlen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + hlen))) as SaveHeader;
  if (header.version > SAVE_VERSION) throw new Error(`Save version ${header.version} is newer than this game`);

  const world = new World(header.width, header.height, header.seed);
  world.originX = header.originX;
  world.originY = header.originY;
  const known = new Set<string>(FIELD_SPECS.map((s) => s.name));
  let off = 8 + hlen;
  for (const f of header.fields) {
    const bytes = raw.subarray(off, off + f.bytes);
    off += f.bytes;
    if (!known.has(f.name)) continue; // field was removed in a later version
    const target = world.field(f.name as FieldName);
    if (target.byteLength !== f.bytes) throw new Error(`Field ${f.name} has unexpected size`);
    new Uint8Array(target.buffer, target.byteOffset, target.byteLength).set(bytes);
  }
  const sim = new Simulation(world, header.seed);
  sim.setState(header.sim);
  return { sim, meta: header.meta };
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

async function pipe(data: BufferSource, stream: GenericTransformStream): Promise<ArrayBuffer> {
  const out = new Blob([data]).stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Response(out).arrayBuffer();
}

function gzip(data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  return pipe(data, new CompressionStream('gzip'));
}

function gunzip(data: ArrayBuffer): Promise<ArrayBuffer> {
  return pipe(data, new DecompressionStream('gzip'));
}
