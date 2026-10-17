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
import { WorldLayers } from './render/worldLayers';
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

  // Vegetation, people and fish. Until herders exist (M3-δ), a main-thread
  // "fake crowd" of grazing animals adds ambient life.
  const layers = new WorldLayers(renderer, data, seed, { centerX: data.info.startX, centerY: data.info.startY, dogs: 0 });

  const hud = new Hud(uiRoot, (s) => client.setSpeed(s), params.has('stats'));
  const tools = new ToolPalette(uiRoot, {
    canvas,
    mirror,
    pick: (x, y) => renderer.pick(x, y),
    setPreviewPlan: (cells) => renderer.setPreviewPlan(cells),
    setCameraPrimaryPointer: (on) => cameraInput.setPrimaryPointerEnabled(on),
    command: (cmd) => client.command(cmd),
  });

  client.onSnapshot((s) => {
    mirror.apply(s);
    renderer.applySnapshot(s);
    layers.applySnapshot(s);
    hud.update(s);
    const v = s.stats.village;
    if (v) tools.setPopulation(v.peak ?? v.population);
    if (s.plan) tools.planUpdated();
  });

  const intro = new Intro(uiRoot);
  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    hud.frame(dt);
    // The welcome panels cover the game (and render their own scenes).
    if (!intro.isOpen) renderer.frame(now);
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
    (window as unknown as { __hydro: unknown }).__hydro = { client, renderer, mirror, tools, data, autosave, crowd: layers.crowd, fakeCrowd: () => layers.fakeCrowd, showIntro, intro, SimClient };
  }
  document.getElementById('loading')?.classList.add('done');
}

if (params.has('bench')) {
  void import('./benchPage').then((m) => m.runBenchPage());
} else {
  main().catch(fail);
}

function fail(e: unknown): void {
  console.error(e);
  const el = document.getElementById('loading');
  if (el) el.innerHTML = `<p>Something went wrong: ${String(e)}</p>`;
}
