/**
 * Bootstrap: start the simulation worker, build the renderer and UI, wire
 * snapshots to them, and expose a test hook with ?test=1.
 */
import './ui/styles.css';
import { SimClient, type ReadyData } from './client/simClient';
import { readSave, writeSave } from './persist/idb';
import { Menu } from './ui/menu';
import { Intro } from './ui/intro';
import { WorldMirror } from './client/mirror';
import { GameRenderer } from './render/renderer';
import { attachCameraInput } from './render/camera';
import { VegetationLayer } from './render/objects/vegetation';
import { CrowdLayer } from './render/crowd/crowd';
import { FakeCrowd } from './render/crowd/fakeCrowd';
import { FishJumps } from './render/fishJumps';
import type { EntityFrame } from './shared/protocol';
import { Hud } from './ui/hud';
import { ToolPalette } from './ui/tools';

const params = new URLSearchParams(location.search);
const testMode = params.has('test');
const seed = Number(params.get('seed') ?? (testMode ? 1 : Math.floor(Math.random() * 1e9)));
const size = Number(params.get('size') ?? 256);
/** Saving is off in tests unless explicitly requested with ?persist=1. */
const persist = !testMode || params.has('persist');
/** Resume the autosave unless a specific or new world was requested. */
const resume = persist && !params.has('seed') && !params.has('new');
const AUTOSAVE = 'autosave';
/** Tests start paused so that their state is exactly reproducible. */
const initialSpeed = testMode ? 0 : 1;
const AUTOSAVE_MS = 60_000;
/** Phones: let the sim use at most ~45% of a core (battery, heat); ?duty= overrides. */
const duty = Number(params.get('duty') ?? (matchMedia('(pointer: coarse)').matches ? 0.45 : 1));

async function startClient(): Promise<{ client: SimClient; data: ReadyData }> {
  if (resume) {
    const saved = await readSave(AUTOSAVE);
    if (saved) {
      const client = new SimClient({ bytes: saved.bytes, speed: initialSpeed, duty });
      try {
        return { client, data: await client.ready };
      } catch (e) {
        console.warn('Could not resume the saved world, starting a new one.', e);
        client.dispose();
      }
    }
  }
  const client = new SimClient({ seed, size, speed: initialSpeed, duty });
  return { client, data: await client.ready };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui')!;
  const { client, data } = await startClient();
  if (params.has('new')) history.replaceState(null, '', location.pathname);
  const mirror = new WorldMirror(data);

  const renderer = new GameRenderer(canvas, data, { followSimTime: true });
  renderer.camera.focus(data.info.startX, data.info.startY);
  const cameraInput = attachCameraInput(canvas, renderer.camera);

  const vegetation = new VegetationLayer(renderer.scene, renderer.heights, data.look, data.info.width, data.info.height, seed, {
    sunDir: renderer.sky.state.dir,
  });
  if (data.revealed) vegetation.setRevealed(data.revealed);
  // People come from the sim. Until herders exist (M3-δ), a main-thread
  // "fake crowd" of grazing animals adds ambient life; its latest frame is
  // merged into every snapshot's entities.
  const crowd = new CrowdLayer(renderer.scene, renderer.heights, { camera: renderer.camera.camera });
  // Created on the first snapshot, once water depths are known.
  let fakeCrowd: FakeCrowd | null = null;
  const fishJumps = new FishJumps(renderer.scene, renderer.heights);
  fishJumps.known = (x, y) => !renderer.fog.enabled || renderer.fog.at(x, y) >= 200;
  renderer.addFrameListener((dt, now) => {
    fakeCrowd?.advance(dt);
    crowd.update(dt, now);
    const cam = renderer.camera.getCurrentState();
    fishJumps.update(dt, cam.x, cam.y, cam.viewHeight);
  });

  const hud = new Hud(uiRoot, (s) => client.setSpeed(s), params.has('stats'));
  const tools = new ToolPalette(uiRoot, {
    canvas,
    mirror,
    pick: (x, y) => renderer.pick(x, y),
    setPreviewPlan: (cells) => renderer.setPreviewPlan(cells),
    setCameraPrimaryPointer: (on) => cameraInput.setPrimaryPointerEnabled(on),
    command: (cmd) => client.command(cmd),
  });

  let lookCounter = 0;
  let season = 0;
  client.onSnapshot((s) => {
    mirror.apply(s);
    renderer.applySnapshot(s);
    fakeCrowd ??= new FakeCrowd(renderer.heights, {
      seed,
      centerX: data.info.startX,
      centerY: data.info.startY,
      look: data.look,
      people: 0,
      dogs: 0,
    });
    crowd.setFrame(hideInFog(mergeFrames(s.entities, fakeCrowd.frame()), renderer), performance.now());
    hud.update(s);
    const v = s.stats.village;
    if (v) tools.setPopulation(v.peak ?? v.population);
    if (s.revealed) vegetation.setRevealed(s.revealed);
    if (s.plan) tools.planUpdated();
    if (s.terrain) vegetation.invalidate(0, s.terrain.y0, data.info.width, s.terrain.y1);
    if (s.fields) vegetation.setFields(s.fields);
    if (s.fish) fishJumps.setFish(s.fish);
    if (s.time.season !== season) {
      season = s.time.season;
      vegetation.setSeason(season);
    }
    // Re-scatter vegetation occasionally; it changes slowly.
    if (s.look && ++lookCounter % 20 === 0) vegetation.update(s.look);
  });

  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    hud.frame(dt);
    renderer.frame(now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.addEventListener('resize', () => renderer.resize());

  const autosave = async () => {
    if (!persist) return;
    const bytes = await client.save();
    await writeSave(AUTOSAVE, bytes, { savedAt: Date.now(), seed: data.info.seed, day: client.latest?.time.day ?? 0 });
  };
  if (persist) setInterval(() => void autosave(), AUTOSAVE_MS);

  // Pause and save when hidden (battery; phones may kill the tab), resume at the previous speed.
  let speedBeforeHide = 1;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      speedBeforeHide = client.getSpeed();
      client.setSpeed(0);
      void autosave();
    } else {
      client.setSpeed(speedBeforeHide);
    }
  });

  // Welcome panels: first visit, and from the menu. The game waits meanwhile.
  const intro = new Intro(uiRoot);
  const showIntro = () => {
    const before = client.getSpeed();
    client.setSpeed(0);
    hud.setSpeed(0);
    intro.open(() => {
      client.setSpeed(before);
      hud.setSpeed(before);
    });
  };
  if (!testMode && !Intro.seen()) showIntro();

  new Menu(uiRoot, {
    howToPlay: showIntro,
    newWorld: () => {
      location.search = '?new=1';
    },
    exportSave: async () => {
      const bytes = await client.save();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      a.download = `hydro-${data.info.seed}-day${client.latest?.time.day ?? 0}.hydro`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    },
    importSave: async (file) => {
      const bytes = await file.arrayBuffer();
      await writeSave(AUTOSAVE, bytes, { savedAt: Date.now(), seed: 0, day: 0 });
      location.search = '';
    },
  });

  if (testMode) {
    client.setSpeed(0);
    hud.setSpeed(0);
    (window as unknown as { __hydro: unknown }).__hydro = { client, renderer, mirror, tools, data, autosave, crowd, fakeCrowd: () => fakeCrowd, showIntro };
  }
  document.getElementById('loading')?.classList.add('done');
}

