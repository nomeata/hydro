/**
 * The sound system (docs/SOUND.md): one AudioContext, created at the first
 * user gesture (autoplay rules), samples fetched lazily then; a mixing tick
 * 4× a second from the latest snapshot and camera; mute and volume
 * persisted in localStorage; silent while the tab is hidden. The welcome
 * scenes feed their own snapshots (ui/introScenes.ts via audio/bus.ts).
 *
 * For review it records its mixing ticks and renders them offline through
 * the same graph (`renderOffline`, tools/sound-review.ts).
 */
import type { Snapshot } from '../shared/protocol';
import type { SoundSink } from './bus';
import { SoundDirector } from './director';
import { AudioEngine, SAMPLE_NAMES, type MixFrame, type Samples, type UiSound } from './engine';
import type { View } from './mix';

const KEY = 'hydro.sound';
const TICK_MS = 250;
/** A scene's feed counts as live this long after its last snapshot (s). */
const SCENE_LIVE = 1.5;

export interface SoundSettings {
  muted: boolean;
  /** 0..1 (the slider); the gain is its square. */
  volume: number;
}

export const DEFAULT_SETTINGS: SoundSettings = { muted: false, volume: 0.7 };

export function loadSettings(): SoundSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<SoundSettings>;
      return {
        muted: typeof s.muted === 'boolean' ? s.muted : DEFAULT_SETTINGS.muted,
        volume: typeof s.volume === 'number' && s.volume >= 0 && s.volume <= 1 ? s.volume : DEFAULT_SETTINGS.volume,
      };
    }
  } catch {
    // Storage blocked: defaults.
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s: SoundSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not persisted; fine.
  }
}

export interface RecordedTick {
  t: number;
  frame?: MixFrame;
  ui?: UiSound;
}

interface Feed {
  director: SoundDirector;
  view: () => View;
}

