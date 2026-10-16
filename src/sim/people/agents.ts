/**
 * Individual people: state, movement along paths, and packing into entity
 * frames for the renderer. Decisions about *what* to do live in village.ts.
 */
import { CarryKind, EntityAnim, EntityKind, type EntityFrame } from '../../shared/protocol';
import { STEPS_PER_SECOND_1X } from '../constants';
import type { World } from '../world';

export const enum Job {
  Idle = 0,
  Builder = 1,
  Farmer = 2,
  Fisher = 3,
}

export const enum Task {
  /** Needs a new task. */
  None = 0,
  /** Walking along `path` towards `site`. */
  Walk = 1,
  /** Working at `site` for `timer` steps. */
  Work = 2,
  /** Resting / idling for `timer` steps. */
  Rest = 3,
  /** Leaving the settlement for good; removed on arrival. */
  Leave = 4,
}

/** What the work at a site is (decides the effect when it completes). */
export const enum SiteKind {
  None = 0,
  House = 1,
  Earthwork = 2,
  Sow = 3,
  Tend = 4,
  Harvest = 5,
  Deliver = 6,
  Wander = 7,
  Fish = 8,
}

export interface Agent {
  id: number;
  settlement: number;
  /** Appearance variant (character model). */
  variant: number;
  x: number;
  y: number;
  heading: number;
  job: Job;
  task: Task;
  /** Work kind to do when the walk ends. */
  siteKind: SiteKind;
  /** Target cell index (or building id for houses). */
  site: number;
  /** Remaining path (cell indices), consumed from `pathPos`. */
  path: number[];
  pathPos: number;
  /** Steps left for Work/Rest. */
  timer: number;
  carry: CarryKind;
  /** Amount carried (food, person-days). */
  load: number;
  anim: EntityAnim;
  /** Running away from rising water. */
  flee?: boolean;
  /** Last movement velocity (cells per step), for extrapolation. */
  vx: number;
  vy: number;
}

/** Walking speed in cells per hydro step (≈ 1.5 cells per real second at 1×). */
export const WALK_SPEED = 1.5 / STEPS_PER_SECOND_1X;

/**
 * Move an agent along its path for `steps` hydro steps. Returns true when it
 * has arrived at the end of the path.
 */
export function walk(world: World, a: Agent, steps: number): boolean {
  const W = world.width;
  let budget = steps * WALK_SPEED;
  const x0 = a.x;
  const y0 = a.y;
  while (budget > 0 && a.pathPos < a.path.length) {
    const c = a.path[a.pathPos]!;
    const tx = c % W;
    const ty = (c / W) | 0;
    const dx = tx - a.x;
    const dy = ty - a.y;
    const d = Math.hypot(dx, dy);
    // Wading slows people down.
    const slow = world.water[c]! > 0.05 ? 0.5 : 1;
    const can = budget * slow;
    if (d <= can) {
      a.x = tx;
      a.y = ty;
      budget -= d / slow;
      a.pathPos++;
    } else {
      a.x += (dx / d) * can;
      a.y += (dy / d) * can;
      budget = 0;
    }
  }
  const mx = a.x - x0;
  const my = a.y - y0;
  if (mx !== 0 || my !== 0) a.heading = Math.atan2(my, mx);
  a.vx = mx / steps;
  a.vy = my / steps;
  return a.pathPos >= a.path.length;
}

/** Pack all agents into an entity frame (velocities in cells per real second at 1×). */
export function packEntities(agents: readonly Agent[], speed: number): EntityFrame {
  const n = agents.length;
  const id = new Uint16Array(n);
  const info = new Uint8Array(n * 4);
  const pos = new Float32Array(n * 5);
  const k = STEPS_PER_SECOND_1X * speed;
  for (let i = 0; i < n; i++) {
    const a = agents[i]!;
    id[i] = a.id;
    info[i * 4] = EntityKind.Person;
    info[i * 4 + 1] = a.variant;
    info[i * 4 + 2] = a.anim;
    info[i * 4 + 3] = a.carry;
    pos[i * 5] = a.x;
    pos[i * 5 + 1] = a.y;
    pos[i * 5 + 2] = a.vx * k;
    pos[i * 5 + 3] = a.vy * k;
    pos[i * 5 + 4] = a.heading;
  }
  return { count: n, id, info, pos };
}
