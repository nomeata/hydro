/**
 * The Web Audio graph (docs/SOUND.md): procedural ambient layers (noise
 * through filters, slowly modulated), sample and synthesised spot sounds
 * with stereo pan, UI sounds, a gentle compressor and the master volume.
 *
 * Works on any BaseAudioContext, so the same graph renders in real time in
 * the game and offline for review (tools/sound-review.ts). Every change is
 * scheduled at an explicit time with smooth ramps (no clicks).
 */
import { LAYER_IDS, type Layers, type SpotEvent } from './mix';

/** The recorded samples (public/audio/*.mp3, CC0; see CREDITS.md there). */
export const SAMPLE_NAMES = ['chop', 'creak1', 'creak2', 'hammer1', 'hammer2', 'dig1', 'dig2', 'moo', 'baa', 'birds'] as const;
export type SampleName = (typeof SAMPLE_NAMES)[number];
export type Samples = Partial<Record<SampleName, AudioBuffer>>;

export type UiSound = 'click' | 'tool' | 'place' | 'chime' | 'fanfare';

/** What the engine plays for one mixing tick. */
export interface MixFrame {
  layers: Layers;
  pans: { river: number; lake: number; rapids: number };
  spots: SpotEvent[];
  ui?: UiSound[];
}

/**
 * Full-scale gain of each ambient layer (a layer gain of 1 from the mixer).
 * Chosen by ear-less reasoning and checked with tools/sound-review.ts:
 * the beds sit around −30…−22 dBFS RMS, spots peak a few dB above.
 */
export const LAYER_LEVEL: Layers = {
  river: 0.5,
  lake: 0.45,
  rapids: 0.32,
  rain: 0.3,
  wind: 0.55,
  birds: 0,
  crickets: 0.022,
  frogs: 0,
  hum: 0.05,
};

/** Spot sound levels (before distance gain). */
export const SPOT_LEVEL: Record<SpotEvent['kind'], number> = {
  hammer: 0.5,
  chop: 0.45,
  dig: 0.4,
  moo: 0.25,
  baa: 0.3,
  peep: 0.05,
  creak: 0.45,
  splash: 0.22,
  bird: 0.9,
  frog: 0.1,
};

/** Time constant (s) of the layer gain ramps. */
const RAMP = 0.7;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Make a loop seamless: the last `fade` samples of `src` (length n + fade) crossfade into the start. */
function loopify(src: Float32Array, n: number, fade: number): Float32Array {
  const out = src.subarray(0, n);
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    out[i] = src[i]! * w + src[n + i]! * (1 - w);
  }
  return out;
}

function normalise(a: Float32Array, peak = 0.9): void {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]!));
  if (m > 0) for (let i = 0; i < a.length; i++) a[i]! *= peak / m;
}

/** Pink noise (Paul Kellet's filter), seamlessly looping. */
export function pinkNoise(n: number, seed: number): Float32Array {
  const fade = 2048;
  const r = rng(seed);
  const a = new Float32Array(n + fade);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < a.length; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    a[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  const out = loopify(a, n, fade);
  normalise(out, 0.7);
  return out;
}

/** Brown (red) noise with a leak (no DC drift), seamlessly looping. */
export function brownNoise(n: number, seed: number): Float32Array {
  const fade = 4096;
  const r = rng(seed);
  const a = new Float32Array(n + fade);
  let v = 0;
  for (let i = 0; i < a.length; i++) {
    v = v * 0.985 + (r() * 2 - 1) * 0.1;
    a[i] = v;
  }
  const out = loopify(a, n, fade);
  normalise(out, 0.8);
  return out;
}

/** Smooth random wobble in −1..1 with a new value every `step` samples (cosine interpolated), looping. */
export function slowNoise(n: number, step: number, seed: number): Float32Array {
  const r = rng(seed);
  const k = Math.max(2, Math.round(n / step));
  const pts = Array.from({ length: k }, () => r() * 2 - 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f = (i / n) * k;
    const j = Math.floor(f);
    const t = (1 - Math.cos((f - j) * Math.PI)) / 2;
    out[i] = pts[j % k]! * (1 - t) + pts[(j + 1) % k]! * t;
  }
  return out;
}

/** Lapping waves: soft irregular swells 0..1, one every 1.6–3.4 s. */
export function lapEnvelope(n: number, rate: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n);
  let t = 0;
  while (t < n) {
    const len = Math.round((1.6 + r() * 1.8) * rate);
    const amp = 0.45 + r() * 0.55;
    const end = Math.min(n, t + len);
    for (let i = t; i < end; i++) {
      const p = (i - t) / len;
      // Quick rise, slow fall: a wave slapping and draining.
      const e = p < 0.25 ? Math.sin((p / 0.25) * Math.PI / 2) : Math.cos(((p - 0.25) / 0.75) * Math.PI / 2);
      out[i] = amp * e * e;
    }
    t = end;
  }
  return out;
}

