/**
 * Bootstrap: start the simulation worker, build the renderer and UI, wire
 * snapshots to them, and expose a test hook with ?test=1.
 */
import './ui/styles.css';
import { SimClient } from './client/simClient';
import { WorldMirror } from './client/mirror';
import { GameRenderer } from './render/renderer';
import { attachCameraInput } from './render/camera';
import { VegetationLayer } from './render/objects/vegetation';
import { WandererLayer } from './render/objects/wanderers';
import { Hud } from './ui/hud';
import { ToolPalette } from './ui/tools';

const params = new URLSearchParams(location.search);
const testMode = params.has('test');
const seed = Number(params.get('seed') ?? (testMode ? 1 : Math.floor(Math.random() * 1e9)));
const size = Number(params.get('size') ?? 256);

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui')!;
  const client = new SimClient(seed, size);
  const data = await client.ready;
  const mirror = new WorldMirror(data);

  const renderer = new GameRenderer(canvas, data, { followSimTime: true });
  renderer.camera.focus(data.info.startX, data.info.startY);
  const cameraInput = attachCameraInput(canvas, renderer.camera);

  const vegetation = new VegetationLayer(renderer.scene, renderer.heights, data.look, data.info.width, data.info.height, seed);
  const wanderers = new WandererLayer(renderer.scene, renderer.heights, {
    count: 10,
    seed,
    centerX: data.info.startX,
    centerY: data.info.startY,
    radius: 14,
  });
  renderer.addFrameListener((dt) => wanderers.update(dt));

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
  client.onSnapshot((s) => {
    mirror.apply(s);
    renderer.applySnapshot(s);
    hud.update(s);
    if (s.plan) tools.planUpdated();
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

  // Pause when hidden (battery), resume at the previous speed.
  let speedBeforeHide = 1;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      speedBeforeHide = client.getSpeed();
      client.setSpeed(0);
    } else {
      client.setSpeed(speedBeforeHide);
    }
  });

  if (testMode) {
    client.setSpeed(0);
    hud.setSpeed(0);
    (window as unknown as { __hydro: unknown }).__hydro = { client, renderer, mirror, tools, data };
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
