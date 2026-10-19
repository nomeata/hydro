/**
 * What a selected turbine, pole or pump is doing now (ui/selection.ts): its
 * line's power, the houses it lights, and for a turbine its head, worked out
 * on the main thread from the snapshot's PowerInfo, the buildings and the
 * mirror's water (the same network rule as sim/power/grid.ts: wires join
 * finished turbines and poles; a house hangs on the nearest within
 * SUPPLY_RADIUS, a pump by its house too).
 */
import type { PowerInfo } from '../shared/protocol';
import { POWER, SUPPLY_RADIUS, turbineFlow, turbinePower } from '../sim/power/power';

export interface PowerHouse {
  id: number;
  kind: string;
  x: number;
  y: number;
  progress: number;
}

export interface Readout {
  /** Running (making or using power) or not. */
  running: boolean;
  /** Being built: progress 0..1 (the rest is then empty). */
  building?: number;
  /** A gauge 0..1 (turbine: of what its head could give; pump: of its rating) and its label. */
  gauge?: number;
  gaugeLabel?: string;
  /** Head (m, turbines), power (W: made by a turbine, on a pole's line, used by a pump), flow (m³/s). */
  head?: number;
  power: number;
  flow?: number;
  /** Houses on the line: lit and all. */
  lit: number;
  houses: number;
  /** One line saying what it does, or why not. */
  text: string;
}

/** Power in friendly units. */
export function kw(watts: number): string {
  return watts >= 9500 ? `${Math.round(watts / 1000)} kW` : `${(watts / 1000).toFixed(1)} kW`;
}

export function powerReadout(
  info: PowerInfo,
  buildings: readonly PowerHouse[],
  /** Water surface (m) at a cell, for a turbine's head. */
  surface: (x: number, y: number) => number,
  kind: 'turbine' | 'pole' | 'pump',
  id: number,
): Readout | null {
  // Networks of finished nodes.
  const live: { key: string; x: number; y: number }[] = [];
  for (const t of info.turbines) if (t.progress >= 1) live.push({ key: `${t.x},${t.y}`, x: t.x, y: t.y });
  for (const p of info.poles) if (p.progress >= 1) live.push({ key: `${p.x},${p.y}`, x: p.x, y: p.y });
  const parent = new Map<string, string>();
  for (const n of live) parent.set(n.key, n.key);
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  const W = info.wires;
  for (let k = 0; k + 3 < W.length; k += 4) {
    const a = `${W[k]},${W[k + 1]}`;
    const b = `${W[k + 2]},${W[k + 3]}`;
    if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  }
  const nearest = (x: number, y: number): string | null => {
    let best: string | null = null;
    let bd = SUPPLY_RADIUS;
    for (const n of live) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d <= bd) {
        bd = d;
        best = n.key;
      }
    }
    return best ? find(best) : null;
  };
  const level = new Map<number, number>();
  for (let k = 0; k + 1 < info.lit.length; k += 2) level.set(info.lit[k]!, info.lit[k + 1]!);
  /** A network's power made, and its houses (lit, all). */
  const net = (root: string | null) => {
    let power = 0;
    let turbines = 0;
    let lit = 0;
    let houses = 0;
    if (root) {
      for (const t of info.turbines)
        if (t.progress >= 1 && find(`${t.x},${t.y}`) === root) {
          power += t.power;
          turbines++;
        }
      for (const h of buildings) {
        if (h.kind !== 'house' || h.progress < 1 || nearest(h.x, h.y) !== root) continue;
        houses++;
        if ((level.get(h.id) ?? 0) > 0) lit++;
      }
    }
    return { power, turbines, lit, houses };
  };
  const housesText = (lit: number, houses: number) =>
    houses === 0 ? 'No houses on its line yet: the villagers are putting up the poles.' : lit === houses ? `${houses} house${houses > 1 ? 's' : ''} lit.` : `${lit} of ${houses} houses lit.`;

  if (kind === 'turbine') {
    const t = info.turbines.find((o) => o.id === id);
    if (!t) return null;
    if (t.progress < 1) return { running: false, building: t.progress, power: 0, lit: 0, houses: 0, text: `Being built: ${Math.round(t.progress * 100)} %.` };
    const head = Math.abs(surface(t.ax, t.ay) - surface(t.bx, t.by));
    // (What the head could give at full flow; the main thread's water is a little behind the sim's.)
    const full = Math.max(turbinePower(turbineFlow(head), head), t.power);
    const n = net(find(`${t.x},${t.y}`));
    const running = t.power > 0;
    const why =
      head < POWER.minHead
        ? `Idle: only ${head.toFixed(1)} m of head. The pool behind the wall is too low (a gate drained it?), or the water below stands as high.`
        : 'Idle: its pool is below the crest, kept for when the houses need light.';
    return {
      running,
      head,
      power: t.power,
      flow: Math.abs(t.flow),
      gauge: full > 0 ? Math.min(1, t.power / full) : 0,
      gaugeLabel: running ? `${kw(t.power)} of ${kw(full)}` : '0 kW',
      lit: n.lit,
      houses: n.houses,
      text: running ? `${head.toFixed(1)} m of head: ${kw(t.power)}. ${housesText(n.lit, n.houses)}` : `${why} ${housesText(n.lit, n.houses)}`,
    };
  }
  if (kind === 'pole') {
    const p = info.poles.find((o) => o.id === id);
    if (!p) return null;
    if (p.progress < 1) return { running: false, building: p.progress, power: 0, lit: 0, houses: 0, text: `Being built: ${Math.round(p.progress * 100)} %.` };
    const n = net(find(`${p.x},${p.y}`));
    if (n.turbines === 0) return { running: false, power: 0, lit: 0, houses: n.houses, text: 'Not joined to a turbine yet: the villagers are putting up the line.' };
    return {
      running: n.power > 0,
      power: n.power,
      gauge: n.houses > 0 ? n.lit / n.houses : 0,
      gaugeLabel: `${kw(n.power)} on the line`,
      lit: n.lit,
      houses: n.houses,
      text: `${kw(n.power)} from ${n.turbines} turbine${n.turbines > 1 ? 's' : ''}. ${housesText(n.lit, n.houses)}`,
    };
  }
  const p = info.pumps.find((o) => o.id === id);
  if (!p) return null;
  if (p.progress < 1) return { running: false, building: p.progress, power: 0, lit: 0, houses: 0, text: `Being built: ${Math.round(p.progress * 100)} %.` };
  const root = nearest(p.hx, p.hy);
  const n = net(root);
  const running = p.flow > 0.01;
  return {
    running,
    power: p.power,
    flow: p.flow,
    gauge: Math.min(1, p.power / POWER.pumpRating),
    gaugeLabel: running ? `${kw(p.power)} of ${kw(POWER.pumpRating)}` : '0 kW',
    lit: n.lit,
    houses: n.houses,
    text: running
      ? `Lifting ${p.flow.toFixed(2)} m³/s on ${kw(p.power)} of spare power.`
      : !root || n.turbines === 0
        ? 'Idle: not on a power line yet. Once a turbine turns, the villagers put up poles to it.'
        : n.power <= 0
          ? 'Idle: its turbines make no power now.'
          : 'Idle: no spare power (the houses come first), or no water at its inlet.',
  };
}
