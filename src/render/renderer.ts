/**
 * GameRenderer: owns the WebGL renderer, scene, terrain/water layers, sky and
 * camera. Other layers (objects, characters) add themselves to `scene` and
 * subscribe to `addFrameListener`.
 */
import { GameClock } from './gameClock';
import * as THREE from 'three';
import type { PowerInfo, Snapshot, WorldInfo } from '../shared/protocol';
import { CameraController } from './camera';
import { HEIGHT_SCALE, heightToY } from './coords';
import { CHUNK, makeChunkGeometry, setChunkBounds } from './grid';
import { HeightField } from './heights';
import { rayMarchHeightfield } from './picking';
import { SkyLighting } from './sky';
import { TerrainLayer, createTerrainUniforms } from './terrain';
import {
  makeByteTexture,
  makeFloatTexture,
  makeNoiseTexture,
  packPlan,
  PLAN_NONE,
  packVel,
  uploadFloatRows,
} from './textures';
import { WaterLayer, createWaterUniforms } from './water';
import { FlowParticles } from './flow';
import { WeatherLayer, createFrontUniforms } from './weather';
import { BuildingsLayer } from './village/buildings';
import { CropLayer } from './village/crops';
import { PlotLayer } from './village/plots';
import { VillageCuesLayer } from './village/cues';
import { MillWheelsLayer } from './village/millwheels';
import { fieldsToRgba } from './village/fields';
import { villageLanes } from './village/lanes';
import { StructuresLayer } from './structures/structures';
import { WheelPreview } from './structures/wheelPreview';
import { BrushCursor } from './brushCursor';
import { CellTint } from './cellTint';
import { GatePreview } from './structures/gatePreview';
import { PowerLayer } from './power/power';
import { makeLiningTexture } from './structures/lining';
import { FogField } from './fog';
import type { BuildingInfo, StructureInfo } from '../shared/protocol';

/** Fixed time of day used for lighting: a pleasant early afternoon. */
const DAY_TIME = 0.56;

export interface InitialData {
  info: WorldInfo;
  terrain: Float32Array;
  look: Uint8Array;
  plan: Float32Array;
  /** Fog of war (absent: everything known). */
  revealed?: Uint8Array;
}

export interface GameRendererOptions {
  /** Default min(devicePixelRatio, 1.5). */
  pixelRatio?: number;
  /** Sun shadow map (default off). */
  shadows?: boolean;
  /** MSAA (default true). */
  antialias?: boolean;
  /** Follow the snapshot's time of day / season for lighting (default false: fixed afternoon). */
  followSimTime?: boolean;
}

/** Called every frame with the wall-clock step and the game clock (see gameClock.ts). */
type FrameListener = (realDt: number, clock: GameClock) => void;

let capsLogged = false;

export class GameRenderer {
  readonly scene = new THREE.Scene();
  readonly heights: HeightField;
  readonly camera: CameraController;
  readonly gl: THREE.WebGLRenderer;
  readonly sky: SkyLighting;
  readonly info: WorldInfo;

