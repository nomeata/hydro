/**
 * Sun, ambient light and the sky gradient background, driven by time of day
 * and season (`setSun`).
 */
import * as THREE from 'three';

export interface SunState {
  /** Unit vector pointing towards the light (sun or moon). */
  dir: THREE.Vector3;
  /** Direct light colour × intensity (linear). */
  sunColor: THREE.Color;
  sky: THREE.Color;
  ground: THREE.Color;
  skyTop: THREE.Color;
  skyBottom: THREE.Color;
  /** 0 = night, 1 = full day. */
  daylight: number;
}

const BG_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.9999, 1.0);
}
`;
const BG_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uBottom;
varying vec2 vUv;
void main() {
  float t = smoothstep(0.0, 1.0, vUv.y);
  vec3 c = mix(uBottom, uTop, t);
  // Soft vignette.
  vec2 d = vUv - 0.5;
  c *= 1.0 - dot(d, d) * 0.35;
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`;

const lerpC = (a: THREE.Color, b: THREE.Color, t: number): THREE.Color => a.clone().lerp(b, t);
const hex = (h: number): THREE.Color => new THREE.Color(h);

export class SkyLighting {
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  readonly background: THREE.Mesh;
  readonly state: SunState = {
    dir: new THREE.Vector3(0, 1, 0),
    sunColor: new THREE.Color(),
    sky: new THREE.Color(),
    ground: new THREE.Color(),
    skyTop: new THREE.Color(),
    skyBottom: new THREE.Color(),
    daylight: 1,
  };
  private readonly bgMat: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene) {
    this.sun.name = 'sun';
    this.hemi.name = 'ambient';
    scene.add(this.sun, this.sun.target, this.hemi);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.bgMat = new THREE.ShaderMaterial({
      uniforms: { uTop: { value: new THREE.Color() }, uBottom: { value: new THREE.Color() } },
      vertexShader: BG_VERT,
      fragmentShader: BG_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.background = new THREE.Mesh(geo, this.bgMat);
    this.background.name = 'sky';
    this.background.frustumCulled = false;
    this.background.renderOrder = -1000;
    scene.add(this.background);
    this.setSun(0.6, 1);
  }

  /**
   * timeOfDay 0..1 (0.5 = noon), season 0..4 (0 spring, 1 summer, 2 autumn,
   * 3 winter; fractional values blend).
   */
  setSun(timeOfDay: number, season: number): void {
    const s = this.state;
    const maxElev = (46 + 18 * Math.cos(((season - 1) * Math.PI) / 2)) * (Math.PI / 180);
    const ha = (timeOfDay - 0.5) * Math.PI * 2;
    const elev = Math.asin(Math.sin(maxElev) * Math.cos(ha) - 0.04);
    // Sun travels from east (+x) over south (+z, behind the default camera) to west.
    const az = ha;
    const dayT = smooth(-0.14, 0.1, elev);
    const lowT = 1 - smooth(0.04, 0.45, elev); // warm light near the horizon
    const winter = Math.max(0, Math.cos(((season - 3) * Math.PI) / 2));

    if (elev > -0.05) {
      const e = Math.max(elev, 0.22);
      s.dir.set(Math.sin(az) * Math.cos(e) * -1, Math.sin(e), Math.cos(az) * Math.cos(e)).normalize();
    } else {
      // Moonlight from a fixed high direction.
      s.dir.set(-0.4, 0.8, 0.45).normalize();
    }
    const daySun = lerpC(hex(0xfff3dc), hex(0xffa860), lowT * 0.85);
    daySun.lerp(hex(0xeef2ff), winter * 0.35);
    const moon = hex(0x9fb4f0);
    s.sunColor.copy(lerpC(moon, daySun, dayT)).multiplyScalar(1.05 + 1.85 * dayT);

    const daySky = lerpC(hex(0xcfe6ff), hex(0xffd3b0), lowT * 0.6);
    const nightSky = hex(0x7890d0);
    s.sky.copy(lerpC(nightSky, daySky, dayT)).multiplyScalar(1.0 + 0.05 * dayT);
    s.ground.copy(lerpC(hex(0x3c4a74), hex(0x8a7f62), dayT)).multiplyScalar(0.9);

    s.skyTop.copy(lerpC(hex(0x1c2a55), lerpC(hex(0x7fb7ec), hex(0x6f8fd0), lowT * 0.5), dayT));
    s.skyBottom.copy(lerpC(hex(0x3d4f86), lerpC(hex(0xe3f1fb), hex(0xffcfa6), lowT * 0.8), dayT));
    s.daylight = dayT;

    this.sun.color.copy(s.sunColor);
    this.sun.intensity = 1;
    this.hemi.color.copy(s.sky);
    this.hemi.groundColor.copy(s.ground);
    this.hemi.intensity = 1;
    const u = this.bgMat.uniforms;
    (u.uTop!.value as THREE.Color).copy(s.skyTop);
    (u.uBottom!.value as THREE.Color).copy(s.skyBottom);
  }

  /** Place the sun (for shadows) relative to a world-space focus point. */
  placeSun(focus: THREE.Vector3, distance: number): void {
    this.sun.position.copy(focus).addScaledVector(this.state.dir, distance);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  dispose(): void {
    this.bgMat.dispose();
    this.background.geometry.dispose();
    this.sun.dispose();
    this.hemi.dispose();
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
