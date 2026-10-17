/**
 * Weather: rain fronts drifting across the map with a slowly turning
 * prevailing wind. Precipitation is evaluated per tile for speed.
 */
import type { ClimateState, RainFront, SimTime } from '../../shared/protocol';
import type { Rng } from '../../shared/rng';
import { STEPS_PER_DAY, TILE } from '../constants';
import { PARAMS } from '../params';
import type { World } from '../world';
import { seaLevelTemperature } from './calendar';

interface Front extends RainFront {
  /** Velocity in cells per step. */
  vx: number;
  vy: number;
  /** Remaining lifetime in steps. */
  life: number;
  /** Peak intensity; actual intensity ramps up and down. */
  peak: number;
  age: number;
}

export interface WeatherState {
  windDir: number;
  windSpeed: number;
  fronts: Front[];
}

export class Weather {
  state: WeatherState;
  /** Precipitation rate per tile, metres per step (before orographic factor). */
  readonly tileRain: Float32Array;
  readonly tw: number;
  readonly th: number;
  /** Mean terrain elevation per tile (m), for orographic effect and temperature. */
  readonly tileElevation: Float32Array;
  /** Spawn random fronts (off in staged scenes, which place their own with `addFront`). */
  autoFronts = true;
  /** Per-tile rain factor from the generation climate (wetness, rain shadow; 1 = nominal). */
  readonly rainMap: Float32Array;
  /** Multiplier on the front frequency (the year's wetness, climate.ts). */
  frontFactor = 1;

  constructor(
    private readonly world: World,
    rng: Rng,
  ) {
    this.tw = Math.ceil(world.width / TILE);
    this.th = Math.ceil(world.height / TILE);
    this.tileRain = new Float32Array(this.tw * this.th);
    this.tileElevation = new Float32Array(this.tw * this.th);
    this.rainMap = new Float32Array(this.tw * this.th).fill(1);
    this.state = { windDir: rng.range(0, Math.PI * 2), windSpeed: 1, fronts: [] };
    this.updateElevation();
  }

  /** Recompute per-tile mean elevation (after big terrain changes). */
  updateElevation(): void {
    const { world, tw, th } = this;
    const { width: W, height: H } = world;
    this.tileElevation.fill(0);
    const counts = new Float32Array(tw * th);
    for (let y = 0; y < H; y++) {
      const ty = (y / TILE) | 0;
      for (let x = 0; x < W; x++) {
        const t = ty * tw + ((x / TILE) | 0);
        this.tileElevation[t]! += world.terrain(y * W + x);
        counts[t]! += 1;
      }
    }
    for (let t = 0; t < tw * th; t++) this.tileElevation[t]! /= Math.max(1, counts[t]!);
  }

  /** Advance weather by `steps` hydro steps and recompute the rain field. */
  advance(steps: number, time: SimTime, rng: Rng): void {
    const s = this.state;
    const { width: W, height: H } = this.world;
    // Prevailing wind slowly wanders.
    s.windDir += rng.normal() * 0.02 * Math.sqrt(steps / 60);
    s.windSpeed = 0.8 + 0.4 * Math.sin(time.yearFrac * Math.PI * 4);

    // Spawn new fronts upwind.
    const rate = PARAMS.frontsPerDay[time.season]! * this.frontFactor;
    const pSpawn = (rate * steps) / STEPS_PER_DAY;
    if (rng.next() < pSpawn && this.autoFronts) {
      const ext = Math.max(W, H);
      const dir = s.windDir + rng.range(-0.4, 0.4);
      const cellsPerStep = (s.windSpeed * rng.range(60, 140)) / STEPS_PER_DAY; // ~1 map per 2–4 days
      const vx = Math.cos(dir) * cellsPerStep;
      const vy = Math.sin(dir) * cellsPerStep;
      const cx = W / 2 - Math.cos(dir) * ext * 0.9 + rng.range(-0.4, 0.4) * ext * -Math.sin(dir);
      const cy = H / 2 - Math.sin(dir) * ext * 0.9 + rng.range(-0.4, 0.4) * ext * Math.cos(dir);
      const travel = (ext * 1.9) / cellsPerStep;
      s.fronts.push({
        x: cx,
        y: cy,
        rx: rng.range(0.25, 0.6) * ext,
        ry: rng.range(0.1, 0.25) * ext,
        angle: dir + Math.PI / 2,
        intensity: 0,
        snow: false,
        vx,
        vy,
        life: travel,
        peak: rng.range(0.4, 1.2),
        age: 0,
      });
    }

    const temp = seaLevelTemperature(time);
    for (const f of s.fronts) {
      f.x += f.vx * steps;
      f.y += f.vy * steps;
      f.age += steps;
      f.life -= steps;
      const total = f.age + f.life;
      const ramp = Math.min(1, f.age / (total * 0.2), f.life / (total * 0.2));
      f.intensity = Math.max(0, f.peak * ramp);
      f.snow = temp < 0.5;
    }
    s.fronts = s.fronts.filter((f) => f.life > 0);
    this.computeRainField();
  }

  /**
   * Add a front moving at (vx, vy) cells per step for `life` steps, peaking
   * at intensity `peak` (staged scenes; random fronts come from `advance`).
   */
  addFront(f: { x: number; y: number; rx: number; ry: number; angle: number; vx: number; vy: number; life: number; peak: number }): void {
    this.state.fronts.push({ ...f, intensity: 0, snow: false, age: 0 });
  }

  private computeRainField(): void {
    const { tw, th, tileRain, tileElevation, rainMap } = this;
    tileRain.fill(0);
    const base = PARAMS.rainPerDay / STEPS_PER_DAY;
    for (const f of this.state.fronts) {
      if (f.intensity <= 0) continue;
      const ca = Math.cos(f.angle);
      const sa = Math.sin(f.angle);
      for (let ty = 0; ty < th; ty++) {
        for (let tx = 0; tx < tw; tx++) {
          const px = (tx + 0.5) * TILE - f.x;
          const py = (ty + 0.5) * TILE - f.y;
          const u = (px * ca + py * sa) / f.rx;
          const v = (-px * sa + py * ca) / f.ry;
          const d2 = u * u + v * v;
          if (d2 >= 1) continue;
          const t = ty * tw + tx;
          const shape = (1 - d2) * (1 - d2);
          const oro = 1 + (PARAMS.orographicPer100m * Math.max(0, tileElevation[t]!)) / 100;
          tileRain[t]! += base * f.intensity * shape * oro * rainMap[t]!;
        }
      }
    }
  }

  climateState(time: SimTime): ClimateState {
    const s = this.state;
    return {
      temperature: seaLevelTemperature(time),
      windDir: s.windDir,
      windSpeed: s.windSpeed,
      fronts: s.fronts.map(({ x, y, rx, ry, angle, intensity, snow }) => ({ x, y, rx, ry, angle, intensity, snow })),
    };
  }
}
