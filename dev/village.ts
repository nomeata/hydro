/**
 * Dev check for render/village: building variants at every construction
 * stage, the store at every food level, and (with ?parts=1) the raw
 * fantasy-town parts with axis markers (red = +x, blue = +z).
 *
 *   npx vite --port 5175   →   http://localhost:5175/dev/village.html
 *   ?zoom=12 (visible world height)  ?yaw=45  ?parts=1
 */
import * as THREE from 'three';
import type { HeightSampler } from '../src/render/coords';
import { modelLibrary } from '../src/render/objects/loader';
import { MODELS, type ModelName } from '../src/render/objects/manifest';
import { BuildingsLayer } from '../src/render/village/buildings';
import { MillWheelsLayer } from '../src/render/village/millwheels';
import type { BuildingInfo } from '../src/shared/protocol';

const params = new URLSearchParams(location.search);
const zoom = Number(params.get('zoom') ?? 12);
const yaw = (Number(params.get('yaw') ?? 35) * Math.PI) / 180;

const flat: HeightSampler = { width: 64, height: 64, terrainAt: () => 0, depthAt: () => 0 };

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9cc7e0);
  scene.add(new THREE.HemisphereLight(0xe8f4ff, 0x7a6a4a, 1.7));
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.4);
  sun.position.set(-20, 30, 10);
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshLambertMaterial({ color: 0x7fb653 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const aspect = canvas.clientWidth / canvas.clientHeight;
  const camera = new THREE.OrthographicCamera((-zoom / 2) * aspect, (zoom / 2) * aspect, zoom / 2, -zoom / 2, -500, 500);
  let cx = 0;
  let cz = 0;

  if (params.has('parts')) {
    const names = (Object.keys(MODELS) as ModelName[]).filter((n) => n.startsWith('town_') && !['town_watermill', 'town_windmill'].includes(n));
    const ms = await modelLibrary().preloadStatic(names);
    ms.forEach((m, i) => {
      const mesh = new THREE.Mesh(m.geometry, m.material);
      const x = (i % 6) * 2;
      const z = Math.floor(i / 6) * 2;
      mesh.position.set(x, 0, z);
      scene.add(mesh);
      const rx = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
      rx.position.set(x + 0.7, 0.05, z);
      const bz = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial({ color: 0x0000ff }));
      bz.position.set(x, 0.05, z + 0.7);
      scene.add(rx, bz);
      console.log(i, m.name);
    });
    cx = 5;
    cz = 4;
  } else {
    const layer = new BuildingsLayer(scene, flat);
    await layer.ready;
    const list: BuildingInfo[] = [];
    let id = 1;
    const progresses = [0.1, 0.5, 0.8, 1];
    for (let v = 0; v < 4; v++)
      for (let s = 0; s < progresses.length; s++) list.push({ id: v + 4 * id++, kind: 'house', x: 10 + s * 2.5, y: 10 + v * 2.5, rot: 0, progress: progresses[s]! });
    // Force variants by id: ids chosen so variant = v.
    list.forEach((b, k) => (b.id = Math.floor(k / progresses.length) + 1000 * (k % progresses.length)));
    list.push({ id: 9000, kind: 'store', x: 10, y: 21, rot: 0, progress: 1 });
    list.push({ id: 9001, kind: 'store', x: 13, y: 21, rot: Math.PI / 2, progress: 1 });
    // Wells (four stages, then a dry one) and mills (four stages, then with 1–3 sacks), wheels facing +x.
    for (let s = 0; s < progresses.length; s++) list.push({ id: 9100 + s, kind: 'well', x: 10 + s * 2.5, y: 24, rot: 0, progress: progresses[s]! });
    list.push({ id: 9110, kind: 'well', x: 20, y: 24, rot: 0, progress: 1, dry: true });
    for (let s = 0; s < progresses.length; s++) list.push({ id: 9200 + s, kind: 'mill', x: 10 + s * 3, y: 27, rot: 0, progress: progresses[s]!, spin: 1 });
    list.push({ id: 9210, kind: 'mill', x: 22, y: 27, rot: Math.PI / 2, progress: 1, spin: 0.5, sacks: 3 });
    layer.setBuildings(list);
    layer.setVillages([{ x: 10, y: 21, population: 4, houses: 4, food: Number(params.get('food') ?? 60) * 4, wellbeing: 1 }]);
    const wheels = new MillWheelsLayer(scene, flat);
    wheels.setBuildings(list);
    let last = performance.now();
    const spin = () => {
      const now = performance.now();
      wheels.update((now - last) / 1000, 1);
      last = now;
      requestAnimationFrame(spin);
    };
    spin();
    cx = Number(params.get('cx') ?? 15.5);
    cz = Number(params.get('cz') ?? 19);
    (window as unknown as { __layer: unknown }).__layer = layer;
  }

  const r = 50;
  camera.position.set(cx + Math.sin(yaw) * r * Math.cos(0.6), Math.sin(0.6) * r, cz + Math.cos(yaw) * r * Math.cos(0.6));
  camera.lookAt(cx, 0, cz);
  const state = { ready: false, calls: 0, triangles: 0 };
  (window as unknown as { __objects: unknown }).__objects = state;
  let frames = 0;
  const loop = () => {
    renderer.render(scene, camera);
    state.calls = renderer.info.render.calls;
    state.triangles = renderer.info.render.triangles;
    if (++frames > 3) state.ready = true;
    requestAnimationFrame(loop);
  };
  loop();
}

void main();