/** Cricket chirps: groups of three 18 ms pulses, a group every ~0.5 s, 0..1. */
export function chirpEnvelope(n: number, rate: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n);
  let t = Math.round(0.1 * rate);
  while (t < n) {
    for (let p = 0; p < 3; p++) {
      const s = t + Math.round(p * 0.042 * rate);
      const len = Math.round(0.018 * rate);
      for (let i = 0; i < len && s + i < n; i++) out[s + i] = Math.sin((i / len) * Math.PI) ** 2;
    }
    t += Math.round((0.42 + r() * 0.2) * rate);
  }
  return out;
}

/** Rain drops: soft tiny ticks (decaying sine bursts), ~70/s. */
export function dropsBuffer(n: number, rate: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n);
  const count = Math.round((n / rate) * 70);
  for (let k = 0; k < count; k++) {
    const t = Math.floor(r() * n);
    const f = 2200 + r() * 3500;
    const amp = 0.15 + r() * r() * 0.85;
    const len = Math.round(0.012 * rate);
    for (let i = 0; i < len; i++) {
      const j = (t + i) % n;
      const env = Math.exp(-i / (0.0025 * rate)) * Math.min(1, i / 8);
      out[j]! += amp * env * Math.sin((2 * Math.PI * f * i) / rate);
    }
  }
  normalise(out, 0.8);
  return out;
}

interface Layer {
  gain: GainNode;
  pan?: StereoPannerNode;
}

export class AudioEngine {
  /** User volume (and mute). */
  readonly master: GainNode;
  private readonly ctx: BaseAudioContext;
  private readonly mix: GainNode;
  private readonly spotBus: GainNode;
  private readonly uiBus: GainNode;
  private readonly layers = {} as Record<keyof Layers, Layer>;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly white: AudioBuffer;
  private samples: Samples = {};
  private started = false;
  private alt = 0;
  /**
   * End times of the spot voices playing (or scheduled), to cap the
   * polyphony on phones. Time-based, so it works offline too (where
   * `ended` events only come after rendering).
   */
  private ends: number[] = [];
  private readonly rand = rng(7);

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    const sr = ctx.sampleRate;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    // A gentle glue compressor as a safety net (it should rarely act).
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.3;
    this.mix = ctx.createGain();
    this.mix.connect(comp).connect(this.master).connect(ctx.destination);
    const ambBus = ctx.createGain();
    ambBus.connect(this.mix);
    this.spotBus = ctx.createGain();
    this.spotBus.connect(this.mix);
    this.uiBus = ctx.createGain();
    this.uiBus.connect(this.mix);