export class SoundSystem implements SoundSink {
  readonly enabled: boolean;
  private settings: SoundSettings;
  private ctx: AudioContext | null = null;
  private engine: AudioEngine | null = null;
  private samples: Samples = {};
  private loading: Promise<void> | null = null;
  private main: Feed | null = null;
  private sceneFeed: (Feed & { at: number; run: number; lastView: View }) | null = null;
  private last = performance.now();
  private recording: { t0: number; ticks: RecordedTick[] } | null = null;
  private readonly listeners = new Set<() => void>();
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: { enabled: boolean; base?: string }) {
    this.enabled = opts.enabled;
    this.base = opts.base ?? './';
    this.settings = loadSettings();
    if (!this.enabled) return;
    const unlock = () => {
      if (this.ctx || this.settings.muted) return;
      this.start();
    };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    document.addEventListener('visibilitychange', () => this.updateRunning());
    setInterval(() => this.tick(), TICK_MS);
  }

  private readonly base: string;

  get muted(): boolean {
    return this.settings.muted;
  }

  get volume(): number {
    return this.settings.volume;
  }

  /** Running audio (for tests): the context state, or 'none' before the first gesture. */
  get state(): string {
    return this.ctx?.state ?? 'none';
  }

  /** Notified when mute/volume change (the menu's controls). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setMuted(muted: boolean): void {
    this.settings.muted = muted;
    saveSettings(this.settings);
    // An unmute click is a user gesture: the first start may happen here.
    if (!muted && this.enabled && !this.ctx) this.start();
    this.updateRunning();
    for (const fn of this.listeners) fn();
  }

  setVolume(volume: number): void {
    this.settings.volume = Math.max(0, Math.min(1, volume));
    saveSettings(this.settings);
    this.updateRunning();
    for (const fn of this.listeners) fn();
  }

  private gain(): number {
    return this.settings.volume * this.settings.volume;
  }

  /** The main game: its world size, initial look/fog/plan and camera. */
  attachMain(init: { width: number; look?: Uint8Array; revealed?: Uint8Array | null; plan?: Float32Array }, view: () => View): void {
    this.main = { director: new SoundDirector(init), view };
  }

  feedMain(s: Snapshot): void {
    if (!this.enabled || !this.main) return;
    this.main.director.onSnapshot(s, this.main.view(), performance.now() / 1000);
  }

  splash(x: number, y: number): void {
    if (this.main) this.main.director.splash(this.main.view(), x, y);
  }

  scene(s: Snapshot, view: View, width: number): void {
    if (!this.enabled) return;
    const run = s.sceneRun ?? 0;
    // States of a scene run already left may still arrive: ignore them.
    if (this.sceneFeed && run < this.sceneFeed.run) return;
    if (!this.sceneFeed || this.sceneFeed.run !== run) {
      const director = new SoundDirector({ width });
      this.sceneFeed = { director, run, at: 0, lastView: view, view: () => this.sceneFeed!.lastView };
    }
    this.sceneFeed.lastView = view;
    this.sceneFeed.at = performance.now() / 1000;
    this.sceneFeed.director.onSnapshot(s, view, this.sceneFeed.at);
  }

  sceneSplash(x: number, y: number): void {
    const f = this.sceneFeed;
    if (f) f.director.splash(f.lastView, x, y);
  }

  sceneEnd(): void {
    this.sceneFeed = null;
  }

  ui(kind: UiSound): void {
    if (!this.enabled) return;
    if (this.recording) this.recording.ticks.push({ t: performance.now() / 1000 - this.recording.t0, ui: kind });
    if (this.engine && this.ctx?.state === 'running') this.engine.ui(kind, this.ctx.currentTime + 0.01);
  }

  private active(now: number): Feed | null {
    const sc = this.sceneFeed;
    if (sc && now - sc.at < SCENE_LIVE) return sc;
    return this.main;
  }

  private tick(): void {
    const nowMs = performance.now();
    const dt = Math.min(1, (nowMs - this.last) / 1000);
    this.last = nowMs;
    if (document.hidden) return;
    const now = nowMs / 1000;
    const feed = this.active(now);
    if (!feed) return;
    const frame = feed.director.tick(dt, feed.view(), now);
    if (this.recording) this.recording.ticks.push({ t: now - this.recording.t0, frame });
    if (this.engine && this.ctx?.state === 'running') this.engine.apply(frame, this.ctx.currentTime + 0.03);
  }

  private start(): void {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    try {
      this.ctx = new Ctx({ latencyHint: 'playback' });
    } catch (e) {
      console.warn('No audio:', e);
      return;
    }
    this.engine = new AudioEngine(this.ctx);
    this.engine.start(this.ctx.currentTime + 0.05);
    void this.ctx.resume?.();
    void this.loadSamples().then(() => this.engine?.setSamples(this.samples));
    this.updateRunning();
  }

  /** Fetch and decode the samples (once). Missing ones are skipped. */
  loadSamples(): Promise<void> {
    this.loading ??= (async () => {
      const decoder = new OfflineAudioContext(1, 1, 44100);
      await Promise.all(
        SAMPLE_NAMES.map(async (name) => {
          try {
            const r = await fetch(`${this.base}audio/${name}.mp3`);
            if (!r.ok) return;
            this.samples[name] = await decoder.decodeAudioData(await r.arrayBuffer());
          } catch (e) {
            console.warn(`Sound ${name} not loaded:`, e);
          }
        }),
      );
    })();
    return this.loading;
  }

  /** Mute, hidden tab: fade out and suspend (no CPU); otherwise resume and fade in. */
  private updateRunning(): void {
    const ctx = this.ctx;
    const engine = this.engine;
    if (!ctx || !engine) return;
    const on = !this.settings.muted && !document.hidden;
    if (this.suspendTimer) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    if (on) {
      void ctx.resume().then(() => engine.setVolume(this.gain(), ctx.currentTime, 0.25));
      engine.setVolume(this.gain(), ctx.currentTime, 0.25);
    } else {
      engine.setVolume(0, ctx.currentTime, 0.06);
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        if (this.settings.muted || document.hidden) void ctx.suspend();
      }, 400);
    }
  }

  // ---------------------------------------------------------------------------
  // Review: record the mixing ticks, render them offline through the same graph.

  startRecording(): void {
    this.recording = { t0: performance.now() / 1000, ticks: [] };
  }

  stopRecording(): RecordedTick[] {
    const r = this.recording?.ticks ?? [];
    this.recording = null;
    return r;
  }

  /** Render recorded ticks offline at the default volume; returns stereo PCM. */
  async renderOffline(ticks: readonly RecordedTick[], seconds: number, sampleRate = 44100, volume = DEFAULT_SETTINGS.volume): Promise<{ left: Float32Array; right: Float32Array; sampleRate: number }> {
    await this.loadSamples();
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    const engine = new AudioEngine(ctx);
    engine.setSamples(this.samples);
    engine.start(0);
    engine.setVolume(volume * volume, 0, 0.01);
    for (const t of ticks) {
      if (t.t >= seconds) continue;
      if (t.frame) engine.apply(t.frame, Math.max(0, t.t));
      if (t.ui) engine.ui(t.ui, Math.max(0, t.t));
    }
    const buf = await ctx.startRendering();
    return { left: buf.getChannelData(0), right: buf.getChannelData(1), sampleRate };
  }
}