  private readonly canvas: HTMLCanvasElement;
  private readonly geometry: THREE.BufferGeometry;
  private readonly terrain: TerrainLayer;
  private readonly water: WaterLayer;
  /** Drifting foam flecks / leaves showing the flow direction. */
  readonly flow: FlowParticles;
  /** Clouds, cloud shadows, rain and snow following the rain fronts. */
  readonly weather: WeatherLayer;
  /** Houses and the store from the snapshot's building list. */
  readonly buildings: BuildingsLayer;
  /** Crop models on fields when zoomed in (the terrain shader paints the fields). */
  readonly crops: CropLayer;
  readonly plots: PlotLayer;
  /** Chimney smoke, laundry and flowers showing each village's mood. */
  readonly cues: VillageCuesLayer;
  readonly millWheels: MillWheelsLayer;
  /** Sluice gates and weirs from the snapshot's structure list. */
  readonly structures: StructuresLayer;
  /** The water-wheel tool's ghost wheel and site marks. */
  readonly wheelPreview: WheelPreview;
  /** The sculpting brush's ring under the pointer. */
  readonly brushCursor: BrushCursor;
  /** Turbines, poles, pumps and lit cottages (M6). */
  readonly power: PowerLayer;
  /** The power tool's ghost: a pump, while drawing (or moving one). */
  readonly powerGhost: PowerLayer;
  private readonly ghostMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, color: 0xd8f0ff, emissive: 0x203040 });
  /** The gate tool's hover ghost. */
  readonly gatePreview: GatePreview;
  /** A weir being drawn or edited, as it will stand (the weir tool, the selection's handles). */
  readonly weirGhost: GatePreview;
  /** Weirs the crew is still building, shown whole as a ghost (their plan cells are not highlighted). */
  readonly buildGhost: GatePreview;
  /** The last plan from the sim (NaN = none), kept to mask building weirs' cells. */
  private planRaw: Float32Array;
  /** Cells near the line of a weir under construction. */
  private weirMask = new Set<number>();
  /** Tinted cells for the brushes: fields under the brush, the stroke's raised and dug ground, an undo's flash. */
  readonly cellTint: CellTint;
  /** Lining per cell as last received, and cells previewed by a lining tool. */
  private liningBase: Uint8Array;
  private liningPreview: readonly number[] | null = null;
  /** Whether the terrain and water shaders include the lining code yet. */
  private liningShaders = false;
  /** Fog of war: what the player knows of the land. */
  readonly fog: FogField;
  /** Latest building list (unfiltered; buildings in the fog are not drawn). */
  private buildingList: readonly BuildingInfo[] = [];
  /** The last snapshot fields (paths and lanes are redrawn when the buildings change too). */
  private lastFields: Uint8Array | null = null;
  /** The village buildings of the latest snapshot. */
  get buildingInfos(): readonly BuildingInfo[] {
    return this.buildingList;
  }
  private season = 1;
  /** 0..1: the strongest snow front's intensity (fresh snow covers footprints). */
  snowfall = 0;
  private readonly tex: {
    terrain: THREE.DataTexture;
    look: THREE.DataTexture;
    plan: THREE.DataTexture;
    preview: THREE.DataTexture;
    depthA: THREE.DataTexture;
    depthB: THREE.DataTexture;
    vel: THREE.DataTexture;
    noise: THREE.DataTexture;
    fields: THREE.DataTexture;
    lining: THREE.DataTexture;
  };
  /** CPU buffers for the two depth textures; `depthCur` is the newer one. */
  private depthPrevIsA = true;
  private readonly listeners: FrameListener[] = [];
  private lastFrameMs: number | null = null;
  /** Some cell of the ground look has snow (A > 0). */
  private lookHasSnow = true;
  /** The game-time animation clock: stops while paused (gameClock.ts). */
  readonly clock = new GameClock();
  private snapPending = false;
  private snapAtMs = 0;
  private snapIntervalMs = 100;
  private lastSnapAtMs: number | null = null;
  private contextLost = false;
  private readonly shadows: boolean;
  private readonly followSimTime: boolean;
  private maxDepthSeen = 0;
  private readonly onLost: (e: Event) => void;
  private readonly onRestored: () => void;
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector2();

  constructor(canvas: HTMLCanvasElement, data: InitialData, opts: GameRendererOptions = {}) {
    this.canvas = canvas;
    this.info = data.info;
    const { width: W, height: H } = data.info;
    this.shadows = opts.shadows ?? false;
    this.followSimTime = opts.followSimTime ?? false;

    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: opts.antialias ?? true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.gl.setPixelRatio(opts.pixelRatio ?? Math.min(globalThis.devicePixelRatio || 1, 1.5));
    this.gl.shadowMap.enabled = this.shadows;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.logCapabilities();

    // CPU state.
    this.heights = new HeightField(W, H, data.terrain);

    // Textures.
    const planBuf = new Float32Array(W * H);
    const anyPlan = packPlan(data.plan, planBuf);
    const previewBuf = new Float32Array(W * H);
    this.tex = {
      terrain: makeFloatTexture(W, H, new Float32Array(this.heights.terrain)),
      look: makeByteTexture(W, H, 4, new Uint8Array(data.look.subarray(0, W * H * 4))),
      plan: makeFloatTexture(W, H, planBuf),
      preview: makeFloatTexture(W, H, previewBuf),
      depthA: makeFloatTexture(W, H),
      depthB: makeFloatTexture(W, H),
      vel: makeByteTexture(W, H, 2),
      noise: makeNoiseTexture(),
      fields: makeByteTexture(W, H, 4),
      lining: makeLiningTexture(W, H),
    };
    this.liningBase = new Uint8Array(W * H);

    // Layers.
    this.geometry = makeChunkGeometry();
    this.fog = new FogField(W, H, data.revealed);
    this.fog.updateHeight(this.heights);
    const fronts = createFrontUniforms();
    const tu = createTerrainUniforms(this.tex, W, H, fronts, this.fog.uniforms);
    tu.uPlanOn.value = anyPlan ? 1 : 0;
    this.terrain = new TerrainLayer(this.geometry, tu, W, H);
    this.terrain.setCastShadow(this.shadows);
    this.scene.add(this.terrain.group);
    const wu = createWaterUniforms(
      {
        terrain: this.tex.terrain,
        depthA: this.tex.depthA,
        depthB: this.tex.depthB,
        vel: this.tex.vel,
        noise: this.tex.noise,
        plan: this.tex.plan,
        preview: this.tex.preview,
      },
      W,
      H,
      fronts,
      this.fog.uniforms,
    );
    // Plan flags are shared with the terrain so both overlays switch together.
    wu.uPlanOn = tu.uPlanOn;
    wu.uPreviewOn = tu.uPreviewOn;
    wu.uLining = tu.uLining;
    wu.uLiningOn = tu.uLiningOn;
    wu.uFields = tu.uFields;
    wu.uFieldsOn = tu.uFieldsOn;
    this.water = new WaterLayer(this.geometry, wu, W, H);
    this.updateFogChunks();
    this.scene.add(this.water.group);
    this.flow = new FlowParticles(this.heights);
    this.flow.revealed = this.fog.enabled ? this.fog.revealed : null;
    this.scene.add(this.flow.mesh);
    this.weather = new WeatherLayer(fronts, this.tex.terrain, W, H, HEIGHT_SCALE);
    this.scene.add(this.weather.group);
    this.buildings = new BuildingsLayer(this.scene, this.heights);
    this.buildings.setShadows(this.shadows);
    this.buildings.setLook(this.tex.look.image.data as Uint8Array, W);
    this.lookHasSnow = hasSnow(this.tex.look.image.data as Uint8Array);
    this.updateSnowAny();
    this.crops = new CropLayer(this.scene, this.heights);
    this.plots = new PlotLayer(this.scene, this.heights);
    this.cues = new VillageCuesLayer(this.scene, this.heights);
    this.millWheels = new MillWheelsLayer(this.scene, this.heights);
    this.millWheels.flowAt = (x, y, out) => this.flow.velocityAt(x, y, out);
    this.structures = new StructuresLayer(this.scene, this.heights);
    this.structures.flowAt = (x, y, out) => this.flow.velocityAt(x, y, out);
    this.wheelPreview = new WheelPreview(this.scene, this.heights);
    this.wheelPreview.setFlow((x, y, out) => this.flow.velocityAt(x, y, out));
    this.brushCursor = new BrushCursor(this.scene, this.heights);
    this.power = new PowerLayer(this.scene, this.heights);
    this.powerGhost = new PowerLayer(this.scene, this.heights, this.ghostMat);
    this.powerGhost.group.renderOrder = 12;
    this.gatePreview = new GatePreview(this.scene, this.heights);
    this.weirGhost = new GatePreview(this.scene, this.heights);
    this.buildGhost = new GatePreview(this.scene, this.heights, 0.35);
    this.planRaw = data.plan.slice();
    this.cellTint = new CellTint(this.scene, this.heights);
    this.updateBounds();

    this.sky = new SkyLighting(this.scene);
    this.applySeasonColours();
    if (this.shadows) {
      const s = this.sky.sun.shadow;
      s.mapSize.set(1024, 1024);
      s.bias = -0.0005;
      s.normalBias = 0.02;
      this.sky.sun.castShadow = true;
    }

    // Camera.
    this.camera = new CameraController(this.heights);
    this.updateCameraBounds();
    this.resize();
    // Default zoom: ~64 cells across the shorter screen side (portrait phones too).
    const cw = canvas.clientWidth || canvas.width || 1;
    const ch = canvas.clientHeight || canvas.height || 1;
    this.camera.setState({ x: data.info.startX, y: data.info.startY, viewHeight: 36 * Math.max(1, ch / cw) });

    for (const t of Object.values(this.tex)) this.gl.initTexture(t);

    this.onLost = (e: Event) => {
      e.preventDefault();
      this.contextLost = true;
      console.warn('[render] WebGL context lost');
    };
    this.onRestored = () => {
      console.info('[render] WebGL context restored');
      this.contextLost = false;
      for (const t of Object.values(this.tex)) t.needsUpdate = true;
    };
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  /** The ground look texture (RGBA per cell, A = snow cover). */
  get lookTexture(): THREE.DataTexture {
    return this.tex.look;
  }

  /** Current ground look (A = snow) and land use (fields texture, R = LandUse) bytes. */
  groundBytes(): { look: Uint8Array; fields: Uint8Array } {
    return { look: this.tex.look.image.data as Uint8Array, fields: this.tex.fields.image.data as Uint8Array };
  }

  /**
   * New terrain heights for rows [y0, y1) (the brushes' instant feedback,
   * client/sculptor.ts; snapshots go through applySnapshot).
   */
  setTerrainRows(y0: number, y1: number, data: Float32Array): void {
    const W = this.info.width;
    this.heights.setRows(y0, y1, data);
    (this.tex.terrain.image.data as Float32Array).set(data.subarray(0, (y1 - y0) * W), y0 * W);
    uploadFloatRows(this.gl, this.tex.terrain, y0, y1);
  }

  /** Upload a snapshot: depth/vel always, terrain rows / look / plan when present. */
  applySnapshot(s: Snapshot): void {
    const W = this.info.width;
    const H = this.info.height;
    const n = W * H;
    // Swap: the old "current" becomes "previous", new data goes into the other buffer.
    this.depthPrevIsA = !this.depthPrevIsA;
    const cur = this.depthBuf(false);
    cur.set(s.depth.subarray(0, n));
    this.heights.depth.set(cur);
    this.curDepthTex().needsUpdate = true;
    packVel(s.vel, this.tex.vel.image.data as Uint8Array);
    this.tex.vel.needsUpdate = true;
    this.flow.setVelocity(s.vel);
    this.flow.gameSpeed = s.stats.speedRequested > 0 ? Math.max(s.stats.speedAchieved, 0.3) : 0;
    this.structures.gameSpeed = this.flow.gameSpeed;
    this.structures.refreshWater();
    this.power.gameSpeed = this.flow.gameSpeed;
    this.clock.gameSpeed = this.flow.gameSpeed;
    this.weather.setFronts(s.climate.fronts);
    this.snowfall = 0;
    for (const f of s.climate.fronts) if (f.snow) this.snowfall = Math.max(this.snowfall, Math.min(1, f.intensity));
    // Hoar frost on the grass below freezing (the day's temperature).
    this.terrain.uniforms.uFrost.value = Math.min(1, Math.max(0, -s.climate.temperature / 4));
    this.updateSnowAny();
    const wu = this.water.uniforms;
    wu.uDepthA.value = this.prevDepthTex();
    wu.uDepthB.value = this.curDepthTex();
    wu.uMix.value = 0;
    this.water.updateVisibility(this.depthBuf(true), cur);
    let maxD = 0;
    for (let i = 0; i < n; i++) if (cur[i]! > maxD) maxD = cur[i]!;
    if (maxD > this.maxDepthSeen) {
      this.maxDepthSeen = maxD;
      this.updateBounds();
    }

    if (s.terrain) {
      const { y0, y1, data } = s.terrain;
      this.setTerrainRows(y0, y1, data);
      this.updateBounds();
      this.buildings.refreshHeights();
      this.cues.refreshHeights();
      this.millWheels.refreshHeights();
      this.structures.refreshHeights();
      this.wheelPreview.refreshHeights();
      this.power.refreshHeights();
      this.gatePreview.refreshHeights();
      this.weirGhost.refreshHeights();
      this.buildGhost.refreshHeights();
      this.cellTint.refreshHeights();
      this.crops.invalidate();
      this.plots.invalidate();
    }
    if (s.look) {
      (this.tex.look.image.data as Uint8Array).set(s.look.subarray(0, n * 4));
      this.tex.look.needsUpdate = true;
      this.buildings.setLook(this.tex.look.image.data as Uint8Array, this.info.width);
      this.lookHasSnow = hasSnow(this.tex.look.image.data as Uint8Array);
      this.updateSnowAny();
    }
    if (s.structures) {
      this.structures.setStructures(s.structures);
      this.buildingWeirs(s.structures);
    }
    if (s.plan) this.planRaw.set(s.plan.subarray(0, n));
    if (s.plan || s.structures) this.uploadPlan();
    if (s.power) this.power.setInfo(s.power);
    if (s.lining) {
      this.liningBase.set(s.lining.subarray(0, n));
      this.uploadLining();
      this.structures.setLining(s.lining);
    }
    if (s.revealed) {
      this.fog.setRevealed(s.revealed);
      this.fog.updateHeight(this.heights);
      this.updateFogChunks();
      this.updateCameraBounds();
      if (!s.buildings) {
        const vis = this.visibleBuildings(this.buildingList);
        this.buildings.setBuildings(vis);
        this.cues.setBuildings(vis);
        this.millWheels.setBuildings(vis);
        this.power.setBuildings(vis);
      }
    }
    if (s.buildings) {
      this.buildingList = s.buildings;
      const vis = this.visibleBuildings(s.buildings);
      this.buildings.setBuildings(vis);
      this.cues.setBuildings(vis);
      this.millWheels.setBuildings(vis);
      this.power.setBuildings(vis);
    }
    const vs = s.stats.villages;
    if (vs) {
      this.buildings.setVillages(vs);
      this.cues.setVillages(vs);
    }
    this.cues.setWind(s.climate.windDir, s.climate.windSpeed);
    if (s.fields) this.lastFields = s.fields;
    if (this.lastFields && (s.fields || s.buildings)) {
      // Paths and the lanes between the houses (which follow the buildings too).
      const data = this.tex.fields.image.data as Uint8Array;
      fieldsToRgba(this.lastFields, data, n, this.info.width);
      villageLanes(this.lastFields, data, n, this.info.width, this.buildingList);
      this.tex.fields.needsUpdate = true;
    }
    if (s.fields) {
      this.terrain.uniforms.uFieldsOn.value = 1;
      this.crops.setFields(s.fields);
      this.plots.setFields(s.fields);
    }
    // Always daytime (a day/night cycle is distracting); the season drifts smoothly.
    if (this.followSimTime) this.setSun(DAY_TIME, s.time.yearFrac * 4);
    this.snapPending = true;
  }

  /** Optimistic plan overlay (target height per cell, NaN = none), or null to clear. */
  /** Contour lines across the whole map (terrain.ts), while an earth brush is selected. */
  setContours(on: boolean): void {
    this.terrain.uniforms.uContours.value = on ? 1 : 0;
  }

  get contours(): boolean {
    return this.terrain.uniforms.uContours.value > 0;
  }

  setPreviewPlan(cells: Float32Array | null): void {
    const u = this.terrain.uniforms;
    if (!cells) {
      u.uPreviewOn.value = 0;
      return;
    }
    const any = packPlan(cells, this.tex.preview.image.data as Float32Array);
    u.uPreviewOn.value = any ? 1 : 0;
    this.tex.preview.needsUpdate = true;
  }

  /** The power tool's ghost pump (ui/tools.ts, a moved pump: ui/selection.ts; red when its place does not work); null hides it. */
  setPowerGhost(g: { pump: PowerInfo['pumps'][number] } | null, ok = true): void {
    this.ghostMat.color.set(ok ? 0xd8f0ff : 0xff4a3a);
    this.ghostMat.emissive.set(ok ? 0x203040 : 0x400800);
    this.powerGhost.setInfo({ turbines: [], poles: [], wires: [], pumps: g ? [g.pump] : [], lit: [] });
  }

  /** Optimistic lining overlay (cells to show as planned lining), or null to clear. */
  setPreviewLining(cells: readonly number[] | null): void {
    this.liningPreview = cells;
    this.uploadLining();
  }

  /** Weirs under construction: a whole ghost of each, and the cells round their lines (masked from the plan overlays). */
  private buildingWeirs(list: readonly StructureInfo[]): void {
    const building = list.filter((o) => o.kind === 'weir' && o.progress < 0.999 && o.x2 !== undefined && o.y2 !== undefined);
    this.buildGhost.setStructures(building.map((o) => ({ ...o, progress: 1 })));
    const mask = new Set<number>();
    const W = this.heights.width;
    const H = this.heights.height;
    for (const o of building) {
      const ax = o.x;
      const ay = o.y;
      const bx = o.x2!;
      const by = o.y2!;
      const R = 3;
      for (let y = Math.max(0, Math.floor(Math.min(ay, by) - R)); y <= Math.min(H - 1, Math.ceil(Math.max(ay, by) + R)); y++)
        for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - R)); x <= Math.min(W - 1, Math.ceil(Math.max(ax, bx) + R)); x++) {
          const dx = bx - ax;
          const dy = by - ay;
          const l2 = dx * dx + dy * dy;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
          if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= R) mask.add(y * W + x);
        }
    }
    const changed = mask.size !== this.weirMask.size || [...mask].some((i) => !this.weirMask.has(i));
    this.weirMask = mask;
    if (changed) this.uploadLining();
  }

  private uploadPlan(): void {
    const dst = this.tex.plan.image.data as Float32Array;
    let any = packPlan(this.planRaw, dst);
    if (any && this.weirMask.size) {
      for (const i of this.weirMask) dst[i] = PLAN_NONE;
      any = false;
      for (let i = 0; i < dst.length; i++)
        if (dst[i] !== PLAN_NONE) {
          any = true;
          break;
        }
    }
    this.terrain.uniforms.uPlanOn.value = any ? 1 : 0;
    this.tex.plan.needsUpdate = true;
  }

  private uploadLining(): void {
    const data = this.tex.lining.image.data as Uint8Array;
    data.set(this.liningBase);
    // (A weir being built shows as its ghost, not as planned cells.)
    for (const i of this.weirMask) if (data[i]! > 0 && data[i]! < 254) data[i] = 0;
    if (this.liningPreview) for (const i of this.liningPreview) if (data[i] === 0) data[i] = 1;
    let any = false;
    for (let i = 0; i < data.length; i++)
      if (data[i] !== 0) {
        any = true;
        break;
      }
    this.terrain.uniforms.uLiningOn.value = any ? 1 : 0;
    this.tex.lining.needsUpdate = true;
    // Compile the lining shader code only once there is lining to show.
    if (any && !this.liningShaders) {
      this.liningShaders = true;
      for (const m of [this.terrain.material, this.water.material]) {
        const md = m as THREE.Material & { defines?: Record<string, string> };
        md.defines = { ...md.defines, HYDRO_LINING: '' };
        m.needsUpdate = true;
      }
    }
  }

  /** Lighting hook: timeOfDay 0..1 (0.5 noon), season 0..3 (fractional ok). */
  setSun(timeOfDay: number, season: number): void {
    this.sky.setSun(timeOfDay, season);
    if (Math.abs(season - this.season) > 1e-4) {
      this.season = season;
      this.applySeasonColours();
      this.power?.setSeason(season);
    }
  }

  /** Season palette → terrain ground cover, water tint, leaves, foam. */
  private applySeasonColours(): void {
    const p = this.sky.palette;
    const tu = this.terrain.uniforms;
    tu.uGrassDry.value.copy(p.grassDry);
    tu.uGrassLush.value.copy(p.grassLush);
    tu.uForest.value.copy(p.forest);
    // Stubble on harvested fields through autumn (season 2..3), fading at the edges.
    const sf = ((this.season % 4) + 4) % 4;
    tu.uStubble.value = Math.min(Math.max((sf - 1.85) / 0.15, 0), 1) * Math.min(Math.max((3.0 - sf) / 0.15, 0), 1);
    const wu = this.water.uniforms;
    wu.uShallow.value.copy(p.waterShallow);
    wu.uDeep.value.copy(p.waterDeep);
    this.flow.setLeafColours(p.leafA, p.leafB);
  }

  /** Snow anywhere, or frost: the terrain shader fetches its snow noise only then. */
  private updateSnowAny(): void {
    const tu = this.terrain.uniforms;
    tu.uSnowAny.value = this.lookHasSnow || tu.uFrost.value > 0 ? 1 : 0;
  }

  addFrameListener(fn: FrameListener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Render one frame. `nowMs` should be a performance.now()/rAF timestamp. */
  frame(nowMs: number): void {
    const dt = this.lastFrameMs === null ? 0 : Math.min(0.1, Math.max(0, (nowMs - this.lastFrameMs) / 1000));
    this.lastFrameMs = nowMs;

    // Known land fades into exactly the sky behind it.
    const fu = this.fog.uniforms;
    fu.uBgTop.value.copy(this.sky.state.skyTop);
    fu.uBgBottom.value.copy(this.sky.state.skyBottom);
    this.gl.getDrawingBufferSize(fu.uViewport.value);

    if (this.snapPending) {
      this.snapPending = false;
      if (this.lastSnapAtMs !== null) {
        const iv = Math.min(500, Math.max(30, nowMs - this.lastSnapAtMs));
        this.snapIntervalMs += (iv - this.snapIntervalMs) * 0.3;
      }
      this.lastSnapAtMs = nowMs;
      this.snapAtMs = nowMs;
    }
    const mix = Math.min(1, Math.max(0, (nowMs - this.snapAtMs) / this.snapIntervalMs));
    this.water.uniforms.uMix.value = mix;

    this.camera.update(dt);
    // Game activity runs on the game clock: frozen while paused (gameClock.ts).
    const clock = this.clock;
    clock.tick(dt);
    const t = clock.animSec;
    const adt = clock.animDt;
    this.terrain.uniforms.uTime.value = t;
    const wu = this.water.uniforms;
    wu.uTime.value = t;
    const sky = this.sky.state;
    wu.uSunDir.value.copy(sky.dir);
    wu.uSunColor.value.copy(sky.sunColor);
    wu.uSkyColor.value.copy(sky.sky);
    wu.uGroundColor.value.copy(sky.ground);
    this.camera.camera.getWorldDirection(wu.uViewDir.value).negate();

    if (this.shadows) this.fitShadow();
    else this.sky.placeSun(this.camera.targetWorld(this.tmpV), Math.max(this.info.width, this.info.height));
    // Flecks scale their drift by the game speed themselves (and renew after camera moves while paused).
    this.flow.update(dt, this.camera);
    this.weather.update(adt, t, this.camera);
    const cs = this.camera.getCurrentState();
    this.crops.update(nowMs, cs.x, cs.y, cs.viewHeight);
    this.plots.update(cs.viewHeight);
    this.cues.update(adt, cs.viewHeight);
    this.millWheels.update(clock.playDt, this.flow.gameSpeed);
    this.structures.update(clock.playDt);
    this.wheelPreview.update(dt);
    this.brushCursor.update();
    this.cellTint.update();
    this.power.update(adt);
    for (const fn of this.listeners) fn(dt, clock);
    if (this.contextLost) return;
    this.gl.render(this.scene, this.camera.camera);
  }

  resize(): void {
    const c = this.canvas;
    const w = Math.max(1, c.clientWidth || c.width);
    const h = Math.max(1, c.clientHeight || c.height);
    this.gl.setSize(w, h, false);
    const db = this.gl.getDrawingBufferSize(this.tmpV2);
    this.weather?.setViewport(db.x, db.y);
    const r = c.getBoundingClientRect();
    this.camera.setViewport(w, h, r.left, r.top);
  }

  /** Cell coordinates (fractional, cell i centre at i) under a client position, or null. */
  pick(clientX: number, clientY: number): { x: number; y: number } | null {
    const r = this.canvas.getBoundingClientRect();
    this.camera.setViewport(r.width || 1, r.height || 1, r.left, r.top);
    const { origin, dir } = this.camera.rayAt(clientX, clientY);
    const hf = this.heights;
    const hit = rayMarchHeightfield(
      origin,
      dir,
      (x, z) => heightToY(hf.surfaceAt(x - 0.5, z - 0.5)),
      {
        minX: 0.5,
        maxX: hf.width - 0.5,
        minZ: 0.5,
        maxZ: hf.height - 0.5,
        minY: heightToY(hf.minTerrain) - 1,
        maxY: heightToY(hf.maxTerrain + this.maxDepthSeen) + 1,
      },
      0.35,
    );
    return hit ? { x: hit.x - 0.5, y: hit.z - 0.5 } : null;
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.terrain.dispose();
    this.water.dispose();
    this.flow.dispose();
    this.weather.dispose();
    this.buildings.dispose();
    this.crops.dispose();
    this.plots.dispose();
    this.cues.dispose();
    this.millWheels.dispose();
    this.structures.dispose();
    this.power.dispose();
    this.powerGhost.dispose();
    this.fog.dispose();
    this.sky.dispose();
    this.geometry.dispose();
    for (const t of Object.values(this.tex)) t.dispose();
    this.listeners.length = 0;
    this.gl.dispose();
  }

  // -------------------------------------------------------------------------

  /** Water chunks entirely in the fog are never drawn. */
  private updateFogChunks(): void {
    const C = CHUNK;
    const w = this.water;
    let k = 0;
    w.hiddenChunks = [];
    for (let oy = 0; oy < this.info.height; oy += C)
      for (let ox = 0; ox < this.info.width; ox += C) w.hiddenChunks[k++] = this.fog.hidden(ox, oy, ox + C, oy + C);
    w.updateVisibility(this.depthBuf(true), this.depthBuf(false));
  }

  /** Panning stays over known land (plus a margin of fog). */
  private updateCameraBounds(): void {
    const b = this.fog.enabled ? this.fog.bounds : null;
    const m = 12;
    this.camera.setPanBounds(b ? { x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m } : null);
  }

  private visibleBuildings(list: readonly BuildingInfo[]): BuildingInfo[] {
    return this.fog.enabled ? list.filter((b) => this.fog.known(b.x, b.y)) : list.slice();
  }

  private depthBuf(prev: boolean): Float32Array {
    const useA = prev === this.depthPrevIsA;
    return (useA ? this.tex.depthA : this.tex.depthB).image.data as Float32Array;
  }

  private prevDepthTex(): THREE.DataTexture {
    return this.depthPrevIsA ? this.tex.depthA : this.tex.depthB;
  }

  private curDepthTex(): THREE.DataTexture {
    return this.depthPrevIsA ? this.tex.depthB : this.tex.depthA;
  }

  private updateBounds(): void {
    const hf = this.heights;
    const skirt = heightToY(hf.minTerrain) - Math.max(3, (hf.maxTerrain - hf.minTerrain) * HEIGHT_SCALE * 0.15);
    this.terrain.uniforms.uSkirtY.value = skirt;
    this.weather.setCloudBase(heightToY(hf.maxTerrain) + 14);
    setChunkBounds(this.geometry, skirt - 1, heightToY(hf.maxTerrain + this.maxDepthSeen) + 2);
  }

  private fitShadow(): void {
    const sun = this.sky.sun;
    const focus = this.camera.targetWorld(this.tmpV);
    const vh = this.camera.getCurrentState().viewHeight;
    const cam = sun.shadow.camera;
    const ext = vh * 0.9;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    const D = Math.max(this.info.width, this.info.height);
    cam.near = 1;
    cam.far = D * 3;
    cam.updateProjectionMatrix();
    this.sky.placeSun(focus, D);
  }

  private logCapabilities(): void {
    if (capsLogged) return;
    capsLogged = true;
    const gl = this.gl.getContext();
    const ext = (n: string): boolean => !!gl.getExtension(n);
    console.info('[render] WebGL capabilities', {
      webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
      OES_texture_float_linear: ext('OES_texture_float_linear'),
      EXT_color_buffer_float: ext('EXT_color_buffer_float'),
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
      MAX_TEXTURE_SIZE: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      renderer: gl.getParameter(gl.RENDERER),
      pixelRatio: this.gl.getPixelRatio(),
    });
  }
}

/** Whether any cell of a ground look (RGBA bytes) has snow. */
function hasSnow(look: Uint8Array): boolean {
  for (let i = 3; i < look.length; i += 4) if (look[i]! > 0) return true;
  return false;
}
