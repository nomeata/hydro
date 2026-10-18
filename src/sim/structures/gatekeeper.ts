/**
 * Who opens and closes the sluice gates (docs/GAMEPLAY.md §2). Villagers
 * work a gate near their village: they release the reservoir in spring and
 * summer when their fields below it run dry, never while houses below are
 * wet, and close it again to refill. Any gate, with or without a village,
 * opens before the water spills over its dike (flood relief).
 *
 * Checked eight times a game day per finished gate (first matching rule
 * wins):
 *  1. Flood relief: the upstream pool is within 0.25 m of the crest → open,
 *     until it is 0.7 m below it.
 *  2. Keeper village only: a house within 16 cells of the downstream end was
 *     in water (> 0.1 m) today or yesterday → closed.
 *  3. Keeper village only, spring and summer: ≥ 15 % of the village's fields
 *     within 24 cells of the downstream end are dry and the pool is ≥ 0.4 m
 *     above the sill → open; it stays open while ≥ 5 % are dry and the head
 *     is ≥ 0.25 m.
 *  4. Otherwise closed (the reservoir refills).
 * A gate switches at most once in two days, except to open for flood
 * relief. With a keeper village, a villager walks to the gate and turns its
 * wheel while the leaf moves; if nobody comes in time (a quarter day for
 * flood relief, a day otherwise) the gate moves by itself.
 *
 * Deterministic: no randomness; all state lives on the Gate records
 * (structures.ts) and is saved with them. Gates held by the toggleGate
 * command are left alone.
 */
import type { SimTime } from '../../shared/protocol';
import { STEPS_PER_DAY } from '../constants';
import { SiteKind, Task } from '../people/agents';
import type { PeopleSystem } from '../people/village';
import { LandUse, type World } from '../world';
import type { Gate, Structures } from './structures';

/** Why a gate is open. */
export const enum GateMode {
  None = 0,
  /** Rule 1: the pool nearly reached the crest. */
  Relief = 1,
  /** Rule 3: the villagers water their fields. */
  Irrigate = 2,
}

export const GATEKEEPING = {
  /** Steps between checks (three game hours). */
  every: STEPS_PER_DAY / 8,
  /** Steps a gate stays as it is before it may switch again (except to open for relief). */
  hold: 2 * STEPS_PER_DAY,
  /** Flood relief opens this far below the crest (m) and closes this far below it. */
  reliefOpen: 0.25,
  reliefClose: 0.7,
  /** Houses this close (cells) to the downstream end, in water this deep (m), keep the gate shut. */
  houseRange: 16,
  houseWet: 0.1,
  /** Fields this close (cells) to the downstream end are served by the gate; fewer than minFields count as none. */
  fieldRange: 24,
  minFields: 6,
  /** Share of dry served fields to open for, and to stay open while. */
  dryOpen: 0.15,
  dryStay: 0.05,
  /** Pool head above the sill (m) to open for, and to stay open while. */
  headOpen: 0.4,
  headStay: 0.25,
  /** Steps to wait for the villager before the gate moves by itself: for relief, otherwise. */
  waitRelief: STEPS_PER_DAY / 4,
  waitWork: STEPS_PER_DAY,
} as const;

/** Checks run at this step of each interval (off the other subsystems' beats). */
const CHECK_PHASE = 37;

/** Achievement events: a villager opened a gate to water the fields; flood relief kept a dike from being overtopped. */
export type GateEvent = 'irrigated' | 'safetyValve';

/** What a check sees at a gate. */
export interface GateView {
  /** Mean water surface (m) at the upstream and downstream ends of the passage. */
  hU: number;
  hD: number;
  /** Downstream end (cell coordinates). */
  downX: number;
  downY: number;
  /** The lower of the dike crest beside the gate and the gate's top (m). */
  crest: number;
  /** Whether water runs over the dike beside the gate. */
  overtopped: boolean;
}

export class Gatekeeper {
  /** Told of achievement events (an observer). */
  onEvent: ((e: GateEvent) => void) | null = null;

  constructor(
    private readonly world: World,
    private readonly structures: Structures,
    private readonly clock: () => SimTime,
  ) {}

  /** Every step: move the leaves; every few game hours, decide. */
  tick(step: number, people: PeopleSystem | null): void {
    const st = this.structures;
    if (st.gates.length === 0) return;
    st.stepGates();
    if (step % GATEKEEPING.every !== CHECK_PHASE) return;
    const time = this.clock();
    for (const g of st.gates) if (g.progress >= 1 && !g.manual) this.check(g, step, time, people);
  }