if (params.has('bench')) {
  void import('./benchPage').then((m) => m.runBenchPage());
} else {
  main().catch(fail);
}

/** Drop entities standing on unknown land (they walk out of the fog, not on it). */
function hideInFog(f: EntityFrame, renderer: GameRenderer): EntityFrame {
  const fog = renderer.fog;
  if (!fog.enabled || f.count === 0) return f;
  let n = 0;
  for (let k = 0; k < f.count; k++) if (fog.known(f.pos[k * 5]!, f.pos[k * 5 + 1]!)) n++;
  if (n === f.count) return f;
  const id = new Uint16Array(n);
  const info = new Uint8Array(n * 4);
  const pos = new Float32Array(n * 5);
  let o = 0;
  for (let k = 0; k < f.count; k++) {
    if (!fog.known(f.pos[k * 5]!, f.pos[k * 5 + 1]!)) continue;
    id[o] = f.id[k]!;
    info.set(f.info.subarray(k * 4, k * 4 + 4), o * 4);
    pos.set(f.pos.subarray(k * 5, k * 5 + 5), o * 5);
    o++;
  }
  return { count: n, id, info, pos };
}

/** Concatenate two entity frames; ids of the second are offset to stay distinct. */
function mergeFrames(a: EntityFrame | undefined, b: EntityFrame): EntityFrame {
  if (!a || a.count === 0) return b;
  const n = a.count + b.count;
  const id = new Uint16Array(n);
  const info = new Uint8Array(n * 4);
  const pos = new Float32Array(n * 5);
  id.set(a.id.subarray(0, a.count));
  info.set(a.info.subarray(0, a.count * 4));
  pos.set(a.pos.subarray(0, a.count * 5));
  for (let k = 0; k < b.count; k++) id[a.count + k] = (b.id[k]! + 40000) & 0xffff;
  info.set(b.info.subarray(0, b.count * 4), a.count * 4);
  pos.set(b.pos.subarray(0, b.count * 5), a.count * 5);
  return { count: n, id, info, pos };
}

function fail(e: unknown): void {
  console.error(e);
  const el = document.getElementById('loading');
  if (el) el.innerHTML = `<p>Something went wrong: ${String(e)}</p>`;
}
