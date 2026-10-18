/**
 * Live illustrations for the welcome panels: a second simulation worker runs
 * a staged scene (sim/scenes.ts) and a GameRenderer with the game's own
 * layers draws it on the dialog's canvas, from a fixed camera. Each scene
 * plays a short scripted timeline and restarts. One WebGL context and one
 * worker serve all panels; `dispose` releases both.
 */
import * as THREE from 'three';
import { SimClient } from '../client/simClient';
import { WorldMirror } from '../client/mirror';
import type { CameraState } from '../render/camera';
import { heightToY } from '../render/coords';
import { GameRenderer } from '../render/renderer';
import { WorldLayers, type AnimalOptions } from '../render/worldLayers';
import type { Pt, SceneId, Snapshot } from '../shared/protocol';
import { planTrench } from '../sim/plans/plans';
import { SCENE_LAYOUT as L } from '../sim/sceneLayout';
import { ICONS } from './icons';
import { cameraView, sound } from '../audio/bus';

const DEG = Math.PI / 180;
/** Trench the hand draws (the real tool's defaults would be 2 wide; a bit wider reads better). */
const TRENCH = { width: 3, depth: 1.5 };

interface Script {
  camera: Partial<CameraState>;
  /** Simulation speed (× real time at 1×). */
  speed: number;
  /** Seconds until the scene restarts. */
  duration: number;
  animals?: AnimalOptions;
  fishRate?: number;
  /** Keep clouds visible at this zoom (WeatherLayer.zoomBias). */
  clouds?: number;
}

const SCRIPTS: Record<SceneId, Script> = {
  water: { camera: { x: 46, y: 42, yaw: 45 * DEG, pitch: 30 * DEG, viewHeight: 30 }, speed: 3, duration: 11, clouds: 2.8 },
  shape: { camera: { x: 58, y: 51, yaw: -39 * DEG, pitch: 38 * DEG, viewHeight: 22 }, speed: 3, duration: 13 },
  village: {
    camera: { x: 34, y: 71, yaw: 25 * DEG, pitch: 38 * DEG, viewHeight: 13 },
    speed: 2,
    duration: 14,
    animals: { centerX: 26, centerY: 81, radius: 5, cows: 3, chicks: 4, pigs: 1, dogs: 1, searchRadius: 3 },
    fishRate: 8,
  },
  // Tool cards (toolCards.ts).
  weir: { camera: { x: 27, y: 41, yaw: 40 * DEG, pitch: 36 * DEG, viewHeight: 20 }, speed: 3, duration: 14 },
  gate: { camera: { x: 77, y: 69, yaw: -20 * DEG, pitch: 40 * DEG, viewHeight: 16 }, speed: 3, duration: 16 },
  wheel: { camera: { x: 71, y: 84, yaw: -30 * DEG, pitch: 34 * DEG, viewHeight: 9 }, speed: 3, duration: 16 },
  turbine: { camera: { x: 31, y: 41, yaw: 40 * DEG, pitch: 36 * DEG, viewHeight: 11 }, speed: 3, duration: 14 },
  poles: { camera: { x: 29, y: 60, yaw: 30 * DEG, pitch: 40 * DEG, viewHeight: 27 }, speed: 3, duration: 14 },
  pump: { camera: { x: 72, y: 70, yaw: -20 * DEG, pitch: 40 * DEG, viewHeight: 24 }, speed: 3, duration: 16 },
};

/** Timeline of the 'shape' scene (seconds). */
const T_TAP = 1.3;
const T_DRAW = 2.0;
const T_RELEASE = 4.4;
const T_GONE = 5.4;

