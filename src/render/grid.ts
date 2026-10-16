/**
 * The one shared chunk grid geometry used by terrain and water, plus the GLSL
 * that maps a chunk-local grid vertex to a global cell.
 *
 * A chunk covers CHUNK×CHUNK quads between cell centres. Its geometry has an
 * extra ring of vertices (local index −1 and CHUNK+1). Inside the map those
 * ring vertices collapse onto their inner neighbour (degenerate triangles);
 * on the map border they become "skirt" vertices that the terrain shader
 * drops down to a base level, so the map reads as a little diorama block.
 *
 * The mesh position is (originCell + 0.5, 0, originCell + 0.5); the vertex
 * shader recovers the chunk origin from modelMatrix and computes world
 * positions directly, so per-chunk frustum culling works via the shared
 * geometry's bounding sphere.
 */
import * as THREE from 'three';

export const CHUNK = 64;

export function makeChunkGeometry(): THREE.BufferGeometry {
  const n = CHUNK + 3; // vertices per side: -1 .. CHUNK+1
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 3;
      pos[k] = i - 1;
      pos[k + 1] = 0;
      pos[k + 2] = j - 1;
    }
  }
  const q = n - 1;
  const idx = new Uint16Array(q * q * 6);
  let p = 0;
  for (let j = 0; j < q; j++) {
    for (let i = 0; i < q; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // Diagonal from b to c; lower-left triangle (frac.x + frac.y < 1) is (a, c, b).
      idx[p++] = a;
      idx[p++] = c;
      idx[p++] = b;
      idx[p++] = b;
      idx[p++] = c;
      idx[p++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  setChunkBounds(g, -10, 10);
  return g;
}

/** Set the shared bounding volume for a world-y range. */
export function setChunkBounds(g: THREE.BufferGeometry, minY: number, maxY: number): void {
  const c = CHUNK / 2;
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-2, minY, -2), new THREE.Vector3(CHUNK + 2, maxY, CHUNK + 2));
  const center = new THREE.Vector3(c, (minY + maxY) / 2, c);
  const r = Math.hypot(c + 2, c + 2, (maxY - minY) / 2);
  g.boundingSphere = new THREE.Sphere(center, r);
}

/** Chunk origins (in cells) covering a W×H map. */
export function chunkOrigins(width: number, height: number): [number, number][] {
  const out: [number, number][] = [];
  for (let y = 0; y < height; y += CHUNK) for (let x = 0; x < width; x += CHUNK) out.push([x, y]);
  return out;
}

/**
 * GLSL: compute the global cell for this vertex. Defines `ivec2 gridCell`
 * (clamped to the map) and `bool gridSkirt`. Requires `uniform vec2 uGrid`.
 */
export const GRID_VERTEX_GLSL = /* glsl */ `
  ivec2 gridL = ivec2(round(position.xz));
  ivec2 gridG = ivec2(round(modelMatrix[3].xz - 0.5)) + gridL;
  ivec2 gridMax = ivec2(uGrid) - 1;
  if (gridL.x < 0 && gridG.x >= 0) gridG.x += 1;
  if (gridL.y < 0 && gridG.y >= 0) gridG.y += 1;
  if (gridL.x > ${CHUNK}) gridG.x -= 1;
  if (gridL.y > ${CHUNK}) gridG.y -= 1;
  bool gridSkirt = gridG.x < 0 || gridG.y < 0 || gridG.x > gridMax.x || gridG.y > gridMax.y;
  ivec2 gridCell = clamp(gridG, ivec2(0), gridMax);
`;