    const buf = (data: Float32Array, rate = sr) => {
      const b = ctx.createBuffer(1, data.length, rate);
      b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      return b;
    };
    const pinkA = buf(pinkNoise(sr * 5, 1));
    const pinkB = buf(pinkNoise(sr * 6, 2));
    const brown = buf(brownNoise(sr * 7, 3));
    this.white = pinkA;
    const LR = 8000;
    const wobble = buf(slowNoise(LR * 24, LR * 0.8, 4), LR);
    const loop = (b: AudioBuffer, rate = 1, offset = 0) => {
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.loop = true;
      s.playbackRate.value = rate;
      this.sources.push(s);
      (s as unknown as { _offset: number })._offset = offset;
      return s;
    };
    const filter = (type: BiquadFilterType, f: number, q = 0.707) => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      return n;
    };
    const gain = (v: number) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    /** A slow LFO (−1..1 × depth) added onto a parameter. */
    const lfo = (param: AudioParam, depth: number, rate: number, offset: number) => {
      loop(wobble, rate, offset).connect(gain(depth)).connect(param);
    };
    const layer = (id: keyof Layers, pan: boolean): Layer => {
      const g = gain(0);
      let p: StereoPannerNode | undefined;
      if (pan) {
        p = ctx.createStereoPanner();
        p.connect(g);
      }
      g.connect(ambBus);
      const l = { gain: g, pan: p };
      this.layers[id] = l;
      return l;
    };
    const into = (l: Layer) => l.pan ?? l.gain;

    const pinkSrcA = loop(pinkA, 1, 0);
    const pinkSrcB = loop(pinkB, 1, 1.3);
    const brownSrc = loop(brown, 1, 0);

    // River: a low body of brown noise and a babbling, gurgling band of pink noise.
    const river = layer('river', true);
    const body = filter('lowpass', 800, 0.5);
    brownSrc.connect(filter('highpass', 160, 0.6)).connect(body).connect(gain(0.9)).connect(into(river));
    const babble = filter('bandpass', 1300, 1.3);
    lfo(babble.frequency, 380, 2.2, 3);
    const babbleGain = gain(0.5);
    lfo(babbleGain.gain, 0.3, 3.1, 11);
    pinkSrcA.connect(babble).connect(babbleGain).connect(into(river));

    // Lake: low lapping swells.
    const lake = layer('lake', true);
    const lapLp = filter('lowpass', 420, 0.6);
    const lapGain = gain(0.05);
    const lap = buf(lapEnvelope(LR * 23, LR, 5), LR);
    loop(lap, 1, 0).connect(lapGain.gain);
    brownSrc.connect(filter('highpass', 90, 0.6)).connect(lapLp).connect(lapGain).connect(into(lake));
    const lapHi = filter('bandpass', 900, 0.8);
    const lapHiGain = gain(0);
    loop(lap, 1, 0).connect(gain(0.35)).connect(lapHiGain.gain);
    pinkSrcB.connect(lapHi).connect(lapHiGain).connect(into(lake));

    // Rapids / weir spill: broad rushing noise.
    const rapids = layer('rapids', true);
    const rHp = filter('highpass', 300, 0.6);
    const rLp = filter('lowpass', 4200, 0.6);
    const rGain = gain(0.85);
    lfo(rGain.gain, 0.15, 1.7, 5);
    pinkSrcB.connect(rHp).connect(rLp).connect(rGain).connect(into(rapids));

    // Rain: hiss plus soft drops.
    const rain = layer('rain', false);
    pinkSrcA.connect(filter('highpass', 1100, 0.6)).connect(filter('lowpass', 7000, 0.6)).connect(gain(0.8)).connect(into(rain));
    loop(buf(dropsBuffer(sr * 3, sr, 6)), 1, 0).connect(filter('highpass', 1500)).connect(gain(0.35)).connect(into(rain));

    // Wind: a slowly sweeping band with gusts.
    const wind = layer('wind', false);
    const wBand = filter('bandpass', 420, 0.9);
    lfo(wBand.frequency, 230, 0.23, 7);
    const gust = gain(0.55);
    lfo(gust.gain, 0.42, 0.11, 13);
    brownSrc.connect(filter('highpass', 120)).connect(wBand).connect(gust).connect(into(wind));

    // Crickets: two singers, sine tones gated by chirp patterns.
    const crickets = layer('crickets', false);
    for (const [f, rate, seed] of [
      [4400, 1, 8],
      [4730, 1.09, 9],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      const g = gain(0);
      loop(buf(chirpEnvelope(LR * 7, LR, seed), LR), rate, 0).connect(g.gain);
      osc.connect(g).connect(into(crickets));
      this.sources.push(osc);
    }

    // Turbine hum: a soft low tone with a little shimmer.
    const hum = layer('hum', false);
    const humLp = filter('lowpass', 500, 0.7);
    for (const [type, f, v] of [
      ['triangle', 98, 0.6],
      ['sine', 196.6, 0.35],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = f;
      osc.connect(gain(v)).connect(humLp);
      this.sources.push(osc);
    }
    const humMod = gain(0.8);
    lfo(humMod.gain, 0.15, 0.5, 2);
    humLp.connect(humMod).connect(into(hum));

    // Birds and frogs are spot sounds; their "layers" only exist for the mixer.
    this.layers.birds = { gain: gain(0) };
    this.layers.frogs = { gain: gain(0) };
  }

  setSamples(s: Samples): void {
    this.samples = s;
  }

  /** Start the ambient sources (once), at `at`. */
  start(at: number): void {
    if (this.started) return;
    this.started = true;
    for (const s of this.sources) {
      const off = (s as unknown as { _offset?: number })._offset ?? 0;
      if (s instanceof AudioBufferSourceNode) s.start(at, off % (s.buffer?.duration ?? 1));
      else s.start(at);
    }
  }

  /** Fade the master volume to v (0 = silent) from `at`. */
  setVolume(v: number, at: number, tau = 0.15): void {
    this.master.gain.setTargetAtTime(v, at, tau);
  }

  /** Play one mixing tick's worth at `at`. */
  apply(f: MixFrame, at: number): void {
    for (const id of LAYER_IDS) {
      const l = this.layers[id];
      l.gain.gain.setTargetAtTime(f.layers[id] * LAYER_LEVEL[id], at, RAMP);
    }
    this.layers.river.pan?.pan.setTargetAtTime(f.pans.river, at, 1);
    this.layers.lake.pan?.pan.setTargetAtTime(f.pans.lake, at, 1);
    this.layers.rapids.pan?.pan.setTargetAtTime(f.pans.rapids, at, 1);
    for (const e of f.spots) this.spot(e, at + e.delay);
    for (const u of f.ui ?? []) this.ui(u, at);
  }

  // -------------------------------------------------------------------------
  // Spot sounds.

  private out(gain: number, pan: number, at: number, attack = 0.004): GainNode {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + attack);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p).connect(this.spotBus);
    return g;
  }

  /** Play a sample (with a voice limit); returns false when not loaded. */
  private sample(name: SampleName, gain: number, pan: number, at: number, rate = 1, offset = 0, dur?: number, fade = 0): boolean {
    const b = this.samples[name];
    if (!b) return false;
    const len = dur ?? (b.duration - offset) / rate;
    if (!this.claim(at, at + len)) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate;
    const g = this.out(gain, pan, at, fade || 0.004);
    src.connect(g);
    if (fade > 0) {
      g.gain.setValueAtTime(gain, at + Math.max(fade, len - fade));
      g.gain.linearRampToValueAtTime(0, at + len);
    }
    src.start(at, offset);
    src.stop(at + len + 0.05);
    src.onended = () => g.disconnect();
    return true;
  }

  /** Room for one more voice from `at` to `end`? (At most 10 at a time.) */
  private claim(at: number, end: number): boolean {
    this.ends = this.ends.filter((e) => e > at);
    if (this.ends.length >= 10) return false;
    this.ends.push(end);
    return true;
  }

  spot(e: SpotEvent, at: number): void {
    const lv = SPOT_LEVEL[e.kind] * e.gain;
    const v = e.variant;
    const jitter = (k: number) => 1 + (this.rand() - 0.5) * k;
    switch (e.kind) {
      case 'hammer': {
        // A few taps of a mallet on wood.
        const n = 1 + Math.floor(v * 3);
        for (let k = 0; k < n; k++) this.sample(this.alt++ % 2 ? 'hammer1' : 'hammer2', lv * (k === 0 ? 1 : 0.85), e.pan, at + k * 0.46, jitter(0.12));
        break;
      }
      case 'chop': {
        const n = v < 0.6 ? 1 : 2;
        for (let k = 0; k < n; k++) this.sample('chop', lv, e.pan, at + k * 0.95, 0.9 * jitter(0.1));
        break;
      }
      case 'dig':
        this.sample(v < 0.5 ? 'dig1' : 'dig2', lv, e.pan, at, 0.75 * jitter(0.15));
        break;
      case 'moo':
        this.sample('moo', lv, e.pan, at, 0.92 + v * 0.14);
        break;
      case 'baa':
        this.sample('baa', lv, e.pan, at, 0.95 + v * 0.15);
        break;
      case 'creak':
        this.sample(v < 0.5 ? 'creak1' : 'creak2', lv, e.pan, at, 0.8 + v * 0.2);
        break;
      case 'bird': {
        const b = this.samples.birds;
        if (!b) break;
        const dur = 3 + v * 3.5;
        const off = this.rand() * Math.max(0, b.duration - dur - 0.1);
        this.sample('birds', lv, e.pan, at, 1, off, dur, 0.7);
        break;
      }
      case 'peep':
        for (let k = 0, n = 2 + Math.floor(v * 2); k < n; k++) this.peep(lv, e.pan, at + k * (0.16 + this.rand() * 0.08), 2700 + v * 700);
        break;
      case 'frog':
        this.croak(lv, e.pan, at, v);
        if (v > 0.55) this.croak(lv * 0.8, e.pan, at + 0.32, v);
        break;
      case 'splash':
        this.splash(lv, e.pan, at);
        break;
    }
  }

  private voice(at: number, end: number, nodes: AudioScheduledSourceNode[], out: GainNode): void {
    if (!this.claim(at, end)) {
      out.disconnect();
      return;
    }
    for (const n of nodes) {
      n.start(at);
      n.stop(end);
    }
    nodes[0]!.onended = () => out.disconnect();
  }

  /** A chick's peep: a quick upward sine sweep. */
  private peep(gain: number, pan: number, at: number, f: number): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(f, at);
    osc.frequency.exponentialRampToValueAtTime(f * 1.3, at + 0.07);
    const g = this.out(gain, pan, at, 0.008);
    g.gain.setTargetAtTime(0, at + 0.04, 0.02);
    osc.connect(g);
    this.voice(at, at + 0.2, [osc], g);
  }

  /** A frog's croak: a buzzy low pulse train through a resonance. */
  private croak(gain: number, pan: number, at: number, v: number): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 150 + v * 60;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 520 + v * 200;
    bp.Q.value = 3;
    const g = this.out(0, pan, at);
    // 7 pulses at ~26 Hz, each a soft bump.
    const n = 6 + Math.floor(v * 3);
    const pulse = 1 / 26;
    for (let k = 0; k < n; k++) {
      const t = at + k * pulse;
      const a = gain * (k === 0 ? 0.6 : 1) * (1 - (k / n) * 0.4);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(a, t + pulse * 0.3);
      g.gain.linearRampToValueAtTime(0, t + pulse * 0.9);
    }
    osc.connect(bp).connect(g);
    this.voice(at, at + n * pulse + 0.05, [osc], g);
  }

  /** A fish splash: a short falling swish of noise and a plip. */
  private splash(gain: number, pan: number, at: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(2400, at);
    bp.frequency.exponentialRampToValueAtTime(700, at + 0.18);
    const g = this.out(gain, pan, at, 0.006);
    g.gain.setTargetAtTime(0, at + 0.03, 0.06);
    src.connect(bp).connect(g);
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(950, at + 0.02);
    osc.frequency.exponentialRampToValueAtTime(420, at + 0.09);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, at);
    og.gain.linearRampToValueAtTime(0.35, at + 0.03);
    og.gain.setTargetAtTime(0, at + 0.05, 0.02);
    osc.connect(og).connect(g);
    this.voice(at, at + 0.45, [src, osc], g);
  }

  // -------------------------------------------------------------------------
  // UI sounds (not positional, not distance-scaled).

  private tone(f: number, at: number, gain: number, decay: number, type: OscillatorType = 'sine'): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.005);
    g.gain.setTargetAtTime(0, at + 0.006, decay);
    osc.connect(g).connect(this.uiBus);
    osc.start(at);
    osc.stop(at + 0.01 + decay * 7);
    osc.onended = () => g.disconnect();
  }

  /** A soft bell: fundamental plus an inharmonic partial. */
  private bell(f: number, at: number, gain: number, decay = 0.6): void {
    this.tone(f, at, gain, decay);
    this.tone(f * 2.76, at, gain * 0.18, decay * 0.4);
    this.tone(f * 5.4, at, gain * 0.05, decay * 0.2);
  }

  ui(kind: UiSound, at: number): void {
    switch (kind) {
      case 'click':
        // A soft wooden tock.
        this.tone(660, at, 0.06, 0.018, 'triangle');
        this.tone(1980, at, 0.015, 0.01);
        break;
      case 'tool':
        this.tone(520, at, 0.07, 0.025, 'triangle');
        this.tone(780, at + 0.06, 0.05, 0.03, 'triangle');
        break;
      case 'place':
        this.tone(330, at, 0.09, 0.05, 'triangle');
        this.tone(495, at + 0.07, 0.06, 0.07, 'triangle');
        break;
      case 'chime': {
        // C6 E6 G6 C7, gently.
        const notes = [1046.5, 1318.5, 1568, 2093];
        notes.forEach((f, k) => this.bell(f, at + k * 0.11, 0.05 - k * 0.004, 0.5));
        break;
      }
      case 'fanfare': {
        // A rising pentatonic phrase, a touch longer and warmer.
        const notes = [784, 880, 1046.5, 1174.7, 1568];
        notes.forEach((f, k) => this.bell(f, at + k * 0.13, 0.055, k === notes.length - 1 ? 0.9 : 0.45));
        break;
      }
    }
  }
}
