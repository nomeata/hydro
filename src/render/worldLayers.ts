/**
 * The object layers living on a GameRenderer's land: vegetation, people and
 * animals, jumping fish. Shared by the game (main.ts) and the welcome
 * scenes (ui/introScenes.ts), so both are wired the same way.
 */
import type { EntityFrame, Snapshot } from '../shared/protocol';
import { CrowdLayer } from './crowd/crowd';
import { FakeCrowd, type FakeCrowdOptions } from './crowd/fakeCrowd';
import { FishJumps } from './fishJumps';
import { VegetationLayer } from './objects/vegetation';
import type { GameRenderer, InitialData } from './renderer';

/** Ambient animals for the welcome scenes (the game's herds are sim entities): a FakeCrowd without people. */
export type AnimalOptions = Omit<FakeCrowdOptions, 'seed' | 'look' | 'people'>;

export class WorldLayers {
  readonly vegetation: VegetationLayer;
  readonly crowd: CrowdLayer;
  readonly fishJumps: FishJumps;
  /** Grazing animals merged into the entities; created on the first snapshot. */
  fakeCrowd: FakeCrowd | null = null;
  private animals: AnimalOptions | null;
  private readonly look: Uint8Array;
  private lookCounter = 0;
  private season = 0;
  private readonly unlisten: () => void;

  constructor(
    private readonly renderer: GameRenderer,
    data: InitialData,
    private readonly seed: number,
    animals: AnimalOptions | null,
  ) {
    const { width: W, height: H } = data.info;
    this.animals = animals;
    this.look = data.look;
    this.vegetation = new VegetationLayer(renderer.scene, renderer.heights, data.look, W, H, seed, {
      sunDir: renderer.sky.state.dir,
    });
    if (data.revealed) this.vegetation.setRevealed(data.revealed);
    this.crowd = new CrowdLayer(renderer.scene, renderer.heights, { camera: renderer.camera.camera });
    this.fishJumps = new FishJumps(renderer.scene, renderer.heights);
    this.fishJumps.known = (x, y) => !renderer.fog.enabled || renderer.fog.at(x, y) >= 200;
    this.unlisten = renderer.addFrameListener((dt, now) => {
      this.fakeCrowd?.advance(dt);
      this.crowd.update(dt, now);
      const cam = renderer.camera.getCurrentState();
      this.fishJumps.update(dt, cam.x, cam.y, cam.viewHeight);
    });
  }

  /** Models loaded and the first vegetation built. */
  get ready(): Promise<void> {
    return Promise.all([this.vegetation.ready, this.crowd.ready]).then(() => undefined);
  }

  /** Replace the ambient animals (null: none); they appear with the next snapshot. */
  setAnimals(animals: AnimalOptions | null): void {
    this.animals = animals;
    this.fakeCrowd = null;
  }

  /** Call after `renderer.applySnapshot(s)`. */
  applySnapshot(s: Snapshot): void {
    const r = this.renderer;
    const { width: W, height: H } = r.info;
    if (this.animals) this.fakeCrowd ??= new FakeCrowd(r.heights, { seed: this.seed, look: this.look, people: 0, ...this.animals });
    const animals = this.fakeCrowd?.frame();
    const entities = animals ? mergeFrames(s.entities, animals) : (s.entities ?? EMPTY);
    this.crowd.setFrame(hideInFog(entities, r), performance.now());
    const v = this.vegetation;
    if (s.revealed) v.setRevealed(s.revealed);
    if (s.terrain) v.invalidate(0, s.terrain.y0, W, s.terrain.y1);
    if (s.fields) v.setFields(s.fields);
    if (s.lining) v.setLining(s.lining);
    if (s.fish) this.fishJumps.setFish(s.fish);
    if (s.time.season !== this.season) {
      this.season = s.time.season;
      v.setSeason(this.season);
    }
    // Re-scatter vegetation occasionally (it changes slowly), and at once
    // when the whole land was replaced.
    const whole = s.terrain && s.terrain.y0 === 0 && s.terrain.y1 >= H;
    if (s.look && (++this.lookCounter % 20 === 0 || whole)) v.update(s.look);
  }

  dispose(): void {
    this.unlisten();
    this.vegetation.dispose();
    this.crowd.dispose();
    this.fishJumps.dispose();
  }
}

const EMPTY: EntityFrame = { count: 0, id: new Uint16Array(0), info: new Uint8Array(0), pos: new Float32Array(0) };

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