export class IntroScenes {
  /** Called once the first live frame is on screen (the SVG fallback can go). */
  onLive: (() => void) | null = null;
  /** Called when the live scenes cannot run (no WebGL, worker failure). */
  onFail: (() => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLElement;
  private readonly hand: HTMLElement;
  private readonly palette: HTMLElement;
  private readonly client: SimClient;
  private renderer: GameRenderer | null = null;
  private layers: WorldLayers | null = null;
  private mirror: WorldMirror | null = null;
  private scene: SceneId;
  /** Run id of the scene we want, and of the state currently shown. */
  private wantRun = 0;
  private shownRun = -1;
  private runStart = 0;
  private restartAt = 0;
  private live = false;
  private disposed = false;
  private raf = 0;
  /** 'shape' timeline state. */
  private drew = false;
  private previewAt = 0;
  private awaitingPlan = false;
  private readonly onResize = () => this.renderer?.resize();
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly container: HTMLElement,
    first: SceneId,
  ) {
    this.scene = first;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'intro-live';
    this.overlay = document.createElement('div');
    this.overlay.className = 'intro-overlay';
    this.hand = document.createElement('div');
    this.hand.className = 'intro-hand';
    this.hand.innerHTML = ICONS.hand;
    // A piece of the real tool palette (same markup and styles as ui/tools.ts).
    this.palette = document.createElement('div');
    this.palette.className = 'toolrow panel intro-tools';
    for (const [id, label] of [
      ['look', 'Look'],
      ['trench', 'Trench'],
      ['dike', 'Dike'],
    ] as const) {
      const b = document.createElement('button');
      b.tabIndex = -1;
      b.dataset.tool = id;
      b.innerHTML = `${ICONS[id === 'look' ? 'hand' : id]}<span>${label}</span>`;
      this.palette.append(b);
    }
    this.overlay.append(this.palette, this.hand);
    container.append(this.canvas, this.overlay);

    const coarse = matchMedia('(pointer: coarse)').matches;
    // Paused until the renderer is up (then `restart` sets the scene's speed).
    this.client = new SimClient({ scene: first, speed: 0, duty: coarse ? 0.45 : 1 });
    this.wantRun = this.client.sceneRun;
    this.client.ready.then(
      (data) => {
        if (this.disposed) return;
        try {
          this.renderer = new GameRenderer(this.canvas, data, { pixelRatio: Math.min(devicePixelRatio || 1, 1.5), shadows: false });
        } catch (e) {
          console.warn('Welcome scenes: no WebGL, keeping the drawings.', e);
          this.fail();
          return;
        }
        this.mirror = new WorldMirror(data);
        this.layers = new WorldLayers(this.renderer, data, data.info.seed, null);
        this.layers.fishJumps.onSplash = (x, y) => sound.sceneSplash(x, y);
        this.renderer.setSun(0.56, 1.2);
        this.client.onSnapshot((s) => this.onSnapshot(s));
        // The scene ran on while the renderer started up: begin it afresh.
        this.restart();
        window.addEventListener('resize', this.onResize);
        this.raf = requestAnimationFrame(this.frame);
      },
      (e) => {
        console.warn('Welcome scenes: the scene worker failed, keeping the drawings.', e);
        this.fail();
      },
    );
  }