  /**
   * A villager reached gate `id` (PeopleSystem.onGate): the waiting switch
   * happens now. Returns the gate's centre to face, or null if there is
   * nothing to do there.
   */
  arrived(id: number, agent: number): readonly [number, number] | null {
    const g = this.structures.gates.find((g) => g.id === id);
    if (!g) return null;
    const want = g.want ?? -1;
    if (want >= 0) this.apply(g, want === 1, g.wantMode ?? GateMode.None, agent, this.clock());
    else if ((g.lift ?? 0) === (g.open ? 1 : 0)) return null;
    return [g.x, g.y];
  }

  /** The water at a gate: which side is up, how high, and the crest beside it. */
  view(g: Gate): GateView {
    const w = this.world;
    const W = w.width;
    const along = Math.abs(Math.cos(g.rot)) > 0.5;
    const [dx, dy] = along ? [1, 0] : [0, 1];
    const [px, py] = [-dy, dx];
    // The passage's extent across the gate line, on either side.
    let kp = 0;
    let kn = 0;
    for (const c of g.passage) {
      const k = Math.round((c % W) * px + ((c / W) | 0) * py - (g.x * px + g.y * py));
      if (k > kp) kp = k;
      if (k < kn) kn = k;
    }
    const mean = (cx: number, cy: number): number => {
      let s = 0;
      let n = 0;
      for (let y = cy - 1; y <= cy + 1; y++)
        for (let x = cx - 1; x <= cx + 1; x++) {
          if (!w.inBounds(x, y)) continue;
          s += w.surface(w.idx(x, y));
          n++;
        }
      return n ? s / n : -Infinity;
    };
    const ax = Math.round(g.x + px * (kp + 2));
    const ay = Math.round(g.y + py * (kp + 2));
    const bx = Math.round(g.x + px * (kn - 2));
    const by = Math.round(g.y + py * (kn - 2));
    const ha = mean(ax, ay);
    const hb = mean(bx, by);
    const aUp = ha >= hb;
    // The dike beside the gate: up to three cells beyond the wall on its line.
    let crest = g.top;
    let overtopped = false;
    for (const c of this.flanks(g, 3)) {
      crest = Math.min(crest, w.terrain(c));
      if (w.water[c]! > 0.05) overtopped = true;
    }
    return { hU: aUp ? ha : hb, hD: aUp ? hb : ha, downX: aUp ? bx : ax, downY: aUp ? by : ay, crest, overtopped };
  }

  /** Cells on the gate line beyond its wall, up to `reach` on each side (nearest first). */
  private flanks(g: Gate, reach: number): number[] {
    const w = this.world;
    const W = w.width;
    const along = Math.abs(Math.cos(g.rot)) > 0.5;
    const [dx, dy] = along ? [1, 0] : [0, 1];
    const first = g.cells[0]!;
    const last = g.cells[g.cells.length - 1]!;
    const out: number[] = [];
    for (let k = 1; k <= reach; k++)
      for (const [c, s] of [
        [first, -1],
        [last, 1],
      ] as const) {
        const x = (c % W) + dx * k * s;
        const y = ((c / W) | 0) + dy * k * s;
        if (w.inBounds(x, y)) out.push(w.idx(x, y));
      }
    return out;
  }

