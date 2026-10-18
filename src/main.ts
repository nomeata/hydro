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
import { StatsBar } from './ui/statsbar';
import { HistoryPanel } from './ui/historyPanel';
import { AchievementsUi } from './ui/achievements';
import { ToolPalette } from './ui/tools';
import { ToolCards } from './ui/toolCards';
import { isUnlocked, setUnlockAll } from './shared/unlocks';
import { AreaHighlight } from './ui/areaHighlight';
import { heightToY } from './render/coords';
import * as THREE from 'three';
import { SoundSystem } from './audio/sound';
import { cameraView, setSoundSink } from './audio/bus';

const params = new URLSearchParams(location.search);
const testMode = params.has('test');
setUnlockAll(params.has('cheat'));
const seed = Number(params.get('seed') ?? (testMode ? 1 : Math.floor(Math.random() * 1e9)));
const size = Number(params.get('size') ?? 256);
/** Saving is off in tests unless explicitly requested with ?persist=1. */
const persist = !testMode || params.has('persist');
/** Resume the autosave unless a specific or new world was requested. */
const resume = persist && !params.has('seed') && !params.has('new');
const AUTOSAVE = 'autosave';
/** The welcome panels on a first visit: the game waits until they close. */
const introDue = !testMode && !Intro.seen();
/** Tests start paused so that their state is exactly reproducible; so does a first visit (the intro). */
const initialSpeed = testMode || introDue ? 0 : 1;
const AUTOSAVE_MS = 60_000;
/** Phones: let the sim use at most ~45% of a core (battery, heat); ?duty= overrides. */
const duty = Number(params.get('duty') ?? (matchMedia('(pointer: coarse)').matches ? 0.45 : 1));
/** Sound (docs/SOUND.md): on by default, starting at the first gesture; off in tests unless ?sound=1. */
const sound = new SoundSystem({ enabled: !testMode || params.has('sound'), base: import.meta.env.BASE_URL });
setSoundSink(sound);

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

  // Vegetation, people, their animals and fish (the village herds are sim
  // entities since M3-δ; only the welcome scenes add ambient animals).
  const layers = new WorldLayers(renderer, data, seed, null);
  sound.attachMain({ width: data.info.width, look: data.look, revealed: data.revealed, plan: data.plan }, () =>
    cameraView(renderer.camera.getCurrentState(), canvas.clientWidth, canvas.clientHeight),
  );
  layers.fishJumps.onSplash = (x, y) => sound.splash(x, y);
  // Soft clicks for the HUD's buttons; tools have their own.
  uiRoot.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b || b.closest('.menu-sound')) return;
    sound.ui(b.dataset.tool ? 'tool' : 'click');
  });

  const hud = new Hud(uiRoot, (s) => client.setSpeed(s), params.has('stats'));
  const historyPanel = new HistoryPanel(uiRoot, () => client.history());
  // Ideas for this valley: "Show me" glides there and rings the spot.
  const tmp = new THREE.Vector3();
  const highlight = new AreaHighlight(uiRoot, (x, y) => {
    const v = tmp.set(x + 0.5, heightToY(renderer.heights.terrainAt(x, y)), y + 0.5).project(renderer.camera.camera);
    if (v.z > 1) return null;
    const r = canvas.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  });
  let peak = 0;
  let menu: Menu | null = null;
  const intro = new Intro(uiRoot);
  // Tool cards at unlock (not in tests unless asked for with ?cards=1).
  const cards = new ToolCards(uiRoot);
  /** A dialog covers the game: achievement toasts and milestone notes wait. */
  const quiet = () => intro.isOpen || cards.isOpen;
  const achievements = new AchievementsUi(uiRoot, {
    seed: data.info.seed,
    unlocked: (t) => isUnlocked(t, peak),
    show: (idea) => {
      renderer.camera.focus(idea.x, idea.y);
      renderer.camera.setState({ viewHeight: Math.min(70, Math.max(26, idea.r * 5)) }, false);
      highlight.show(idea.x, idea.y, idea.r + 1);
    },
    news: (on) => menu?.setNews(on),
    quiet,
  });
  const statsBar = new StatsBar(uiRoot.querySelector('.topbar')!, () => historyPanel.open(), quiet);
  const cardsDue = !testMode || params.has('cards');
  const showCard = (tool: string) => {
    if (!ToolCards.has(tool) || intro.isOpen) return;
    const before = client.getSpeed();
    client.setSpeed(0);
    hud.setSpeed(0);
    cards.open(tool, () => {
      client.setSpeed(before);
      hud.setSpeed(before);
      statsBar.update(client.latest?.stats);
    });
  };
  const tools = new ToolPalette(uiRoot, {
    hasCard: (t) => ToolCards.has(t),
    cardDue: (t) => cardsDue && ToolCards.has(t) && !ToolCards.seen(t),
    showCard,
    canvas,
    mirror,
    pick: (x, y) => renderer.pick(x, y),
    setPreviewPlan: (cells) => renderer.setPreviewPlan(cells),
    setPreviewLining: (cells) => renderer.setPreviewLining(cells),
    depth: (i) => renderer.heights.depth[i] ?? 0,
    speed: (i) => renderer.flow.speed(i),
    setWheelGhost: (site, ok) => renderer.wheelPreview.setGhost(site, ok),
    setWheelSites: (sites) => renderer.wheelPreview.setSites(sites),
    setCameraPrimaryPointer: (on) => cameraInput.setPrimaryPointerEnabled(on),
    command: (cmd) => {
      client.command(cmd);
      sound.ui('place');
    },
  });

  client.onSnapshot((s) => {
    mirror.apply(s);
    sound.feedMain(s);
    renderer.applySnapshot(s);
    layers.applySnapshot(s);
    hud.update(s);
    statsBar.update(s.stats);
    achievements.update(s.achievements);
    const v = s.stats.village;
    if (v) tools.setPopulation(v.peak ?? v.population);
    const p = v ? (v.peak ?? v.population) : 0;
    if (s.ideas || p !== peak) {
      peak = p;
      achievements.updateIdeas(s.ideas);
    }
    if (s.plan || s.lining) tools.planUpdated();
  });

  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    hud.frame(dt);
    // The welcome panels cover the game (and render their own scenes).
    if (!intro.isOpen && !cards.isOpen) renderer.frame(now);
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
  const showIntro = (resumeAt?: number) => {
    const before = resumeAt ?? client.getSpeed();
    client.setSpeed(0);
    hud.setSpeed(0);
    intro.open(() => {
      client.setSpeed(before);
      hud.setSpeed(before);
      statsBar.update(client.latest?.stats);
    });
  };
  // A first visit started paused (initialSpeed); play begins when the panels close.
  if (introDue) showIntro(1);

  menu = new Menu(uiRoot, {
    howToPlay: () => showIntro(),
    achievements: () => achievements.panel.open(),
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
    sound,
  });
  achievements.updateIdeas();

  if (testMode) {
    client.setSpeed(0);
    hud.setSpeed(0);
    (window as unknown as { __hydro: unknown }).__hydro = { client, renderer, mirror, tools, data, autosave, crowd: layers.crowd, fakeCrowd: () => layers.fakeCrowd, showIntro, intro, cards, showCard, SimClient, statsBar, historyPanel, achievements, sound };
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
