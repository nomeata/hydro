/**
 * Individual people: state, movement along paths, and packing into entity
 * frames for the renderer. Decisions about *what* to do live in village.ts.
 */
import { CarryKind, EntityAnim, EntityKind, type EntityFrame } from '../../shared/protocol';
import { STEPS_PER_SECOND_1X } from '../constants';
import { LandUse, type World } from '../world';

export const enum Job {
  Idle = 0,
  Builder = 1,
  Farmer = 2,
  Fisher = 3,
  /** Fells trees at the forest edge and carries the logs to the woodpile (M3-δ). */
  Woodcutter = 4,
  /** Leads the village herd to pasture and back, and brings the milk home (M3-δ). */
  Herder = 5,
  /** Grinds the grain brought to the village mill and carries the flour to the store (GAMEPLAY §1.2). */
  Miller = 6,
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
  /** Pick up a stone at the store (for lining). */
  Quarry = 9,
  /** Lay a stone: line the cell `site`. */
  Line = 10,
  /** Build the village jetty (site = shore cell). */
  Jetty = 11,
  /** Fell a tree: the forest cell `site` (standing at its edge). */
  Chop = 12,
  /** Lead the herd to pasture and watch it graze (site = pasture cell). */
  Herd = 13,
  /** Work a sluice gate's wheel (site = gate id; structures/gatekeeper.ts). */
  Gate = 14,
  /** Fill a bucket at the village well or the water's edge (site = the well's building id, or the water cell). */
  Fetch = 15,
  /** Carry the bucket home to a house (site = the house's cell). */
  Pour = 16,
  /** Bring a sack of grain to the mill (site = the mill's building id). */
  Mill = 17,
  /** Grind grain at the mill (site = the mill's building id). */
  Grind = 18,
  /** Build or rebuild a footbridge (site = the bridge's id; bridges.ts). */
  Bridge = 19,
  /** Dig a field ditch off the player's canal (site = the ditch cell; people/ditches.ts). */
  Ditch = 20,
  /** Put up a power pole (site = the pole's id; power/grid.ts). */
  Pole = 21,
  /** Shovel the snow off a field cell before sowing it (site = the field cell; village.ts `clearSnow`). */
  ClearSnow = 22,
  /** Mend a structure in disrepair (site = building or bridge id, or -1 for the village jetty; people/wear.ts). */
  Repair = 23,
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
  /**
   * A child playing between the houses of a prosperous village (PEOPLE.md
   * §7): cosmetic, never works, not counted in the population.
   */
  child?: boolean;
  /**
   * A newcomer camping at the village edge, waiting for room or land
   * (docs/GAMEPLAY.md §4.6): idles by the camp, never works, not counted
   * in the population until the family moves in.
   */
  camper?: boolean;
  /** Last movement velocity (cells per step), for extrapolation. */
  vx: number;
  vy: number;
}

/** Walking speed in cells per hydro step (≈ 1.5 cells per real second at 1×). */
export const WALK_SPEED = 1.5 / STEPS_PER_SECOND_1X;
/** Walking on a trodden path is a little quicker. */
export const PATH_SPEED = 1.2;
/** Footfall added to a cell's traffic by every walker entering it (desire paths, people/desire.ts). */
export const TRAFFIC_STEP = 4;

/** Something that walks along a path of cells (people and animals). */
export interface Walker {
  x: number;
  y: number;
  heading: number;
  path: number[];
  pathPos: number;
  vx: number;
  vy: number;
}

/**
 * Move an agent along its path for `steps` hydro steps. Returns true when it
 * has arrived at the end of the path.
 */
export function walk(world: World, a: Walker, steps: number, speed = 1): boolean {
  const W = world.width;
  let budget = steps * WALK_SPEED * speed;
  const x0 = a.x;
  const y0 = a.y;
  while (budget > 0 && a.pathPos < a.path.length) {
    const c = a.path[a.pathPos]!;
    const tx = c % W;
    const ty = (c / W) | 0;
    const dx = tx - a.x;
    const dy = ty - a.y;
    const d = Math.hypot(dx, dy);
    // Wading slows people down; trodden paths speed them up.
    const slow = world.water[c]! > 0.05 ? 0.5 : world.landuse[c] === LandUse.Path ? PATH_SPEED : 1;
    const can = budget * slow;
    if (d <= can) {
      a.x = tx;
      a.y = ty;
      budget -= d / slow;
      a.pathPos++;
      // Footfall: well-used ways become desire paths.
      if (d > 0) {
        const t = world.traffic[c]!;
        world.traffic[c] = t > 255 - TRAFFIC_STEP ? 255 : t + TRAFFIC_STEP;
      }
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

/** A village animal (M3-δ): cows and sheep go to pasture with the herder, pigs and chicks stay by the houses. */
export interface Animal extends Walker {
  id: number;
  settlement: number;
  /** EntityKind: Cow, Sheep, Pig or Chick (or a founding party's Cart). */
  kind: EntityKind;
  /** A cart's load (CarryKind.Bundle while on the road; absent: none). */
  carry?: CarryKind;
  task: Task;
  timer: number;
  anim: EntityAnim;
}

/** Pack all agents and animals into an entity frame (velocities in cells per real second at 1×). */
export function packEntities(agents: readonly Agent[], speed: number, animals: readonly Animal[] = []): EntityFrame {
  const na = agents.length;
  const n = na + animals.length;
  const id = new Uint16Array(n);
  const info = new Uint8Array(n * 4);
  const pos = new Float32Array(n * 5);
  const k = STEPS_PER_SECOND_1X * speed;
  for (let i = na; i < n; i++) {
    const a = animals[i - na]!;
    id[i] = a.id;
    info[i * 4] = a.kind;
    info[i * 4 + 1] = a.id & 3;
    info[i * 4 + 2] = a.anim;
    info[i * 4 + 3] = a.carry ?? CarryKind.None;
    pos[i * 5] = a.x;
    pos[i * 5 + 1] = a.y;
    pos[i * 5 + 2] = a.vx * k;
    pos[i * 5 + 3] = a.vy * k;
    pos[i * 5 + 4] = a.heading;
  }
  for (let i = 0; i < na; i++) {
    const a = agents[i]!;
    id[i] = a.id;
    info[i * 4] = a.child ? EntityKind.Child : EntityKind.Person;
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