  private check(g: Gate, step: number, time: SimTime, people: PeopleSystem | null): void {
    const w = this.world;
    const K = GATEKEEPING;
    const v = this.view(g);
    const day = time.day;

    // Safety Valve: a relief opening, and the dike beside the gate stayed dry that day.
    const rd = g.reliefDay ?? -1;
    if (rd >= 0) {
      if (v.overtopped) g.overtopped = true;
      if (day > rd) {
        if (!g.overtopped) this.onEvent?.('safetyValve');
        g.reliefDay = -1;
      }
    }

    const centre = w.idx(Math.round(g.x), Math.round(g.y));
    const keeper = people?.settlementNear(centre) ?? null;
    const keeperIndex = keeper && people ? people.settlements.indexOf(keeper) : -1;

    // Houses below the gate in water today.
    if (people) {
      const r2 = K.houseRange * K.houseRange;
      for (const b of people.buildings) {
        if (b.kind !== 'house') continue;
        if ((b.x - v.downX) ** 2 + (b.y - v.downY) ** 2 > r2) continue;
        if (w.water[w.idx(b.x, b.y)]! > K.houseWet) {
          g.wetDay = day;
          break;
        }
      }
    }

    let want = false;
    let mode: GateMode = GateMode.None;
    const reliefLine = g.open && g.mode === GateMode.Relief ? v.crest - K.reliefClose : v.crest - K.reliefOpen;
    const relief = g.open && g.mode === GateMode.Relief ? v.hU > reliefLine : v.hU >= reliefLine;
    if (relief) {
      want = true;
      mode = GateMode.Relief;
    } else if (keeper && (g.wetDay ?? -1e9) >= day - 1) {
      want = false;
    } else if (keeper && people && (time.season === 0 || time.season === 1)) {
      const dry = this.dryShare(people, keeper, v.downX, v.downY, time.season);
      const head = v.hU - g.sill;
      const ok = g.open ? dry >= K.dryStay && head >= K.headStay : dry >= K.dryOpen && head >= K.headOpen;
      if (ok) {
        want = true;
        mode = GateMode.Irrigate;
      }
    }

    const pending = g.want ?? -1;
    if (want === g.open) {
      // Nothing to change (a waiting call is no longer needed); an open gate may stay open for another reason.
      if (pending >= 0) g.want = -1;
      if (g.open) g.mode = mode;
      return;
    }
    const urgent = want && mode === GateMode.Relief;
    if (pending >= 0 && (pending === 1) === want) {
      // Waiting for the villager: move by itself if nobody came in time.
      if (step - (g.wantStep ?? step) >= (urgent ? K.waitRelief : K.waitWork)) this.apply(g, want, mode, -1, time);
      else if (people && keeperIndex >= 0 && !this.onTheWay(people, g)) this.call(g, people, keeperIndex, time);
      return;
    }
    if (!urgent && step - (g.lastSwitch ?? -1e9) < K.hold) return;
    if (!people || keeperIndex < 0) {
      this.apply(g, want, mode, -1, time);
      return;
    }
    g.want = want ? 1 : 0;
    g.wantMode = mode;
    g.wantStep = step;
    this.call(g, people, keeperIndex, time);
  }

  /** Send a villager to the gate (or let it move by itself if nobody can stand there). */
  private call(g: Gate, people: PeopleSystem, index: number, time: SimTime): void {
    const w = this.world;
    const s = people.settlements[index]!.state;
    let stand = -1;
    let bestD = Infinity;
    for (const c of this.flanks(g, 2)) {
      if (w.water[c]! > 0.05 || w.landuse[c] === LandUse.Building) continue;
      const d = Math.hypot((c % w.width) - s.x, ((c / w.width) | 0) - s.y);
      if (d < bestD) {
        bestD = d;
        stand = c;
      }
    }
    if (stand < 0) {
      this.apply(g, g.want === 1, g.wantMode ?? GateMode.None, -1, time);
      return;
    }
    people.callToGate(index, stand, g.id, time);
  }

  private onTheWay(people: PeopleSystem, g: Gate): boolean {
    return people.agents.some((a) => a.siteKind === SiteKind.Gate && a.site === g.id && a.task === Task.Walk);
  }

  private apply(g: Gate, open: boolean, mode: GateMode, operator: number, time: SimTime): void {
    g.want = -1;
    if (g.open !== open) {
      g.open = open;
      g.lastSwitch = time.step;
      g.operator = operator;
      this.structures.structuresDirty = true;
      if (open && mode === GateMode.Relief) {
        g.reliefDay = time.day;
        g.overtopped = false;
      }
      if (open && mode === GateMode.Irrigate && operator >= 0) this.onEvent?.('irrigated');
    }
    g.mode = open ? mode : GateMode.None;
  }

  /** Share of the keeper village's fields near the downstream end that are dry (0 with fewer than minFields). */
  private dryShare(people: PeopleSystem, keeper: NonNullable<ReturnType<PeopleSystem['settlementNear']>>, x0: number, y0: number, season: number): number {
    const w = this.world;
    const R = GATEKEEPING.fieldRange;
    const many = people.settlements.length > 1;
    let n = 0;
    let dry = 0;
    for (let y = Math.max(0, y0 - R); y <= Math.min(w.height - 1, y0 + R); y++)
      for (let x = Math.max(0, x0 - R); x <= Math.min(w.width - 1, x0 + R); x++) {
        if ((x - x0) ** 2 + (y - y0) ** 2 > R * R) continue;
        const i = w.idx(x, y);
        if (w.landuse[i] !== LandUse.Field) continue;
        if (many && people.ownerOf(x, y) !== keeper) continue;
        n++;
        const s = people.stressAt(i, season);
        if (s >= 1 && s <= 127) dry++;
      }
    return n < GATEKEEPING.minFields ? 0 : dry / n;
  }
}