  /** Show a scene (restarting it from the beginning). */
  show(id: SceneId): void {
    if (this.disposed) return;
    this.scene = id;
    this.restart();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    sound.sceneEnd();
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.client.dispose();
    this.layers?.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      // Free the context now rather than whenever the GC gets to it.
      this.renderer.gl.forceContextLoss();
    }
    this.layers = null;
    this.renderer = null;
    this.canvas.remove();
    this.overlay.remove();
  }

  private fail(): void {
    if (this.disposed) return;
    const cb = this.onFail;
    this.dispose();
    cb?.();
  }

  private restart(): void {
    this.container.classList.remove('live-on');
    this.wantRun = this.client.scene(this.scene, SCRIPTS[this.scene].speed);
    this.restartAt = 0;
    this.resetScript();
  }

  private resetScript(): void {
    this.drew = false;
    this.awaitingPlan = false;
    this.renderer?.setPreviewPlan(null);
    this.hand.style.opacity = '0';
    this.palette.hidden = this.scene !== 'shape';
    this.pressTool('look');
  }

  private onSnapshot(s: Snapshot): void {
    const r = this.renderer;
    if (!r || !this.layers || !this.mirror) return;
    // Drop states of scenes we have already left.
    if (s.sceneRun !== this.wantRun) return;
    const first = this.shownRun !== this.wantRun;
    if (first) {
      this.shownRun = this.wantRun;
      const sc = SCRIPTS[this.scene];
      r.camera.setState(sc.camera, true);
      this.layers.setAnimals(sc.animals ?? null);
      this.layers.fishJumps.rateScale = sc.fishRate ?? 1;
      r.weather.zoomBias = sc.clouds ?? 1;
      this.resetScript();
      this.runStart = performance.now();
    }
    this.mirror.apply(s);
    // The scene's own soft ambience, from its camera (audio/bus.ts).
    sound.scene(s, cameraView(r.camera.getCurrentState(), this.canvas.clientWidth, this.canvas.clientHeight), r.info.width);
    r.applySnapshot(s);
    this.layers.applySnapshot(s);
    if (s.plan && this.awaitingPlan) {
      this.awaitingPlan = false;
      r.setPreviewPlan(null);
    }
    if (first) {
      // Let a frame or two render, then fade in.
      setTimeout(() => {
        if (this.disposed || this.shownRun !== this.wantRun) return;
        this.container.classList.add('live-on');
        if (!this.live) {
          this.live = true;
          this.onLive?.();
        }
      }, 120);
    }
  }

  private readonly frame = (now: number): void => {
    if (this.disposed || !this.renderer) return;
    this.raf = requestAnimationFrame(this.frame);
    if (this.shownRun === this.wantRun) {
      const t = (now - this.runStart) / 1000;
      const sc = SCRIPTS[this.scene];
      if (this.scene === 'shape') this.shapeScript(t);
      if (t > sc.duration && !this.restartAt) {
        // Fade out, then start over.
        this.container.classList.remove('live-on');
        this.restartAt = now + 350;
      }
    }
    if (this.restartAt && now >= this.restartAt) this.restart();
    this.renderer.frame(now);
  };

  // ---------------------------------------------------------------------------
  // 'You shape the water': the hand picks the trench tool and draws a trench.

  private shapeScript(t: number): void {
    const hand = this.hand.style;
    const pts = L.trench;
    const start = this.toScreen(pts[0]!);
    const btn = this.palette.querySelector<HTMLElement>('[data-tool=trench]')!;
    const cr = this.canvas.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const tool: [number, number] = [br.left + br.width / 2 - cr.left, br.top + br.height * 0.4 - cr.top];
    const rest: [number, number] = [tool[0] + cr.width * 0.18, tool[1] - cr.height * 0.25];
    let p: [number, number];
    let press = false;
    if (t < T_TAP - 0.5) {
      p = rest;
    } else if (t < T_TAP) {
      p = lerp2(rest, tool, ease((t - (T_TAP - 0.5)) / 0.5));
    } else if (t < T_DRAW) {
      const k = (t - T_TAP) / (T_DRAW - T_TAP);
      press = k < 0.25;
      if (k >= 0.15) this.pressTool('trench');
      p = lerp2(tool, start, ease(Math.max(0, (k - 0.25) / 0.75)));
    } else if (t < T_RELEASE) {
      press = true;
      const k = (t - T_DRAW) / (T_RELEASE - T_DRAW);
      const drawn = partialPath(pts, ease(k));
      p = this.toScreen(drawn[drawn.length - 1]!);
      if (t - this.previewAt > 0.08 || t < this.previewAt) {
        this.previewAt = t;
        this.preview(drawn);
      }
    } else {
      if (!this.drew) {
        this.drew = true;
        this.preview(pts);
        this.awaitingPlan = true;
        this.client.command({ type: 'planTrench', points: pts, width: TRENCH.width, depth: TRENCH.depth });
        // One stroke per tool use, as in the game: back to looking.
        this.pressTool('look');
        // Let the water come quickly.
        this.client.setSpeed(4);
      }
      const end = this.toScreen(pts[pts.length - 1]!);
      const k = Math.min(1, (t - T_RELEASE) / (T_GONE - T_RELEASE));
      p = lerp2(end, [end[0] + cr.width * 0.12, end[1] + cr.height * 0.12], ease(k));
    }
    const fadeIn = Math.min(1, t / 0.4);
    const fadeOut = 1 - Math.min(1, Math.max(0, (t - T_RELEASE - 0.3) / (T_GONE - T_RELEASE - 0.3)));
    hand.opacity = String(Math.min(fadeIn, fadeOut));
    hand.transform = `translate(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px) scale(${press ? 0.88 : 1})`;
  }

  private pressTool(id: string): void {
    for (const b of this.palette.querySelectorAll<HTMLElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.tool === id));
  }

  /** The real tool preview: planTrench on a copy of the mirrored world. */
  private preview(points: Pt[]): void {
    if (!this.mirror || !this.renderer) return;
    const grid = this.mirror.previewGrid();
    planTrench(grid, points, TRENCH.width, TRENCH.depth);
    this.renderer.setPreviewPlan(grid.plan);
  }

  /** Canvas CSS pixel position of a cell point on the ground. */
  private toScreen(p: Pt): [number, number] {
    const r = this.renderer!;
    const v = this.tmp.set(p[0] + 0.5, heightToY(r.heights.terrainAt(p[0], p[1])), p[1] + 0.5).project(r.camera.camera);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
  }
}

function ease(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
}

function lerp2(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** The first fraction `f` of a polyline (by length). */
function partialPath(pts: readonly Pt[], f: number): Pt[] {
  let total = 0;
  for (let k = 0; k + 1 < pts.length; k++) total += Math.hypot(pts[k + 1]![0] - pts[k]![0], pts[k + 1]![1] - pts[k]![1]);
  let left = Math.max(0.01, f) * total;
  const out: Pt[] = [pts[0]!];
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k]!;
    const b = pts[k + 1]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (left >= l) {
      out.push(b);
      left -= l;
      continue;
    }
    const u = left / l;
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
    break;
  }
  return out;
}
